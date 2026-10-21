import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import {
	AUTOPILOT_ANSWER_CUSTOM_TYPE,
	AUTOPILOT_DECISION_CUSTOM_TYPE,
	AUTOPILOT_STATE_CUSTOM_TYPE,
	type AutopilotStrategy,
} from "../../src/autopilot/state";
import { convertToLlm } from "../../src/session/messages";
import type { CustomEntry } from "../../src/session/session-entries";
import { SessionManager } from "../../src/session/session-manager";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;

function textReply(requested: Model, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: requested.api,
		provider: requested.provider,
		model: requested.id,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Returns the scripted replies in order; records each request context. */
function scripted(replies: readonly string[], calls: { context: Context; model: Model }[]): StreamFn {
	let index = 0;
	return (requested, context) => {
		calls.push({ context, model: requested });
		const text = replies[Math.min(index++, replies.length - 1)]!;
		const message = textReply(requested, text);
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
}

interface SessionHarness {
	session: AgentSession;
	mainCalls: { context: Context; model: Model }[];
	sideCalls: { context: Context; model: Model }[];
	settles: { isTerminal?: boolean }[];
}

const sessions: AgentSession[] = [];

function createSession(options: {
	mainReplies: readonly string[];
	sideReplies: readonly string[];
	maxCycles?: number;
	strategy?: AutopilotStrategy;
	enabled?: boolean;
	sharedManager?: SessionManager;
}): SessionHarness {
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"autopilot.maxCycles": options.maxCycles ?? 3,
		"autopilot.strategy": options.strategy ?? "continue",
	});
	const mainCalls: { context: Context; model: Model }[] = [];
	const sideCalls: { context: Context; model: Model }[] = [];
	const settles: { isTerminal?: boolean }[] = [];
	const session = new AgentSession({
		agent: new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: scripted(options.mainReplies, mainCalls),
		}),
		sessionManager: options.sharedManager ?? SessionManager.inMemory(),
		settings,
		modelRegistry,
		sideStreamFn: scripted(options.sideReplies, sideCalls),
	});
	session.subscribe(event => {
		if (event.type === "agent_end") settles.push({ isTerminal: event.isTerminal });
	});
	sessions.push(session);
	if (options.enabled) session.setAutopilotEnabled(true);
	return { session, mainCalls, sideCalls, settles };
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
});

function injectedAnswer(session: AgentSession): string | undefined {
	const message = session.agent.state.messages.find(
		candidate => candidate.role === "custom" && candidate.customType === AUTOPILOT_ANSWER_CUSTOM_TYPE,
	);
	if (!message || message.role !== "custom") return undefined;
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join(" ");
}

function contextText(context: Context): string {
	return JSON.stringify(context.messages);
}

describe("/autopilot end-to-end", () => {
	it("answers one closing question with the session model and continues without a user prompt", async () => {
		const { session, mainCalls, sideCalls, settles } = createSession({
			mainReplies: ["Refactor finished. Should I run the e2e suite?", "Running the e2e suite now."],
			// First decision answers the question; the continuation turn ends with a
			// statement, and the responder concludes it so the run stops there.
			sideReplies: ["Yes, run the e2e suite", "done"],
			enabled: true,
		});

		await session.prompt("Finish the refactor");
		await session.waitForIdle();

		// One main turn, one hidden answer turn, no extra user prompt.
		expect(mainCalls).toHaveLength(2);
		expect(sideCalls).toHaveLength(2);
		// The responder ran on the session's effective model.
		expect(sideCalls[0]!.model.id).toBe(model.id);
		expect(sideCalls[0]!.model.provider).toBe(model.provider);
		expect(contextText(sideCalls[0]!.context)).toContain("Should I run the e2e suite?");
		// The decision reached the second main request as a hidden custom message.
		expect(contextText(mainCalls[1]!.context)).toContain("Autopilot: Yes, run the e2e suite");
		expect(injectedAnswer(session)).toContain("Continue without asking.");
		// Persisted as the displayable decision card (the content is model-facing).
		const entry = session.sessionManager
			.getEntries()
			.find(
				candidate => candidate.type === "custom_message" && candidate.customType === AUTOPILOT_ANSWER_CUSTOM_TYPE,
			);
		expect(entry).toBeDefined();
		expect(entry && "display" in entry ? entry.display : false).toBe(true);
		// One continuation for the cycle; the run settles terminal only after the
		// autopilot turn ends, so goal controllers act on that later cycle.
		expect(settles.at(-1)?.isTerminal).toBe(true);
	});

	it("continues a question-free ending with the next action and stops on a repeat", async () => {
		const { session, mainCalls, sideCalls } = createSession({
			mainReplies: ["All checks pass; the refactor is complete."],
			sideReplies: ["Run the release build"],
			enabled: true,
		});

		await session.prompt("Finish the work");
		await session.waitForIdle();

		// First ending has no question but still gets a decision; the continuation
		// turn ends with the identical text, so the repeat guard stops the loop.
		expect(mainCalls).toHaveLength(2);
		expect(sideCalls).toHaveLength(1);
		expect(contextText(sideCalls[0]!.context)).toContain("stopped without asking a question");
		expect(injectedAnswer(session)).toContain("Autopilot: Run the release build.");
	});

	it("does not continue when the responder concludes the task", async () => {
		const { session, mainCalls, sideCalls } = createSession({
			mainReplies: ["Everything is finished."],
			sideReplies: ["done"],
			enabled: true,
		});

		await session.prompt("Finish the work");
		await session.waitForIdle();

		expect(mainCalls).toHaveLength(1);
		expect(sideCalls).toHaveLength(1);
		expect(injectedAnswer(session)).toBeUndefined();
	});

	it("goal-aware stops after a cycle without tool progress", async () => {
		const { session, mainCalls, sideCalls } = createSession({
			mainReplies: [
				"First status report.",
				"Second status report.",
				"Third status report.",
				"Fourth status report.",
				"Fifth status report.",
			],
			sideReplies: ["Continue with the next step"],
			strategy: "goal-aware",
			maxCycles: 0,
			enabled: true,
		});

		await session.prompt("Finish the work");
		await session.waitForIdle();

		expect(mainCalls).toHaveLength(5);
		expect(sideCalls).toHaveLength(1);
		const journal = session.sessionManager
			.getEntries()
			.filter(
				(entry): entry is CustomEntry =>
					entry.type === "custom" && entry.customType === AUTOPILOT_DECISION_CUSTOM_TYPE,
			);
		expect(journal.some(entry => (entry.data as { kind?: string }).kind === "reiterate")).toBe(true);
		expect(journal.at(-1)?.data).toMatchObject({ stopped: "no-progress" });
	});

	it("persists the directive across toggles and sends it to the responder", async () => {
		const { session, sideCalls } = createSession({
			mainReplies: ["Should I proceed?"],
			sideReplies: ["Yes, run the unit tests"],
		});
		session.setAutopilotEnabled(true, "Always run the unit tests first");
		expect(session.getAutopilotPrompt()).toBe("Always run the unit tests first");
		session.setAutopilotEnabled(false);
		expect(session.isAutopilotEnabled()).toBe(false);
		expect(session.getAutopilotPrompt()).toBe("Always run the unit tests first");
		session.setAutopilotEnabled(true);

		await session.prompt("Finish the work");
		await session.waitForIdle();

		expect(sideCalls).toHaveLength(1);
		expect(contextText(sideCalls[0]!.context)).toContain("Always run the unit tests first");
		expect(session.getAutopilotStatus().prompt).toBe("Always run the unit tests first");
	});

	it("persists a per-session cycle limit and reports it", async () => {
		const { session } = createSession({ mainReplies: [], sideReplies: [] });
		expect(session.getAutopilotMaxCycles()).toBeUndefined();
		session.setAutopilotMaxCycles(5);
		expect(session.getAutopilotMaxCycles()).toBe(5);
		expect(session.getAutopilotStatus().maxCycles).toBe(5);
		session.setAutopilotMaxCycles(undefined);
		expect(session.getAutopilotMaxCycles()).toBeUndefined();
		expect(session.getAutopilotStatus().maxCycles).toBe(3);
	});

	it("does not call the responder while disabled", async () => {
		const { session, mainCalls, sideCalls } = createSession({
			mainReplies: ["Should I run the tests?"],
			sideReplies: ["Yes"],
			enabled: false,
		});

		await session.prompt("Do the work");
		await session.waitForIdle();

		expect(mainCalls).toHaveLength(1);
		expect(sideCalls).toHaveLength(0);
		expect(injectedAnswer(session)).toBeUndefined();
	});

	it("stops when the agent repeats the same question", async () => {
		const { session, mainCalls, sideCalls } = createSession({
			mainReplies: ["Should I continue?", "Should I continue?", "Should I continue?"],
			sideReplies: ["Yes, continue"],
			enabled: true,
		});

		await session.prompt("Do the work");
		await session.waitForIdle();

		expect(sideCalls).toHaveLength(1);
		expect(mainCalls).toHaveLength(2);
	});

	it("honors the per-prompt cycle cap", async () => {
		const { session, mainCalls, sideCalls } = createSession({
			mainReplies: ["Should I do step one?", "Should I do step two?", "Should I do step three?"],
			sideReplies: ["Yes, do it"],
			maxCycles: 2,
			enabled: true,
		});

		await session.prompt("Do the work");
		await session.waitForIdle();

		expect(sideCalls).toHaveLength(2);
		expect(mainCalls).toHaveLength(3);
	});

	it("persists the toggle and restores it in a resumed session", async () => {
		const sharedManager = SessionManager.inMemory();
		const first = createSession({ mainReplies: ["Done."], sideReplies: ["Yes"], sharedManager });
		first.session.setAutopilotEnabled(true);
		expect(
			first.session.sessionManager
				.getEntries()
				.some(entry => entry.type === "custom" && entry.customType === AUTOPILOT_STATE_CUSTOM_TYPE),
		).toBe(true);
		expect(first.session.isAutopilotEnabled()).toBe(true);

		const second = createSession({ mainReplies: ["Done."], sideReplies: ["Yes"], sharedManager });
		expect(second.session.isAutopilotEnabled()).toBe(true);
		second.session.setAutopilotEnabled(false);
		expect(
			second.session.sessionManager
				.getEntries()
				.some(entry => entry.type === "custom" && entry.customType === AUTOPILOT_STATE_CUSTOM_TYPE),
		).toBe(true);
	});
});
