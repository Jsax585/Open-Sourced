import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

function createMockSession(onPrompt: (emit: (event: AgentSessionEvent) => void) => void | Promise<void>): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		...createSessionDefaults(),
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			await onPrompt(emit);
			return true;
		},
		getLastAssistantMessage: () => undefined,
		hasPendingAsyncWork: () => false,
		abort: async () => {},
	};
	return session as unknown as AgentSession;
}
function mockCreateAgentSession(session: AgentSession) {
	const result = {
		session,
		extensionsResult: {},
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} as unknown as CreateAgentSessionResult;
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(result);
}
const baseAgent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
const baseOptions = {
	cwd: "/tmp",
	agent: baseAgent,
	task: "do work",
	index: 0,
	id: "subagent-runtime",
	settings: Settings.isolated(),
	modelRegistry: { refresh: async () => {} },
	enableLsp: false,
};

describe("terminal runtime ordering", () => {
	afterEach(() => vi.restoreAllMocks());
	it("late external signal after a committed yield does not flip success", async () => {
		const accepted = Promise.withResolvers<void>();
		const session = createMockSession(async emit => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-yield",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			} as AgentSessionEvent);
			accepted.resolve();
			await Bun.sleep(200);
		});
		mockCreateAgentSession(session);
		const ac = new AbortController();
		const promise = runSubprocess({ ...baseOptions, id: "late-signal", signal: ac.signal } as never);
		await accepted.promise;
		await Bun.sleep(20);
		ac.abort("late caller cancel");
		const result = await promise;
		expect(result.exitCode).toBe(0);
		expect(result.aborted).toBe(false);
	});

	it("cancellation before yield commitment fails closed", async () => {
		const started = Promise.withResolvers<void>();
		const session = createMockSession(async () => {
			started.resolve();
			await Bun.sleep(200);
		});
		mockCreateAgentSession(session);
		const ac = new AbortController();
		const promise = runSubprocess({ ...baseOptions, id: "early-signal", signal: ac.signal } as never);
		await started.promise;
		ac.abort("early caller cancel");
		const result = await promise;
		expect(result.exitCode).not.toBe(0);
		expect(result.aborted).toBe(true);
	});
});
