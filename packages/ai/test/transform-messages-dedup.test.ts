// Duplicate Responses-family tool-call ids are composites (`callId|itemId`).
// The dedup suffix must reach the wire call_id — the FIRST segment, which
// normalizeResponsesToolCallId extracts at encode time — otherwise the request
// carries two function_call/function_call_output pairs sharing one call_id.
// Regression for the suffix previously landing on the composite as a whole
// (`call_x|fc_y` → `call_x|fc_y_dup1`, wire call_id `call_x` for both copies).
import { describe, expect, it } from "bun:test";
import { buildResponsesInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { normalizeResponsesToolCallId } from "@oh-my-pi/pi-ai/utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function makeModel(): Model<"openai-responses"> {
	return buildModel({
		api: "openai-responses",
		name: "GPT Test",
		id: "gpt-test",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 8192,
		maxTokens: 2048,
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

function assistantWithCall(id: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path: "a" } }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function assistantWithCalls(ids: string[]): AssistantMessage {
	return {
		...assistantWithCall(ids[0]!),
		content: ids.map(id => ({ type: "toolCall" as const, id, name: "read", arguments: { path: "a" } })),
	};
}

function toolResult(id: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	} as ToolResultMessage;
}

describe("deduplicateToolCallIds with composite Responses ids", () => {
	it("suffixes the call_id segment so wire ids stay distinct", () => {
		const dupId = "call_x|fc_y";
		const messages: Message[] = [
			assistantWithCall(dupId),
			toolResult(dupId, "first"),
			assistantWithCall(dupId),
			toolResult(dupId, "second"),
		];

		const transformed = transformMessages(messages, makeModel());

		const callIds = transformed
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.flatMap(m => m.content)
			.filter(b => b.type === "toolCall")
			.map(b => normalizeResponsesToolCallId((b as { id: string }).id).callId);
		expect(callIds).toHaveLength(2);
		expect(new Set(callIds).size).toBe(2);

		// Each rewritten toolResult resolves to the same wire call_id as its call.
		const resultIds = transformed
			.filter((m): m is ToolResultMessage => m.role === "toolResult")
			.map(m => normalizeResponsesToolCallId(m.toolCallId).callId);
		expect(resultIds).toEqual(callIds);
	});

	it("suffixes same-turn repeats of one id and pairs them 1:1 with their results in order", () => {
		// One assistant turn emitting the SAME id twice: the second block must
		// still be suffixed (`_dup1`) and the second real result must rewrite onto
		// it. The per-turn first-occurrence rule is what restricts the "drop
		// carried-over pending rewrites" step to an id's FIRST occurrence in a
		// turn; without it the second block would drop the first block's queued
		// rewrite, the first real result would rewrite onto the `_dup1` call and
		// the second would keep the base id — caller/result pairing inverted.
		const dupId = "call_same";
		const messages: Message[] = [
			{ role: "user", content: "read twice", timestamp: 0 },
			assistantWithCalls([dupId, dupId]),
			toolResult(dupId, "first"),
			toolResult(dupId, "second"),
		];

		const transformed = transformMessages(messages, makeModel());

		const assistantIds = transformed
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.flatMap(m => m.content)
			.filter((b): b is ToolCall => b.type === "toolCall")
			.map(b => b.id);
		expect(assistantIds).toEqual([dupId, `${dupId}_dup1`]);

		const results = transformed.filter((m): m is ToolResultMessage => m.role === "toolResult");
		expect(results.map(r => r.toolCallId)).toEqual([dupId, `${dupId}_dup1`]);
		expect(results[0]!.content).toEqual([{ type: "text", text: "first" }]);
		expect(results[1]!.content).toEqual([{ type: "text", text: "second" }]);
		// No synthetic back-fill: both real results found their call.
		expect(results.some(r => r.content.some(p => p.type === "text" && p.text === "No result provided"))).toBe(false);
	});

	it("keeps distinct ids independent when one turn interleaves repeats", () => {
		// A single turn `[A, B, A, B]`: each id's first occurrence is untouched by
		// the other, so both accumulate their own `_dup1` counter and rewrite
		// queue, and the four results pair 1:1 with the four calls in order.
		const idA = "call_a";
		const idB = "call_b";
		const messages: Message[] = [
			{ role: "user", content: "read four times", timestamp: 0 },
			assistantWithCalls([idA, idB, idA, idB]),
			toolResult(idA, "first"),
			toolResult(idA, "second"),
			toolResult(idB, "third"),
			toolResult(idB, "fourth"),
		];

		const transformed = transformMessages(messages, makeModel());

		const assistantIds = transformed
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.flatMap(m => m.content)
			.filter((b): b is ToolCall => b.type === "toolCall")
			.map(b => b.id);
		expect(assistantIds).toEqual([idA, idB, `${idA}_dup1`, `${idB}_dup1`]);

		const results = transformed.filter((m): m is ToolResultMessage => m.role === "toolResult");
		expect(results.map(r => [r.toolCallId, r.content])).toEqual([
			[idA, [{ type: "text", text: "first" }]],
			[`${idA}_dup1`, [{ type: "text", text: "second" }]],
			[idB, [{ type: "text", text: "third" }]],
			[`${idB}_dup1`, [{ type: "text", text: "fourth" }]],
		]);
	});

	it.each([true, false])("pairs native repeated calls in incremental=%s history without mutating it", incremental => {
		const originalId = "call_native|fc_first";
		const makeNativeCall = (label: string): Record<string, unknown> => ({
			type: "function_call",
			id: `fc_${label}`,
			call_id: "call_native",
			name: "read",
			arguments: JSON.stringify({ path: label }),
			encrypted_function_args: [label],
		});
		const reasoning = { type: "reasoning", id: "rs_native", summary: [], encrypted_content: "opaque" };
		const first = assistantWithCalls([originalId, "call_native|fc_second"]);
		first.providerPayload = {
			type: "openaiResponsesHistory",
			provider: "openai",
			...(incremental ? { dt: true } : {}),
			items: [reasoning, makeNativeCall("first"), makeNativeCall("second")],
		};
		const last = assistantWithCall("call_native|fc_third");
		last.providerPayload = {
			type: "openaiResponsesHistory",
			provider: "openai",
			...(incremental ? { dt: true } : {}),
			items: incremental
				? [makeNativeCall("third")]
				: [
						...first.providerPayload.items,
						{ type: "function_call_output", call_id: "call_native", output: "result first" },
						{ type: "function_call_output", call_id: "call_native", output: "result second" },
						makeNativeCall("third"),
					],
		};
		const messages: Message[] = [
			first,
			toolResult(originalId, "result first"),
			toolResult("call_native|fc_second", "result second"),
			last,
			toolResult("call_native|fc_third", "result third"),
		];
		// A later legacy snapshot must also rewrite the prefix when its own
		// content has no calls and therefore needs no content-level deduplication.
		if (!incremental) {
			messages.push({
				...assistantWithCall(originalId),
				content: [{ type: "text", text: "Done" }],
				stopReason: "stop",
				providerPayload: {
					...last.providerPayload,
					items: [
						...last.providerPayload.items,
						{ type: "function_call_output", call_id: "call_native", output: "result third" },
						{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] },
					],
				},
			});
		}
		const original = structuredClone(messages);
		const input = buildResponsesInput({
			model: makeModel(),
			context: { messages },
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
			repairOrphanOutputs: true,
		});
		const calls = input.filter(item => item.type === "function_call");
		const outputs = input.filter(item => item.type === "function_call_output");
		expect(calls.map(call => call.call_id)).toEqual(["call_native", "call_native_dup1", "call_native_dup2"]);
		expect(outputs).toHaveLength(3);
		for (const [index, label] of ["first", "second", "third"].entries()) {
			expect(calls[index]).toMatchObject({
				arguments: JSON.stringify({ path: label }),
				encrypted_function_args: [label],
			});
			expect(outputs.filter(output => output.call_id === calls[index]!.call_id)).toEqual([
				expect.objectContaining({ output: `result ${label}` }),
			]);
		}
		expect(JSON.stringify(input)).not.toContain("No result provided");
		expect(JSON.stringify(input)).not.toContain("[Orphan tool result");
		expect(messages).toEqual(original);
	});

	it("reserves exact native identities before anonymous occurrence fallback", () => {
		const assistant = assistantWithCalls(["call_mixed", "call_mixed|fc_exact"]);
		assistant.providerPayload = {
			type: "openaiResponsesHistory",
			provider: "openai",
			dt: true,
			items: [
				{
					type: "function_call",
					id: "fc_exact",
					call_id: "call_mixed",
					name: "read",
					arguments: '{"path":"exact"}',
				},
				{ type: "function_call", call_id: "call_mixed", name: "read", arguments: '{"path":"anonymous"}' },
			],
		};
		const messages = [assistant, toolResult("call_mixed", "anonymous"), toolResult("call_mixed|fc_exact", "exact")];
		const original = structuredClone(messages);
		const input = buildResponsesInput({
			model: makeModel(),
			context: { messages },
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
			repairOrphanOutputs: true,
		});
		const calls = input.filter(item => item.type === "function_call");
		const outputs = input.filter(item => item.type === "function_call_output");
		for (const call of calls) {
			expect(outputs.filter(output => output.call_id === call.call_id)).toEqual([
				expect.objectContaining({ output: JSON.parse(call.arguments).path }),
			]);
		}
		expect(calls.map(call => call.call_id)).toEqual(["call_mixed_dup1", "call_mixed"]);
		expect(messages).toEqual(original);
	});

	it("uses occurrence fallback when native calls have no item ids", () => {
		const assistant = assistantWithCalls(["call_missing|fc_first", "call_missing|fc_second"]);
		assistant.providerPayload = {
			type: "openaiResponsesHistory",
			provider: "openai",
			dt: true,
			items: ["first", "second"].map(label => ({
				type: "function_call",
				call_id: "call_missing",
				name: "read",
				arguments: JSON.stringify({ path: label }),
			})),
		};
		const input = buildResponsesInput({
			model: makeModel(),
			context: {
				messages: [
					assistant,
					toolResult("call_missing|fc_first", "first"),
					toolResult("call_missing|fc_second", "second"),
				],
			},
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
			repairOrphanOutputs: true,
		});
		const calls = input.filter(item => item.type === "function_call");
		const outputs = input.filter(item => item.type === "function_call_output");
		expect(calls.map(call => call.call_id)).toEqual(["call_missing", "call_missing_dup1"]);
		for (const call of calls) {
			expect(outputs.filter(output => output.call_id === call.call_id)).toEqual([
				expect.objectContaining({ output: JSON.parse(call.arguments).path }),
			]);
		}
	});

	it("keeps occurrence pairing for result-owned item ids across repeated Responses calls", () => {
		const messages = [
			assistantWithCalls(["call_legacy|fc_first", "call_legacy|fc_second"]),
			toolResult("call_legacy|output_first", "first"),
			toolResult("call_legacy|output_second", "second"),
		];
		const transformed = transformMessages(messages, makeModel());
		const results = transformed.filter((message): message is ToolResultMessage => message.role === "toolResult");
		expect(results.map(result => [normalizeResponsesToolCallId(result.toolCallId).callId, result.content])).toEqual([
			["call_legacy", [{ type: "text", text: "first" }]],
			["call_legacy_dup1", [{ type: "text", text: "second" }]],
		]);
	});

	it.each([false, true])("preserves normalized snapshot results with mixed raw ids=%s", mixed => {
		const labels = mixed ? ["first", "second", "third"] : ["first", "second"];
		const assistant = assistantWithCalls(labels.map(label => `call_x|fc_${label}`));
		assistant.content = labels.map(label => ({
			type: "toolCall",
			id: `call_x|fc_${label}`,
			name: "read",
			arguments: { path: label },
		}));
		const wireIds = mixed ? ["call_x", "call_x", "call_x_dup2"] : ["call_x", "call_x_dup1"];
		const nativeCalls = labels.map((label, index) => ({
			type: "function_call",
			id: `fc_${label}`,
			call_id: wireIds[index]!,
			name: "read",
			arguments: JSON.stringify({ path: label }),
			encrypted_function_args: [`encrypted-${label}`],
		}));
		const resultOrder = mixed ? [1, 2, 0] : [1, 0];
		const snapshot: AssistantMessage = {
			...assistantWithCall("unused"),
			content: [{ type: "text", text: "Done" }],
			stopReason: "stop",
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "openai",
				...(mixed ? { dt: false } : {}),
				items: [
					...nativeCalls,
					...resultOrder.map(index => ({
						type: "function_call_output",
						id: `output_${labels[index]}`,
						call_id: wireIds[index]!,
						output: labels[index]!,
					})),
					{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] },
				],
			},
		};
		const messages: Message[] = [
			assistant,
			...resultOrder.map(index => toolResult(`call_x|fc_${labels[index]}`, labels[index]!)),
			snapshot,
		];
		const original = structuredClone(messages);
		const input = buildResponsesInput({
			model: makeModel(),
			context: { messages },
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
			repairOrphanOutputs: true,
		});
		const calls = input.filter(item => item.type === "function_call");
		const results = input.filter(item => item.type === "function_call_output");
		expect(calls.map(call => call.call_id)).toEqual(
			labels.map((_, index) => (index === 0 ? "call_x" : `call_x_dup${index}`)),
		);
		expect(results).toHaveLength(labels.length);
		for (const [index, call] of calls.entries()) {
			expect(call.arguments).toBe(JSON.stringify({ path: labels[index] }));
			expect(call.encrypted_function_args).toEqual([`encrypted-${labels[index]}`]);
			expect(results.filter(result => result.call_id === call.call_id).map(result => result.output)).toEqual([
				labels[index],
			]);
		}
		expect(JSON.stringify(input)).not.toContain("No result provided");
		expect(JSON.stringify(input)).not.toContain("Orphan");
		expect(messages).toEqual(original);
	});

	it.each([
		["normalized", ["call_x", "call_x_dup1", "call_x_dup1_dup1"]],
		["raw", ["call_x", "call_x", "call_x_dup1"]],
		["mixed", ["call_x", "call_x", "call_x_dup1_dup1"]],
	] as const)("keeps colliding suffixes paired in a %s snapshot without item IDs", (_, wireIds) => {
		const rawIds = ["call_x", "call_x", "call_x_dup1"];
		const canonicalIds = ["call_x", "call_x_dup1", "call_x_dup1_dup1"];
		const labels = ["first", "second", "third"];
		const assistant = assistantWithCalls(rawIds);
		assistant.content = rawIds.map((id, index) => ({
			type: "toolCall",
			id,
			name: "read",
			arguments: { path: labels[index] },
		}));
		const resultOrder = [2, 0, 1];
		const snapshot: AssistantMessage = {
			...assistantWithCall("unused"),
			content: [{ type: "text", text: "Done" }],
			stopReason: "stop",
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "openai",
				items: [
					...wireIds.map((callId, index) => ({
						type: "function_call",
						call_id: callId,
						name: "read",
						arguments: JSON.stringify({ path: labels[index] }),
						encrypted_function_args: [`encrypted-${labels[index]}`],
					})),
					...resultOrder.map(index => ({
						type: "function_call_output",
						call_id: wireIds[index],
						output: labels[index],
					})),
					{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] },
				],
			},
		};
		const messages: Message[] = [
			assistant,
			...resultOrder.map(index => toolResult(rawIds[index]!, labels[index]!)),
			snapshot,
		];
		const original = structuredClone(messages);
		const input = buildResponsesInput({
			model: makeModel(),
			context: { messages },
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
			repairOrphanOutputs: true,
		});
		const calls = input.filter(item => item.type === "function_call");
		const results = input.filter(item => item.type === "function_call_output");
		expect(calls.map(call => call.call_id)).toEqual(canonicalIds);
		expect(results.map(result => [result.call_id, result.output])).toEqual(
			resultOrder.map(index => [canonicalIds[index], labels[index]]),
		);
		for (const [index, call] of calls.entries()) {
			expect(call.arguments).toBe(JSON.stringify({ path: labels[index] }));
			expect(call.encrypted_function_args).toEqual([`encrypted-${labels[index]}`]);
		}
		expect(messages).toEqual(original);
	});

	it("leaves non-Responses payloads untouched when calls are deduplicated", () => {
		const first = assistantWithCall("call_native");
		const second = assistantWithCall("call_native");
		second.providerPayload = { type: "anthropicMessage", effort: "high" };
		const messages = [first, toolResult("call_native", "first"), second, toolResult("call_native", "second")];
		const original = structuredClone(messages);
		const transformed = transformMessages(messages, makeModel());
		const assistants = transformed.filter((message): message is AssistantMessage => message.role === "assistant");
		expect(assistants[1]!.providerPayload).toEqual(second.providerPayload);
		expect(assistants[1]!.content).toMatchObject([{ type: "toolCall", id: "call_native_dup1" }]);
		expect(messages).toEqual(original);
	});
});
