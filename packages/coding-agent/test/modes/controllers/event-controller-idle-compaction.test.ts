import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { Component } from "@oh-my-pi/pi-tui";
import { RecapNotice } from "@oh-my-pi/pi-tui/chat/recap-notice";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

import { cfgCompactionIdleEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { cfgRecapEnabled, cfgRecapIdleSeconds } from "@oh-my-pi/pi-coding-agent/modes/settings";

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
	}
}

/** `present` stand-in for spies: the controller only hands content over. */
function recordPresented(_content: Component | readonly Component[]): void {}

/** Data of every `completion-recap` custom entry on the manager's active branch, oldest first. */
function recapRecords(manager: SessionManager): unknown[] {
	return manager
		.getBranch()
		.flatMap(entry => (entry.type === "custom" && entry.customType === "completion-recap" ? [entry.data] : []));
}

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 200,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 210,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createContext(
	options: {
		goalObjective?: string;
		isCompacting?: boolean;
		isStreaming?: boolean;
		runIdleCompaction?: AgentSession["runIdleCompaction"];
		promptCacheEntry?: AgentSession["promptCacheEntry"];
		model?: AgentSession["model"];
		runEphemeralTurn?: AgentSession["runEphemeralTurn"];
		present?: InteractiveModeContext["present"];
		sessionName?: string;
		sessionManager?: SessionManager;
		todoPhases?: InteractiveModeContext["todoPhases"];
	} = {},
) {
	const runIdleCompaction = options.runIdleCompaction ?? (async () => {});
	const runEphemeralTurn =
		options.runEphemeralTurn ?? (async () => ({ replyText: "", assistantMessage: createAssistantMessage() }));
	const goalState: GoalModeState | undefined = options.goalObjective
		? {
				enabled: true,
				mode: "active",
				goal: {
					id: "goal-test",
					objective: options.goalObjective,
					status: "active",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: 0,
					updatedAt: 0,
				},
			}
		: undefined;
	return createInteractiveModeContext({
		sessionManager: options.sessionManager ?? { getSessionName: () => options.sessionName },
		todoPhases: options.todoPhases ?? [],
		...(options.present ? { present: options.present } : {}),
		session: {
			isCompacting: options.isCompacting ?? false,
			isStreaming: options.isStreaming ?? false,
			runIdleCompaction,
			promptCacheEntry: options.promptCacheEntry,
			runEphemeralTurn,
			model: options.model ?? { provider: "anthropic", id: "claude-sonnet-4-5" },
			messages: [createAssistantMessage()],
			getContextUsage: () => ({ tokens: 210, contextWindow: 1_000, percent: 21 }),
			getGoalModeState: () => goalState,
		},
	});
}

describe("EventController idle compaction teardown", () => {
	beforeEach(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": true,
				"compaction.idleThresholdTokens": 100,
				"compaction.idleTimeoutSeconds": 60,
			},
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("cancels scheduled idle compaction when disposed", async () => {
		const runIdleCompaction = vi.fn(async () => {});
		const context = createContext({ runIdleCompaction });

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		controller.dispose();
		vi.advanceTimersByTime(60_000);

		expect(runIdleCompaction).not.toHaveBeenCalled();
	});

	it("arms idle compaction when it is enabled after the turn becomes idle", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleThresholdTokens": 100,
				"compaction.idleTimeoutSeconds": 60,
			},
		});
		const runIdleCompaction = vi.fn();
		const context = createContext({ runIdleCompaction });
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });

		cfgCompactionIdleEnabled.set(settings, true);
		controller.refreshIdleCompactionTimer();
		vi.advanceTimersByTime(60_000);

		expect(runIdleCompaction).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("waits for the prompt cache lifetime instead of the fallback delay when it is known", async () => {
		const runIdleCompaction = vi.fn(async () => {});
		const context = createContext({
			runIdleCompaction,
			promptCacheEntry: { touchedAt: Date.now(), tier: "long", ttlMs: 3_600_000 },
		});
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });

		// The 60s fallback would have fired long ago; the 1h entry is refreshed at 54 min.
		vi.advanceTimersByTime(54 * 60_000 - 5_001);
		expect(runIdleCompaction).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(runIdleCompaction).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("compacts right away when the turn settles past the refresh point but before expiry", async () => {
		const runIdleCompaction = vi.fn(async () => {});
		const context = createContext({
			runIdleCompaction,
			promptCacheEntry: { touchedAt: Date.now() - 59 * 60_000, tier: "long", ttlMs: 3_600_000 },
		});
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });

		// The entry expires in one minute; the 60s fallback would land after it.
		vi.advanceTimersByTime(1);
		expect(runIdleCompaction).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("falls back to the configured delay once the cache entry has lapsed", async () => {
		const runIdleCompaction = vi.fn(async () => {});
		const context = createContext({
			runIdleCompaction,
			promptCacheEntry: { touchedAt: Date.now() - 2 * 3_600_000, tier: "long", ttlMs: 3_600_000 },
		});
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });

		vi.advanceTimersByTime(59_999);
		expect(runIdleCompaction).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(runIdleCompaction).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("ignores a live 5-minute cache entry and keeps the configured delay", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": true,
				"compaction.idleThresholdTokens": 100,
				"compaction.idleTimeoutSeconds": 600,
			},
		});
		const runIdleCompaction = vi.fn(async () => {});
		const context = createContext({
			runIdleCompaction,
			promptCacheEntry: { touchedAt: Date.now(), tier: "short", ttlMs: 300_000 },
		});
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });

		// Cache timing would compact at ~4.4 min; the configured 10 min wins.
		vi.advanceTimersByTime(600_000 - 1);
		expect(runIdleCompaction).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(runIdleCompaction).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("never idle-compacts a logged-in Codex session whose prompt cache does not expire", async () => {
		const runIdleCompaction = vi.fn(async () => {});
		const codex = getBundledModels("openai-codex").find(model => model.api === "openai-codex-responses");
		expect(codex).toBeDefined();
		const context = createContext({ runIdleCompaction, model: codex });
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });

		vi.advanceTimersByTime(3_600_000);
		expect(runIdleCompaction).not.toHaveBeenCalled();
		controller.dispose();
	});

	it("arms the idle recap when enabled mid-idle and never re-delivers a shown recap", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": false,
				"completion.notify": "off",
				"recap.enabled": false,
				"recap.idleSeconds": 60,
			},
		});
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "Recap body.",
			assistantMessage: createAssistantMessage(),
		}));
		const context = createContext({ runEphemeralTurn });
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });

		cfgRecapEnabled.override(settings, true);
		controller.refreshIdleRecapTimer();
		vi.advanceTimersByTime(60_000);
		await flushMicrotasks();
		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);

		// Same idle window: a later setting change must not schedule a second recap.
		cfgRecapIdleSeconds.override(settings, 90);
		controller.refreshIdleRecapTimer();
		vi.advanceTimersByTime(90_000);
		await flushMicrotasks();
		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("emits an LLM-generated recap after the default four-minute delay", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": false,
				"completion.notify": "off",
			},
		});
		const present = vi.fn(recordPresented);
		let capturedPrompt = "";
		const runEphemeralTurn = vi.fn(async (args: { promptText: string; signal?: AbortSignal }) => {
			capturedPrompt = args.promptText;
			return {
				replyText: "Reworking the login flow; auth suite passes. Next: wire the focused token-refresh test.",
				assistantMessage: createAssistantMessage(),
			};
		});
		const context = createContext({
			sessionName: "Fix login flow",
			present,
			runEphemeralTurn,
			todoPhases: [{ name: "Work", tasks: [{ content: "Wire focused tests", status: "pending" }] }],
		});

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(239_999);
		expect(runEphemeralTurn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		await flushMicrotasks();

		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		// Live goal/title and the active todo task anchor the recap prompt the snapshot can't guarantee.
		expect(capturedPrompt).toContain("Fix login flow");
		expect(capturedPrompt).toContain("Wire focused tests");

		const notice = present.mock.calls
			.map(([content]) => content)
			.find((content): content is RecapNotice => content instanceof RecapNotice);
		expect(notice?.render(200).map(line => Bun.stripANSI(line).trim())).toEqual([
			"",
			"※ recap: Reworking the login flow; auth suite passes. Next: wire the focused token-refresh test.",
		]);
		controller.dispose();
	});

	it("aborts the in-flight recap and drops its late reply when disposed", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": false,
				"completion.notify": "off",
			},
		});
		const { promise, resolve } = Promise.withResolvers<{ replyText: string; assistantMessage: AssistantMessage }>();
		let receivedSignal: AbortSignal | undefined;
		const runEphemeralTurn = vi.fn((args: { promptText: string; signal?: AbortSignal }) => {
			receivedSignal = args.signal;
			return promise;
		});
		const present = vi.fn(recordPresented);
		const context = createContext({ sessionName: "Fix login flow", present, runEphemeralTurn });

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(240_000);
		await flushMicrotasks();

		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		expect(receivedSignal?.aborted).toBe(false);

		controller.dispose();
		expect(receivedSignal?.aborted).toBe(true);

		// A reply that lands after cancellation must not paint a stale recap.
		resolve({ replyText: "stale recap", assistantMessage: createAssistantMessage() });
		await flushMicrotasks();
		expect(present.mock.calls.some(([content]) => content instanceof RecapNotice)).toBe(false);
	});

	it("records a turn-bound recap without adding model messages and clears it on new work", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: { "compaction.idleEnabled": false, "completion.notify": "off" },
		});
		const manager = SessionManager.inMemory();
		const turnId = manager.appendMessage(createAssistantMessage());
		const before = manager.buildSessionContext().messages;
		const present = vi.fn(recordPresented);
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "Fixed the parser; the next step is review.",
			assistantMessage: createAssistantMessage(),
		}));
		const controller = new EventController(createContext({ sessionManager: manager, present, runEphemeralTurn }));
		try {
			await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
			vi.advanceTimersByTime(240_000);
			await flushMicrotasks();
			expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
			expect(present.mock.calls.some(([content]) => content instanceof RecapNotice)).toBe(true);
			expect(recapRecords(manager)).toEqual([
				{
					version: 1,
					sessionId: manager.getSessionId(),
					turnId,
					state: "available",
					text: "Fixed the parser; the next step is review.",
				},
			]);
			expect(manager.buildSessionContext().messages).toEqual(before);

			await controller.handleEvent({ type: "agent_start" });
			expect(recapRecords(manager).at(-1)).toEqual({
				version: 1,
				sessionId: manager.getSessionId(),
				turnId,
				state: "cleared",
			});
			expect(manager.buildSessionContext().messages).toEqual(before);
		} finally {
			controller.dispose();
		}
	});

	it.each(["user", "assistant"])("drops a recap after newer %s work arrives during generation", async latestRole => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: { "compaction.idleEnabled": false, "completion.notify": "off" },
		});
		const manager = SessionManager.inMemory();
		manager.appendMessage(createAssistantMessage());
		const { promise, resolve } = Promise.withResolvers<{ replyText: string; assistantMessage: AssistantMessage }>();
		const present = vi.fn(recordPresented);
		const controller = new EventController(
			createContext({ sessionManager: manager, present, runEphemeralTurn: () => promise }),
		);
		try {
			await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
			vi.advanceTimersByTime(240_000);
			await flushMicrotasks();
			manager.appendMessage({ role: "user", content: "New work", timestamp: Date.now() });
			if (latestRole === "assistant") manager.appendMessage(createAssistantMessage());
			resolve({ replyText: "The previous turn is finished.", assistantMessage: createAssistantMessage() });
			await flushMicrotasks();
			expect(present.mock.calls.some(([content]) => content instanceof RecapNotice)).toBe(false);
			expect(recapRecords(manager)).toEqual([]);
		} finally {
			controller.dispose();
		}
	});

	it("drops a recap after a newer user message follows a turn that ended without a reply", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: { "compaction.idleEnabled": false, "completion.notify": "off" },
		});
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "First request", timestamp: Date.now() });
		const { promise, resolve } = Promise.withResolvers<{ replyText: string; assistantMessage: AssistantMessage }>();
		const present = vi.fn(recordPresented);
		const recordRecap = vi.spyOn(manager, "recordRecap");
		const controller = new EventController(
			createContext({ sessionManager: manager, present, runEphemeralTurn: () => promise }),
		);
		try {
			await controller.handleEvent({ type: "agent_end", messages: [] });
			vi.advanceTimersByTime(240_000);
			await flushMicrotasks();
			manager.appendMessage({ role: "user", content: "Second request", timestamp: Date.now() });
			resolve({ replyText: "The first request is finished.", assistantMessage: createAssistantMessage() });
			await flushMicrotasks();
			expect(present.mock.calls.some(([content]) => content instanceof RecapNotice)).toBe(false);
			expect(recordRecap).not.toHaveBeenCalled();
			expect(recapRecords(manager)).toEqual([]);
		} finally {
			controller.dispose();
		}
	});

	it("clears a session's recap when it starts work while another session is viewed", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: { "compaction.idleEnabled": false, "completion.notify": "off" },
		});
		const main = SessionManager.inMemory();
		const turnId = main.appendMessage(createAssistantMessage());
		const context = createContext({
			sessionManager: main,
			runEphemeralTurn: async () => ({ replyText: "Main is done.", assistantMessage: createAssistantMessage() }),
		});
		let mainListener: ((event: { type: string }) => void) | undefined;
		Object.assign(context.session, {
			subscribe: (listener: (event: { type: string }) => void) => {
				mainListener = listener;
				return () => {
					mainListener = undefined;
				};
			},
		});
		const controller = new EventController(context);
		try {
			await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
			vi.advanceTimersByTime(240_000);
			await flushMicrotasks();
			expect(recapRecords(main).at(-1)).toMatchObject({ turnId, state: "available" });

			// Focus a worker: from here the controller only sees the worker's events.
			const workerManager = SessionManager.inMemory();
			workerManager.appendMessage(createAssistantMessage());
			const worker = { ...context.session, sessionManager: workerManager };
			Object.defineProperty(context, "viewSession", { get: () => worker });
			mainListener?.({ type: "agent_start" });

			expect(recapRecords(main).at(-1)).toEqual({
				version: 1,
				sessionId: main.getSessionId(),
				turnId,
				state: "cleared",
			});
			expect(recapRecords(workerManager)).toEqual([]);
			expect(mainListener).toBeUndefined();
		} finally {
			controller.dispose();
		}
	});

	it("keeps published and cleared recaps in the session file without changing model context", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: { "compaction.idleEnabled": false, "completion.notify": "off" },
		});
		// Real file I/O runs on real timers; only the recap delay uses the fake clock.
		vi.useRealTimers();
		const dir = await mkdtemp(join(tmpdir(), "omp-recap-"));
		const manager = SessionManager.create(dir, dir);
		const turnId = manager.appendMessage(createAssistantMessage());
		const before = manager.buildSessionContext().messages;
		const controller = new EventController(
			createContext({
				sessionManager: manager,
				runEphemeralTurn: async () => ({
					replyText: "Fixed the parser; the next step is review.",
					assistantMessage: createAssistantMessage(),
				}),
			}),
		);
		let reopened: SessionManager | undefined;
		try {
			await manager.flush();
			vi.useFakeTimers();
			await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
			vi.advanceTimersByTime(240_000);
			await flushMicrotasks();
			vi.useRealTimers();
			await controller.handleEvent({ type: "agent_start" });
			await manager.flush();

			reopened = await SessionManager.open(manager.getSessionFile()!, dir);
			expect(recapRecords(reopened)).toEqual([
				{
					version: 1,
					sessionId: manager.getSessionId(),
					turnId,
					state: "available",
					text: "Fixed the parser; the next step is review.",
				},
				{ version: 1, sessionId: manager.getSessionId(), turnId, state: "cleared" },
			]);
			expect(reopened.buildSessionContext().messages).toEqual(before);
		} finally {
			controller.dispose();
			vi.useRealTimers();
			await reopened?.close();
			await manager.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("records a focused session's recap in the focused session only", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: { "compaction.idleEnabled": false, "completion.notify": "off" },
		});
		const main = SessionManager.inMemory();
		main.appendMessage(createAssistantMessage());
		const context = createContext({ sessionManager: main });
		const focusedManager = SessionManager.inMemory();
		const focusedTurn = focusedManager.appendMessage(createAssistantMessage());
		const focused = {
			...context.session,
			sessionManager: focusedManager,
			runEphemeralTurn: async () => ({
				replyText: "The focused agent is mid-refactor.",
				assistantMessage: createAssistantMessage(),
			}),
		};
		Object.defineProperty(context, "viewSession", { get: () => focused });
		const controller = new EventController(context);
		try {
			await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
			vi.advanceTimersByTime(240_000);
			await flushMicrotasks();
			expect(recapRecords(focusedManager)).toEqual([
				{
					version: 1,
					sessionId: focusedManager.getSessionId(),
					turnId: focusedTurn,
					state: "available",
					text: "The focused agent is mid-refactor.",
				},
			]);
			expect(recapRecords(main)).toEqual([]);
		} finally {
			controller.dispose();
		}
	});

	it("drops a recap when the view switches to another session during generation", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: { "compaction.idleEnabled": false, "completion.notify": "off" },
		});
		const main = SessionManager.inMemory();
		main.appendMessage(createAssistantMessage());
		const { promise, resolve } = Promise.withResolvers<{ replyText: string; assistantMessage: AssistantMessage }>();
		const present = vi.fn(recordPresented);
		const context = createContext({ sessionManager: main, present, runEphemeralTurn: () => promise });
		const controller = new EventController(context);
		try {
			await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
			vi.advanceTimersByTime(240_000);
			await flushMicrotasks();
			const otherManager = SessionManager.inMemory();
			otherManager.appendMessage(createAssistantMessage());
			const other = { ...context.session, sessionManager: otherManager };
			Object.defineProperty(context, "viewSession", { get: () => other });
			resolve({ replyText: "The previous view's recap.", assistantMessage: createAssistantMessage() });
			await flushMicrotasks();
			expect(present.mock.calls.some(([content]) => content instanceof RecapNotice)).toBe(false);
			expect(recapRecords(main)).toEqual([]);
			expect(recapRecords(otherManager)).toEqual([]);
		} finally {
			controller.dispose();
		}
	});
});
