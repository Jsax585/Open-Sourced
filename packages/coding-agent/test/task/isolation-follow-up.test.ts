import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	type IsolationFollowUps,
	mergeIsolatedChanges,
	runIsolatedSubprocess,
} from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

async function git(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args.join(" ")} exited ${exitCode}`);
	return stdout.trim();
}

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function configureIdentity(repo: string): Promise<void> {
	await git(repo, ["config", "user.email", "test@example.com"]);
	await git(repo, ["config", "user.name", "Test User"]);
	await git(repo, ["config", "core.autocrlf", "false"]);
}

/** A parent repo holding `a.txt`, and an isolation cloned from it with its own object store. */
async function createRepoAndIsolation(): Promise<{ repo: string; iso: string; baseSha: string }> {
	const repo = await tempDir("omp-follow-up-repo-");
	await git(repo, ["init", "-q", "-b", "main"]);
	await configureIdentity(repo);
	await Bun.write(path.join(repo, "a.txt"), "zero\n");
	await git(repo, ["add", "a.txt"]);
	await git(repo, ["commit", "-q", "-m", "base"]);
	const iso = path.join(await tempDir("omp-follow-up-iso-"), "work");
	await git(path.dirname(iso), ["clone", "-q", repo, iso]);
	await configureIdentity(iso);
	return { repo, iso, baseSha: await git(repo, ["rev-parse", "HEAD"]) };
}

/**
 * Add a nested git repository `sub/` holding `n.txt`, in the parent and cloned
 * into the isolation. Every commit exists once, in the parent, and the isolation
 * only fetches it. A capture reads the isolation's HEAD from the parent's
 * object store, so a second commit made there would be a different object
 * whenever the two commits straddle a second boundary: identical content and
 * message still hash differently with a different timestamp.
 */
async function addNestedRepo(repo: string, iso: string): Promise<void> {
	const parentNested = path.join(repo, "sub");
	await fs.mkdir(parentNested);
	await git(parentNested, ["init", "-q", "-b", "main"]);
	await configureIdentity(parentNested);
	await Bun.write(path.join(parentNested, "n.txt"), "n0\n");
	await git(parentNested, ["add", "n.txt"]);
	await git(parentNested, ["commit", "-q", "-m", "nested"]);
	await Bun.write(path.join(repo, ".gitignore"), "sub/\n");
	await git(repo, ["add", ".gitignore"]);
	await git(repo, ["commit", "-q", "-m", "ignore nested"]);
	await git(iso, ["pull", "-q", "--ff-only"]);
	await git(iso, ["clone", "-q", parentNested, "sub"]);
}

function result(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "Do work",
		assignment: "Do work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

interface KeptAliveRun {
	first: SingleResult;
	/** The hook the runner handed the executor for follow-up turns; by default no later turn has started. */
	settleFollowUp: ((turn: SingleResult, superseded?: () => boolean) => Promise<string>) | undefined;
	/** Where the runner writes the agent's patch files. */
	artifactsDir: string;
}

/**
 * Run a kept-alive isolated agent whose first run performs `firstRun` inside
 * the isolation, without a real model behind it.
 */
async function runKeptAlive(opts: {
	id: string;
	repo: string;
	iso: string;
	mergeMode: "patch" | "branch";
	followUps: IsolationFollowUps;
	firstRun: () => Promise<void>;
	/**
	 * Runs once the agent is idle and before the runner captures the first
	 * run. `turnStarted` is the hook the executor calls when a turn starts.
	 * `release` is the runner's own onRelease, not the lifecycle wrapper.
	 */
	afterRun?: (turnStarted: (() => void) | undefined, release: (() => Promise<void>) | undefined) => Promise<void>;
	onReleaseArtifacts?: () => void;
	/** When set, release actually removes the isolation instead of the default no-op. */
	deleteIsolationOnCleanup?: boolean;
	onCleanupStarted?: () => void;
}): Promise<KeptAliveRun> {
	const artifactsDir = await tempDir("omp-follow-up-artifacts-");
	vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
		mergedDir: opts.iso,
		backend: natives.IsoBackendKind.Rcopy,
		fellBack: false,
		fallbackReason: null,
	});
	vi.spyOn(worktreeModule, "cleanupIsolation").mockImplementation(async () => {
		opts.onCleanupStarted?.();
		if (opts.deleteIsolationOnCleanup) await fs.rm(opts.iso, { recursive: true, force: true });
	});
	const session = {
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		dispose: async () => {},
	} as unknown as AgentSession;
	let settleFollowUp: KeptAliveRun["settleFollowUp"];
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		await opts.firstRun();
		const hook = options.onFollowUpTurnSettled;
		settleFollowUp = hook && ((turn, superseded = () => false) => hook(turn, superseded));
		AgentRegistry.global().register({
			id: options.id,
			displayName: options.id,
			kind: "sub",
			session,
			sessionFile: path.join(artifactsDir, `${options.id}.jsonl`),
			status: "running",
		});
		await executorModule.finalizeSubagentLifecycle({
			id: options.id,
			session,
			aborted: false,
			keepAlive: true,
			isolated: true,
			agentIdleTtlMs: 0,
			reviveSession: async () => session,
			onRelease: options.onRelease,
			onAdopted: options.onAdopted,
		});
		await opts.afterRun?.(options.onFollowUpTurnStarted, options.onRelease);
		return result(options.id);
	});
	const first = await runIsolatedSubprocess({
		baseOptions: {
			cwd: opts.repo,
			agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
			task: "Do work",
			index: 0,
			id: opts.id,
		},
		context: { repoRoot: opts.repo },
		preferredBackend: undefined,
		agentId: opts.id,
		mergeMode: opts.mergeMode,
		artifactsDir,
		followUps: opts.followUps,
		buildFailureResult: error => ({ ...result(opts.id), exitCode: 1, error: String(error) }),
		onReleaseArtifacts: opts.onReleaseArtifacts,
	});
	return { first, settleFollowUp, artifactsDir };
}

/** Lands captured changes the way the task tool does; `firstRun` reports the first run's landing. */
function landingFollowUps(repo: string, mergeMode: "patch" | "branch") {
	const firstRun = Promise.withResolvers<boolean | null>();
	const followUps: IsolationFollowUps = {
		firstRunLanded: firstRun.promise,
		land: async captured => {
			const outcome = await mergeIsolatedChanges({ result: captured, repoRoot: repo, mergeMode });
			return { summary: outcome.summary, landed: outcome.changesApplied };
		},
	};
	return { firstRun, followUps };
}

async function commitIn(iso: string, content: string, message: string, ...flags: string[]): Promise<void> {
	await Bun.write(path.join(iso, "a.txt"), content);
	await git(iso, ["commit", "-q", "-a", ...flags, "-m", message]);
}

async function taskBranches(repo: string): Promise<string> {
	return git(repo, ["branch", "--list", "omp/task/*"]);
}

describe("isolated agent follow-up turns", () => {
	it("lands a follow-up commit in the parent and leaves no task branch behind", async () => {
		const { repo, iso, baseSha } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "branch");
		const run = await runKeptAlive({
			id: "FollowUpBranch",
			repo,
			iso,
			mergeMode: "branch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		const firstLanding = await mergeIsolatedChanges({ result: run.first, repoRoot: repo, mergeMode: "branch" });
		firstRun.resolve(firstLanding.changesApplied === true);
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("one\n");

		await commitIn(iso, "two\n", "review fix");
		const summary = await run.settleFollowUp?.(result("FollowUpBranch"));

		expect(summary).toContain("Merged branch");
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("two\n");
		expect(await git(repo, ["log", "--format=%s", `${baseSha}..HEAD`])).toBe("review fix\nfirst run");
		expect(await taskBranches(repo)).toBe("");

		// A turn that changed nothing reports nothing and leaves the parent alone.
		expect(await run.settleFollowUp?.(result("FollowUpBranch"))).toBe("");

		await AgentLifecycleManager.global().release("FollowUpBranch");
		expect(await taskBranches(repo)).toBe("");
		expect(await git(repo, ["status", "--porcelain"])).toBe("");
	});

	it("lands nothing from a turn whose capture overlapped the agent's next turn", async () => {
		const { repo, iso, baseSha } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "branch");
		const run = await runKeptAlive({
			id: "FollowUpSuperseded",
			repo,
			iso,
			mergeMode: "branch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		const firstLanding = await mergeIsolatedChanges({ result: run.first, repoRoot: repo, mergeMode: "branch" });
		firstRun.resolve(firstLanding.changesApplied === true);
		await commitIn(iso, "two\n", "review fix");
		// The agent's next turn starts while this turn's workspace is being read.
		let nextTurnStarted = false;
		const capture = worktreeModule.captureDeltaPatch;
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockImplementationOnce(async (dir, baseline) => {
			const captured = await capture(dir, baseline);
			nextTurnStarted = true;
			return captured;
		});

		const summary = await run.settleFollowUp?.(result("FollowUpSuperseded"), () => nextTurnStarted);

		expect(summary).toContain("the agent started another turn before the capture finished");
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("one\n");
		expect(await taskBranches(repo)).toBe("");
		// The next turn's capture carries both turns' work.
		await commitIn(iso, "three\n", "next turn");
		expect(await run.settleFollowUp?.(result("FollowUpSuperseded"))).toContain("Merged branch");
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("three\n");
		expect(await git(repo, ["log", "-1", "--format=%B", "HEAD"])).toBe("review fix\n\nnext turn");
		expect(await git(repo, ["rev-list", "--count", `${baseSha}..HEAD`])).toBe("2");
		await AgentLifecycleManager.global().release("FollowUpSuperseded");
	});

	for (const [mergeMode, landedSummary] of [
		["branch", "Merged branch"],
		["patch", "Applied patches: yes"],
	] as const) {
		it(`hands over nothing from a first run whose capture a turn overlapped, in ${mergeMode} mode`, async () => {
			const { repo, iso } = await createRepoAndIsolation();
			const { firstRun, followUps } = landingFollowUps(repo, mergeMode);
			const id = `FirstRunOverlapped-${mergeMode}`;
			const run = await runKeptAlive({
				id,
				repo,
				iso,
				mergeMode,
				followUps,
				firstRun: () => commitIn(iso, "one\n", "first run"),
				// A message wakes the agent as soon as it is idle; its turn edits the workspace.
				afterRun: async turnStarted => {
					turnStarted?.();
					await commitIn(iso, "two\n", "review fix");
				},
			});

			// The capture may hold part of that turn, whose result has not reached the parent.
			expect(run.first.isolationCaptureSuperseded).toBe(true);
			expect(run.first.branchName).toBeUndefined();
			expect(run.first.patchPath).toBeUndefined();
			expect(await taskBranches(repo)).toBe("");
			// As the task tool reports it: nothing was handed over, so no landing was attempted.
			firstRun.resolve(null);
			expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("zero\n");

			// Both runs' work lands with the turn's result.
			expect(await run.settleFollowUp?.(result(id))).toContain(landedSummary);
			expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("two\n");
			await AgentLifecycleManager.global().release(id);
			expect(await taskBranches(repo)).toBe("");
		});
	}

	it("holds a follow-up that ends before the first run has landed until it has", async () => {
		const { repo, iso, baseSha } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "branch");
		const events: string[] = [];
		// A thenable rather than a promise: `await` calls its `then`, which
		// tells the test the follow-up has started waiting on the first run.
		const waitedOn = Promise.withResolvers<void>();
		const firstRunLanded = {
			// oxlint-disable-next-line unicorn/no-thenable -- the await on it is the signal under test
			then: (onLanded: (landed: boolean | null) => unknown, onFailed?: (reason: unknown) => unknown) => {
				waitedOn.resolve();
				return firstRun.promise.then(onLanded, onFailed);
			},
		} as unknown as Promise<boolean | null>;
		const run = await runKeptAlive({
			id: "FollowUpEarly",
			repo,
			iso,
			mergeMode: "branch",
			followUps: {
				firstRunLanded,
				land: captured => {
					events.push("follow-up landed");
					return followUps.land(captured);
				},
			},
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		await commitIn(iso, "two\n", "review fix");
		const followUp = run.settleFollowUp?.(result("FollowUpEarly"));
		// Either the follow-up waits for the first run, or it finishes on its own.
		await Promise.race([waitedOn.promise, followUp]);

		const firstLanding = await mergeIsolatedChanges({ result: run.first, repoRoot: repo, mergeMode: "branch" });
		expect(firstLanding.changesApplied).toBe(true);
		events.push("first run landed");
		firstRun.resolve(true);

		expect(await followUp).toContain("Merged branch");
		expect(events).toEqual(["first run landed", "follow-up landed"]);
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("two\n");
		expect(await git(repo, ["log", "--format=%s", `${baseSha}..HEAD`])).toBe("review fix\nfirst run");
		await AgentLifecycleManager.global().release("FollowUpEarly");
		expect(await taskBranches(repo)).toBe("");
	});

	it("lands only the new work when the first run left its change uncommitted", async () => {
		const { repo, iso, baseSha } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "branch");
		const run = await runKeptAlive({
			id: "FollowUpLeftover",
			repo,
			iso,
			mergeMode: "branch",
			followUps,
			firstRun: () => Bun.write(path.join(iso, "a.txt"), "one\n").then(() => undefined),
		});
		const firstLanding = await mergeIsolatedChanges({ result: run.first, repoRoot: repo, mergeMode: "branch" });
		firstRun.resolve(firstLanding.changesApplied === true);

		// The agent now commits work the parent already received uncommitted.
		await commitIn(iso, "two\n", "review fix");
		const summary = await run.settleFollowUp?.(result("FollowUpLeftover"));

		expect(summary).toContain("Merged branch");
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("two\n");
		expect(await git(repo, ["rev-list", "--count", `${baseSha}..HEAD`])).toBe("2");
		expect(await git(repo, ["log", "-1", "--format=%s"])).toBe("review fix");
		await AgentLifecycleManager.global().release("FollowUpLeftover");
		expect(await taskBranches(repo)).toBe("");
	});

	it("lands a follow-up that amends the commit the parent already has", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "branch");
		const run = await runKeptAlive({
			id: "FollowUpAmend",
			repo,
			iso,
			mergeMode: "branch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		const firstLanding = await mergeIsolatedChanges({ result: run.first, repoRoot: repo, mergeMode: "branch" });
		firstRun.resolve(firstLanding.changesApplied === true);

		await commitIn(iso, "two\n", "first run, fixed", "--amend");
		const summary = await run.settleFollowUp?.(result("FollowUpAmend"));

		expect(summary).toContain("Merged branch");
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("two\n");
		expect(await git(repo, ["log", "-1", "--format=%s"])).toBe("first run, fixed");
		await AgentLifecycleManager.global().release("FollowUpAmend");
		expect(await taskBranches(repo)).toBe("");
	});

	it("applies a follow-up patch on top of the first run's applied patch", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "patch");
		const run = await runKeptAlive({
			id: "FollowUpPatch",
			repo,
			iso,
			mergeMode: "patch",
			followUps,
			// The agent commits inside isolation: that commit exists only in the isolation's object store.
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		const firstLanding = await mergeIsolatedChanges({ result: run.first, repoRoot: repo, mergeMode: "patch" });
		firstRun.resolve(firstLanding.changesApplied === true);
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("one\n");

		await commitIn(iso, "two\n", "review fix");
		const summary = await run.settleFollowUp?.(result("FollowUpPatch"));

		expect(summary).toContain("Applied patches: yes");
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("two\n");
		// A turn that changed nothing leaves the applied patch artifact as it was.
		expect(await run.settleFollowUp?.(result("FollowUpPatch"))).toBe("");
		expect(await Bun.file(run.first.patchPath ?? "").text()).toContain("+two");
		await AgentLifecycleManager.global().release("FollowUpPatch");
	});

	it("keeps unlanded first-run work in every later capture", async () => {
		const { repo, iso, baseSha } = await createRepoAndIsolation();
		// apply=false: nothing lands, so each capture must carry all work since the run began.
		const handedOver: SingleResult[] = [];
		const followUps: IsolationFollowUps = {
			firstRunLanded: Promise.resolve(null),
			land: async captured => {
				handedOver.push(captured);
				return { summary: "captured", landed: null };
			},
		};
		const run = await runKeptAlive({
			id: "FollowUpUnlanded",
			repo,
			iso,
			mergeMode: "branch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		expect(run.first.branchName).toBe("omp/task/FollowUpUnlanded");

		await commitIn(iso, "two\n", "review fix");
		expect(await run.settleFollowUp?.(result("FollowUpUnlanded"))).toBe("captured");
		// Kept on purpose, not refused: an unchanged turn hands nothing over again.
		expect(await run.settleFollowUp?.(result("FollowUpUnlanded"))).toBe("");

		expect(handedOver.map(captured => captured.branchBaseSha)).toEqual([baseSha]);
		expect(await git(repo, ["log", "--format=%s", `${baseSha}..omp/task/FollowUpUnlanded`])).toBe(
			"review fix\nfirst run",
		);
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("zero\n");
		await AgentLifecycleManager.global().release("FollowUpUnlanded");
	});

	it("leaves only the unlanded work, as a patch, when released after a patch-mode landing", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "patch");
		const run = await runKeptAlive({
			id: "FollowUpPatchRelease",
			repo,
			iso,
			mergeMode: "patch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		const firstLanding = await mergeIsolatedChanges({ result: run.first, repoRoot: repo, mergeMode: "patch" });
		firstRun.resolve(firstLanding.changesApplied === true);
		await commitIn(iso, "two\n", "review fix");
		expect(await run.settleFollowUp?.(result("FollowUpPatchRelease"))).toContain("Applied patches: yes");

		// Work whose turn never reported to the parent is left for release.
		await commitIn(iso, "three\n", "unreported");
		await AgentLifecycleManager.global().release("FollowUpPatchRelease");

		// The parent holds the landed edits uncommitted: a branch from the run's
		// start would repeat them and conflict with them.
		expect(await taskBranches(repo)).toBe("");
		const leftover = await Bun.file(run.first.patchPath ?? "").text();
		expect(leftover).toContain("-two");
		expect(leftover).toContain("+three");
		expect(leftover).not.toContain("-zero");
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("two\n");
	});

	for (const unreported of [true, false]) {
		it(`tells the caller ${unreported ? "when" : "only when"} release leaves remaining work in the artifacts directory`, async () => {
			const { repo, iso } = await createRepoAndIsolation();
			const { firstRun, followUps } = landingFollowUps(repo, "branch");
			const left = vi.fn();
			const id = unreported ? "ReleaseLeavesWork" : "ReleaseLeavesNothing";
			const run = await runKeptAlive({
				id,
				repo,
				iso,
				mergeMode: "branch",
				followUps,
				firstRun: () => commitIn(iso, "one\n", "first run"),
				onReleaseArtifacts: left,
			});
			const firstLanding = await mergeIsolatedChanges({ result: run.first, repoRoot: repo, mergeMode: "branch" });
			firstRun.resolve(firstLanding.changesApplied);
			if (unreported) await commitIn(iso, "two\n", "unreported");

			await AgentLifecycleManager.global().release(id);

			// The caller keeps that directory past the agent's release, so it must not be told otherwise.
			expect(left).toHaveBeenCalledTimes(unreported ? 1 : 0);
		});
	}
	it("tells the caller to keep artifacts when a refused patch-mode follow-up is released with no later turn", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		const firstRun = Promise.withResolvers<boolean | null>();
		const left = vi.fn();
		const id = "RefusedFollowUpRelease";
		const run = await runKeptAlive({
			id,
			repo,
			iso,
			mergeMode: "patch",
			followUps: {
				firstRunLanded: firstRun.promise,
				land: async () => ({ summary: "refused", landed: false }),
			},
			firstRun: () => commitIn(iso, "one\n", "first run"),
			onReleaseArtifacts: left,
		});
		const firstLanding = await mergeIsolatedChanges({ result: run.first, repoRoot: repo, mergeMode: "patch" });
		firstRun.resolve(firstLanding.changesApplied === true);
		await commitIn(iso, "two\n", "review fix");
		expect(await run.settleFollowUp?.(result(id))).toBe("refused");

		await AgentLifecycleManager.global().release(id);

		// The refused capture already wrote the only copy. Release must say so,
		// or a no-session lease deletes the directory when the agent goes.
		expect(left).toHaveBeenCalledTimes(1);
		expect(await Bun.file(run.first.patchPath ?? "").text()).toContain("+two");
	});

	it("names a follow-up nested patch so the roster scanner can find it", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		await addNestedRepo(repo, iso);

		const firstRun = Promise.withResolvers<boolean | null>();
		const id = "FollowUpNestedName";
		const run = await runKeptAlive({
			id,
			repo,
			iso,
			mergeMode: "patch",
			followUps: {
				firstRunLanded: firstRun.promise,
				land: async () => ({ summary: "refused", landed: false }),
			},
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		firstRun.resolve(true);
		await Bun.write(path.join(iso, "sub", "n.txt"), "n1\n");
		expect(await run.settleFollowUp?.(result(id))).toBe("refused");

		const artifactsDir = path.dirname(run.first.patchPath ?? "");
		const names = (await fs.readdir(artifactsDir)).filter(name => name.includes("nested") && name.endsWith(".patch"));
		// The scanner accepts `<id>.nested-…` only. `<id>.<n>.nested-…` is invisible after a restart.
		expect(names.length).toBeGreaterThan(0);
		expect(names.every(name => name.startsWith(`${id}.nested-`))).toBe(true);
		await AgentLifecycleManager.global().release(id);
	});

	it("names the patch, not a branch, when a follow-up after a patch-mode landing cannot be captured", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "patch");
		const run = await runKeptAlive({
			id: "FollowUpPatchPending",
			repo,
			iso,
			mergeMode: "patch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		const firstLanding = await mergeIsolatedChanges({ result: run.first, repoRoot: repo, mergeMode: "patch" });
		firstRun.resolve(firstLanding.changesApplied === true);
		await commitIn(iso, "two\n", "review fix");
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockRejectedValueOnce(new Error("ENOSPC"));

		const summary = await run.settleFollowUp?.(result("FollowUpPatchPending"));

		// Release after a patch-mode landing writes the patch and no branch.
		expect(summary).toContain("ENOSPC");
		expect(summary).toContain(run.first.patchPath ?? "<no patch>");
		expect(summary).not.toContain("omp/task/");
		// The work stays pending and lands with the next turn.
		expect(await run.settleFollowUp?.(result("FollowUpPatchPending"))).toContain("Applied patches: yes");
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("two\n");
		await AgentLifecycleManager.global().release("FollowUpPatchPending");
	});

	it("names the patch files as well as the branch when a branch-mode follow-up cannot be captured", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "branch");
		const run = await runKeptAlive({
			id: "FollowUpBranchPending",
			repo,
			iso,
			mergeMode: "branch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		const firstLanding = await mergeIsolatedChanges({ result: run.first, repoRoot: repo, mergeMode: "branch" });
		firstRun.resolve(firstLanding.changesApplied);
		await commitIn(iso, "two\n", "review fix");
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockRejectedValueOnce(new Error("ENOSPC"));

		const summary = await run.settleFollowUp?.(result("FollowUpBranchPending"));

		// Release always writes patch files; the branch holds root-repository changes only,
		// so a turn that changed only a nested repository is still accounted for.
		expect(summary).toContain("ENOSPC");
		expect(summary).toContain("/FollowUpBranchPending.patch");
		expect(summary).toContain("omp/task/FollowUpBranchPending");
		expect(await run.settleFollowUp?.(result("FollowUpBranchPending"))).toContain("Merged branch");
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("two\n");
		await AgentLifecycleManager.global().release("FollowUpBranchPending");
	});

	/**
	 * A parent with uncommitted edits to `w.txt` (line 1) and `u.txt`, an
	 * isolation started from that working tree, and a first run that commits
	 * only `a.txt` and has landed.
	 */
	async function landedRunOnDirtyParent(id: string) {
		const { repo, iso } = await createRepoAndIsolation();
		await Bun.write(path.join(repo, "w.txt"), "1\n2\n3\n");
		await Bun.write(path.join(repo, "u.txt"), "u0\n");
		await git(repo, ["add", "w.txt", "u.txt"]);
		await git(repo, ["commit", "-q", "-m", "tracked"]);
		await git(iso, ["pull", "-q", "--ff-only"]);
		for (const dir of [repo, iso]) {
			await Bun.write(path.join(dir, "w.txt"), "1-wip\n2\n3\n");
			await Bun.write(path.join(dir, "u.txt"), "u-wip\n");
		}
		const commitOnly = async (file: string, content: string, message: string) => {
			await Bun.write(path.join(iso, file), content);
			await git(iso, ["commit", "-q", "-m", message, "--", file]);
		};
		const { firstRun, followUps } = landingFollowUps(repo, "branch");
		const run = await runKeptAlive({
			id,
			repo,
			iso,
			mergeMode: "branch",
			followUps,
			firstRun: () => commitOnly("a.txt", "one\n", "first run"),
		});
		const firstLanding = await mergeIsolatedChanges({ result: run.first, repoRoot: repo, mergeMode: "branch" });
		firstRun.resolve(firstLanding.changesApplied === true);
		expect(firstLanding.changesApplied).toBe(true);
		return { repo, run, commitOnly, landedTip: await git(repo, ["rev-parse", "HEAD"]) };
	}

	it("lands only the agent's edit when a follow-up touches a file the parent has uncommitted edits in", async () => {
		const { repo, run, commitOnly, landedTip } = await landedRunOnDirtyParent("FollowUpDirtyParent");

		await commitOnly("w.txt", "1-wip\n2\n3-agent\n", "review fix");
		const summary = await run.settleFollowUp?.(result("FollowUpDirtyParent"));

		expect(summary).toContain("Merged branch");
		expect(await git(repo, ["log", "--format=%s", `${landedTip}..HEAD`])).toBe("review fix");
		// The commit carries the agent's line on the committed file, none of the
		// parent's uncommitted work, and leaves that work in the working tree.
		expect(await git(repo, ["show", "--format=", "--name-only", "HEAD"])).toBe("w.txt");
		expect(await git(repo, ["show", "HEAD:w.txt"])).toBe("1\n2\n3-agent");
		expect(await git(repo, ["show", "HEAD:u.txt"])).toBe("u0");
		expect(await Bun.file(path.join(repo, "w.txt")).text()).toBe("1-wip\n2\n3-agent\n");
		expect(await Bun.file(path.join(repo, "u.txt")).text()).toBe("u-wip\n");
		await AgentLifecycleManager.global().release("FollowUpDirtyParent");
		expect(await taskBranches(repo)).toBe("");
	});

	it("keeps a follow-up that rewrites the parent's uncommitted line on its branch, like a first run", async () => {
		const { repo, run, commitOnly, landedTip } = await landedRunOnDirtyParent("FollowUpDirtyOverlap");

		await commitOnly("w.txt", "1-agent\n2\n3\n", "review fix");
		const summary = await run.settleFollowUp?.(result("FollowUpDirtyOverlap"));

		// A pick onto a dirty path is refused, as for a first run, and the branch kept.
		expect(summary).toContain("Branch merge failed");
		expect(await git(repo, ["rev-parse", "HEAD"])).toBe(landedTip);
		const branch = "omp/task/FollowUpDirtyOverlap";
		expect(await git(repo, ["rev-parse", `${branch}^`])).toBe(landedTip);
		expect(await git(repo, ["log", "--format=%s", `${landedTip}..${branch}`])).toBe("review fix");
		// The agent's version of the file it touched, and the parent's committed
		// version of the uncommitted file it did not touch.
		expect(await git(repo, ["show", "--format=", "--name-only", branch])).toBe("w.txt");
		expect(await git(repo, ["show", `${branch}:w.txt`])).toBe("1-agent\n2\n3");
		expect(await git(repo, ["show", `${branch}:u.txt`])).toBe("u0");
		expect(await Bun.file(path.join(repo, "w.txt")).text()).toBe("1-wip\n2\n3\n");
		expect(await Bun.file(path.join(repo, "u.txt")).text()).toBe("u-wip\n");
		// Nothing new since the refused landing: release leaves that branch as it is.
		await AgentLifecycleManager.global().release("FollowUpDirtyOverlap");
		expect(await git(repo, ["log", "--format=%s", `${landedTip}..${branch}`])).toBe("review fix");
	});

	it("lands a refused follow-up with the next turn once its block is cleared, even if that turn edits nothing", async () => {
		const { repo, run, commitOnly, landedTip } = await landedRunOnDirtyParent("FollowUpRetry");
		await commitOnly("w.txt", "1-agent\n2\n3\n", "review fix");
		expect(await run.settleFollowUp?.(result("FollowUpRetry"))).toContain("Branch merge failed");

		// The user drops the uncommitted line the pick was refused on.
		await git(repo, ["checkout", "--", "w.txt"]);
		const summary = await run.settleFollowUp?.(result("FollowUpRetry"));

		expect(summary).toContain("Merged branch");
		expect(await git(repo, ["log", "--format=%s", `${landedTip}..HEAD`])).toBe("review fix");
		expect(await git(repo, ["show", "HEAD:w.txt"])).toBe("1-agent\n2\n3");
		expect(await Bun.file(path.join(repo, "u.txt")).text()).toBe("u-wip\n");
		// Landed now: a further unchanged turn has nothing to hand over.
		expect(await run.settleFollowUp?.(result("FollowUpRetry"))).toBe("");
		await AgentLifecycleManager.global().release("FollowUpRetry");
		expect(await taskBranches(repo)).toBe("");
	});

	it("lands a refused first run with the next turn once its block is cleared, even if that turn edits nothing", async () => {
		const { repo, iso, baseSha } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "branch");
		const run = await runKeptAlive({
			id: "FirstRunRetry",
			repo,
			iso,
			mergeMode: "branch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		// An uncommitted edit in the parent blocks the first run's pick.
		await Bun.write(path.join(repo, "a.txt"), "stray\n");
		const firstLanding = await mergeIsolatedChanges({ result: run.first, repoRoot: repo, mergeMode: "branch" });
		expect(firstLanding.changesApplied).toBe(false);
		firstRun.resolve(firstLanding.changesApplied);

		// The user drops that edit; the agent's next turn changes nothing.
		await git(repo, ["checkout", "--", "a.txt"]);
		const summary = await run.settleFollowUp?.(result("FirstRunRetry"));

		expect(summary).toContain("Merged branch");
		expect(await git(repo, ["log", "--format=%s", `${baseSha}..HEAD`])).toBe("first run");
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("one\n");
		// Landed now: a further unchanged turn has nothing to hand over.
		expect(await run.settleFollowUp?.(result("FirstRunRetry"))).toBe("");
		await AgentLifecycleManager.global().release("FirstRunRetry");
		expect(await taskBranches(repo)).toBe("");
	});

	it("keeps an unlanded apply=false handoff when the agent is released", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		const released: string[] = [];
		const { firstRun, followUps } = landingFollowUps(repo, "patch");
		// The task tool's apply=false path: the landing resolves null, so nothing is applied.
		followUps.land = async () => ({ summary: "not applied", landed: null });
		const run = await runKeptAlive({
			id: "FollowUpUnlandedRelease",
			repo,
			iso,
			mergeMode: "patch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
			onReleaseArtifacts: () => released.push("released"),
		});
		firstRun.resolve(null);
		await commitIn(iso, "two\n", "review fix");
		expect(await run.settleFollowUp?.(result("FollowUpUnlandedRelease"))).toContain("not applied");

		await AgentLifecycleManager.global().release("FollowUpUnlandedRelease");

		// The handoff was deliberately left unapplied. Release must not delete the only copy.
		expect(released).toEqual(["released"]);
		expect(await Bun.file(run.first.patchPath ?? "").text()).toContain("+two");
	});

	it("withdraws an unlanded patch the agent later undoes", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "patch");
		const run = await runKeptAlive({
			id: "FollowUpUndone",
			repo,
			iso,
			mergeMode: "patch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		// apply=false: the first result advertised this patch as the way to recover the work.
		firstRun.resolve(null);
		const patchPath = run.first.patchPath ?? "";
		expect(await Bun.file(patchPath).text()).toContain("+one");
		// The Agent Hub lists these from registry history; they must exist before, or the
		// check after the withdrawal proves nothing.
		expect(AgentRegistry.global().get("FollowUpUndone")?.history?.patchPath).toBe(patchPath);

		// The agent deliberately puts the workspace back to its starting content.
		await commitIn(iso, "zero\n", "undo");
		const notice = await run.settleFollowUp?.(result("FollowUpUndone"));

		// A leftover patch would let someone apply work the agent removed.
		expect(await Bun.file(patchPath).exists()).toBe(false);
		expect(AgentRegistry.global().get("FollowUpUndone")?.history?.patchPath).toBeUndefined();
		expect(AgentRegistry.global().get("FollowUpUndone")?.history?.nestedPatchPaths).toBeUndefined();
		expect(notice).toContain("undid");
		await AgentLifecycleManager.global().release("FollowUpUndone");
		expect(await Bun.file(patchPath).exists()).toBe(false);
	});

	it("withdraws a refused task branch the agent later undoes", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "branch");
		const run = await runKeptAlive({
			id: "FollowUpBranchUndone",
			repo,
			iso,
			mergeMode: "branch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		firstRun.resolve(false);
		expect(await taskBranches(repo)).toContain("omp/task/FollowUpBranchUndone");
		expect(AgentRegistry.global().get("FollowUpBranchUndone")?.history?.branchName).toBe(
			"omp/task/FollowUpBranchUndone",
		);

		await commitIn(iso, "zero\n", "undo");
		const notice = await run.settleFollowUp?.(result("FollowUpBranchUndone"));

		expect(await taskBranches(repo)).toBe("");
		expect(AgentRegistry.global().get("FollowUpBranchUndone")?.history?.branchName).toBeUndefined();
		expect(notice).toContain("undid");
		await AgentLifecycleManager.global().release("FollowUpBranchUndone");
		expect(await taskBranches(repo)).toBe("");
	});

	it("withdraws an unlanded patch on release when the agent undid it in a turn nobody captured", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "patch");
		const run = await runKeptAlive({
			id: "ReleaseUndonePatch",
			repo,
			iso,
			mergeMode: "patch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		firstRun.resolve(null);
		const patchPath = run.first.patchPath ?? "";
		expect(await Bun.file(patchPath).text()).toContain("+one");
		expect(AgentRegistry.global().get("ReleaseUndonePatch")?.history?.patchPath).toBe(patchPath);

		// The agent puts everything back, but that turn is never captured: it failed, or only a peer heard it.
		await commitIn(iso, "zero\n", "undo");
		await AgentLifecycleManager.global().release("ReleaseUndonePatch");

		// Release is the first code to see the reverted workspace. A leftover patch would offer removed work.
		expect(await Bun.file(patchPath).exists()).toBe(false);
		expect(AgentRegistry.global().get("ReleaseUndonePatch")?.history?.patchPath).toBeUndefined();
	});

	it("withdraws a refused task branch on release when the agent undid it in a turn nobody captured", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "branch");
		await runKeptAlive({
			id: "ReleaseUndoneBranch",
			repo,
			iso,
			mergeMode: "branch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		firstRun.resolve(false);
		expect(await taskBranches(repo)).toContain("omp/task/ReleaseUndoneBranch");

		await commitIn(iso, "zero\n", "undo");
		await AgentLifecycleManager.global().release("ReleaseUndoneBranch");

		expect(await taskBranches(repo)).toBe("");
		expect(AgentRegistry.global().get("ReleaseUndoneBranch")?.history?.branchName).toBeUndefined();
	});

	it("removes a nested patch the agent undid when the rest of an unlanded handoff is replaced", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		await addNestedRepo(repo, iso);
		const { firstRun, followUps } = landingFollowUps(repo, "patch");
		// apply=false: nothing lands, so every capture is cumulative since the run began.
		followUps.land = async () => ({ summary: "not applied", landed: null });
		const id = "FollowUpPartialUndo";
		const run = await runKeptAlive({
			id,
			repo,
			iso,
			mergeMode: "patch",
			followUps,
			firstRun: async () => {
				await commitIn(iso, "one\n", "first run");
				await Bun.write(path.join(iso, "sub", "n.txt"), "n1\n");
			},
		});
		firstRun.resolve(null);
		const [firstNested] = run.first.nestedPatchPaths ?? [];
		expect(await Bun.file(firstNested ?? "").text()).toContain("+n1");

		// The agent puts the nested repository back but keeps changing the root.
		await Bun.write(path.join(iso, "sub", "n.txt"), "n0\n");
		await commitIn(iso, "two\n", "later fix");
		await run.settleFollowUp?.(result(id));

		// The replacement handoff holds no nested work. The first one's file would
		// still offer, and after a restart rediscover, a patch for work that is gone.
		expect(await Bun.file(firstNested ?? "").exists()).toBe(false);
		expect(AgentRegistry.global().get(id)?.history?.nestedPatchPaths ?? []).not.toContain(firstNested);
		await AgentLifecycleManager.global().release(id);
		const names = await fs.readdir(path.dirname(run.first.patchPath ?? ""));
		expect(names.filter(name => name.includes(".nested-"))).toEqual([]);
		expect(await Bun.file(run.first.patchPath ?? "").text()).toContain("+two");
	});

	it("deletes the task branch when a refused follow-up is undone after an earlier one landed", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "branch");
		const id = "FollowUpLandedThenUndone";
		const run = await runKeptAlive({
			id,
			repo,
			iso,
			mergeMode: "branch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		const firstLanding = await mergeIsolatedChanges({ result: run.first, repoRoot: repo, mergeMode: "branch" });
		firstRun.resolve(firstLanding.changesApplied === true);
		// A landing removes the task branch.
		expect(await taskBranches(repo)).toBe("");

		// A follow-up the caller refuses to merge: its branch is the only copy of that work.
		followUps.land = async () => ({ summary: "refused", landed: false });
		await commitIn(iso, "two\n", "review fix");
		await run.settleFollowUp?.(result(id));
		expect(await taskBranches(repo)).toContain(`omp/task/${id}`);

		// The agent puts the workspace back to exactly what landed.
		await commitIn(iso, "one\n", "undo");
		await run.settleFollowUp?.(result(id));

		// Restoring the landed tip would recreate a branch of work already applied.
		expect(await taskBranches(repo)).toBe("");
		expect(AgentRegistry.global().get(id)?.history?.branchName).toBeUndefined();
		await AgentLifecycleManager.global().release(id);
		expect(await taskBranches(repo)).toBe("");
	});

	it("removes a nested patch the agent undid when release replaces an unlanded handoff", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		await addNestedRepo(repo, iso);
		const { firstRun, followUps } = landingFollowUps(repo, "patch");
		followUps.land = async () => ({ summary: "not applied", landed: null });
		const id = "ReleasePartialUndo";
		const run = await runKeptAlive({
			id,
			repo,
			iso,
			mergeMode: "patch",
			followUps,
			firstRun: async () => {
				await commitIn(iso, "one\n", "first run");
				await Bun.write(path.join(iso, "sub", "n.txt"), "n1\n");
			},
		});
		firstRun.resolve(null);
		const [firstNested] = run.first.nestedPatchPaths ?? [];
		expect(await Bun.file(firstNested ?? "").exists()).toBe(true);

		// A later turn nobody captured: the nested repository goes back, the root keeps changing.
		await Bun.write(path.join(iso, "sub", "n.txt"), "n0\n");
		await commitIn(iso, "two\n", "later fix");
		await AgentLifecycleManager.global().release(id);

		expect(await Bun.file(firstNested ?? "").exists()).toBe(false);
		expect(AgentRegistry.global().get(id)?.history?.nestedPatchPaths ?? []).not.toContain(firstNested);
		expect(await Bun.file(run.first.patchPath ?? "").text()).toContain("+two");
	});

	/** A refused branch handoff holding root work plus nested work in `sub/`. */
	async function refusedBranchWithNested(id: string) {
		const { repo, iso } = await createRepoAndIsolation();
		await addNestedRepo(repo, iso);
		const { firstRun, followUps } = landingFollowUps(repo, "branch");
		const run = await runKeptAlive({
			id,
			repo,
			iso,
			mergeMode: "branch",
			followUps,
			firstRun: async () => {
				await commitIn(iso, "one\n", "first run");
				await Bun.write(path.join(iso, "sub", "n.txt"), "n1\n");
			},
		});
		firstRun.resolve(false);
		expect(await taskBranches(repo)).toContain(`omp/task/${id}`);
		expect(AgentRegistry.global().get(id)?.history?.branchName).toBe(`omp/task/${id}`);
		// The agent drops its root change and keeps the nested one.
		await commitIn(iso, "zero\n", "drop root work");
		return { repo, iso, run };
	}

	it("removes a refused task branch when a later turn drops all its root work but keeps nested work", async () => {
		const id = "FollowUpRootDropped";
		const { repo, run } = await refusedBranchWithNested(id);

		await run.settleFollowUp?.(result(id));

		// The branch held only root changes the agent has since removed.
		expect(await taskBranches(repo)).toBe("");
		expect(AgentRegistry.global().get(id)?.history?.branchName).toBeUndefined();
		// The nested work is still real and still offered.
		const nested = AgentRegistry.global().get(id)?.history?.nestedPatchPaths ?? [];
		expect(nested).toHaveLength(1);
		expect(await Bun.file(nested[0] ?? "").text()).toContain("+n1");
		await AgentLifecycleManager.global().release(id);
		expect(await taskBranches(repo)).toBe("");
	});

	it("removes a refused task branch on release when the agent dropped all its root work but kept nested work", async () => {
		const id = "ReleaseRootDropped";
		const { repo } = await refusedBranchWithNested(id);

		// That turn is never captured: release is the first code to see it.
		await AgentLifecycleManager.global().release(id);

		expect(await taskBranches(repo)).toBe("");
		expect(AgentRegistry.global().get(id)?.history?.branchName).toBeUndefined();
	});

	it("stops listing the first run's task branch once its landing deletes it", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "branch");
		const id = "FirstRunBranchLanded";
		const branch = `omp/task/${id}`;
		const run = await runKeptAlive({
			id,
			repo,
			iso,
			mergeMode: "branch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		expect(AgentRegistry.global().get(id)?.history?.branchName).toBe(branch);

		const landing = await mergeIsolatedChanges({ result: run.first, repoRoot: repo, mergeMode: "branch" });
		firstRun.resolve(landing.changesApplied);

		expect(landing.changesApplied).toBe(true);
		expect(await taskBranches(repo)).toBe("");
		// The Agent Hub row of the idle agent must not name a branch that no longer exists.
		expect(AgentRegistry.global().get(id)?.history?.branchName).toBeUndefined();
		await AgentLifecycleManager.global().release(id);
	});

	it("stops listing a follow-up's task branch once its landing deletes it", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "branch");
		const id = "FollowUpBranchLanded";
		const run = await runKeptAlive({
			id,
			repo,
			iso,
			mergeMode: "branch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		// Refused, so the branch stays and is listed.
		firstRun.resolve(false);
		expect(AgentRegistry.global().get(id)?.history?.branchName).toBe(`omp/task/${id}`);

		await commitIn(iso, "two\n", "review fix");
		expect(await run.settleFollowUp?.(result(id))).toContain("Merged branch");

		expect(await taskBranches(repo)).toBe("");
		expect(AgentRegistry.global().get(id)?.history?.branchName).toBeUndefined();
		await AgentLifecycleManager.global().release(id);
	});

	it("keeps listing the task branch when its merge conflicts and the branch is kept", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "branch");
		const id = "FirstRunBranchConflicts";
		const run = await runKeptAlive({
			id,
			repo,
			iso,
			mergeMode: "branch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		// The parent changed the same line, so the merge cannot succeed.
		await Bun.write(path.join(repo, "a.txt"), "parent\n");
		await git(repo, ["commit", "-q", "-a", "-m", "parent change"]);

		const landing = await mergeIsolatedChanges({ result: run.first, repoRoot: repo, mergeMode: "branch" });
		firstRun.resolve(landing.changesApplied);

		expect(landing.changesApplied).toBe(false);
		// The branch is the only copy of the work, and it is still there to be listed.
		expect(await taskBranches(repo)).toContain(`omp/task/${id}`);
		expect(AgentRegistry.global().get(id)?.history?.branchName).toBe(`omp/task/${id}`);
		await AgentLifecycleManager.global().release(id);
	});

	/** A patch-mode agent whose first handoff was left unapplied, and the unapplied root patch it advertises. */
	async function unappliedPatchAgent(id: string) {
		const { repo, iso } = await createRepoAndIsolation();
		await addNestedRepo(repo, iso);
		const { firstRun, followUps } = landingFollowUps(repo, "patch");
		const run = await runKeptAlive({
			id,
			repo,
			iso,
			mergeMode: "patch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		// Left unapplied: the patch file is the only copy of the work.
		firstRun.resolve(null);
		const patchPath = run.first.patchPath ?? "";
		const handedOver = await Bun.file(patchPath).text();
		expect(handedOver).toContain("+one");
		// The next turn changes root and nested work.
		await commitIn(iso, "two\n", "later fix");
		await Bun.write(path.join(iso, "sub", "n.txt"), "n1\n");
		return { iso, run, patchPath, handedOver };
	}

	it("keeps the patch the caller was handed when a later capture's nested files cannot be written", async () => {
		const id = "FollowUpPatchKept";
		const { iso, run, patchPath, handedOver } = await unappliedPatchAgent(id);
		await fs.mkdir(path.join(run.artifactsDir, `${id}.nested-1.nested-0-sub.patch`));

		expect(await run.settleFollowUp?.(result(id))).toContain("not captured");
		// A capture that was not accepted must leave the advertised patch as it was.
		expect(await Bun.file(patchPath).text()).toBe(handedOver);

		// The agent puts everything back as it was handed over. Nothing new is captured,
		// so nothing would ever repair a file the failed capture had overwritten.
		await commitIn(iso, "one\n", "undo later fix");
		await Bun.write(path.join(iso, "sub", "n.txt"), "n0\n");
		expect(await run.settleFollowUp?.(result(id))).toBe("");
		expect(await Bun.file(patchPath).text()).toBe(handedOver);
		await AgentLifecycleManager.global().release(id);
	});

	it("leaves no files of a capture whose root patch could not be published", async () => {
		const id = "FollowUpPatchPublishFails";
		const { run, patchPath, handedOver } = await unappliedPatchAgent(id);
		vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("EXDEV"));

		expect(await run.settleFollowUp?.(result(id))).toContain("not captured");

		expect(await Bun.file(patchPath).text()).toBe(handedOver);
		// Neither the new capture's nested patch nor a half-written root patch may stay behind.
		const leftovers = (await fs.readdir(run.artifactsDir)).filter(
			name => name.includes(".nested-1.") || name.endsWith(".tmp"),
		);
		expect(leftovers).toEqual([]);
		await AgentLifecycleManager.global().release(id);
	});

	it("keeps the handed-over task branch when a nested-only replacement cannot be written", async () => {
		const id = "FollowUpReplacementWriteFails";
		const { repo, run } = await refusedBranchWithNested(id);
		expect(await taskBranches(repo)).toContain(`omp/task/${id}`);

		// The agent has dropped its root work (the helper did that), so the replacement is nested-only
		// and would delete the old branch. Its nested patch cannot be written.
		await fs.mkdir(path.join(run.artifactsDir, `${id}.nested-1.nested-0-sub.patch`));
		expect(await run.settleFollowUp?.(result(id))).toContain("not captured");

		// Nothing was handed over, so the caller still has the branch it was told about.
		expect(await taskBranches(repo)).toContain(`omp/task/${id}`);
		expect(AgentRegistry.global().get(id)?.history?.branchName).toBe(`omp/task/${id}`);
		await AgentLifecycleManager.global().release(id);
	});

	it("restores the task branch when writing a follow-up's nested patches fails", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		await addNestedRepo(repo, iso);
		const { firstRun, followUps } = landingFollowUps(repo, "branch");
		const id = "FollowUpBranchNestedWriteFails";
		const branch = `omp/task/${id}`;
		const run = await runKeptAlive({
			id,
			repo,
			iso,
			mergeMode: "branch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		// Left unapplied: the branch is what the caller has been handed.
		firstRun.resolve(null);
		const handedOverTip = await git(repo, ["rev-parse", branch]);

		// The next turn changes root and nested work, and its nested patch cannot be written.
		await commitIn(iso, "two\n", "later fix");
		await Bun.write(path.join(iso, "sub", "n.txt"), "n1\n");
		await fs.mkdir(path.join(run.artifactsDir, `${id}.nested-1.nested-0-sub.patch`));
		expect(await run.settleFollowUp?.(result(id))).toContain("not captured");
		// The branch was moved before the write failed, and the caller was handed none of it.
		expect(await git(repo, ["rev-parse", branch])).toBe(handedOverTip);

		// The agent then undoes that turn entirely: its state is the one already handed over, so
		// the capture takes the unchanged path and never rewrites the branch.
		await commitIn(iso, "one\n", "undo later fix");
		await Bun.write(path.join(iso, "sub", "n.txt"), "n0\n");
		expect(await run.settleFollowUp?.(result(id))).toBe("");
		expect(await git(repo, ["rev-parse", branch])).toBe(handedOverTip);
		await AgentLifecycleManager.global().release(id);
	});

	it("deletes the task branch when the first handoff's nested write fails", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		await addNestedRepo(repo, iso);
		const { followUps } = landingFollowUps(repo, "branch");
		const id = "FollowUpBranchNothingHandedOver";
		const run = await runKeptAlive({
			id,
			repo,
			iso,
			mergeMode: "branch",
			followUps,
			// The first run changed nothing, so no branch was ever handed over.
			firstRun: async () => {},
		});
		await Bun.write(path.join(iso, "sub", "n.txt"), "n1\n");
		await commitIn(iso, "one\n", "later fix");
		await fs.mkdir(path.join(run.artifactsDir, `${id}.nested-1.nested-0-sub.patch`));
		expect(await run.settleFollowUp?.(result(id))).toContain("not captured");

		// No tip was ever handed over, so there is nothing to restore: the branch must not stay behind.
		expect(await taskBranches(repo)).toBe("");
		await AgentLifecycleManager.global().release(id);
	});

	it("withdraws a follow-up's nested patch that did not apply when the agent later undoes it", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		await addNestedRepo(repo, iso);
		const firstRun = Promise.withResolvers<boolean | null>();
		const handedOver: SingleResult[] = [];
		const id = "FollowUpNestedUndone";
		const run = await runKeptAlive({
			id,
			repo,
			iso,
			mergeMode: "patch",
			followUps: {
				firstRunLanded: firstRun.promise,
				// The root lands; the nested patch for `sub` does not.
				land: async captured => {
					handedOver.push(captured);
					return { summary: "landed", landed: true, unappliedNested: ["sub"] };
				},
			},
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		firstRun.resolve(true);

		await Bun.write(path.join(iso, "sub", "n.txt"), "n1\n");
		await run.settleFollowUp?.(result(id));
		// The root landed, so its file is a record. The nested patch never applied: its file is the only copy.
		const nestedPatch = handedOver[0]?.nestedPatchPaths?.[0] ?? "";
		expect(await Bun.file(nestedPatch).exists()).toBe(true);

		// The agent undoes that edit in a later turn. The parent never got it, so there is nothing to recover.
		await Bun.write(path.join(iso, "sub", "n.txt"), "n0\n");
		expect(await run.settleFollowUp?.(result(id))).toContain("undid");
		expect(await Bun.file(nestedPatch).exists()).toBe(false);
		expect(AgentRegistry.global().get(id)?.history?.nestedPatchPaths ?? []).not.toContain(nestedPatch);
		await AgentLifecycleManager.global().release(id);
	});

	it("withdraws the first run's nested patch that did not apply when the agent later undoes it", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		await addNestedRepo(repo, iso);
		const firstRun = Promise.withResolvers<boolean | null>();
		const id = "FirstRunNestedUndone";
		const run = await runKeptAlive({
			id,
			repo,
			iso,
			mergeMode: "patch",
			followUps: {
				firstRunLanded: firstRun.promise,
				firstRunUnappliedNested: () => ["sub"],
				land: async () => ({ summary: "landed", landed: true, unappliedNested: [] }),
			},
			firstRun: async () => {
				await commitIn(iso, "one\n", "first run");
				await Bun.write(path.join(iso, "sub", "n.txt"), "n1\n");
			},
		});
		firstRun.resolve(true);
		const nestedPatch = run.first.nestedPatchPaths?.[0] ?? "";
		expect(await Bun.file(nestedPatch).exists()).toBe(true);

		await Bun.write(path.join(iso, "sub", "n.txt"), "n0\n");
		expect(await run.settleFollowUp?.(result(id))).toContain("undid");
		expect(await Bun.file(nestedPatch).exists()).toBe(false);
		expect(AgentRegistry.global().get(id)?.history?.nestedPatchPaths ?? []).not.toContain(nestedPatch);
		await AgentLifecycleManager.global().release(id);
	});

	it("withdraws the first run's branch-mode nested patch that did not apply when the agent later undoes it", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		await addNestedRepo(repo, iso);
		const firstRun = Promise.withResolvers<boolean | null>();
		const id = "FirstRunBranchNestedUndone";
		const run = await runKeptAlive({
			id,
			repo,
			iso,
			mergeMode: "branch",
			followUps: {
				firstRunLanded: firstRun.promise,
				firstRunUnappliedNested: () => ["sub"],
				land: async () => ({ summary: "landed", landed: true, unappliedNested: [] }),
			},
			firstRun: async () => {
				await commitIn(iso, "one\n", "first run");
				await Bun.write(path.join(iso, "sub", "n.txt"), "n1\n");
			},
		});
		firstRun.resolve(true);
		const nestedPatch = run.first.nestedPatchPaths?.[0] ?? "";
		expect(await Bun.file(nestedPatch).exists()).toBe(true);

		await Bun.write(path.join(iso, "sub", "n.txt"), "n0\n");
		expect(await run.settleFollowUp?.(result(id))).toContain("undid");
		expect(await Bun.file(nestedPatch).exists()).toBe(false);
		await AgentLifecycleManager.global().release(id);
	});

	it("keeps a nested repository cumulative after a landing could not apply its patch", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		await addNestedRepo(repo, iso);
		const firstRun = Promise.withResolvers<boolean | null>();
		const handedOver: SingleResult[] = [];
		const id = "FollowUpNestedKept";
		const run = await runKeptAlive({
			id,
			repo,
			iso,
			mergeMode: "patch",
			followUps: {
				firstRunLanded: firstRun.promise,
				// Every turn's root lands. The first turn's patch for `sub` does not.
				land: async captured => {
					handedOver.push(captured);
					return { summary: "landed", landed: true, unappliedNested: handedOver.length === 1 ? ["sub"] : [] };
				},
			},
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		firstRun.resolve(true);

		await Bun.write(path.join(iso, "sub", "n.txt"), "n1\n");
		await run.settleFollowUp?.(result(id));
		await Bun.write(path.join(iso, "sub", "n.txt"), "n2\n");
		await run.settleFollowUp?.(result(id));

		expect(handedOver).toHaveLength(2);
		const second = handedOver[1]?.nestedPatches?.[0]?.patch ?? "";
		// The parent never received the first turn's edit to `sub`, so the second capture must
		// carry it. A patch of only the later edit would apply onto a repository lacking its
		// prerequisite.
		expect(second).toContain("-n0");
		expect(second).toContain("+n2");
		await AgentLifecycleManager.global().release(id);
	});

	it("hands over only the later nested edit when the landing applied the earlier one", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		await addNestedRepo(repo, iso);
		const firstRun = Promise.withResolvers<boolean | null>();
		const handedOver: SingleResult[] = [];
		const id = "FollowUpNestedApplied";
		const run = await runKeptAlive({
			id,
			repo,
			iso,
			mergeMode: "patch",
			followUps: {
				firstRunLanded: firstRun.promise,
				land: async captured => {
					handedOver.push(captured);
					return { summary: "landed", landed: true, unappliedNested: [] };
				},
			},
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		firstRun.resolve(true);

		await Bun.write(path.join(iso, "sub", "n.txt"), "n1\n");
		await run.settleFollowUp?.(result(id));
		await Bun.write(path.join(iso, "sub", "n.txt"), "n2\n");
		await run.settleFollowUp?.(result(id));

		const second = handedOver[1]?.nestedPatches?.[0]?.patch ?? "";
		// The earlier edit landed, so repeating it would only fail to apply.
		expect(second).toContain("-n1");
		expect(second).toContain("+n2");
		expect(second).not.toContain("-n0");
		await AgentLifecycleManager.global().release(id);
	});

	it("keeps a nested repository cumulative after the first run's landing could not apply its patch", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		await addNestedRepo(repo, iso);
		const firstRun = Promise.withResolvers<boolean | null>();
		const handedOver: SingleResult[] = [];
		const id = "FirstRunNestedKept";
		const run = await runKeptAlive({
			id,
			repo,
			iso,
			mergeMode: "patch",
			followUps: {
				firstRunLanded: firstRun.promise,
				firstRunUnappliedNested: () => ["sub"],
				land: async captured => {
					handedOver.push(captured);
					return { summary: "landed", landed: true, unappliedNested: [] };
				},
			},
			firstRun: async () => {
				await commitIn(iso, "one\n", "first run");
				await Bun.write(path.join(iso, "sub", "n.txt"), "n1\n");
			},
		});
		firstRun.resolve(true);

		await Bun.write(path.join(iso, "sub", "n.txt"), "n2\n");
		await run.settleFollowUp?.(result(id));

		const first = handedOver[0]?.nestedPatches?.[0]?.patch ?? "";
		expect(first).toContain("-n0");
		expect(first).toContain("+n2");
		await AgentLifecycleManager.global().release(id);
	});

	it("does not announce a withdrawal when the first run handed over nothing", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "patch");
		const run = await runKeptAlive({
			id: "FollowUpNothingHandedOver",
			repo,
			iso,
			mergeMode: "patch",
			followUps,
			firstRun: async () => {},
		});
		firstRun.resolve(null);

		// Nothing was ever offered, so there is nothing to withdraw and no notice to give.
		expect(await run.settleFollowUp?.(result("FollowUpNothingHandedOver"))).toBe("");
		await AgentLifecycleManager.global().release("FollowUpNothingHandedOver");
	});

	it("does not delete the isolation while the first capture is still writing", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "patch");
		let releasing: Promise<void> | undefined;
		let cleaned = false;
		const run = await runKeptAlive({
			id: "FollowUpReleaseDuringCapture",
			repo,
			iso,
			mergeMode: "patch",
			followUps,
			deleteIsolationOnCleanup: true,
			onCleanupStarted: () => {
				cleaned = true;
			},
			firstRun: () => commitIn(iso, "one\n", "first run"),
			// Call the runner's onRelease directly. The lifecycle wrapper awaits
			// park and dispose first, so it can miss this window entirely.
			afterRun: async (_turnStarted, release) => {
				releasing = release?.();
				// Without the latch, release deletes the isolation during this wait.
				// With it, release is blocked on the capture this run is still inside.
				for (let i = 0; i < 25 && !cleaned; i++) {
					const { promise, resolve } = Promise.withResolvers<void>();
					setTimeout(resolve, 20);
					await promise;
				}
			},
		});
		firstRun.resolve(run.first.isolationCaptureFailed ? null : true);
		await releasing;

		expect(run.first.isolationCaptureFailed).not.toBe(true);
		expect(run.first.patchPath && (await Bun.file(run.first.patchPath).text())).toContain("+one");
	});
	it("leaves no task branch when a follow-up is superseded after the first run landed", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "branch");
		const run = await runKeptAlive({
			id: "FollowUpSupersededBranch",
			repo,
			iso,
			mergeMode: "branch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		const firstLanding = await mergeIsolatedChanges({ result: run.first, repoRoot: repo, mergeMode: "branch" });
		firstRun.resolve(firstLanding.changesApplied === true);
		await commitIn(iso, "two\n", "review fix");
		// The first superseded() check is before the branch write; the second is after it.
		let checks = 0;
		expect(await run.settleFollowUp?.(result("FollowUpSupersededBranch"), () => ++checks >= 2)).toContain(
			"not captured",
		);

		// The landing removed the branch, and a superseded capture must not bring it back:
		// it would hold work the caller already has.
		expect(await taskBranches(repo)).toBe("");
		await AgentLifecycleManager.global().release("FollowUpSupersededBranch");
	});

	it("keeps a refused first-run branch when a later follow-up is superseded", async () => {
		const { repo, iso, baseSha } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "branch");
		const run = await runKeptAlive({
			id: "FollowUpRefusedSuperseded",
			repo,
			iso,
			mergeMode: "branch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		// The caller refused the merge. The branch is still the only copy of that work.
		firstRun.resolve(false);
		await commitIn(iso, "two\n", "review fix");
		let checks = 0;
		expect(await run.settleFollowUp?.(result("FollowUpRefusedSuperseded"), () => ++checks >= 2)).toContain(
			"not captured",
		);

		expect(await git(repo, ["log", "--format=%s", `${baseSha}..omp/task/FollowUpRefusedSuperseded`])).toBe(
			"first run",
		);
		await AgentLifecycleManager.global().release("FollowUpRefusedSuperseded");
	});

	it("marks a first run whose changes could not be captured and lands none of its follow-ups", async () => {
		const { repo, iso } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "patch");
		const land = vi.spyOn(followUps, "land");
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockRejectedValueOnce(new Error("EACCES"));
		const run = await runKeptAlive({
			id: "FollowUpCaptureFailed",
			repo,
			iso,
			mergeMode: "patch",
			followUps,
			firstRun: () => commitIn(iso, "one\n", "first run"),
		});
		// As the task tool reports it: nothing was captured, so no landing was attempted.
		firstRun.resolve(null);

		expect(run.first.exitCode).toBe(0);
		expect(run.first.isolationCaptureFailed).toBe(true);
		expect(run.first.error).toContain("EACCES");
		// The workspace was retained for recovery, so nothing more is captured from it.
		expect(await run.settleFollowUp?.(result("FollowUpCaptureFailed"))).toBe("");
		expect(land).not.toHaveBeenCalled();
		await AgentLifecycleManager.global().release("FollowUpCaptureFailed");
	});
});
