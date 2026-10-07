import { describe, expect, test } from "bun:test";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { RepeatedToolCallDetection } from "@oh-my-pi/pi-ai/utils/tool-call-loop-guard";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import {
	type CumulativeToolCallDetection,
	CumulativeToolCallLoopGuard,
	renderAdvisorToolCallLoopRedirect,
} from "../../src/advisor/cumulative-loop-guard";
import { toolCallSignature } from "../../src/advisor/tool-call-signature";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

let nextId = 0;

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id: `tc_${nextId++}`, name, arguments: args };
}

function turn(calls: ToolCall[], toolResults: ToolResultMessage[] = []) {
	const message = {
		role: "assistant",
		content: calls,
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: zeroUsage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	} satisfies AssistantMessage;
	return { message, toolResults };
}

function result(call: ToolCall, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("CumulativeToolCallLoopGuard", () => {
	test("trips on one call repeated far past the bound while alternating with others", () => {
		const guard = new CumulativeToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		let detection: RepeatedToolCallDetection | CumulativeToolCallDetection | null = null;
		for (let index = 0; index < 10; index++) {
			expect(guard.recordTurn(turn([toolCall("grep", { pattern: `probe-${index}` })]))).toBeNull();
			const spin = toolCall("glob", { path: ".git/index.lock", [INTENT_FIELD]: `attempt ${index}` });
			detection = guard.recordTurn(turn([spin], [result(spin, "no\n\nmatches")]));
			if (detection) break;
		}
		expect(detection).toEqual({
			kind: "repeated_tool_call",
			cumulative: true,
			toolName: "glob",
			count: 10,
			resultSummary: "no matches",
			argumentsSummary: '{"path":".git/index.lock"}',
		});
	});

	test("never tallies exempt tools", () => {
		const guard = new CumulativeToolCallLoopGuard({ threshold: 2, exemptTools: ["wait"] });
		for (let index = 0; index < 20; index++) {
			expect(
				guard.recordTurn(turn([toolCall("wait", { id: "job" }), toolCall("read", { path: `${index}` })])),
			).toBeNull();
		}
	});

	test("reports a back-to-back run as the shared consecutive detection", () => {
		const guard = new CumulativeToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		expect(guard.recordTurn(turn([toolCall("bash", { command: "ls" })]))).toBeNull();
		const detection = guard.recordTurn(turn([toolCall("bash", { command: "ls" })]));
		expect(detection).not.toBeNull();
		expect(detection).not.toHaveProperty("cumulative");
		expect(detection?.count).toBe(2);
	});
});

describe("renderAdvisorToolCallLoopRedirect", () => {
	const base = {
		kind: "repeated_tool_call",
		toolName: "read",
		count: 15,
		argumentsSummary: '{"path":"a.ts"}',
		resultSummary: "",
	} as const;

	test("says 'consecutive' only for a back-to-back run; both keep 'this turn'", () => {
		const consecutive = renderAdvisorToolCallLoopRedirect(base);
		const cumulative = renderAdvisorToolCallLoopRedirect({ ...base, cumulative: true });
		expect(consecutive).toContain("You called `read` 15 consecutive times with identical arguments");
		expect(cumulative).toContain("You called `read` 15 times with identical arguments");
		expect(cumulative).not.toContain("consecutive");
		expect(cumulative).toContain("(no text result)");
		for (const text of [consecutive, cumulative]) expect(text).toContain("again this turn");
	});
});

describe("toolCallSignature", () => {
	test("ignores intent fields and key order, but not argument values", () => {
		const plain = toolCallSignature("grep", { pattern: "x", path: "src" });
		expect(
			toolCallSignature("grep", { path: "src", pattern: "x", [INTENT_FIELD]: "Searching", __intent: "old" }),
		).toBe(plain);
		expect(toolCallSignature("grep", { pattern: "x", path: "src/" })).not.toBe(plain);
		expect(toolCallSignature("grep", { pattern: "x ", path: "src" })).not.toBe(plain);
		expect(toolCallSignature("glob", { pattern: "x", path: "src" })).not.toBe(plain);
	});
});
