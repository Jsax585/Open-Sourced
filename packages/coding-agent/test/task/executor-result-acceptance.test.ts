/**
 * Acceptance-boundary contract (#11079): a subagent whose terminal `yield` was
 * accepted must leave `running` and carry its run lifecycle milestones without
 * any parent message or extra poll — on the initial run, on a follow-up turn,
 * and on an autonomous IRC wake turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import { type CursorExecResolvedCarrier, kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	attachIrcWakeTurnMonitor,
	type IrcWakeTurnMonitorOptions,
	runSubagentFollowUpTurn,
	runSubprocess,
} from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const AGENT_ID = "accepted-result";

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

function assistantStopMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface SessionHarness {
	session: AgentSession;
	/** Resolves when the executor has dispatched the session's prompt. */
	promptEntered: Promise<void>;
	/** Emit a successful terminal `yield` tool result through the session event stream. */
	emitTerminalYield: (data: unknown) => void;
	/** End an assistant message carrying `text` and no tool calls. */
	emitAssistantText: (text: string) => void;
	/** End an assistant message carrying `content`, tool calls included. */
	emitAssistantContent: (content: AssistantMessage["content"]) => void;
	/** End the agent loop with every assistant message emitted so far. */
	emitAgentEnd: () => void;
	/** Finish a `toolName` call whose result is `text`. */
	emitToolResult: (toolName: string, text: string) => void;
	/** The observer factory installed by {@link attachIrcWakeTurnMonitor}, if any. */
	wakeObserver: () =>
		| ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined)
		| undefined;
}

/**
 * Minimal session that satisfies the executor's run surface. `prompt` submits a
 * terminal `yield` (so `runSubprocess` / `runSubagentFollowUpTurn` settle), and
 * `subscribeRunState` never fires — the run-state mirror omits `idle`, which is
 * exactly the leak the acceptance boundary must cover.
 */
function createHarness(options?: { hangPrompt?: boolean; asyncJobManager?: AsyncJobManager }): SessionHarness {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: AssistantMessage[] = [];
	const promptEntered = Promise.withResolvers<void>();
	const hangingPrompt = Promise.withResolvers<void>();
	let yieldSeq = 0;
	let toolSeq = 0;
	let wakeObserver: ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined;
	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...listeners]) listener(event);
	};
	const emitAssistantContent = (content: AssistantMessage["content"]) => {
		const message = assistantStopMessage(content);
		messages.push(message);
		emit({ type: "message_end", message } as AgentSessionEvent);
	};
	const emitAssistantText = (text: string) => emitAssistantContent([{ type: "text", text }]);
	const emitAgentEnd = () => emit({ type: "agent_end", messages: [...messages] } as AgentSessionEvent);
	const emitToolResult = (toolName: string, text: string) => {
		toolSeq += 1;
		emit({
			type: "tool_execution_end",
			toolCallId: `${toolName}-${toolSeq}`,
			toolName,
			result: { content: [{ type: "text", text }] },
		} as AgentSessionEvent);
	};
	const emitTerminalYield = (data: unknown) => {
		yieldSeq += 1;
		emit({
			type: "tool_execution_end",
			toolCallId: `yield-${yieldSeq}`,
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data },
			},
		} as AgentSessionEvent);
	};
	const session = {
		state: { messages },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		getToolByName: () => undefined,
		setActiveToolsByName: async () => {},
		setWorkPoolYieldItems: () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string) => {
			promptEntered.resolve();
			if (options?.hangPrompt) {
				await hangingPrompt.promise;
				return true;
			}
			emitAssistantText("submitting");
			emitTerminalYield({ report: text });
			return true;
		},
		waitForIdle: async () => {},
		isAdvisorActive: () => false,
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => messages[messages.length - 1],
		hasPendingAsyncWork: () => false,
		getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
		settleAsyncWork: async () => {},
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: (
			observer: ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined,
		) => {
			wakeObserver = observer;
		},
		trackIrcReply: () => {},
		subscribeRunState: () => () => {},
		isParentIrcSteer: () => false,
		asyncJobManager: options?.asyncJobManager,
	};
	return {
		session: session as unknown as AgentSession,
		promptEntered: promptEntered.promise,
		emitTerminalYield,
		emitAssistantText,
		emitAssistantContent,
		emitAgentEnd,
		emitToolResult,
		wakeObserver: () => wakeObserver,
	};
}

function registerRunning(session: AgentSession) {
	return AgentRegistry.global().register({
		id: AGENT_ID,
		displayName: AGENT_ID,
		kind: "sub",
		session,
		status: "running",
	});
}

async function flushMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe("runSubprocess result acceptance", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it("terminalizes the ref and stamps the run lifecycle when the yield is accepted", async () => {
		const harness = createHarness();
		const ref = registerRunning(harness.session);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: harness.session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as CreateAgentSessionResult);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do the work",
			index: 0,
			id: AGENT_ID,
		});

		expect(result.exitCode).toBe(0);
		const settled = AgentRegistry.global().get(AGENT_ID);
		expect(settled?.status).not.toBe("running");
		expect(settled?.lifecycle?.responseAt).toBeNumber();
		expect(settled?.lifecycle?.acceptedAt).toBeNumber();
		expect(settled?.lifecycle?.terminalAt).toBeNumber();
		expect(AgentRegistry.global().staleAcceptedRuns()).toEqual([]);
		// Launch milestone is the registration timestamp the acceptance must not move.
		expect(settled?.createdAt).toBe(ref.createdAt);
	});

	it("settles the owning task job when Agent Hub tombstones a running subagent", async () => {
		const harness = createHarness({ hangPrompt: true });
		const ref = registerRunning(harness.session);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: harness.session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as CreateAgentSessionResult);
		const delivered = Promise.withResolvers<{ id: string; text: string }>();
		const manager = new AsyncJobManager({
			onJobComplete: (id, text) => delivered.resolve({ id, text }),
		});
		const jobId = manager.register("task", AGENT_ID, async ({ signal }) => {
			const result = await runSubprocess({
				cwd: "/tmp",
				agent: baseAgent,
				task: "do the work",
				index: 0,
				id: AGENT_ID,
				signal,
			});
			if (result.exitCode !== 0) throw new Error(result.abortReason ?? result.error ?? "Task failed");
			return result.output;
		});

		try {
			await harness.promptEntered;
			await harness.session.abort();
			await AgentLifecycleManager.global().release(AGENT_ID, ref, { tombstone: true });

			const job = manager.getJob(jobId);
			expect(job).toBeDefined();
			await flushMicrotasks();
			const settlement = job!.status === "running" ? ("still-running" as const) : ("settled" as const);
			if (settlement === "still-running") manager.cancel(jobId);
			await job!.promise;

			expect(settlement).toBe("settled");
			expect(job!.status).toBe("failed");
			expect(await delivered.promise).toMatchObject({ id: jobId });
		} finally {
			manager.cancel(jobId);
			await manager.dispose({ timeoutMs: 1000 });
		}
	});

	it("terminalizes an existing ref on a follow-up turn whose run-state mirror omits idle", async () => {
		const harness = createHarness();
		registerRunning(harness.session);

		const result = await runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: baseAgent,
			message: "continue",
		});

		expect(result.exitCode).toBe(0);
		const settled = AgentRegistry.global().get(AGENT_ID);
		expect(settled?.status).not.toBe("running");
		expect(settled?.lifecycle?.responseAt).toBeNumber();
		expect(settled?.lifecycle?.acceptedAt).toBeNumber();
		expect(settled?.lifecycle?.terminalAt).toBeNumber();
	});

	it("terminalizes the ref when an autonomous wake turn's yield is accepted", async () => {
		const harness = createHarness();
		registerRunning(harness.session);
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
		const observer = harness.wakeObserver();
		expect(observer).toBeDefined();

		const finish = observer?.([
			{
				role: "custom",
				customType: "irc:incoming",
				content: "wake",
				display: false,
				attribution: "user",
				timestamp: Date.now(),
			} as unknown as AgentMessage,
		]);
		expect(finish).toBeDefined();
		harness.emitTerminalYield({ report: "answered while woken" });
		await finish?.(undefined);

		const settled = AgentRegistry.global().get(AGENT_ID);
		expect(settled?.status).not.toBe("running");
		expect(settled?.lifecycle?.responseAt).toBeNumber();
		expect(settled?.lifecycle?.acceptedAt).toBeNumber();
		expect(settled?.lifecycle?.terminalAt).toBeNumber();
	});

	it("delivers every yield of a woken agent to its parent as a job completion", async () => {
		const manager = new AsyncJobManager({});
		const delivered: string[] = [];
		manager.registerDeliverySink("Parent", (_jobId, text) => {
			delivered.push(text);
		});
		const harness = createHarness({ asyncJobManager: manager });
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");

		try {
			for (const report of ["followup-done", "broadcast-ok"]) {
				const finish = observer([
					{
						role: "custom",
						customType: "irc:incoming",
						content: "follow up",
						display: false,
						details: { id: `msg-${report}`, from: "Parent", message: "follow up" },
						attribution: "agent",
						timestamp: Date.now(),
					} as unknown as AgentMessage,
				]);
				harness.emitTerminalYield({ report });
				// Pending from acceptance until finalization: the parent's `wait` can block on it.
				expect(manager.getRunningJobs({ ownerId: "Parent" }).map(job => job.agentId)).toEqual([AGENT_ID]);
				await finish?.(undefined);
				await manager.waitForAll();
				await manager.drainDeliveries({ timeoutMs: 1000 });
			}

			expect(delivered).toHaveLength(2);
			expect(delivered[0]).toContain("followup-done");
			expect(delivered[1]).toContain("broadcast-ok");
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});

	it("reads the latest message-result completion after an IRC wake instead of the first result", async () => {
		const tempDir = TempDir.createSync("@omp-latest-agent-result-");
		const artifactsDir = tempDir.path();
		const harness = createHarness();
		harness.session.sessionManager.getArtifactsDir = () => artifactsDir;
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, {
			id: AGENT_ID,
			agent: baseAgent,
			structured: false,
			artifactsDir,
		});
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		const reader = new ReadTool({
			cwd: artifactsDir,
			hasUI: false,
			getArtifactsDir: () => artifactsDir,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		});

		try {
			// A completed first run left a structured payload on disk.
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.md`), '{"reports":[{"verdict":"round-1"}]}');
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.json`), '{"reports":[{"verdict":"round-1"}]}');
			const finish = observer([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "review the revised patch",
					display: false,
					details: { id: "msg-revised", from: "Parent", message: "review the revised patch" },
					attribution: "agent",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
			]);
			harness.emitAssistantText('{"reports":[{"verdict":"round-2"}]}');
			await finish?.(undefined);
			AgentRegistry.global().setStatus(AGENT_ID, "idle");

			const resolved = await InternalUrlRouter.instance().resolve(`agent://${AGENT_ID}`);
			expect(resolved.content).toBe('{"reports":[{"verdict":"round-2"}]}');
			const read = await reader.execute("latest-result", { path: `agent://${AGENT_ID}` });
			expect(read.content).toEqual(
				expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("round-2") })]),
			);
			expect(JSON.stringify(read.content)).not.toContain("round-1");
			// The previous structured sidecar must not shadow the new message result.
			const extracted = await InternalUrlRouter.instance().resolve(`agent://${AGENT_ID}/reports/0/verdict`);
			expect(extracted.content).toBe("round-2");
		} finally {
			InternalUrlRouter.resetForTests();
			resetRegisteredArtifactDirsForTests();
			tempDir.removeSync();
		}
	});

	it("preserves the accepted message result and sidecar when a peer wakes the agent", async () => {
		const tempDir = TempDir.createSync("@omp-peer-agent-result-");
		const artifactsDir = tempDir.path();
		const harness = createHarness();
		harness.session.sessionManager.getArtifactsDir = () => artifactsDir;
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent, structured: false, artifactsDir });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		const accepted = '{"report":"accepted verdict"}';

		try {
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.md`), accepted);
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.json`), accepted);
			const finish = observer([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "is line 42 fine?",
					display: false,
					details: { id: "msg-peer", from: "OtherAgent", message: "is line 42 fine?" },
					attribution: "agent",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
			]);
			harness.emitAssistantText("line 42 is fine");
			await finish?.(undefined);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.md`)).text()).toBe(accepted);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.json`)).text()).toBe(accepted);
		} finally {
			tempDir.removeSync();
		}
	});

	it("delivers a user-resumed message result when all execution slots are occupied", async () => {
		const tempDir = TempDir.createSync("@omp-user-resumed-result-");
		const artifactsDir = tempDir.path();
		const manager = new AsyncJobManager({ maxRunningJobs: 1 });
		const blocker = Promise.withResolvers<string>();
		manager.register("bash", "busy", () => blocker.promise, { ownerId: "Other" });
		expect(manager.atCapacity).toBe(true);
		const delivered: string[] = [];
		manager.registerDeliverySink("Parent", (_jobId, text) => {
			delivered.push(text);
		});
		const harness = createHarness({ asyncJobManager: manager });
		harness.session.sessionManager.getArtifactsDir = () => artifactsDir;
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent, structured: false, artifactsDir });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");

		try {
			// The initial run died on a provider error before reporting.
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.md`), "");
			const finish = observer([
				{
					role: "user",
					content: "credits are back, finish the report",
					attribution: "user",
					timestamp: Date.now(),
				},
			]);
			harness.emitAssistantText("## Report\nroot cause found");
			await finish?.(undefined);
			expect(manager.atCapacity).toBe(true);
			await manager.drainDeliveries({ timeoutMs: 1000 });
			AgentRegistry.global().setStatus(AGENT_ID, "idle");

			const resolved = await InternalUrlRouter.instance().resolve(`agent://${AGENT_ID}`);
			expect(resolved.content).toBe("## Report\nroot cause found");
			expect(delivered).toHaveLength(1);
			expect(delivered[0]).toContain("root cause found");
		} finally {
			InternalUrlRouter.resetForTests();
			blocker.resolve("finished");
			resetRegisteredArtifactDirsForTests();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 1000 });
			tempDir.removeSync();
		}
	});

	it("keeps the accepted artifact and sidecar when the parent cancels its wake job before finalization", async () => {
		const tempDir = TempDir.createSync("@omp-cancelled-wake-result-");
		const artifactsDir = tempDir.path();
		const manager = new AsyncJobManager({});
		const harness = createHarness({ asyncJobManager: manager });
		harness.session.sessionManager.getArtifactsDir = () => artifactsDir;
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent, structured: false, artifactsDir });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		const accepted = '{"report":"accepted verdict"}';

		try {
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.md`), accepted);
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.json`), accepted);
			const finish = observer([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "recheck",
					display: false,
					details: { id: "msg-owner", from: "Parent", message: "recheck" },
					attribution: "agent",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
			]);
			harness.emitAssistantText("cancelled answer");
			expect(manager.cancel(AGENT_ID)).toBe(true);
			await finish?.(undefined);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.md`)).text()).toBe(accepted);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.json`)).text()).toBe(accepted);
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
			tempDir.removeSync();
		}
	});

	it("gives a turn the owner woke a job whose widget reads the turn's tool calls and whose progress wait reads", async () => {
		const tempDir = TempDir.createSync("@omp-wake-job-widget-");
		const artifactsDir = tempDir.path();
		const manager = new AsyncJobManager({});
		const harness = createHarness({ asyncJobManager: manager });
		harness.session.sessionManager.getArtifactsDir = () => artifactsDir;
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent, structured: false, artifactsDir });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");

		try {
			const finish = observer([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "label every bash output",
					display: false,
					details: { id: "msg-owner", from: "Parent", message: "label every bash output" },
					attribution: "agent",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
			]);
			harness.emitToolResult("bash", "BENCH tok_s_stream=171");
			const inputs = manager.getJob(AGENT_ID)?.widgetInputs;
			const [tools] = inputs?.sources() ?? [];
			expect(tools?.id).toBe("tools");
			expect(tools?.read(0).text).toContain("» bash\nBENCH tok_s_stream=171");
			expect(inputs?.brief()).toMatchObject({ kind: "task", task: "label every bash output" });

			harness.emitAssistantText("labelled");
			await finish?.(undefined);
			const details = manager.getJob(AGENT_ID)?.latestDetails;
			expect(details?.progress).toMatchObject([{ id: AGENT_ID }]);
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
			tempDir.removeSync();
		}
	});

	it("keeps the accepted artifact and sidecar when an unstructured follow-up starts aborted", async () => {
		const tempDir = TempDir.createSync("@omp-aborted-agent-result-");
		const artifactsDir = tempDir.path();
		const harness = createHarness();
		registerRunning(harness.session);
		vi.spyOn(harness.session, "prompt").mockImplementation(async () => {
			harness.emitAssistantText("cancelled replacement");
			return true;
		});
		const accepted = '{"report":"accepted verdict"}';

		try {
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.md`), accepted);
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.json`), accepted);
			const result = await runSubagentFollowUpTurn({
				id: AGENT_ID,
				agent: baseAgent,
				message: "continue",
				structured: false,
				artifactsDir,
				signal: AbortSignal.abort("cancelled"),
			});
			expect(result.aborted).toBe(true);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.md`)).text()).toBe(accepted);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.json`)).text()).toBe(accepted);
		} finally {
			tempDir.removeSync();
		}
	});

	it.each([true, false])(
		"reports an IRC-only wake accurately to the parent (already messaged: %s)",
		async alreadyMessaged => {
			const manager = new AsyncJobManager({});
			const harness = createHarness({ asyncJobManager: manager });
			const registry = AgentRegistry.global();
			registry.register({
				id: "Parent",
				displayName: "Parent",
				kind: "main",
				session: createHarness().session,
				status: "running",
			});
			registry.register({
				id: AGENT_ID,
				displayName: AGENT_ID,
				kind: "sub",
				parentId: "Parent",
				session: harness.session,
				status: "idle",
			});
			attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
			const observer = harness.wakeObserver();
			if (!observer) throw new Error("wake-turn observer was not registered");
			const parent = {
				cwd: "/tmp",
				settings: Settings.isolated({ "launch.enabled": false }),
				agentRegistry: registry,
				asyncJobManager: manager,
				getAgentId: () => "Parent",
			} as unknown as ToolSession;

			try {
				const finish = observer([
					{
						role: "custom",
						customType: "irc:incoming",
						content: "report your findings",
						display: false,
						details: { id: "msg-report", from: "Parent", message: "report your findings" },
						attribution: "agent",
						timestamp: Date.now(),
					} as unknown as AgentMessage,
				]);
				if (alreadyMessaged) {
					const bus = IrcBus.global();
					const reply = bus.wait("Parent", { from: AGENT_ID }, 1000);
					const receipt = await bus.send({ from: AGENT_ID, to: "Parent", body: "Found the cause." });
					expect(receipt.outcome).not.toBe("failed");
					expect((await reply)?.body).toBe("Found the cause.");
				}
				const waiting = new WaitTool(parent).execute("parent-wait", {});
				// No yield or assistant prose: only the optional IRC message above.
				await finish?.(undefined);
				const result = await waiting;
				const job = result.details?.jobs?.[0];
				expect(job?.status).toBe("completed");
				expect(job?.resultText).toContain(`history://${AGENT_ID}`);
				if (alreadyMessaged) {
					expect(job?.resultText).not.toContain("produced no output");
					expect(job?.resultText).toContain(`${AGENT_ID} sent a message during this turn`);
				} else {
					expect(job?.resultText).toContain("produced no output");
				}
			} finally {
				await manager.dispose({ timeoutMs: 1000 });
			}
		},
	);

	it("blocks the parent's wait on a turn its message woke and returns the turn's answer once", async () => {
		const manager = new AsyncJobManager({});
		const harness = createHarness({ asyncJobManager: manager });
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		const parent = {
			cwd: "/tmp",
			settings: Settings.isolated({ "launch.enabled": false }),
			agentRegistry: AgentRegistry.global(),
			asyncJobManager: manager,
			getAgentId: () => "Parent",
		} as unknown as ToolSession;

		try {
			const finish = observer([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "fix the mask path too",
					display: false,
					details: { id: "msg-mask", from: "Parent", message: "fix the mask path too" },
					attribution: "agent",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
			]);
			const waiting = new WaitTool(parent).execute("parent-wait", {});
			// A conversational answer: the turn ends without a yield.
			harness.emitAssistantText("mask path fixed too");
			await finish?.(undefined);

			const result = await waiting;
			expect(result.details?.jobs?.[0]).toMatchObject({
				id: AGENT_ID,
				status: "completed",
				resultText: "mask path fixed too",
			});
			// The job carries the answer; a relay message would deliver it twice.
			expect(IrcBus.global().take("Parent")).toBeUndefined();
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});

	/** Wake an idle agent from a peer, play `turn`, and return the relay body the peer receives. */
	async function peerWakeRelay(turn: (harness: SessionHarness) => void): Promise<string | undefined> {
		const harness = createHarness();
		const registry = AgentRegistry.global();
		registry.register({
			id: "OtherAgent",
			displayName: "OtherAgent",
			kind: "sub",
			session: createHarness().session,
			status: "running",
		});
		registry.register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");

		const finish = observer([
			{
				role: "custom",
				customType: "irc:incoming",
				content: "is line 42 fine?",
				display: false,
				details: { id: "msg-peer", from: "OtherAgent", message: "is line 42 fine?" },
				attribution: "agent",
				timestamp: Date.now(),
			} as unknown as AgentMessage,
		]);
		const relay = IrcBus.global().wait("OtherAgent", { from: AGENT_ID }, 1000);
		turn(harness);
		harness.emitAgentEnd();
		await finish?.(undefined);
		return (await relay)?.body;
	}

	it("relays only a woken agent's final report, not the narration before its tool calls", async () => {
		const body = await peerWakeRelay(harness => {
			harness.emitAssistantContent([
				{ type: "text", text: "Checking." },
				{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/a.ts" } },
			]);
			harness.emitAssistantText("Answer.");
		});
		expect(body).toBe("Answer.");
	});

	it("does not relay narration that preceded a woken agent's last Cursor-resolved call", async () => {
		const body = await peerWakeRelay(harness => {
			const resolvedCall: ToolCall & CursorExecResolvedCarrier = {
				type: "toolCall",
				id: "exec-1",
				name: "bash",
				arguments: { command: "bun test" },
			};
			resolvedCall[kCursorExecResolved] = true;
			harness.emitAssistantContent([{ type: "text", text: "Running the tests." }, resolvedCall]);
		});
		expect(body).not.toContain("Running the tests.");
		expect(body).toContain("produced no output");
	});

	describe("follow-up turn settle hook", () => {
		const NOTICE = "\n\nMerged branch: omp/task/accepted-result";

		function ircRecord(from: string, message: string): AgentMessage {
			return {
				role: "custom",
				customType: "irc:incoming",
				content: message,
				display: false,
				details: { id: `msg-${from}`, from, message },
				attribution: "agent",
				timestamp: Date.now(),
			} as unknown as AgentMessage;
		}

		/** A kept-alive subagent owned by `Parent`, a registered peer, and a settle hook that reports {@link NOTICE}. */
		function setUp(
			onSettled: (superseded: () => boolean) => Promise<string> = async () => NOTICE,
			monitorOptions: { structured?: boolean; artifactsDir?: string } = {},
		) {
			const manager = new AsyncJobManager({});
			const harness = createHarness({ asyncJobManager: manager });
			const registry = AgentRegistry.global();
			for (const id of ["Parent", "Peer"]) {
				registry.register({
					id,
					displayName: id,
					kind: "main",
					session: createHarness().session,
					status: "running",
				});
			}
			registry.register({
				id: AGENT_ID,
				displayName: AGENT_ID,
				kind: "sub",
				parentId: "Parent",
				session: harness.session,
				status: "idle",
			});
			const settle = vi.fn((_result: unknown, superseded: () => boolean) => onSettled(superseded));
			const started = vi.fn();
			const monitor: IrcWakeTurnMonitorOptions = {
				id: AGENT_ID,
				agent: baseAgent,
				onTurnSettled: settle,
				onTurnStarted: started,
				...monitorOptions,
			};
			attachIrcWakeTurnMonitor(harness.session, monitor);
			const observer = harness.wakeObserver();
			if (!observer) throw new Error("wake-turn observer was not registered");
			const parent = {
				cwd: "/tmp",
				settings: Settings.isolated({ "launch.enabled": false }),
				agentRegistry: registry,
				asyncJobManager: manager,
				getAgentId: () => "Parent",
			} as unknown as ToolSession;
			return { manager, harness, observer, settle, started, parent, monitor };
		}

		it("does not settle a turn whose outcome only reaches a peer", async () => {
			const { manager, harness, observer, settle } = setUp();
			try {
				const relayed = IrcBus.global().wait("Peer", { from: AGENT_ID }, 1000);
				const finish = observer([ircRecord("Peer", "is line 42 fine?")]);
				harness.emitAssistantText("line 42 is fine");
				await finish?.(undefined);

				// The owner hears nothing of this turn, so its checkout must not change.
				expect(settle).not.toHaveBeenCalled();
				expect(manager.getRunningJobs({ ownerId: "Parent" })).toEqual([]);
				const relay = await relayed;
				expect(relay?.body).toContain("line 42 is fine");
				expect(relay?.body).not.toContain("Merged branch");
			} finally {
				await manager.dispose({ timeoutMs: 1000 });
			}
		});

		it("settles a turn the owner woke and appends the notice to the owner's job", async () => {
			const { manager, harness, observer, settle, parent } = setUp();
			const send = vi.spyOn(IrcBus.global(), "send");
			try {
				const finish = observer([ircRecord("Parent", "fix the mask path too")]);
				const waiting = new WaitTool(parent).execute("parent-wait", {});
				harness.emitAssistantText("mask path fixed too");
				await finish?.(undefined);

				expect(settle).toHaveBeenCalledTimes(1);
				const job = (await waiting).details?.jobs?.[0];
				expect(job?.status).toBe("completed");
				expect(job?.resultText).toContain("mask path fixed too");
				expect(job?.resultText?.endsWith(NOTICE)).toBe(true);
				// The job carried the notice, so the owner is not messaged a second time.
				expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ to: "Parent" }));
			} finally {
				await manager.dispose({ timeoutMs: 1000 });
			}
		});

		/** A turn the operator typed to the agent directly, as the Agent Hub focus does. */
		function userRecord(message: string): AgentMessage {
			return {
				role: "user",
				content: [{ type: "text", text: message }],
				attribution: "user",
				timestamp: Date.now(),
			} as unknown as AgentMessage;
		}

		it("settles an operator-prompted turn and delivers the notice while the owner's job manager is live", async () => {
			const tempDir = TempDir.createSync("@omp-user-prompted-settle-");
			const { manager, harness, observer, settle } = setUp(undefined, {
				structured: false,
				artifactsDir: tempDir.path(),
			});
			harness.session.sessionManager.getArtifactsDir = () => tempDir.path();
			const send = vi.spyOn(IrcBus.global(), "send");
			try {
				const finish = observer([userRecord("fix it")]);
				harness.emitAssistantText("fixed");
				await finish?.(undefined);

				expect(settle).toHaveBeenCalledTimes(1);
				expect(manager.getJob(AGENT_ID)?.resultText?.endsWith(NOTICE)).toBe(true);
				// The live manager delivered the result, so the owner is not messaged a second time.
				expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ to: "Parent" }));
			} finally {
				await manager.dispose({ timeoutMs: 1000 });
				tempDir.removeSync();
			}
		});

		it("does not land an operator-prompted turn when the owner's job manager can no longer take the result", async () => {
			const tempDir = TempDir.createSync("@omp-user-prompted-disposed-");
			const { manager, harness, observer, settle } = setUp(undefined, {
				structured: false,
				artifactsDir: tempDir.path(),
			});
			harness.session.sessionManager.getArtifactsDir = () => tempDir.path();
			try {
				const finish = observer([userRecord("fix it")]);
				harness.emitAssistantText("fixed");
				// The owner is shutting down while the turn finishes: publishCompleted would throw.
				await manager.dispose({ timeoutMs: 1000 });
				await finish?.(undefined);

				// Landing now would change the checkout with no way to tell the owner.
				expect(settle).not.toHaveBeenCalled();
			} finally {
				tempDir.removeSync();
			}
		});

		it("does not land a turn whose owner cancelled the wake job before settlement", async () => {
			const { manager, harness, observer, settle } = setUp();
			try {
				const finish = observer([ircRecord("Parent", "fix the mask path too")]);
				harness.emitAssistantText("mask path fixed too");
				expect(manager.cancel(AGENT_ID, { ownerId: "Parent" })).toBe(true);
				await finish?.(undefined);

				expect(settle).not.toHaveBeenCalled();
				expect(manager.getJob(AGENT_ID)?.status).toBe("cancelled");
			} finally {
				await manager.dispose({ timeoutMs: 1000 });
			}
		});

		it("tells the owner what landed when it cancels the wake job while the turn settles", async () => {
			const settling = Promise.withResolvers<void>();
			const proceed = Promise.withResolvers<void>();
			const { manager, harness, observer, settle } = setUp(async () => {
				settling.resolve();
				await proceed.promise;
				return NOTICE;
			});
			try {
				const told = IrcBus.global().wait("Parent", { from: AGENT_ID }, 1000);
				const finish = observer([ircRecord("Parent", "fix the mask path too")]);
				harness.emitAssistantText("mask path fixed too");
				const finished = finish?.(undefined);
				await settling.promise;
				// The owner gives up the turn while its changes are landing.
				expect(manager.cancel(AGENT_ID, { ownerId: "Parent" })).toBe(true);
				proceed.resolve();
				await finished;

				expect(settle).toHaveBeenCalledTimes(1);
				expect(manager.getJob(AGENT_ID)?.status).toBe("cancelled");
				// A cancelled job delivers nothing, so this is the owner's only word that its checkout changed.
				expect((await told)?.body?.endsWith(NOTICE)).toBe(true);
			} finally {
				await manager.dispose({ timeoutMs: 1000 });
			}
		});

		it("tells the owner of an operator-prompted turn what landed when its job manager disposes while the turn settles", async () => {
			const tempDir = TempDir.createSync("@omp-user-prompted-dispose-during-settle-");
			const settling = Promise.withResolvers<void>();
			const proceed = Promise.withResolvers<void>();
			const { manager, harness, observer, settle } = setUp(
				async () => {
					settling.resolve();
					await proceed.promise;
					return NOTICE;
				},
				{ structured: false, artifactsDir: tempDir.path() },
			);
			harness.session.sessionManager.getArtifactsDir = () => tempDir.path();
			try {
				const told = IrcBus.global().wait("Parent", { from: AGENT_ID }, 1000);
				const finish = observer([userRecord("fix it")]);
				harness.emitAssistantText("fixed");
				const finished = finish?.(undefined);
				await settling.promise;
				// The owner starts shutting down while the changes are landing.
				const disposing = manager.dispose({ timeoutMs: 1000 });
				proceed.resolve();
				await finished;
				await disposing;

				expect(settle).toHaveBeenCalledTimes(1);
				// The manager refuses the result, so the owner hears of it directly.
				const message = await told;
				expect(message?.body).toContain("fixed");
				expect(message?.body?.endsWith(NOTICE)).toBe(true);
			} finally {
				tempDir.removeSync();
			}
		});

		it("settles an owner-woken turn and relays the notice when the owner's job cannot be registered", async () => {
			const { manager, harness, observer, settle } = setUp();
			vi.spyOn(manager, "register").mockImplementation(() => {
				throw new Error("running-job limit reached");
			});
			try {
				const relayed = IrcBus.global().wait("Parent", { from: AGENT_ID }, 1000);
				const finish = observer([ircRecord("Parent", "fix the mask path too")]);
				harness.emitAssistantText("mask path fixed too");
				await finish?.(undefined);

				// The relay is the owner's only word of this turn, so it carries the notice.
				expect(settle).toHaveBeenCalledTimes(1);
				const relay = await relayed;
				expect(relay?.body).toContain("mask path fixed too");
				expect(relay?.body?.endsWith(NOTICE)).toBe(true);
			} finally {
				await manager.dispose({ timeoutMs: 1000 });
			}
		});

		it("still tells a peer the agent already answered what became of the turn's changes", async () => {
			const { manager, harness, observer, settle, parent } = setUp();
			try {
				const bus = IrcBus.global();
				const finish = observer([ircRecord("Parent", "fix it"), ircRecord("Peer", "ping me when done")]);
				const waiting = new WaitTool(parent).execute("parent-wait", {});
				// The agent answers the peer itself during the turn.
				const answered = bus.wait("Peer", { from: AGENT_ID }, 1000);
				expect((await bus.send({ from: AGENT_ID, to: "Peer", body: "done" })).outcome).not.toBe("failed");
				expect((await answered)?.body).toBe("done");
				const relayed = bus.wait("Peer", { from: AGENT_ID }, 1000);
				harness.emitAssistantText("fixed");
				await finish?.(undefined);

				expect(settle).toHaveBeenCalledTimes(1);
				// Only the notice: repeating the answer would duplicate the agent's own message.
				expect((await relayed)?.body).toBe(NOTICE.trim());
				expect((await waiting).details?.jobs?.[0]?.resultText?.endsWith(NOTICE)).toBe(true);
			} finally {
				await manager.dispose({ timeoutMs: 1000 });
			}
		});

		it("tells the settle hook once the agent's next turn has started", async () => {
			const checks: Array<() => boolean> = [];
			const settling = Promise.withResolvers<void>();
			const proceed = Promise.withResolvers<void>();
			const { manager, harness, observer } = setUp(async superseded => {
				checks.push(superseded);
				settling.resolve();
				await proceed.promise;
				return NOTICE;
			});
			try {
				const finish = observer([ircRecord("Parent", "fix it")]);
				harness.emitAssistantText("fixed");
				const finished = finish?.(undefined);
				await settling.promise;
				expect(checks[0]?.()).toBe(false);
				// The session lets the next turn begin while the last one's observation finishes.
				const next = observer([ircRecord("Peer", "one more thing")]);
				expect(checks[0]?.()).toBe(true);
				proceed.resolve();
				await finished;
				harness.emitAssistantText("done");
				await next?.(undefined);
				expect(checks).toHaveLength(1);
			} finally {
				await manager.dispose({ timeoutMs: 1000 });
			}
		});

		it("tells the settle hook about a turn the warm-revived session starts", async () => {
			const checks: Array<() => boolean> = [];
			const settling = Promise.withResolvers<void>();
			const proceed = Promise.withResolvers<void>();
			const { manager, harness, observer, monitor } = setUp(async superseded => {
				checks.push(superseded);
				settling.resolve();
				await proceed.promise;
				return NOTICE;
			});
			try {
				const finish = observer([ircRecord("Parent", "fix it")]);
				harness.emitAssistantText("fixed");
				const finished = finish?.(undefined);
				await settling.promise;
				expect(checks[0]?.()).toBe(false);

				// The idle TTL parked the agent while its last turn was still settling, and
				// a peer message revived it. The warm reviver attaches a new monitor with
				// the same options object, on a new session.
				const revived = createHarness({ asyncJobManager: manager });
				attachIrcWakeTurnMonitor(revived.session, monitor);
				const revivedObserver = revived.wakeObserver();
				if (!revivedObserver) throw new Error("revived wake-turn observer was not registered");
				const next = revivedObserver([ircRecord("Peer", "one more thing")]);

				// The old turn's capture would read the workspace the new turn is editing.
				expect(checks[0]?.()).toBe(true);
				proceed.resolve();
				await finished;
				revived.emitAssistantText("done");
				await next?.(undefined);
			} finally {
				await manager.dispose({ timeoutMs: 1000 });
			}
		});

		it("reports each turn as it starts, including one only a peer hears of", async () => {
			const { manager, harness, observer, started } = setUp();
			try {
				// Any turn may edit the workspace, so the owner of the run is told before it does.
				const peerTurn = observer([ircRecord("Peer", "is line 42 fine?")]);
				expect(started).toHaveBeenCalledTimes(1);
				harness.emitAssistantText("line 42 is fine");
				await peerTurn?.(undefined);
				const ownerTurn = observer([ircRecord("Parent", "fix it")]);
				expect(started).toHaveBeenCalledTimes(2);
				harness.emitAssistantText("fixed");
				await ownerTurn?.(undefined);
				expect(started).toHaveBeenCalledTimes(2);
			} finally {
				await manager.dispose({ timeoutMs: 1000 });
			}
		});
	});
});
