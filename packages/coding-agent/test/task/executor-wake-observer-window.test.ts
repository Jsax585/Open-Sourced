import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "../helpers/session-defaults";

/**
 * Contract under test: the executor installs the turn observer before the
 * accepted first run is published as idle. A peer message can wake the agent the
 * moment it reads idle, and a turn that starts with no observer is invisible to
 * everything that depends on one: the shared turn counter an isolated first
 * capture checks, the settle hook that lands the turn's changes, and the
 * delivery of its result.
 */

type TurnObserver = (records: CustomMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined;

interface MockSession {
	session: AgentSession;
	/** Wake the agent as an IRC peer message would; true when an observer was installed to see it. */
	wake: () => Promise<boolean>;
}

function yieldTurn(
	emit: (event: AgentSessionEvent) => void,
	pushMessage: (message: unknown) => void,
	toolCallId: string,
) {
	const message = {
		role: "assistant" as const,
		content: [
			{
				type: "toolCall" as const,
				id: toolCallId,
				name: "yield",
				arguments: { data: { report: "findings" } },
			},
		],
		stopReason: "toolUse" as const,
	};
	pushMessage(message);
	emit({ type: "message_end", message } as unknown as AgentSessionEvent);
	emit({
		type: "tool_execution_end",
		toolCallId,
		toolName: "yield",
		result: {
			content: [{ type: "text", text: "Result submitted." }],
			details: { status: "success", data: { report: "findings" } },
		},
		isError: false,
	} as AgentSessionEvent);
}

function createMockSession(): MockSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: unknown[] = [];
	let observer: TurnObserver | undefined;
	let promptIndex = 0;

	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...listeners]) listener(event);
	};

	const wake = async (): Promise<boolean> => {
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: "ping",
			display: true,
			details: { id: "m1", from: "Peer", message: "ping" },
			attribution: "agent",
			timestamp: Date.now(),
		};
		const finish = observer?.([record]);
		emit({ type: "agent_start" } as AgentSessionEvent);
		yieldTurn(emit, message => messages.push(message), "tool-woken-yield");
		emit({ type: "agent_end", messages: [] } as unknown as AgentSessionEvent);
		await finish?.();
		return observer !== undefined;
	};

	const session: Partial<AgentSession> = {
		...createSessionDefaults(),
		state: { messages: [] } as never,
		agent: { state: { systemPrompt: ["test"] } } as never,
		model: { api: "anthropic-messages" } as never,
		extensionRunner: undefined as never,
		sessionManager: { appendSessionInit: () => {} } as never,
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			promptIndex += 1;
			if (promptIndex === 1) yieldTurn(emit, message => messages.push(message), "tool-first-yield");
			return true;
		},
		getLastAssistantMessage: () => messages[messages.length - 1] as never,
		sendUserMessage: async () => {},
		setIrcWakeTurnObserver: next => {
			observer = next as TurnObserver | undefined;
		},
		trackIrcReply: () => {},
		isParentIrcSteer: () => false,
		abort: async () => {},
		dispose: async () => {},
	};
	return { session: session as AgentSession, wake };
}

const agent: AgentDefinition = {
	name: "scout",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("runSubprocess wake observer", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		tempDir = TempDir.createSync("@pi-wake-observer-");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		tempDir[Symbol.dispose]();
	});

	function setUp(id: string) {
		const mock = createMockSession();
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: mock.session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} satisfies CreateAgentSessionResult);
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session: mock.session,
			sessionFile: null,
			status: "running",
		});
		const turnsStarted: number[] = [];
		const options = {
			cwd: "/tmp",
			agent,
			task: "inventory the api surface",
			index: 0,
			id,
			settings: Settings.isolated({}),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir: tempDir.path(),
			onFollowUpTurnStarted: () => {
				turnsStarted.push(turnsStarted.length + 1);
			},
		};
		return { mock, options, turnsStarted };
	}

	/** Wake the agent from inside the registry's idle notification, the earliest a peer can see it. */
	function wakeWhenIdle(id: string, wake: () => Promise<boolean>): { woken: Promise<boolean> } {
		const woken = Promise.withResolvers<boolean>();
		let fired = false;
		const unsubscribe = AgentRegistry.global().onChange(event => {
			if (fired || event.type !== "status_changed" || event.ref.id !== id || event.ref.status !== "idle") return;
			fired = true;
			unsubscribe();
			void wake().then(woken.resolve, woken.reject);
		});
		return { woken: woken.promise };
	}

	it("observes a turn that starts the moment the accepted first run reads idle", async () => {
		const id = "AcceptedThenWoken";
		const { mock, options, turnsStarted } = setUp(id);
		const { woken } = wakeWhenIdle(id, mock.wake);

		const result = await runSubprocess(options);

		expect(result.exitCode).toBe(0);
		// An observer was installed when the peer's message arrived...
		expect(await woken).toBe(true);
		// ...so the turn was counted once, not zero times and not twice.
		expect(turnsStarted).toEqual([1]);
	});

	it("observes a turn that starts after the run has returned", async () => {
		const id = "WokenAfterReturn";
		const { mock, options, turnsStarted } = setUp(id);

		const result = await runSubprocess(options);
		expect(result.exitCode).toBe(0);
		expect(turnsStarted).toEqual([]);

		expect(await mock.wake()).toBe(true);
		expect(turnsStarted).toEqual([1]);
	});

	it("does not observe wake turns on a one-shot run", async () => {
		const id = "OneShotScout";
		const { mock, options, turnsStarted } = setUp(id);
		const { woken } = wakeWhenIdle(id, mock.wake);

		const result = await runSubprocess({ ...options, keepAlive: false });

		expect(result.exitCode).toBe(0);
		// A one-shot run is never woken: nothing was installed, nothing counted. Awaiting
		// (not racing) proves the idle notification really fired and saw no observer.
		expect(await woken).toBe(false);
		expect(turnsStarted).toEqual([]);
	});
});
