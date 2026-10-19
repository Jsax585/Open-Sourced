/**
 * Reusable isolation lifecycle for subagent execution.
 *
 * Both `TaskTool` and the eval `agent()` bridge spawn subagents that can run
 * inside a copy-on-write worktree, capture their changes, and (optionally)
 * apply those changes back to the parent repo. The orchestration is identical
 * for both callers; this module hosts the shared lifecycle so eval `agent()`
 * does not need to round-trip through `TaskTool.#runSpawn`.
 *
 * Shape:
 *   1. {@link prepareIsolationContext} — resolve the git root.
 *   2. {@link runIsolatedSubprocess}    — start worktree, capture its
 *                                        baseline, run, capture changes, and
 *                                        transfer cleanup ownership.
 *   3. {@link mergeIsolatedChanges}     — apply captured changes back to the
 *                                        parent repo (skip when the caller
 *                                        opted out).
 *
 * Step 1 happens once per top-level call; steps 2 and 3 are per-spawn.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as natives from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import isolationErrorTemplate from "../prompts/tools/isolation-error.md" with { type: "text" };
import isolationSummaryTemplate from "../prompts/tools/isolation-summary.md" with { type: "text" };
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import type { ToolSession } from "../tools";
import { generateCommitMessage } from "../utils/commit-message-generator";
import { trackLateCleanup } from "../utils/late-cleanup";
import type { ExecutorOptions } from "./executor";
import { runSubprocess } from "./executor";
import { needsNativeTeardown, writeRetainedBackend } from "./isolation-ownership";
import type { NestedRepoPatch, SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import {
	applyNestedPatches,
	captureDeltaPatch,
	captureIsolationBaseline,
	cleanupIsolation,
	cleanupTaskBranches,
	type CommitToBranchResult,
	commitDeltaToBranch,
	commitToBranch,
	type DeltaPatchResult,
	diffIsolationStates,
	ensureIsolation,
	getRepoRoot,
	type IsolationHandle,
	type IsolationState,
	mergeTaskBranches,
	sameIsolationState,
	type WorktreeBaseline,
} from "./worktree";

import { cfgTaskIsolationCommits } from "./settings";

type IsoBackendKind = natives.IsoBackendKind;

/** Which isolation outcome `isolation-summary.md` should describe. */
export type IsolationSummaryKind =
	| "captured"
	| "capture-error"
	| "nested-apply-failed"
	| "not-applied"
	| "branch-merge-failed"
	| "branch-capture-failed"
	| "merge-error"
	| "follow-up-pending"
	| "capture-superseded";

/** Context for `isolation-summary.md`; unused fields are simply absent. */
export interface IsolationSummaryContext {
	kind: IsolationSummaryKind;
	branchName?: string;
	/** Root patch path, only when it holds changes. */
	rootPatchPath?: string;
	nestedCount?: number;
	nestedPatchPaths?: string[];
	error?: string;
	conflict?: string;
}

/**
 * Render one isolation outcome as the model-facing suffix appended to a task
 * result. Always starts with a blank line so it separates from the output it
 * follows.
 */
export function renderIsolationSummary(context: IsolationSummaryContext): string {
	return `\n\n${prompt.render(isolationSummaryTemplate, { ...context })}`;
}

/** Record artifact locations for `agent://` and mark the result as an isolated run. */
function rememberAgentArtifacts(result: SingleResult): SingleResult {
	AgentRegistry.global().setHistory(result.id, {
		outputPath: result.outputPath,
		patchPath: result.patchPath,
		branchName: result.branchName,
		nestedPatchPaths: result.nestedPatchPaths,
	});
	return { ...result, isolated: true };
}

/**
 * Decide the fate of a half-built task branch after apply-back threw.
 *
 * Returns the branch name when it carries at least one commit past `baseSha`
 * — the caller must keep it, because the isolation worktree that also held
 * those objects is about to be torn down. Returns `undefined` after deleting
 * a branch that is absent, empty, or still pinned at the baseline, preserving
 * the original stale-branch cleanup for the cases where nothing is at stake.
 *
 * `revList.range` throws when the branch does not exist, which is the common
 * "commitToBranch failed before it created anything" path; that is treated as
 * "nothing to rescue" only after confirming the ref is absent. Other probe
 * failures preserve the branch because deleting it could lose the only reachable
 * copy of the agent's commits.
 */
async function rescueTaskBranch(repoRoot: string, branchName: string, baseSha: string): Promise<string | undefined> {
	const repo = vcs.git(repoRoot);
	try {
		const carriedCommits = (await vcs.requireGit(repoRoot).revListRange(baseSha, branchName)).length;
		if (carriedCommits > 0) return branchName;
	} catch {
		try {
			if (await repo?.refExists(`refs/heads/${branchName}`)) return branchName;
		} catch {
			// An inconclusive recovery probe must never risk deleting the only ref.
			return branchName;
		}
	}
	try {
		await repo?.deleteBranch(branchName, true);
	} catch {
		// Best-effort cleanup matches the old façade's tryDelete semantics.
	}
	return undefined;
}

/** Resolved repo shared by every isolated spawn in a single call. */
export interface IsolationContext {
	repoRoot: string;
}

/**
 * Resolve the git repo root isolated spawns are copied from and merged back
 * into. Throws when the cwd is not inside a git repository; callers surface
 * the error as a task-tool failure. Each spawn captures its own baseline from
 * its isolation copy (see {@link captureIsolationBaseline}).
 */
export async function prepareIsolationContext(cwd: string): Promise<IsolationContext> {
	return { repoRoot: await getRepoRoot(cwd) };
}

/** Build a commit-message callback for branch/nested commits; `undefined` ⇒ fall back to generic message. */
export type BuildCommitMessage = () => undefined | ((diff: string) => Promise<string | null>);

/**
 * Construct the commit-message factory used by isolation branch commits and
 * nested-repo patch commits. Returns a closure that, each time it's called,
 * either yields an AI-backed `(diff) => Promise<string|null>` callback (when
 * `task.isolation.commits === "ai"` and a model registry is available) or
 * `undefined` so the caller falls back to a generic commit message.
 *
 * Centralized so `TaskTool` and the eval `agent()` bridge share one wiring;
 * a drift here previously meant the two callers built subtly different
 * generators for the same setting.
 */
export function makeIsolationCommitMessage(session: ToolSession): BuildCommitMessage {
	return () => {
		const style = cfgTaskIsolationCommits.get(session.settings);
		if (style !== "ai" || !session.modelRegistry) return undefined;
		const registry = session.modelRegistry;
		const settings = session.settings;
		const sessionId = session.getSessionId?.() ?? undefined;
		return async (diff: string) => generateCommitMessage(diff, registry, settings, sessionId);
	};
}

/**
 * How the caller lands a kept-alive isolated agent's follow-up turns (IRC
 * messages, user prompts), so their changes reach the parent the way the first
 * run's did instead of waiting in the workspace until release.
 */
export interface IsolationFollowUps {
	/**
	 * Settles once the caller is done with the first run's changes: `true`
	 * landed, `false` the landing was attempted and refused, `null` kept them
	 * without landing (`task.isolation.apply=false`). Follow-up captures wait
	 * for it, so they never race that landing.
	 */
	readonly firstRunLanded: Promise<boolean | null>;
	/**
	 * Land one follow-up turn's captured changes. `summary` is appended to that
	 * turn's result; `landed` reads like {@link firstRunLanded}. Work that did
	 * not land stays pending: the next capture carries it again, and after a
	 * refusal it is handed over again even if the workspace did not change, so
	 * clearing what blocked it lets the next turn land it. As for a first run,
	 * nested-repo patches that fail to apply after the root changes landed are
	 * reported in `summary` and not retried; each capture writes them to files
	 * of its own, so none is overwritten.
	 */
	land(captured: SingleResult): Promise<{ summary: string; landed: boolean | null }>;
}

export interface IsolatedRunOptions {
	/**
	 * Base run options handed to the subagent subprocess. This helper sets
	 * `worktree`, clears prepared/path extension preloads and custom-tool paths
	 * (isolated runs re-discover inside the worktree), and forwards everything
	 * else unchanged.
	 */
	baseOptions: ExecutorOptions;
	/** Context returned by {@link prepareIsolationContext}. */
	context: IsolationContext;
	/** PAL backend hint from `parseIsolationBackend(...)` (undefined ⇒ resolver picks). */
	preferredBackend: IsoBackendKind | undefined;
	/** Stable id used as the isolation worktree namespace and as the branch suffix. */
	agentId: string;
	/** Merge mode driving how changes are captured ("branch" commits, "patch" diffs). */
	mergeMode: "patch" | "branch";
	/** Output dir for `${agentId}.patch` artifacts (patch mode and branch-mode commit failures). */
	artifactsDir: string;
	/** Human description carried onto the branch commit (branch mode). */
	description?: string;
	/** Build a commit-message callback (`task.isolation.commits === "ai"`). */
	buildCommitMessage?: BuildCommitMessage;
	/**
	 * Construct a `SingleResult` when isolation setup throws — the caller has
	 * the full metadata (index, agent, assignment, modelOverride) needed to
	 * build a result shape consistent with their non-isolated path.
	 */
	buildFailureResult: (err: unknown) => SingleResult;
	/** Observe the real child result before post-run isolation work. */
	onSubprocessResult?: (result: SingleResult) => void;
	/** Lands follow-up turns of a kept-alive run; absent ⇒ their changes are captured only on release. */
	followUps?: IsolationFollowUps;
	/**
	 * Called when release is about to write the agent's remaining work into
	 * `artifactsDir`; the directory then holds that work and must outlive the
	 * agent.
	 */
	onReleaseArtifacts?: () => void;
}

/**
 * Write each nested-repo patch to `${artifactsDir}/${agentId}.nested-<n>-<path>.patch`
 * and return the paths. Throws on the first write failure: the caller must
 * then keep the isolation workspace alive, because it is the only other copy.
 * Every attempted destination is removed best-effort on failure — including
 * the in-progress file, which `Bun.write` may have created or truncated
 * before rejecting — so a half-written set cannot be mistaken for the
 * complete capture by the persisted-agent scanner.
 */
export async function persistNestedPatches(
	artifactsDir: string,
	agentId: string,
	nestedPatches: readonly NestedRepoPatch[],
): Promise<string[]> {
	const saved: string[] = [];
	try {
		for (const [index, nestedPatch] of nestedPatches.entries()) {
			const destination = path.join(
				artifactsDir,
				`${agentId}.nested-${index}-${nestedPatch.relativePath.replace(/[^a-zA-Z0-9._-]/g, "_") || "root"}.patch`,
			);
			// Track before writing: a mid-write failure (ENOSPC, quota) can
			// leave a truncated file behind, and `force: true` makes removing
			// a never-created path a no-op.
			saved.push(destination);
			await Bun.write(destination, nestedPatch.patch);
		}
	} catch (error) {
		await Promise.all(saved.map(file => fs.rm(file, { force: true }).catch(() => undefined)));
		throw error;
	}
	return saved;
}

interface IsolationPatchArtifacts {
	patchPath: string;
	hasRootChanges: boolean;
	nestedPatches: NestedRepoPatch[];
	nestedPatchPaths: string[];
}

interface IsolationPatchCapture {
	artifacts: IsolationPatchArtifacts;
	/** The capture the files were written from. */
	state: IsolationState;
}

/** One capture handed to the caller: its artifacts, the state it saw, and its task branch tip (branch mode). */
interface IsolationHandoff {
	artifacts: Partial<SingleResult>;
	state: IsolationState;
	tip: string | undefined;
}

/** Where every capture of `agentId` writes its root patch. */
function rootPatchPath(artifactsDir: string, agentId: string): string {
	return path.join(artifactsDir, `${agentId}.patch`);
}

/**
 * Write a captured delta to disk: the root patch, and one file per nested repo
 * named after `nestedPatchPrefix`. Throws when any write fails so nothing
 * captured is ever the only copy.
 */
async function writeDeltaPatches(
	delta: DeltaPatchResult,
	artifactsDir: string,
	agentId: string,
	nestedPatchPrefix: string,
): Promise<IsolationPatchArtifacts> {
	const patchPath = rootPatchPath(artifactsDir, agentId);
	await Bun.write(patchPath, delta.rootPatch);
	const nestedPatchPaths = await persistNestedPatches(artifactsDir, nestedPatchPrefix, delta.nestedPatches);
	return {
		patchPath,
		hasRootChanges: delta.rootPatch.trim().length > 0,
		nestedPatches: delta.nestedPatches,
		nestedPatchPaths,
	};
}

/**
 * Capture the isolation delta and write every part of it to disk before the
 * caller tears the workspace down (see {@link writeDeltaPatches}).
 */
async function writeIsolationPatch(
	isolationDir: string,
	baseline: WorktreeBaseline,
	artifactsDir: string,
	agentId: string,
): Promise<IsolationPatchCapture> {
	const delta = await captureDeltaPatch(isolationDir, baseline);
	return { artifacts: await writeDeltaPatches(delta, artifactsDir, agentId, agentId), state: delta.state };
}

/**
 * Move a retained isolation workspace out of its deterministic
 * (`repoRoot` + agent id) slot into a globally unique sibling, so a later
 * isolated run with the same id cannot wipe it: `ensureIsolation`
 * unconditionally removes the deterministic base dir before writing its
 * owner marker. The owner marker, `m` mount, and backend sidecar move along,
 * so `omp worktree clear` still classifies and reclaims the workspace with
 * native teardown. Backends needing it (mounts, Btrfs subvolumes) record the
 * sidecar BEFORE the move so it travels atomically — a crash between rename
 * and a later write would leave a mounted workspace with a dead owner and
 * no metadata, and cleanup would traverse the live mount.
 */
export interface RetainedWorkspace {
	/** Workspace path to report (unique sibling on success, original dir when the move fails). */
	dir: string;
	/**
	 * False when cleanup metadata is missing that `clear` would need: the
	 * sidecar could not be written (plausible under the same disk pressure
	 * that forced retention). The error must then say the mount needs a
	 * manual unmount instead of advertising plain `worktree clear`.
	 */
	sidecarOk: boolean;
}

export async function retainIsolationWorkspace(
	isolationDir: string,
	backend?: natives.IsoBackendKind,
): Promise<RetainedWorkspace> {
	const baseDir = path.dirname(isolationDir);
	const retainedBase = `${baseDir}.retained-${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 32).toString(16)}`;
	const needsSidecar = backend !== undefined && needsNativeTeardown(backend);
	let sidecarOk = !needsSidecar;
	if (needsSidecar && backend !== undefined) {
		try {
			await writeRetainedBackend(baseDir, backend);
			sidecarOk = true;
		} catch {
			sidecarOk = false;
		}
	}
	// A valid move can still fail transiently (Windows AV/indexer locks);
	// retry briefly before conceding the deterministic slot.
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await fs.rename(baseDir, retainedBase);
			return { dir: path.join(retainedBase, path.basename(isolationDir)), sidecarOk };
		} catch {
			if (attempt === 2) return { dir: isolationDir, sidecarOk };
			await Bun.sleep(25);
		}
	}
	return { dir: isolationDir, sidecarOk };
}
/** Context for `isolation-error.md`: the `result.error` text for a run whose changes could not be captured or landed. */
interface IsolationErrorContext {
	kind: "merge-failed" | "patch-capture-failed" | "nested-capture-failed";
	message: string;
	captureError?: string;
	rescueBranch?: string;
	/** Set when the workspace was kept because its changes could not be written out. */
	retainedDir?: string;
	/**
	 * Set when the retained mount's unmount metadata is missing: cleanup
	 * cannot unmount before removal, so the message must direct a manual
	 * unmount instead of advertising plain `worktree clear`.
	 */
	sidecarMissing?: boolean;
}

function renderIsolationError(context: IsolationErrorContext): string {
	return prompt.render(isolationErrorTemplate, { ...context });
}

/**
 * Run a subagent inside an isolation worktree and capture its changes.
 *
 * Branch mode: on success, commits the diff onto `omp/task/${agentId}` and
 * returns `branchName` + `nestedPatches` (+ `nestedPatchPaths`). On commit
 * failure the still-live isolation diff is written to
 * `${artifactsDir}/${agentId}.patch`, the task branch is kept when it already
 * carries commits (deleted otherwise), and `result.error` carries the
 * merge-failure message plus recovery hint.
 *
 * Patch mode: on success, writes `${artifactsDir}/${agentId}.patch` plus one
 * `${agentId}.nested-<n>-<path>.patch` per nested repo and returns
 * `patchPath` + `nestedPatches` + `nestedPatchPaths`.
 *
 * Failure paths preserve the underlying `SingleResult` whenever possible so
 * the caller can still surface the subagent's output; only isolation setup
 * itself routes through {@link IsolatedRunOptions.buildFailureResult}.
 *
 * Kept-alive runs retain the isolation handle through idle/parked lifecycle
 * transitions, then capture final changes and clean up on release. With
 * {@link IsolatedRunOptions.followUps}, each successful follow-up turn is also
 * captured as it ends and handed to the caller to land, relative to the last
 * landed state so landed work is never handed over twice. One-shot and failed
 * startup paths clean up in `finally`. If captured changes cannot be written
 * to disk, the workspace is retained under a unique `.retained-*` sibling and
 * its path is named in the resulting error.
 */
export async function runIsolatedSubprocess(opts: IsolatedRunOptions): Promise<SingleResult> {
	let taskBaseline: WorktreeBaseline | undefined;
	/** The last capture handed to the caller; a capture that matches it has nothing new. */
	let handedOff: IsolationState | undefined;
	/**
	 * The last capture the caller landed, and in branch mode the parent-repo
	 * commit holding it. Once set, captures carry only what changed since.
	 */
	let landed: { state: IsolationState; tip: string | undefined } | undefined;
	/** The last handed-off capture while the caller is still landing it. */
	let pending: { state: IsolationState; tip: string | undefined; landing: Promise<boolean | null> } | undefined;
	/** Set when the caller refused the last handoff, so the next capture hands it over again even if unchanged. */
	let retryRefused = false;
	// Settles once this function is done with the first run. Follow-up turns
	// wait for it, so they never capture before the first run's handoff.
	const firstRunDone = Promise.withResolvers<void>();
	/** Set while the first run's capture runs, so a release waits for it instead of tearing the workspace down. */
	let firstRunCapturing = false;
	// Follow-up captures and the release capture read and move the same
	// handoff state, so they run one at a time.
	let captureQueue: Promise<unknown> = Promise.resolve();
	const serialize = <T>(work: () => Promise<T>): Promise<T> => {
		const run = captureQueue.then(work);
		captureQueue = run.catch(() => undefined);
		return run;
	};
	let handle: IsolationHandle | undefined;
	let deferredCleanup: Promise<void> | undefined;
	let retainWorkspace = false;
	let baseReleasePromise: Promise<void> | undefined;
	let cleanupPromise: Promise<void> | undefined;
	let releasePromise: Promise<void> | undefined;
	const releaseBase = (): Promise<void> => {
		baseReleasePromise ??= opts.baseOptions.onRelease?.() ?? Promise.resolve();
		return baseReleasePromise;
	};
	const cleanupHandle = (): Promise<void> => {
		cleanupPromise ??= (async () => {
			await releaseBase();
			if (handle && !retainWorkspace) await cleanupIsolation(handle);
		})();
		return cleanupPromise;
	};
	/**
	 * Fold the pending handoff into {@link landed} once the caller reports it.
	 * Work the caller did not land stays out, so the next capture carries it
	 * again; after a refused landing, even an unchanged capture does.
	 */
	const settlePending = async (): Promise<void> => {
		const settled = pending;
		pending = undefined;
		if (!settled) return;
		const outcome = await settled.landing;
		retryRefused = outcome === false;
		if (outcome !== true) return;
		// A capture with no root changes made no branch: the previous tip still holds everything.
		landed = { state: settled.state, tip: settled.tip ?? landed?.tip };
	};
	/**
	 * Nested-repo patch file prefix for a capture after the first run's, so no
	 * capture overwrites another's files. The number stays inside `<id>.nested-`
	 * because the roster scanner only accepts that prefix.
	 */
	let laterCaptures = 0;
	const nextNestedPatchPrefix = (): string => `${opts.agentId}.nested-${++laterCaptures}`;
	/**
	 * Capture the workspace for the caller: the work since the last landed
	 * capture, or since the run began while nothing has landed. `"unchanged"`
	 * when nothing changed since the last handoff; `"superseded"` when the
	 * agent started another turn before the workspace was read, so the read may
	 * hold part of that turn's edits and nothing is recorded or written.
	 */
	const captureHandoff = async (
		isolationDir: string,
		baseline: WorktreeBaseline,
		commitMessage: ((diff: string) => Promise<string | null>) | undefined,
		superseded: () => boolean,
	): Promise<IsolationHandoff | "unchanged" | "superseded"> => {
		const current = await captureDeltaPatch(isolationDir, baseline);
		if (superseded()) return "superseded";
		if (!retryRefused && handedOff && sameIsolationState(handedOff, current.state)) return "unchanged";
		const delta = landed ? await diffIsolationStates(baseline, landed.state, current.state) : current;
		if (!delta.rootPatch.trim() && delta.nestedPatches.length === 0) {
			handedOff = current.state;
			retryRefused = false;
			return "unchanged";
		}
		if (opts.mergeMode === "patch") {
			const artifacts = await writeDeltaPatches(delta, opts.artifactsDir, opts.agentId, nextNestedPatchPrefix());
			handedOff = current.state;
			retryRefused = false;
			return { artifacts, state: current.state, tip: undefined };
		}
		// With nothing landed yet the branch carries the agent's own commits,
		// like the first run's; `commitToBranch` reads the workspace itself.
		const branch = landed
			? await commitDeltaToBranch(
					isolationDir,
					baseline,
					opts.agentId,
					landed.tip ?? baseline.root.headCommit,
					delta,
					landed.state.head,
					opts.description,
					commitMessage,
				)
			: await commitToBranch(isolationDir, baseline, opts.agentId, opts.description, commitMessage);
		// `commitToBranch` found nothing in its own read: hand nothing over and look again next turn.
		if (!branch) return "unchanged";
		// `commitToBranch` read the workspace again; a branch built from that read
		// is replaced by the next capture's.
		if (superseded()) return "superseded";
		const nestedPatchPaths = await persistNestedPatches(
			opts.artifactsDir,
			nextNestedPatchPrefix(),
			branch.nestedPatches,
		);
		handedOff = branch.state;
		retryRefused = false;
		return {
			artifacts: {
				branchName: branch.branchName,
				branchBaseSha: branch.baseSha,
				nestedPatches: branch.nestedPatches,
				nestedPatchPaths,
			},
			state: branch.state,
			tip: branch.headSha,
		};
	};
	/** Capture a finished follow-up turn, have the caller land it, and return the text for that turn's result. */
	const landFollowUpTurn = async (turn: SingleResult, superseded: () => boolean): Promise<string> => {
		const followUps = opts.followUps;
		if (!followUps || !handle || !taskBaseline || retainWorkspace || releasePromise) return "";
		// Like a failed first run, a failed turn hands nothing over; its work
		// rides along in the next capture.
		if (turn.exitCode !== 0 || turn.error !== undefined || turn.aborted) return "";
		await settlePending();
		let handoff: IsolationHandoff | "unchanged" | "superseded";
		try {
			handoff = await captureHandoff(handle.mergedDir, taskBaseline, opts.buildCommitMessage?.(), superseded);
		} catch (error) {
			// Name what release will write: patch files always, and the task
			// branch for root changes unless a patch-mode landing left nothing to
			// build it on.
			const patchOnly = landed !== undefined && opts.mergeMode === "patch";
			return renderIsolationSummary({
				kind: "follow-up-pending",
				error: error instanceof Error ? error.message : String(error),
				branchName: patchOnly ? undefined : `omp/task/${opts.agentId}`,
				rootPatchPath: rootPatchPath(opts.artifactsDir, opts.agentId),
			});
		}
		if (handoff === "unchanged") return "";
		// Its work rides along in the next capture, like a failed turn's.
		if (handoff === "superseded") return renderIsolationSummary({ kind: "capture-superseded" });
		const captured = rememberAgentArtifacts({ ...turn, ...handoff.artifacts });
		const landing = Promise.withResolvers<boolean | null>();
		pending = { state: handoff.state, tip: handoff.tip, landing: landing.promise };
		try {
			const outcome = await followUps.land(captured);
			landing.resolve(outcome.landed);
			return outcome.summary;
		} catch (error) {
			landing.resolve(false);
			return renderIsolationSummary({
				kind: "merge-error",
				error: error instanceof Error ? error.message : String(error),
				branchName: captured.branchName,
				rootPatchPath: captured.hasRootChanges === false ? undefined : captured.patchPath,
				nestedPatchPaths: captured.nestedPatchPaths,
			});
		}
	};
	const releaseIsolation = (): Promise<void> => {
		releasePromise ??= serialize(async () => {
			if (firstRunCapturing) await firstRunDone.promise;
			if (!handle || !taskBaseline || retainWorkspace) {
				await cleanupHandle();
				return;
			}
			try {
				await settlePending();
				let delta: DeltaPatchResult;
				try {
					const current = await captureDeltaPatch(handle.mergedDir, taskBaseline);
					// Nothing changed since the last capture the caller got: new
					// artifacts now would only duplicate that work. A refused
					// landing is the exception: its patch files are already the
					// only copy, and skipping the callback lets a no-session
					// lease delete them.
					if (handedOff && sameIsolationState(handedOff, current.state)) {
						if (retryRefused) opts.onReleaseArtifacts?.();
						return;
					}
					delta = landed ? await diffIsolationStates(taskBaseline, landed.state, current.state) : current;
					if (!delta.rootPatch.trim() && delta.nestedPatches.length === 0) {
						if (retryRefused) opts.onReleaseArtifacts?.();
						return;
					}
					opts.onReleaseArtifacts?.();
					const patchResult = await writeDeltaPatches(
						delta,
						opts.artifactsDir,
						opts.agentId,
						nextNestedPatchPrefix(),
					);
					AgentRegistry.global().setHistory(opts.agentId, {
						patchPath: patchResult.patchPath,
						nestedPatchPaths: patchResult.nestedPatchPaths,
					});
				} catch (captureErr) {
					retainWorkspace = true;
					const retained = await retainIsolationWorkspace(handle.mergedDir, handle.backend);
					throw new Error(
						renderIsolationError({
							kind: "patch-capture-failed",
							message: captureErr instanceof Error ? captureErr.message : String(captureErr),
							retainedDir: retained.dir,
							sidecarMissing: !retained.sidecarOk,
						}),
					);
				}
				// Patch mode landed as uncommitted edits, with no commit to build on,
				// and a branch from the run's start would repeat them: the delta patch
				// above is the artifact. Branch mode lands on the last landed commit.
				if (landed && opts.mergeMode === "patch") return;
				const commitResult = landed
					? await commitDeltaToBranch(
							handle.mergedDir,
							taskBaseline,
							opts.agentId,
							landed.tip ?? taskBaseline.root.headCommit,
							delta,
							landed.state.head,
							opts.description,
						)
					: await commitToBranch(handle.mergedDir, taskBaseline, opts.agentId, opts.description, undefined);
				AgentRegistry.global().setHistory(opts.agentId, { branchName: commitResult?.branchName });
			} finally {
				await cleanupHandle();
			}
		});
		return releasePromise;
	};
	/**
	 * Turns the agent has started since its first run ended. A turn that
	 * starts before the first run's capture finishes may be read into it.
	 */
	let turnsStartedSinceRun = 0;
	/**
	 * The first run's result when one of the agent's turns overlapped its
	 * capture: the capture could hold part of that turn, whose result has not
	 * reached the caller, so nothing is handed over and no handoff is recorded.
	 * The next capture carries everything since the run began.
	 */
	const supersededFirstRun = (result: SingleResult): SingleResult =>
		rememberAgentArtifacts({ ...result, isolationCaptureSuperseded: true });
	/** Record the first run's capture for follow-ups and release. */
	const recordFirstRunHandoff = (state: IsolationState, tip: string | undefined): void => {
		handedOff = state;
		const followUps = opts.followUps;
		if (followUps && opts.baseOptions.keepAlive !== false && AgentLifecycleManager.global().has(opts.agentId)) {
			pending = { state, tip, landing: followUps.firstRunLanded };
		}
	};
	try {
		handle = await ensureIsolation(opts.context.repoRoot, opts.agentId, opts.preferredBackend);
		const isolationDir = handle.mergedDir;
		const isolationBackend = handle.backend;
		const baseline = await captureIsolationBaseline(isolationDir, opts.context.repoRoot);
		taskBaseline = baseline;
		const result = await runSubprocess({
			...opts.baseOptions,
			worktree: isolationDir,
			preloadedExtensionPaths: undefined,
			preloadedPreparedExtensions: undefined,
			preloadedCustomToolPaths: undefined,
			onCleanupDeferred: completion => {
				deferredCleanup = completion;
				opts.baseOptions.onCleanupDeferred?.(completion);
			},
			// One-shot runs get `releaseBase` (never touches the worktree): their
			// `finalizeSubagentLifecycle` calls `onRelease` before this function's
			// post-run capture, so the handle must survive until the `finally`
			// below cleans it up. Only kept-alive runs hand full capture+cleanup
			// (`releaseIsolation`) to the agent lifecycle.
			onRelease: opts.baseOptions.keepAlive === false ? releaseBase : releaseIsolation,
			onFollowUpTurnSettled:
				opts.followUps && opts.baseOptions.keepAlive !== false
					? async (turn, superseded) => {
							// Wait outside the queue: the lifecycle may release this agent
							// from inside `runSubprocess`, and that release must not queue
							// behind a turn waiting for this function to finish.
							await firstRunDone.promise;
							return serialize(() => landFollowUpTurn(turn, superseded));
						}
					: undefined,
			onFollowUpTurnStarted:
				opts.followUps && opts.baseOptions.keepAlive !== false
					? () => {
							turnsStartedSinceRun += 1;
						}
					: undefined,
		});
		firstRunCapturing = true;
		opts.onSubprocessResult?.(result);
		// A successful result cannot be captured while deferred owner jobs or
		// shutdown hooks may still write the worktree. Failed runs skip capture,
		// so their cleanup remains asynchronous.
		if (deferredCleanup && result.exitCode === 0) {
			await deferredCleanup;
		}
		if (opts.mergeMode === "branch" && result.exitCode === 0) {
			let commitResult: CommitToBranchResult | null;
			try {
				commitResult = await commitToBranch(
					isolationDir,
					baseline,
					opts.agentId,
					opts.description,
					opts.buildCommitMessage?.(),
				);
			} catch (mergeErr) {
				// Agent succeeded but the branch commit failed. `commitToBranch`
				// is not atomic: the clean-baseline path fetches the agent's
				// commits into the parent ODB and creates `omp/task/<id>` before
				// it commits the leftover working-tree delta, so a throw from
				// that trailing step leaves behind a branch that already holds
				// every commit the agent made. The isolation worktree — the only
				// other copy of those objects — is destroyed by the `finally`
				// below, so deleting the branch unconditionally turned a
				// recoverable merge conflict into permanent loss of committed
				// work (#8868). Delete only when nothing is at stake.
				const baseSha = baseline.root.headCommit;
				const branchName = `omp/task/${opts.agentId}`;
				const rescueBranch = await rescueTaskBranch(opts.context.repoRoot, branchName, baseSha);
				const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
				try {
					const capture = await writeIsolationPatch(isolationDir, baseline, opts.artifactsDir, opts.agentId);
					return rememberAgentArtifacts({
						...result,
						...capture.artifacts,
						isolationCaptureFailed: true,
						error: renderIsolationError({ kind: "merge-failed", message: msg, rescueBranch }),
					});
				} catch (patchErr) {
					retainWorkspace = true;
					const retained = await retainIsolationWorkspace(isolationDir, isolationBackend);
					return rememberAgentArtifacts({
						...result,
						isolationCaptureFailed: true,
						error: renderIsolationError({
							kind: "merge-failed",
							message: msg,
							captureError: patchErr instanceof Error ? patchErr.message : String(patchErr),
							rescueBranch,
							retainedDir: retained.dir,
							sidecarMissing: !retained.sidecarOk,
						}),
					});
				}
			}
			if (turnsStartedSinceRun > 0) {
				// Later captures recreate the branch; one built from this read must not be landed.
				if (commitResult?.branchName) {
					await vcs
						.requireGit(opts.context.repoRoot)
						.deleteBranch(commitResult.branchName, true)
						.catch(error => {
							logger.warn("Could not delete a superseded task branch", {
								branch: commitResult?.branchName,
								error: error instanceof Error ? error.message : String(error),
							});
						});
				}
				return supersededFirstRun(result);
			}
			if (commitResult) recordFirstRunHandoff(commitResult.state, commitResult.headSha);
			// The branch holds the root-repo work, but nested-repo patches exist
			// only in memory until written; the workspace goes away in `finally`.
			try {
				const nestedPatchPaths = await persistNestedPatches(
					opts.artifactsDir,
					opts.agentId,
					commitResult?.nestedPatches ?? [],
				);
				return rememberAgentArtifacts({
					...result,
					branchName: commitResult?.branchName,
					branchBaseSha: commitResult?.baseSha,
					nestedPatches: commitResult?.nestedPatches,
					nestedPatchPaths,
				});
			} catch (persistErr) {
				retainWorkspace = true;
				const retained = await retainIsolationWorkspace(isolationDir, isolationBackend);
				return rememberAgentArtifacts({
					...result,
					isolationCaptureFailed: true,
					branchName: commitResult?.branchName,
					branchBaseSha: commitResult?.baseSha,
					nestedPatches: commitResult?.nestedPatches,
					error: renderIsolationError({
						kind: "nested-capture-failed",
						message: persistErr instanceof Error ? persistErr.message : String(persistErr),
						retainedDir: retained.dir,
						sidecarMissing: !retained.sidecarOk,
					}),
				});
			}
		}
		if (result.exitCode === 0) {
			try {
				const capture = await writeIsolationPatch(isolationDir, baseline, opts.artifactsDir, opts.agentId);
				if (turnsStartedSinceRun > 0) {
					// The next capture writes its own patch files; these must not be applied.
					const { patchPath, nestedPatchPaths } = capture.artifacts;
					await Promise.all([patchPath, ...nestedPatchPaths].map(file => fs.rm(file, { force: true })));
					return supersededFirstRun(result);
				}
				recordFirstRunHandoff(capture.state, undefined);
				return rememberAgentArtifacts({ ...result, ...capture.artifacts });
			} catch (patchErr) {
				retainWorkspace = true;
				const retained = await retainIsolationWorkspace(isolationDir, isolationBackend);
				return rememberAgentArtifacts({
					...result,
					isolationCaptureFailed: true,
					error: renderIsolationError({
						kind: "patch-capture-failed",
						message: patchErr instanceof Error ? patchErr.message : String(patchErr),
						retainedDir: retained.dir,
						sidecarMissing: !retained.sidecarOk,
					}),
				});
			}
		}
		return rememberAgentArtifacts(result);
	} catch (err) {
		return rememberAgentArtifacts(opts.buildFailureResult(err));
	} finally {
		firstRunDone.resolve();
		if (
			handle &&
			!retainWorkspace &&
			!releasePromise &&
			!(opts.baseOptions.keepAlive !== false && AgentLifecycleManager.global().has(opts.agentId))
		) {
			if (deferredCleanup) {
				trackLateCleanup(deferredCleanup.then(cleanupHandle), {
					agentId: opts.agentId,
					resource: "isolation",
				});
			} else {
				await cleanupHandle();
			}
		}
	}
}

export interface IsolationMergeOptions {
	result: SingleResult;
	repoRoot: string;
	mergeMode: "patch" | "branch";
}

export interface IsolationMergeOutcome {
	/** Trailing summary appended to the subagent's result text. May be empty. */
	summary: string;
	/**
	 * Tri-state apply outcome:
	 * - `true`  — merge ran (or had nothing to apply) and left the repo clean.
	 * - `false` — merge attempted and failed; artifacts are preserved.
	 * - `null`  — caller skipped the merge phase entirely (e.g. `apply=false`).
	 */
	changesApplied: boolean | null;
	hadAnyChanges: boolean;
	/** True iff the root branch actually merged — gates nested-repo patch application. */
	mergedBranchForNestedPatches: boolean;
}

/**
 * Apply changes captured by {@link runIsolatedSubprocess} back to the parent
 * repo: patch apply (patch mode) or cherry-pick + cleanup (branch mode).
 *
 * The caller decides whether to run this at all — eval `agent()` with
 * `apply=False` skips this step and surfaces the patch artifact / branch name
 * instead.
 */
export async function mergeIsolatedChanges(opts: IsolationMergeOptions): Promise<IsolationMergeOutcome> {
	const { result, repoRoot, mergeMode } = opts;
	const repo = vcs.requireGit(repoRoot);
	try {
		if (mergeMode === "branch") {
			if (!result.branchName && result.exitCode === 0 && !result.aborted && result.error) {
				return {
					summary: renderIsolationSummary({
						kind: "branch-capture-failed",
						error: result.error,
						rootPatchPath: result.patchPath,
						nestedPatchPaths: result.nestedPatchPaths,
					}),
					changesApplied: false,
					hadAnyChanges: false,
					mergedBranchForNestedPatches: false,
				};
			}
			const canApplyNestedOnly =
				!result.branchName && result.exitCode === 0 && !result.aborted && (result.nestedPatches?.length ?? 0) > 0;
			if (!result.branchName || result.exitCode !== 0 || result.aborted) {
				return {
					summary: canApplyNestedOnly
						? "\n\nNo root changes to apply; nested repository patches captured."
						: "\n\nNo changes to apply.",
					changesApplied: true,
					hadAnyChanges: canApplyNestedOnly,
					mergedBranchForNestedPatches: canApplyNestedOnly,
				};
			}
			const mergeResult = await mergeTaskBranches(repoRoot, [
				{
					branchName: result.branchName,
					taskId: result.id,
					description: result.description,
					baseSha: result.branchBaseSha,
				},
			]);
			const mergedBranchForNestedPatches = mergeResult.merged.includes(result.branchName);
			const changesApplied = mergeResult.failed.length === 0;
			const hadAnyChanges = changesApplied && mergeResult.merged.length > 0;

			let summary: string;
			if (changesApplied) {
				summary = hadAnyChanges ? `\n\nMerged branch: ${result.branchName}` : "\n\nNo changes to apply.";
			} else {
				// The nested patches are skipped when the branch did not merge; name
				// their files so the parent can recover them alongside the branch.
				summary = renderIsolationSummary({
					kind: "branch-merge-failed",
					branchName: result.branchName,
					conflict: mergeResult.conflict,
					nestedPatchPaths: result.nestedPatchPaths,
				});
			}

			// Clean up the merged branch (keep failed ones for manual resolution)
			if (changesApplied) {
				await cleanupTaskBranches(repoRoot, [result.branchName]);
			}
			return { summary, changesApplied, hadAnyChanges, mergedBranchForNestedPatches };
		}

		// Patch mode: apply the patch from a successful run. A failed or
		// aborted run has nothing to apply and must not block the result.
		let changesApplied: boolean;
		let hadAnyChanges: boolean;
		const succeeded = result.exitCode === 0 && !result.error && !result.aborted;
		if (!succeeded) {
			changesApplied = true;
			hadAnyChanges = false;
		} else if (!result.patchPath) {
			changesApplied = false;
			hadAnyChanges = false;
		} else {
			const patchText = await Bun.file(result.patchPath).text();
			if (!patchText.trim()) {
				changesApplied = true;
				hadAnyChanges = false;
			} else {
				const normalized = patchText.endsWith("\n") ? patchText : `${patchText}\n`;
				// Idempotence: declare a no-op only when the reverse patch applies AND
				// the forward patch does not. `--reverse --check` alone can theoretically
				// succeed if the file happens to carry the postimage at another location
				// via git-apply's fuzz factor; requiring the forward check to fail
				// removes that ambiguity while still catching true already-applied
				// runs. Reads only — neither call touches the worktree, unlike
				// `--3way --check`, which exits 0 even when the real apply would
				// leave conflict markers and unmerged index entries.
				const [alreadyApplied, forwardApplies] = await Promise.all([
					repo.canApplyPatch(normalized, { reverse: true }).catch(() => false),
					repo.canApplyPatch(normalized, {}).catch(() => false),
				]);
				hadAnyChanges = false;
				if (alreadyApplied && !forwardApplies) {
					changesApplied = true;
				} else if (forwardApplies) {
					changesApplied = true;
					try {
						await repo.applyPatch(normalized, {});
						hadAnyChanges = true;
					} catch {
						changesApplied = false;
					}
				} else {
					changesApplied = false;
				}
			}
		}

		let summary: string;
		if (changesApplied) {
			summary = hadAnyChanges ? "\n\nApplied patches: yes" : "\n\nNo changes to apply.";
		} else {
			// Nested apply is skipped when the root patch did not apply; the
			// persisted nested patches are the parent's only pointer to that work.
			summary = renderIsolationSummary({
				kind: "not-applied",
				rootPatchPath: result.patchPath,
				nestedPatchPaths: result.nestedPatchPaths,
			});
		}
		return { summary, changesApplied, hadAnyChanges, mergedBranchForNestedPatches: false };
	} catch (mergeErr) {
		return {
			summary: renderIsolationSummary({
				kind: "merge-error",
				error: mergeErr instanceof Error ? mergeErr.message : String(mergeErr),
				branchName: result.branchName,
				rootPatchPath: result.patchPath,
				nestedPatchPaths: result.nestedPatchPaths,
			}),
			changesApplied: false,
			hadAnyChanges: false,
			mergedBranchForNestedPatches: false,
		};
	}
}

export interface NestedPatchApplyOptions {
	/** Subagent result carrying `nestedPatches`/`exitCode`/`aborted`. */
	result: SingleResult;
	repoRoot: string;
	mergeMode: "patch" | "branch";
	/** Parent merge outcome — patch mode skips nested apply when this is `false`. */
	changesApplied: boolean | null;
	/** Branch mode gates nested apply on whether the root branch merged. */
	mergedBranchForNestedPatches: boolean;
	/** Optional AI commit-message callback for nested commits; falls back to a generic message. */
	commitMessage?: (diff: string) => Promise<string | null>;
}

/**
 * Apply nested-repo patches after the parent merge phase. Centralizes the
 * three-way gate (exitCode/aborted, patch-mode failed parent, branch-mode
 * branch-merged) and the non-fatal failure handling so `TaskTool` and the
 * eval `agent()` bridge use one implementation.
 *
 * Returns a system-notification suffix to append to the parent merge summary,
 * or an empty string when nothing was applied or the nested apply succeeded.
 */
export async function applyEligibleNestedPatches(opts: NestedPatchApplyOptions): Promise<string> {
	const { result, repoRoot, mergeMode, changesApplied, mergedBranchForNestedPatches, commitMessage } = opts;
	if (mergeMode === "patch" && changesApplied === false) return "";
	const nestedPatches = result.nestedPatches ?? [];
	const eligible =
		nestedPatches.length > 0 &&
		result.exitCode === 0 &&
		!result.aborted &&
		(mergeMode !== "branch" || mergedBranchForNestedPatches);
	if (!eligible) return "";
	try {
		const warnings = await applyNestedPatches(repoRoot, nestedPatches, commitMessage);
		if (warnings.length === 0) return "";
		return `\n\n<system-notification>${warnings.join("\n")}</system-notification>`;
	} catch (applyErr) {
		// Nested patch failures are non-fatal to the parent merge, but the patch
		// files are the only surviving copy of that work — name them.
		return renderIsolationSummary({
			kind: "nested-apply-failed",
			error: applyErr instanceof Error ? applyErr.message : String(applyErr),
			nestedPatchPaths: result.nestedPatchPaths,
		});
	}
}
