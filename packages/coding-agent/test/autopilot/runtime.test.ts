import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	AUTOPILOT_ANSWER_MAX_CHARS,
	AutopilotRuntime,
	type AutopilotResponderContext,
	type AutopilotRuntimeHost,
	buildAutopilotReiteration,
	buildAutopilotResponderPrompt,
	buildAutopilotStatementPrompt,
	isAutopilotDoneDecision,
	normalizeAutopilotAnswer,
	renderAutopilotContext,
} from "../../src/autopilot/runtime";
import type { AutopilotDecisionDetails, AutopilotDecisionRecord, AutopilotStrategy } from "../../src/autopilot/state";
import { createAssistantMessage } from "../helpers/agent-session-setup";

interface HarnessOptions {
	enabled?: boolean;
	agentKind?: "main" | "sub";
	strategy?: AutopilotStrategy;
	modelReady?: boolean;
	maxCycles?: number;
	responder?: (prompt: string) => Promise<string>;
	context?: AutopilotResponderContext;
}

function harness(options: HarnessOptions = {}) {
	const state = {
		enabled: options.enabled ?? true,
		agentKind: options.agentKind ?? ("main" as const),
		strategy: options.strategy ?? ("continue" as const),
		modelReady: options.modelReady ?? true,
		maxCycles: options.maxCycles ?? 3,
		responder: options.responder ?? (async () => "Yes, run the unit tests"),
		context: options.context ?? { task: "finish the refactor" },
	};
	const calls = {
		responder: [] as string[],
		queued: [] as { content: string; details: AutopilotDecisionDetails }[],
		records: [] as AutopilotDecisionRecord[],
		notices: [] as { level: string; message: string }[],
	};
	const host: AutopilotRuntimeHost = {
		isEnabled: () => state.enabled,
		agentKind: () => state.agentKind,
		strategy: () => state.strategy,
		modelReady: () => state.modelReady,
		maxCycles: () => state.maxCycles,
		responderContext: () => state.context,
		runResponder: async prompt => {
			calls.responder.push(prompt);
			return { text: await state.responder(prompt), model: "test/model", inputTokens: 11, outputTokens: 7 };
		},
		queueContinuation: (content, details) => calls.queued.push({ content, details }),
		recordDecision: record => calls.records.push(record),
		emitNotice: (level, message) => calls.notices.push({ level, message }),
	};
	const runtime = new AutopilotRuntime(host);
	return { runtime, state, calls };
}

function turn(text: string): AgentMessage[] {
	return [createAssistantMessage(text)];
}

describe("AutopilotRuntime", () => {
	it("does nothing while disabled", async () => {
		const { runtime, calls } = harness({ enabled: false });
		expect(await runtime.onTurnEnd(turn("Should I run the tests?"))).toBe(false);
		expect(calls.responder).toHaveLength(0);
		expect(calls.queued).toHaveLength(0);
	});

	it("never answers a subagent's turn", async () => {
		const { runtime, calls } = harness({ agentKind: "sub" });
		expect(await runtime.onTurnEnd(turn("Should I run the tests?"))).toBe(false);
		expect(calls.responder).toHaveLength(0);
	});

	it("answers a closing question once and queues a continuation with card details", async () => {
		const { runtime, calls } = harness();
		expect(await runtime.onTurnEnd(turn("The refactor is done. Should I run the e2e suite?"))).toBe(true);
		expect(calls.responder).toHaveLength(1);
		expect(calls.responder[0]).toContain("Should I run the e2e suite?");
		expect(calls.responder[0]).toContain("finish the refactor");
		expect(calls.queued.map(entry => entry.content)).toEqual([
			"Autopilot: Yes, run the unit tests. Continue without asking.",
		]);
		expect(calls.queued[0]!.details).toMatchObject({
			kind: "question",
			decision: "Yes, run the unit tests",
			strategy: "continue",
			model: "test/model",
			inputTokens: 11,
			outputTokens: 7,
		});
		expect(calls.records).toHaveLength(1);
		expect(calls.notices).toEqual([{ level: "info", message: "Autopilot: Yes, run the unit tests" }]);
	});

	it("resolves a question-free ending into the next action under continue", async () => {
		const { runtime, calls } = harness();
		expect(await runtime.onTurnEnd(turn("All checks pass; the refactor is complete."))).toBe(true);
		expect(calls.responder).toHaveLength(1);
		expect(calls.responder[0]).toContain("stopped without asking a question");
		expect(calls.responder[0]).toContain('answer exactly "done"');
		expect(calls.queued).toHaveLength(1);
	});

	it("answer strategy ignores question-free endings", async () => {
		const { runtime, calls } = harness({ strategy: "answer" });
		expect(await runtime.onTurnEnd(turn("All checks pass."))).toBe(false);
		expect(calls.responder).toHaveLength(0);
	});

	it("goal-aware includes the goal and todos in the prompt", async () => {
		const { runtime, calls } = harness({
			strategy: "goal-aware",
			context: {
				task: "finish the migration",
				goalObjective: "RCE",
				goalStatus: "active",
				todos: "Phase 1: ~ decode;  write PoC",
			},
		});
		await runtime.onTurnEnd([
			createAssistantMessage("Still working on it."),
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: Date.now(),
			},
		]);
		expect(calls.responder[0]).toContain("Goal (active): RCE");
		expect(calls.responder[0]).toContain("Open todos: Phase 1");
		expect(calls.responder[0]).toContain("Last action");
	});

	it("makes the user directive binding in the responder prompt", async () => {
		const { runtime, calls } = harness({
			strategy: "goal-aware",
			context: { task: "finish the migration", directive: "always run the unit tests first" },
		});
		await runtime.onTurnEnd(turn("Should I commit?"));
		expect(calls.responder[0]).toContain("User directive (binding): always run the unit tests first");
		expect(calls.responder[0]).toContain("follow it even when the guidance below differs");
	});

	it("offers investigation and delegation when subagents are available", async () => {
		const { runtime, calls } = harness({
			strategy: "goal-aware",
			context: {
				task: "finish the migration",
				agents: "scout (read-only research), task (general-purpose)",
			},
		});
		await runtime.onTurnEnd(turn("Should I proceed?"));
		expect(calls.responder[0]).toContain("Available subagents: scout (read-only research), task (general-purpose)");
		expect(calls.responder[0]).toContain("understand more of the code");
		expect(calls.responder[0]).toContain("delegate a self-contained slice");
	});

	it("does not offer delegation when the task tool is absent", async () => {
		const { runtime, calls } = harness({ strategy: "goal-aware" });
		await runtime.onTurnEnd(turn("Should I proceed?"));
		expect(calls.responder[0]).toContain("No subagents are available in this session");
		expect(calls.responder[0]).not.toContain("Available subagents:");
	});

	it("reiterates the objective when a cycle makes no tool progress", async () => {
		const { runtime, calls } = harness({
			strategy: "goal-aware",
			context: { task: "finish the migration", goalObjective: "ship it" },
		});
		expect(await runtime.onTurnEnd(turn("First status."))).toBe(true);
		expect(await runtime.onTurnEnd(turn("Second status."))).toBe(true);
		expect(calls.responder).toHaveLength(1);
		const queued = calls.queued.at(-1)!;
		expect(queued.content).toContain("Reiterating the objective.");
		expect(queued.content).toContain("Objective: ship it");
		expect(queued.content).toContain("Take a concrete tool action");
		expect(queued.details).toMatchObject({ kind: "reiterate", decision: "ship it", strategy: "goal-aware" });
		expect(calls.records.at(-1)).toMatchObject({ kind: "reiterate" });
		expect(calls.notices.at(-1)?.message).toBe("Autopilot: reiterating the objective (1/3).");
	});

	it("reiterates instead of stopping when the same question repeats under goal-aware", async () => {
		const { runtime, calls } = harness({ strategy: "goal-aware", maxCycles: 0 });
		expect(await runtime.onTurnEnd(turn("Should I run the tests?"))).toBe(true);
		expect(await runtime.onTurnEnd(turn("Should I run the tests?"))).toBe(true);
		expect(calls.records.at(-1)).toMatchObject({ kind: "reiterate" });
		expect(calls.records.some(record => record.stopped === "repeat")).toBe(false);
	});

	it("stops after the reiteration cap", async () => {
		const { runtime, calls } = harness({
			strategy: "goal-aware",
			context: { task: "finish the migration", goalObjective: "ship it" },
			maxCycles: 0,
		});
		expect(await runtime.onTurnEnd(turn("First status."))).toBe(true);
		for (let step = 2; step <= 4; step++) {
			expect(await runtime.onTurnEnd(turn(`Status ${step}.`))).toBe(true);
		}
		expect(await runtime.onTurnEnd(turn("Status 5."))).toBe(false);
		expect(calls.records.at(-1)).toMatchObject({ stopped: "no-progress" });
		expect(calls.notices.at(-1)?.message).toBe("Autopilot stopped: no tool activity after 3 objective reiterations.");
	});

	it("resets the reiteration budget after a tool call", async () => {
		const { runtime, calls } = harness({
			strategy: "goal-aware",
			context: { task: "finish the migration", goalObjective: "ship it" },
			maxCycles: 0,
		});
		expect(await runtime.onTurnEnd(turn("First status."))).toBe(true);
		for (let step = 2; step <= 4; step++) {
			expect(await runtime.onTurnEnd(turn(`Status ${step}.`))).toBe(true);
		}
		const withTool: AgentMessage[] = [
			createAssistantMessage("Progress status."),
			{
				role: "toolResult",
				toolCallId: "call-2",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		expect(await runtime.onTurnEnd(withTool)).toBe(true);
		// The settled transcript carries the tool result forward; only the final
		// assistant text changed, so the digest is unchanged and no progress was made.
		expect(await runtime.onTurnEnd([...withTool, createAssistantMessage("After tools.")])).toBe(true);
		expect(calls.records.at(-1)).toMatchObject({ kind: "reiterate" });
		expect(calls.notices.at(-1)?.message).toBe("Autopilot: reiterating the objective (1/3).");
	});

	it("goal-aware counts a tool call between cycles as progress", async () => {
		const { runtime, calls } = harness({ strategy: "goal-aware" });
		expect(await runtime.onTurnEnd(turn("First status."))).toBe(true);
		const withTool: AgentMessage[] = [
			createAssistantMessage("Second status."),
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		expect(await runtime.onTurnEnd(withTool)).toBe(true);
		expect(calls.responder).toHaveLength(2);
	});

	it("stops when the responder concludes the task", async () => {
		const { runtime, calls } = harness({ responder: async () => "done" });
		expect(await runtime.onTurnEnd(turn("Everything is finished."))).toBe(false);
		expect(calls.queued).toHaveLength(0);
		expect(calls.records.at(-1)).toMatchObject({ decision: "done", stopped: "done" });
		expect(calls.notices.at(-1)).toEqual({
			level: "info",
			message: "Autopilot: the objective is complete; no continuation.",
		});
	});

	it("stops when the responder fails", async () => {
		const { runtime, calls } = harness({ responder: async () => Promise.reject(new Error("boom")) });
		expect(await runtime.onTurnEnd(turn("Should I run the tests?"))).toBe(false);
		expect(calls.queued).toHaveLength(0);
		expect(calls.records.at(-1)).toMatchObject({ stopped: "responder-failed" });
	});

	it("rejects a reply that is a question or empty", async () => {
		for (const reply of ["Should I?", "   ", '"?']) {
			const { runtime, calls } = harness({ responder: async () => reply });
			expect(await runtime.onTurnEnd(turn("Should I run the tests?"))).toBe(false);
			expect(calls.queued).toHaveLength(0);
		}
	});

	it("honors the per-prompt cycle cap", async () => {
		const { runtime, calls } = harness({ maxCycles: 2 });
		expect(await runtime.onTurnEnd(turn("Should I do step one?"))).toBe(true);
		expect(await runtime.onTurnEnd(turn("Should I do step two?"))).toBe(true);
		expect(await runtime.onTurnEnd(turn("Should I do step three?"))).toBe(false);
		expect(calls.responder).toHaveLength(2);
		expect(calls.records.at(-1)).toMatchObject({ stopped: "limit" });
	});

	it("maxCycles 0 means unlimited", async () => {
		const { runtime, calls } = harness({ maxCycles: 0 });
		for (let step = 1; step <= 5; step++) {
			expect(await runtime.onTurnEnd(turn(`Should I do step ${step}?`))).toBe(true);
		}
		expect(calls.responder).toHaveLength(5);
		expect(runtime.snapshot().maxCycles).toBe(0);
		expect(calls.records.some(record => record.stopped === "limit")).toBe(false);
	});

	it("stops when the same normalized question repeats", async () => {
		const { runtime, calls } = harness();
		expect(await runtime.onTurnEnd(turn("Should I run the tests?"))).toBe(true);
		expect(await runtime.onTurnEnd(turn("SHOULD  i run the TESTS?"))).toBe(false);
		expect(calls.responder).toHaveLength(1);
		expect(calls.notices.at(-1)?.message).toBe("Autopilot stopped: the agent repeated the same question.");
	});

	it("a new user prompt re-arms the budget and the progress digest", async () => {
		const { runtime, calls } = harness({ strategy: "goal-aware", maxCycles: 1 });
		expect(await runtime.onTurnEnd(turn("First status."))).toBe(true);
		expect(await runtime.onTurnEnd(turn("Second status."))).toBe(false);
		runtime.resetCycleBudget();
		expect(await runtime.onTurnEnd(turn("Second status."))).toBe(true);
		expect(calls.responder).toHaveLength(2);
	});

	it("fails closed when the session model is unavailable", async () => {
		const { runtime, calls } = harness({ modelReady: false });
		expect(await runtime.onTurnEnd(turn("Should I run the tests?"))).toBe(false);
		expect(calls.responder).toHaveLength(0);
		expect(calls.records.at(-1)).toMatchObject({ stopped: "model-unavailable" });
	});

	it("emits at most one stop notice per prompt", async () => {
		const { runtime, calls } = harness({ modelReady: false });
		await runtime.onTurnEnd(turn("Should I run the tests?"));
		await runtime.onTurnEnd(turn("Should I run the build?"));
		expect(calls.notices).toHaveLength(1);
	});

	it("reports strategy, cycles and the last decision", async () => {
		const { runtime } = harness({ strategy: "goal-aware" });
		await runtime.onTurnEnd(turn("Should I run the tests?"));
		const snapshot = runtime.snapshot();
		expect(snapshot.strategy).toBe("goal-aware");
		expect(snapshot.cycles).toBe(1);
		expect(snapshot.maxCycles).toBe(3);
		expect(snapshot.last?.decision).toBe("Yes, run the unit tests");
	});
});

describe("normalizeAutopilotAnswer", () => {
	it("collapses whitespace, strips wrapping quotes and a leading label", () => {
		expect(normalizeAutopilotAnswer('  "No, that is out of scope."  ')).toBe("No, that is out of scope.");
		expect(normalizeAutopilotAnswer("Autopilot: proceed with the conservative option")).toBe(
			"proceed with the conservative option",
		);
	});

	it("rejects a reply that is itself a question", () => {
		expect(normalizeAutopilotAnswer("Shall I proceed?")).toBeNull();
		expect(normalizeAutopilotAnswer("Podemos continuar?")).toBeNull();
	});

	it("caps long answers", () => {
		const answer = normalizeAutopilotAnswer("x".repeat(AUTOPILOT_ANSWER_MAX_CHARS + 50));
		expect(answer).not.toBeNull();
		expect(answer!.length).toBeLessThanOrEqual(AUTOPILOT_ANSWER_MAX_CHARS);
		expect(answer!.endsWith("…")).toBe(true);
	});
});

describe("isAutopilotDoneDecision", () => {
	it("accepts the done sentinel with punctuation and case", () => {
		expect(isAutopilotDoneDecision("done")).toBe(true);
		expect(isAutopilotDoneDecision("Done.")).toBe(true);
		expect(isAutopilotDoneDecision("concluído")).toBe(true);
		expect(isAutopilotDoneDecision("run the tests")).toBe(false);
		expect(isAutopilotDoneDecision("done, because X")).toBe(false);
	});
});

describe("renderAutopilotContext", () => {
	it("renders task, goal, todos and the last action", () => {
		const rendered = renderAutopilotContext({
			task: "finish the migration",
			directive: "always run tests",
			agents: "scout (read-only research)",
			goalObjective: "ship it",
			goalStatus: "active",
			todos: "Phase 1: ~ decode",
			lastAction: "bash",
		});
		expect(rendered).toContain("Task: finish the migration");
		expect(rendered).toContain("User directive (binding): always run tests");
		expect(rendered).toContain("Available subagents: scout (read-only research)");
		expect(rendered).toContain("Goal (active): ship it");
		expect(rendered).toContain("Open todos: Phase 1");
		expect(rendered).toContain("Last action: bash");
	});
});

describe("prompt builders", () => {
	it("includes the question and the structured context", () => {
		const prompt = buildAutopilotResponderPrompt("Should I commit?", {
			task: "finish the migration",
			goalObjective: "ship it",
		});
		expect(prompt).toContain("Should I commit?");
		expect(prompt).toContain("finish the migration");
		expect(prompt).toContain("Goal (active): ship it");
		expect(prompt).toContain("without asking any questions");
	});

	it("builds an objective reiteration", () => {
		const reiteration = buildAutopilotReiteration({
			task: "finish the migration",
			goalObjective: "ship it",
			directive: "tests first",
			todos: "Phase 1: ~ decode",
		});
		expect(reiteration).toContain("Reiterating the objective.");
		expect(reiteration).toContain("Objective: ship it");
		expect(reiteration).toContain("Directive (binding): tests first");
		expect(reiteration).toContain("Open todos: Phase 1");
		expect(reiteration).toContain("Take a concrete tool action");
	});

	it("includes the final message, the done sentinel and the context", () => {
		const prompt = buildAutopilotStatementPrompt("All checks pass.", { task: "finish the migration" });
		expect(prompt).toContain("All checks pass.");
		expect(prompt).toContain("finish the migration");
		expect(prompt).toContain('answer exactly "done"');
	});
});
