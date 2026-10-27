/**
 * Contracts: per-item blocking split in `task` spawns.
 *
 * An item whose agent type declares `blocking: true` runs inline (the call
 * waits on its result); non-blocking items in the same call still spawn as
 * background jobs. Previously blocking was all-or-nothing per call: one scout
 * in a batch silently dragged every sibling down the sync path — no job ids
 * despite the tool description promising them, the whole turn blocked on the
 * slowest worker, and every spawn died with the turn signal.
 *
 * 1. A mixed batch splits: the blocking item's result returns inline, the
 *    non-blocking item registers a job that keeps running past the return.
 * 2. Returned details reflect settled jobs (async.state converges), and
 *    post-return job updates keep the inline results — they never regress to
 *    an empty-results skeleton.
 * 3. An all-blocking batch stays fully synchronous (no jobs).
 * 4. Async schedule failure in a mixed call still returns the inline results
 *    and reports the failed spawn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { AgentProgress, SingleResult, TaskParams, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const scoutAgent: AgentDefinition = {
	name: "scout",
	description: "Read-only scout",
	systemPrompt: "You are a scout.",
	source: "bundled",
	blocking: true,
};

function createSession(options: { manager?: AsyncJobManager; settings?: Record<string, unknown> } = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(options.settings ?? { "async.enabled": true, "task.batch": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => null,
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
}

function makeResult(id: string, agent: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent,
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: `${id} output.`,
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function makeProgress(id: string, agent: string, status: AgentProgress["status"] = "running"): AgentProgress {
	return {
		index: 0,
		id,
		agent,
		agentSource: "bundled",
		status,
		task: "task prompt",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 1,
		tokens: 0,
		cost: 0,
		durationMs: 5,
	};
}

function mockDiscovery(): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [taskAgent, scoutAgent],
		projectAgentsDir: null,
	});
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

describe("task per-item blocking split", () => {
	const managers: AsyncJobManager[] = [];

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("runs blocking items inline while non-blocking siblings spawn as jobs", async () => {
		mockDiscovery();
		const gates = new Map<string, PromiseWithResolvers<void>>();
		const callbacks = new Map<string, NonNullable<executorModule.ExecutorOptions["onProgress"]>>();
		const allStarted = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			const gate = Promise.withResolvers<void>();
			gates.set(id, gate);
			callbacks.set(id, options.onProgress!);
			options.onProgress?.(makeProgress(id, options.agent.name));
			if (gates.size === 2) allStarted.resolve();
			await gate.promise;
			return makeResult(id, options.agent.name);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));
		const updates: TaskToolDetails[] = [];
		const executePromise = tool.execute(
			"tc-mixed",
			{
				context: "ctx",
				tasks: [
					{ name: "ScoutOne", agent: "scout", task: "Research A." },
					{ name: "WorkerOne", agent: "task", task: "Build B." },
				],
			} as TaskParams,
			undefined,
			update => {
				if (update.details) updates.push(update.details);
			},
		);

		await allStarted.promise;
		expect(updates.at(-1)?.blockingActive).toBe(true);
		expect(manager.getJob("WorkerOne")?.status).toBe("running");
		gates.get("ScoutOne")!.resolve();
		const result = await executePromise;

		const text = firstText(result);
		expect(text).toContain('id="ScoutOne"');
		expect(text).toContain("ScoutOne output.");
		expect(text).toContain("Spawned 1 background agent");
		expect(text).toContain("- `WorkerOne` (job `WorkerOne`)");
		expect(text).not.toContain("WorkerOne output.");
		expect(result.details?.blockingActive).toBe(false);
		expect(result.details?.results.map(r => r.id)).toEqual(["ScoutOne"]);
		expect(result.details?.async?.state).toBe("running");
		const progressById = new Map(result.details?.progress?.map(p => [p.id, p.status]));
		expect(progressById.get("ScoutOne")).toBe("completed");
		expect(progressById.get("WorkerOne")).toBe("running");
		expect(manager.getJob("WorkerOne")!.status).toBe("running");

		const postReturnStart = updates.length;
		callbacks.get("ScoutOne")!(makeProgress("ScoutOne", "scout"));
		expect(updates.length).toBeGreaterThan(postReturnStart);
		expect(updates.at(-1)?.blockingActive).toBe(false);
		callbacks.get("WorkerOne")!(makeProgress("WorkerOne", "task"));
		expect(updates.at(-1)?.blockingActive).toBe(false);
		gates.get("WorkerOne")!.resolve();
		await manager.getJob("WorkerOne")!.promise;
		expect(manager.getJob("WorkerOne")!.status).toBe("completed");
		expect(updates.slice(postReturnStart).every(details => details.blockingActive === false)).toBe(true);
		expect(updates.at(-1)?.results.map(r => r.id)).toEqual(["ScoutOne"]);
	});

	it("keeps blocking activity while async siblings complete before inline results", async () => {
		mockDiscovery();
		const gates = new Map<string, PromiseWithResolvers<void>>();
		const allStarted = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			const gate = Promise.withResolvers<void>();
			gates.set(id, gate);
			options.onProgress?.(makeProgress(id, options.agent.name));
			if (gates.size === 2) allStarted.resolve();
			await gate.promise;
			return makeResult(id, options.agent.name);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));
		const updates: Array<{ text: string; details: TaskToolDetails }> = [];
		const executePromise = tool.execute(
			"tc-mixed-settle",
			{
				context: "ctx",
				tasks: [
					{ name: "ScoutTwo", agent: "scout", task: "Research." },
					{ name: "WorkerTwo", agent: "task", task: "Build." },
				],
			} as TaskParams,
			undefined,
			update => {
				if (update.details) updates.push({ text: firstText(update), details: update.details });
			},
		);

		await allStarted.promise;
		gates.get("WorkerTwo")!.resolve();
		await manager.getJob("WorkerTwo")!.promise;
		expect(updates.at(-1)?.details.async?.state).toBe("completed");
		expect(updates.at(-1)?.details.blockingActive).toBe(true);
		expect(updates.at(-1)?.details.progress?.find(progress => progress.id === "ScoutTwo")?.status).toBe("running");
		gates.get("ScoutTwo")!.resolve();
		const result = await executePromise;

		expect(result.details?.blockingActive).toBe(false);
		expect(result.details?.async?.state).toBe("completed");
		expect(result.details?.results.map(r => r.id)).toEqual(["ScoutTwo"]);
		const completionUpdates = updates.filter(u => u.text.includes("Background task WorkerTwo complete."));
		expect(completionUpdates).toHaveLength(1);
		expect(completionUpdates[0]?.details.blockingActive).toBe(true);
	});

	it("keeps an all-blocking batch active through progress and inactive after return", async () => {
		mockDiscovery();
		const gate = Promise.withResolvers<void>();
		const allStarted = Promise.withResolvers<void>();
		const callbacks = new Map<string, NonNullable<executorModule.ExecutorOptions["onProgress"]>>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			callbacks.set(id, options.onProgress!);
			options.onProgress?.(makeProgress(id, options.agent.name));
			if (callbacks.size === 2) allStarted.resolve();
			await gate.promise;
			return makeResult(id, options.agent.name);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));
		const updates: TaskToolDetails[] = [];
		const executePromise = tool.execute(
			"tc-all-blocking",
			{
				context: "ctx",
				tasks: [
					{ name: "ScoutA", agent: "scout", task: "Research A." },
					{ name: "ScoutB", agent: "scout", task: "Research B." },
				],
			} as TaskParams,
			undefined,
			update => {
				if (update.details) updates.push(update.details);
			},
		);
		await allStarted.promise;
		expect(updates.at(-1)?.blockingActive).toBe(true);
		callbacks.get("ScoutA")!(makeProgress("ScoutA", "scout", "completed"));
		callbacks.get("ScoutB")!(makeProgress("ScoutB", "scout", "completed"));
		expect(updates.at(-1)?.blockingActive).toBe(true);
		gate.resolve();
		const result = await executePromise;

		expect([...callbacks.keys()].sort()).toEqual(["ScoutA", "ScoutB"]);
		expect(result.details?.blockingActive).toBe(false);
		expect(result.details?.async).toBeUndefined();
		expect(result.details?.results.map(r => r.id).sort()).toEqual(["ScoutA", "ScoutB"]);
		expect(manager.getAllJobs()).toHaveLength(0);
		const postReturnStart = updates.length;
		callbacks.get("ScoutA")!(makeProgress("ScoutA", "scout"));
		expect(updates.length).toBeGreaterThan(postReturnStart);
		expect(updates.at(-1)?.blockingActive).toBe(false);
	});

	it("keeps async-only snapshots inactive before and after job completion", async () => {
		mockDiscovery();
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<NonNullable<executorModule.ExecutorOptions["onProgress"]>>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			options.onProgress?.(makeProgress(id, options.agent.name));
			started.resolve(options.onProgress!);
			await gate.promise;
			options.onProgress?.(makeProgress(id, options.agent.name, "completed"));
			return makeResult(id, options.agent.name);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));
		const updates: TaskToolDetails[] = [];
		const result = await tool.execute(
			"tc-async-only",
			{
				context: "ctx",
				tasks: [{ name: "DetachedOnly", agent: "task", task: "Build." }],
			} as TaskParams,
			undefined,
			update => {
				if (update.details) updates.push(update.details);
			},
		);
		const onProgress = await started.promise;
		expect(result.details?.blockingActive).toBe(false);
		expect(result.details?.async?.state).toBe("running");
		onProgress(makeProgress("DetachedOnly", "task"));
		expect(updates.at(-1)?.blockingActive).toBe(false);
		gate.resolve();
		await manager.getJob("DetachedOnly")!.promise;
		expect(updates.length).toBeGreaterThan(0);
		expect(updates.every(details => details.blockingActive === false)).toBe(true);
		expect(updates.at(-1)?.async?.state).toBe("completed");
		onProgress(makeProgress("DetachedOnly", "task"));
		expect(updates.at(-1)?.blockingActive).toBe(false);
	});

	it.each([false, true])("keeps blocking activity during isolation merge with detached sibling=%s", async mixed => {
		mockDiscovery();
		const mergeEntered = Promise.withResolvers<void>();
		const mergeGate = Promise.withResolvers<isolationRunner.IsolationMergeOutcome>();
		const workerStarted = Promise.withResolvers<void>();
		const workerGate = Promise.withResolvers<void>();
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/repo-root" });
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async options => {
			const { baseOptions } = options;
			const id = baseOptions.id ?? "?";
			baseOptions.onProgress?.(makeProgress(id, baseOptions.agent.name, "completed"));
			return makeResult(id, baseOptions.agent.name);
		});
		vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockImplementation(async () => {
			mergeEntered.resolve();
			return mergeGate.promise;
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			options.onProgress?.(makeProgress(id, options.agent.name));
			workerStarted.resolve();
			await workerGate.promise;
			options.onProgress?.(makeProgress(id, options.agent.name, "completed"));
			return makeResult(id, options.agent.name);
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				settings: {
					"async.enabled": true,
					"task.batch": true,
					"task.isolation.enabled": true,
					"task.isolation.apply": true,
					"task.isolation.merge": "patch",
				},
			}),
		);
		const updates: TaskToolDetails[] = [];
		let returned = false;
		const executePromise = tool
			.execute(
				`tc-merge-${mixed}`,
				{
					context: "ctx",
					tasks: [
						{ name: "MergeScout", agent: "scout", task: "Research.", isolated: true },
						...(mixed ? [{ name: "MergeWorker", agent: "task", task: "Build." }] : []),
					],
				} as TaskParams,
				undefined,
				update => {
					if (update.details) updates.push(update.details);
				},
			)
			.then(result => {
				returned = true;
				return result;
			});
		await mergeEntered.promise;
		if (mixed) {
			await workerStarted.promise;
			workerGate.resolve();
			await manager.getJob("MergeWorker")!.promise;
			expect(updates.at(-1)?.async?.state).toBe("completed");
		}
		expect(returned).toBe(false);
		expect(updates.at(-1)?.progress?.find(progress => progress.id === "MergeScout")?.status).toBe("completed");
		expect(updates.at(-1)?.blockingActive).toBe(true);
		mergeGate.resolve({
			summary: "",
			changesApplied: false,
			hadAnyChanges: false,
			mergedBranchForNestedPatches: false,
		});
		const result = await executePromise;
		expect(result.details?.blockingActive).toBe(false);
		expect(result.details?.results.map(item => item.id)).toEqual(["MergeScout"]);
	});

	it("returns inline results and reports the failure when async scheduling fails", async () => {
		mockDiscovery();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			makeResult(options.id ?? "?", options.agent.name),
		);

		// A running non-queued filler job exhausts maxRunningJobs, so the
		// worker spawn's registration throws while the scout still runs inline.
		const filler = Promise.withResolvers<string>();
		const manager = new AsyncJobManager({ maxRunningJobs: 1, onJobComplete: () => {} });
		managers.push(manager);
		manager.register("bash", "filler", () => filler.promise, { id: "filler" });

		const tool = await TaskTool.create(createSession({ manager }));
		const result = await tool.execute("tc-mixed-schedfail", {
			context: "ctx",
			tasks: [
				{ name: "ScoutThree", agent: "scout", task: "Research." },
				{ name: "WorkerThree", agent: "task", task: "Build." },
			],
		} as TaskParams);
		filler.resolve("done");

		const text = firstText(result);
		expect(text).toContain('id="ScoutThree"');
		expect(text).toContain("Failed to schedule 1 spawn");
		expect(text).toContain("WorkerThree");
		expect(result.details?.results.map(r => r.id)).toEqual(["ScoutThree"]);
		expect(result.details?.async?.state).toBe("failed");
		expect(manager.getJob("WorkerThree")).toBeUndefined();
	});
});
