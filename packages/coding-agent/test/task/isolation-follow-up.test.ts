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
	/** The hook the runner handed the executor for follow-up turns. */
	settleFollowUp: ((turn: SingleResult) => Promise<string>) | undefined;
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
}): Promise<KeptAliveRun> {
	const artifactsDir = await tempDir("omp-follow-up-artifacts-");
	vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
		mergedDir: opts.iso,
		backend: natives.IsoBackendKind.Rcopy,
		fellBack: false,
		fallbackReason: null,
	});
	vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
	const session = {
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		dispose: async () => {},
	} as unknown as AgentSession;
	let settleFollowUp: KeptAliveRun["settleFollowUp"];
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		await opts.firstRun();
		settleFollowUp = options.onFollowUpTurnSettled;
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
		});
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
	});
	return { first, settleFollowUp };
}

/** Lands captured changes the way the task tool does; `firstRun` reports the first run's landing. */
function landingFollowUps(repo: string, mergeMode: "patch" | "branch") {
	const firstRun = Promise.withResolvers<boolean>();
	const followUps: IsolationFollowUps = {
		firstRunLanded: firstRun.promise,
		land: async captured => {
			const outcome = await mergeIsolatedChanges({ result: captured, repoRoot: repo, mergeMode });
			return { summary: outcome.summary, landed: outcome.changesApplied === true };
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

	it("holds a follow-up that ends before the first run has landed until it has", async () => {
		const { repo, iso, baseSha } = await createRepoAndIsolation();
		const { firstRun, followUps } = landingFollowUps(repo, "branch");
		const events: string[] = [];
		// A thenable rather than a promise: `await` calls its `then`, which
		// tells the test the follow-up has started waiting on the first run.
		const waitedOn = Promise.withResolvers<void>();
		const firstRunLanded = {
			// oxlint-disable-next-line unicorn/no-thenable -- the await on it is the signal under test
			then: (onLanded: (landed: boolean) => unknown, onFailed?: (reason: unknown) => unknown) => {
				waitedOn.resolve();
				return firstRun.promise.then(onLanded, onFailed);
			},
		} as unknown as Promise<boolean>;
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
			firstRunLanded: Promise.resolve(false),
			land: async captured => {
				handedOver.push(captured);
				return { summary: "captured", landed: false };
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

		expect(handedOver.map(captured => captured.branchBaseSha)).toEqual([baseSha]);
		expect(await git(repo, ["log", "--format=%s", `${baseSha}..omp/task/FollowUpUnlanded`])).toBe(
			"review fix\nfirst run",
		);
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("zero\n");
		await AgentLifecycleManager.global().release("FollowUpUnlanded");
	});
});
