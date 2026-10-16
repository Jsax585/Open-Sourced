import { expect, it } from "bun:test";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { ResponseStreamEvent } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import { processResponsesStream } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Message, Model, ModelSpec, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model: Model<"openai-responses"> = buildModel({
	id: "anthropic/claude-sonnet-5.5",
	name: "Claude Sonnet 5.5",
	api: "openai-responses",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
} as ModelSpec<"openai-responses">);

function emptyAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

async function* events(list: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const event of list) yield event as ResponseStreamEvent;
}

function functionCallEvents(outputIndex: number, callId: string, name: string, args: string): unknown[] {
	const item = { type: "function_call", id: `fc_${callId}`, call_id: callId, name };
	return [
		{ type: "response.output_item.added", output_index: outputIndex, item: { ...item, arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: outputIndex, item_id: item.id, delta: args },
		{ type: "response.function_call_arguments.done", output_index: outputIndex, item_id: item.id, arguments: args },
		{ type: "response.output_item.done", output_index: outputIndex, item: { ...item, arguments: args } },
	];
}

it("replays a lenient-repaired function call with the arguments that were executed", async () => {
	// Invalid JSON as streamed by OpenRouter/Claude for a strict nullable arg (#14155).
	const brokenArgs = '{"command": "pwd; ls -a", "name": , "ready": null}';
	const output = emptyAssistant();
	const nativeItems: Array<Record<string, unknown>> = [];
	await processResponsesStream(
		events([
			...functionCallEvents(0, "call_read", "read", JSON.stringify({ path: "." })),
			...functionCallEvents(1, "call_bash", "bash", brokenArgs),
		]),
		output,
		{ push: () => {}, end: () => {} } as never,
		model,
		{ onOutputItemDone: item => nativeItems.push(item as unknown as Record<string, unknown>) },
	);
	output.providerPayload = createOpenAIResponsesHistoryPayload(model.provider, nativeItems);

	const bash = output.content.find(block => block.type === "toolCall" && block.name === "bash");
	if (bash?.type !== "toolCall") throw new Error("expected bash tool call");
	const results: ToolResultMessage[] = output.content.flatMap(block =>
		block.type === "toolCall"
			? [
					{
						role: "toolResult",
						toolCallId: block.id,
						toolName: block.name,
						content: [{ type: "text", text: `${block.name} output` }],
						isError: false,
						timestamp: 2,
					},
				]
			: [],
	);

	const input = buildParams(model, { messages: [output, ...results] }, { reasoning: "high" }, undefined).params
		.input as unknown as Array<Record<string, unknown>>;

	const bashCall = input.find(item => item.type === "function_call" && item.call_id === "call_bash");
	expect(bashCall).toBeDefined();
	expect(JSON.parse(String(bashCall?.arguments))).toEqual(bash.arguments);
	expect(input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_bash" }));
	expect(input.at(-1)).toMatchObject({ type: "function_call_output" });
	expect(JSON.stringify(input)).not.toContain("Orphan");
});

it("replays an unrepairable function call with its parse diagnostic so the tool result stays paired", async () => {
	// Invalid JSON the lenient parser cannot repair; the tool answered with a validation error (#15568).
	const brokenArgs = '{"tasks": [{"task": "x" "y"}]] }}';
	const output = emptyAssistant();
	const nativeItems: Array<Record<string, unknown>> = [];
	await processResponsesStream(
		events([
			...functionCallEvents(0, "call_bash", "bash", JSON.stringify({ command: "pwd" })),
			...functionCallEvents(1, "call_task", "task", brokenArgs),
		]),
		output,
		{ push: () => {}, end: () => {} } as never,
		model,
		{ onOutputItemDone: item => nativeItems.push(item as unknown as Record<string, unknown>) },
	);
	output.providerPayload = createOpenAIResponsesHistoryPayload(model.provider, nativeItems);
	const results: ToolResultMessage[] = output.content.flatMap(block =>
		block.type === "toolCall"
			? [
					{
						role: "toolResult",
						toolCallId: block.id,
						toolName: block.name,
						content: [{ type: "text", text: `${block.name} output` }],
						isError: block.name === "task",
						timestamp: 2,
					},
				]
			: [],
	);

	const input = buildParams(model, { messages: [output, ...results] }, { reasoning: "high" }, undefined).params
		.input as unknown as Array<Record<string, unknown>>;

	const taskCall = input.find(item => item.type === "function_call" && item.call_id === "call_task");
	expect(JSON.parse(String(taskCall?.arguments))).toEqual({ __parseError: expect.any(String), __rawJson: brokenArgs });
	expect(input.at(-1)).toMatchObject({ type: "function_call_output", call_id: "call_task" });
	expect(JSON.stringify(input)).not.toContain("Orphan");
});

it("does not crash on a relaxed scalar function-call argument", async () => {
	const output = emptyAssistant();
	const nativeItems: Array<Record<string, unknown>> = [];
	await processResponsesStream(
		events(functionCallEvents(0, "call_scalar", "bash", "'hello'")),
		output,
		{ push: () => {}, end: () => {} } as never,
		model,
		{ onOutputItemDone: item => nativeItems.push(item as unknown as Record<string, unknown>) },
	);

	const toolCall = output.content.find(block => block.type === "toolCall");
	if (toolCall?.type !== "toolCall") throw new Error("expected a finalized toolCall block");
	expect(JSON.stringify(toolCall.arguments)).toBe('"hello"');
	const nativeCall = nativeItems.find(item => item.type === "function_call");
	expect(JSON.parse(String(nativeCall?.arguments))).toBe("hello");
});

it("replays streamed text beside a terminal-finalized call when item-done events are missing", async () => {
	const output = emptyAssistant();
	const nativeItems: Array<Record<string, unknown>> = [];
	await processResponsesStream(
		events([
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_pending", role: "assistant", content: [] },
			},
			{
				type: "response.output_text.delta",
				output_index: 0,
				item_id: "msg_pending",
				delta: "Inspecting the file before editing.",
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "function_call", id: "fc_read", call_id: "call_read", name: "read", arguments: "" },
			},
			{
				type: "response.function_call_arguments.delta",
				output_index: 1,
				item_id: "fc_read",
				delta: '{"path":"file.ts"}',
			},
			{ type: "response.completed", response: { id: "resp_pending", status: "completed" } },
		]),
		output,
		new AssistantMessageEventStream(),
		model,
		{ onOutputItemDone: item => nativeItems.push(item as unknown as Record<string, unknown>) },
	);
	output.providerPayload = createOpenAIResponsesHistoryPayload(model.provider, nativeItems);
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_read|fc_read",
		toolName: "read",
		content: [{ type: "text", text: "file contents" }],
		isError: false,
		timestamp: 2,
	};
	const input = buildParams(model, { messages: [output, result] }, undefined, undefined).params.input;
	expect(input).toMatchObject([
		{ type: "message", content: [{ type: "output_text", text: "Inspecting the file before editing." }] },
		{ type: "function_call", call_id: "call_read", name: "read", arguments: '{"path":"file.ts"}' },
		{ type: "function_call_output", call_id: "call_read", output: "file contents" },
	]);
});

it("replays done-only items by output index rather than arrival order", async () => {
	const output = emptyAssistant();
	const nativeItems: Array<Record<string, unknown>> = [];
	await processResponsesStream(
		events([
			...functionCallEvents(2, "call_read", "read", '{"path":"file.ts"}'),
			...[1, 0].map(outputIndex => ({
				type: "response.output_item.done",
				output_index: outputIndex,
				item: {
					type: "message",
					id: `msg_${outputIndex}`,
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: outputIndex === 0 ? "First" : "Second", annotations: [] }],
				},
			})),
			{ type: "response.completed", response: { status: "completed" } },
		]),
		output,
		new AssistantMessageEventStream(),
		model,
		{ onOutputItemDone: item => nativeItems.push(item as unknown as Record<string, unknown>) },
	);
	output.providerPayload = createOpenAIResponsesHistoryPayload(model.provider, nativeItems);
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_read|fc_call_read",
		toolName: "read",
		content: [{ type: "text", text: "file contents" }],
		isError: false,
		timestamp: 2,
	};
	const input = buildParams(model, { messages: [output, result] }, undefined, undefined).params.input;
	expect(input).toMatchObject([
		{ type: "message", content: [{ type: "output_text", text: "First" }] },
		{ type: "message", content: [{ type: "output_text", text: "Second" }] },
		{ type: "function_call", call_id: "call_read" },
		{ type: "function_call_output", call_id: "call_read", output: "file contents" },
	]);
});

it.each(["completed", "failed"])("keeps indexless finalized history ordered after a %s stream", async status => {
	const output = emptyAssistant();
	const nativeItems: Array<Record<string, unknown>> = [];
	const first = { type: "message", id: "msg_first", role: "assistant", content: [] };
	const second = { type: "message", id: "msg_second", role: "assistant", content: [] };
	let completed = false;
	const processing = processResponsesStream(
		events([
			{ type: "response.output_item.added", item: first },
			{ type: "response.output_text.delta", item_id: first.id, delta: "First draft" },
			{ type: "response.output_item.added", item: second },
			{
				type: "response.output_item.done",
				item: {
					...second,
					status: "completed",
					content: [{ type: "output_text", text: "Second", annotations: [] }],
				},
			},
			{
				type: "response.output_item.done",
				item: {
					...first,
					status: "completed",
					content: [{ type: "output_text", text: "First corrected", annotations: [] }],
				},
			},
			{
				type: `response.${status}`,
				response: {
					status,
					error: status === "failed" ? { code: "server_error", message: "upstream failed" } : undefined,
				},
			},
		]),
		output,
		new AssistantMessageEventStream(),
		model,
		{
			onOutputItemDone: item => nativeItems.push(item as unknown as Record<string, unknown>),
			onCompleted: () => {
				completed = true;
			},
		},
	);
	if (status === "failed") await expect(processing).rejects.toThrow("upstream failed");
	else await processing;
	expect(completed).toBe(status === "completed");
	output.providerPayload = createOpenAIResponsesHistoryPayload(model.provider, nativeItems);
	const input = buildParams(model, { messages: [output] }, undefined, undefined).params.input;
	expect(input).toMatchObject([
		{ type: "message", content: [{ type: "output_text", text: "First corrected" }] },
		{ type: "message", content: [{ type: "output_text", text: "Second" }] },
	]);
});

it.each([
	{ incremental: true, reverseResults: false },
	{ incremental: true, reverseResults: true },
	{ incremental: false, reverseResults: false },
	{ incremental: false, reverseResults: true },
])(
	"keeps native call identities with incremental=$incremental reverseResults=$reverseResults",
	async ({ incremental, reverseResults }) => {
		const output = emptyAssistant();
		const nativeItems: Array<Record<string, unknown>> = [];
		const first = {
			type: "function_call",
			id: "fc_first",
			call_id: "call_shared",
			name: "read",
			arguments: '{"path":"first.ts"}',
			encrypted_function_args: ["encrypted-first"],
		};
		const second = {
			type: "function_call",
			id: "fc_second",
			call_id: "call_shared",
			name: "bash",
			arguments: '{"command":"pwd"}',
			encrypted_function_args: ["encrypted-second"],
		};
		await processResponsesStream(
			events([
				{ type: "response.output_item.added", output_index: 1, item: { ...second, arguments: "" } },
				{ type: "response.output_item.done", output_index: 1, item: second },
				// The earlier item never had an added event: content is B,A; native history is A,B.
				{ type: "response.output_item.done", output_index: 0, item: first },
				{ type: "response.completed", response: { status: "completed" } },
			]),
			output,
			new AssistantMessageEventStream(),
			model,
			{ onOutputItemDone: item => nativeItems.push(item as unknown as Record<string, unknown>) },
		);
		const calls = output.content.filter(block => block.type === "toolCall");
		expect(calls.map(call => call.id)).toEqual(["call_shared|fc_second", "call_shared|fc_first"]);
		expect(nativeItems.map(item => item.id)).toEqual(["fc_first", "fc_second"]);
		output.providerPayload = {
			type: "openaiResponsesHistory",
			provider: model.provider,
			...(incremental ? { dt: true as const } : {}),
			items: nativeItems,
		};
		const results: ToolResultMessage[] = calls.map(call => ({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: `${call.name}: ${JSON.stringify(call.arguments)}` }],
			isError: false,
			timestamp: 2,
		}));
		if (reverseResults) results.reverse();
		const messages: Message[] = [output, ...results];
		if (!incremental) {
			messages.push({
				...emptyAssistant(),
				content: [{ type: "text", text: "Done" }],
				stopReason: "stop",
				providerPayload: {
					type: "openaiResponsesHistory",
					provider: model.provider,
					items: [
						...nativeItems,
						...results.map((result, index) => ({
							type: "function_call_output",
							// These are output ids, deliberately not originating call identities.
							id: index === 0 ? "fc_first" : "fc_second",
							call_id: "call_shared",
							output: result.content[0]!.type === "text" ? result.content[0]!.text : "",
						})),
						{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] },
					],
				},
			});
		}
		const original = structuredClone(messages);
		const input = buildParams(model, { messages }, undefined, undefined).params.input;
		if (!input) throw new Error("Expected replay input");
		const replayedCalls = input.filter(item => item.type === "function_call");
		const replayedResults = input.filter(item => item.type === "function_call_output");
		expect(replayedCalls).toHaveLength(2);
		expect(replayedResults).toHaveLength(2);
		expect(replayedCalls.map(call => call.call_id)).toEqual(["call_shared_dup1", "call_shared"]);
		for (const [index, native] of [first, second].entries()) {
			const call = replayedCalls[index]!;
			expect(call).toMatchObject({
				name: native.name,
				arguments: native.arguments,
				encrypted_function_args: native.encrypted_function_args,
			});
			expect(replayedResults.filter(result => result.call_id === call.call_id)).toEqual([
				expect.objectContaining({ output: `${native.name}: ${native.arguments}` }),
			]);
		}
		expect(JSON.stringify(input)).not.toContain("No result provided");
		expect(JSON.stringify(input)).not.toContain("Orphan");
		expect(messages).toEqual(original);
	},
);

it.each([
	{ kind: "function_call", identity: "final" },
	{ kind: "custom_tool_call", identity: "final" },
	{ kind: "function_call", identity: "added" },
	{ kind: "custom_tool_call", identity: "added" },
	{ kind: "function_call", identity: "absent" },
	{ kind: "custom_tool_call", identity: "absent" },
] as const)("replays $kind with its $identity identity through the OpenAI consumer", async ({ kind, identity }) => {
	const replayModel = { ...model, applyPatchToolType: "freeform" as const };
	const output = emptyAssistant();
	const stream = new AssistantMessageEventStream();
	const nativeItems: Array<Record<string, unknown>> = [];
	const item = {
		type: kind,
		call_id: "call_identity",
		name: kind === "custom_tool_call" ? "apply_patch" : "echo",
		...(kind === "custom_tool_call" ? { input: "patch contents" } : { arguments: '{"value":"hello"}' }),
	};
	await processResponsesStream(
		events([
			{
				type: "response.output_item.added",
				item: { ...item, ...(identity === "added" ? { id: "fc_identity" } : {}) },
			},
			{
				type: "response.output_item.done",
				item: { ...item, ...(identity === "final" ? { id: "fc_identity" } : {}) },
			},
			{ type: "response.completed", response: { status: "completed" } },
		]),
		output,
		stream,
		replayModel,
		{ onOutputItemDone: native => nativeItems.push(native as unknown as Record<string, unknown>) },
	);
	stream.end(output);
	const endedIds: string[] = [];
	for await (const event of stream) {
		if (event.type === "toolcall_end") endedIds.push(event.toolCall.id);
	}
	const calls = output.content.filter(block => block.type === "toolCall");
	expect(calls).toHaveLength(1);
	const call = calls[0]!;
	expect(endedIds).toEqual([call.id]);
	expect(call.id).toBe(
		identity === "absent"
			? `call_identity|fc_${Bun.hash("call_identity").toString(36)}`
			: "call_identity|fc_identity",
	);
	expect(nativeItems).toHaveLength(1);
	if (identity === "absent") expect(nativeItems[0]).not.toHaveProperty("id");
	else expect(nativeItems[0]).toHaveProperty("id", "fc_identity");
	output.providerPayload = createOpenAIResponsesHistoryPayload(model.provider, nativeItems);
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: "executed result" }],
		isError: false,
		timestamp: 2,
	};
	const input = buildParams(replayModel, { messages: [output, result] }, undefined, undefined).params.input;
	expect(input).toMatchObject([
		{
			type: kind,
			call_id: "call_identity",
			...(kind === "custom_tool_call" ? { input: "patch contents" } : { arguments: '{"value":"hello"}' }),
		},
		{
			type: kind === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output",
			call_id: "call_identity",
			output: "executed result",
		},
	]);
	expect(JSON.stringify(input)).not.toContain("Orphan");
});

it.each([false, true])("closes aliases without stealing a distinct sibling, indexless=%s", async indexless => {
	const output = emptyAssistant();
	const nativeItems: Array<Record<string, unknown>> = [];
	const call = { type: "function_call", call_id: "call_shared", name: "echo", arguments: "" };
	await processResponsesStream(
		events([
			{
				type: "response.output_item.added",
				...(indexless ? {} : { output_index: 0 }),
				item: { ...call, ...(indexless ? {} : { id: "fc_old" }) },
			},
			{ type: "response.output_item.added", item: { ...call, id: "fc_sibling" } },
			{
				type: "response.output_item.done",
				...(indexless ? {} : { output_index: 0 }),
				item: { ...call, id: "fc_final", arguments: '{"value":"first"}' },
			},
			// Neither the original item id nor its index may mutate a completed block.
			{ type: "response.function_call_arguments.done", item_id: "fc_old", arguments: '{"value":"stale-id"}' },
			{ type: "response.function_call_arguments.done", output_index: 0, arguments: '{"value":"stale-index"}' },
			// A new final id cannot claim the sibling merely because call_id matches.
			{
				type: "response.output_item.done",
				item: { ...call, id: "fc_done_only", arguments: '{"value":"done-only"}' },
			},
			{ type: "response.function_call_arguments.delta", item_id: "call_shared", delta: '{"value":"sibling"}' },
			{ type: "response.output_item.done", item: { ...call, id: "fc_sibling" } },
			{ type: "response.completed", response: { status: "completed" } },
		]),
		output,
		new AssistantMessageEventStream(),
		model,
		{ onOutputItemDone: item => nativeItems.push(item as unknown as Record<string, unknown>) },
	);
	const calls = output.content.filter(block => block.type === "toolCall");
	expect(calls.map(call => [call.id, call.arguments])).toEqual([
		["call_shared|fc_final", { value: "first" }],
		["call_shared|fc_sibling", { value: "sibling" }],
		["call_shared|fc_done_only", { value: "done-only" }],
	]);
	output.providerPayload = createOpenAIResponsesHistoryPayload(model.provider, nativeItems);
	const results: ToolResultMessage[] = calls.map(call => ({
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: String(call.arguments.value) }],
		isError: false,
		timestamp: 2,
	}));
	const input = buildParams(model, { messages: [output, ...results] }, undefined, undefined).params.input;
	if (!input) throw new Error("Expected replay input");
	const replayCalls = input.filter(item => item.type === "function_call");
	const replayResults = input.filter(item => item.type === "function_call_output");
	expect(replayCalls).toHaveLength(3);
	expect(replayResults).toHaveLength(3);
	for (const call of replayCalls) {
		expect(replayResults.find(result => result.call_id === call.call_id)).toMatchObject({
			output: JSON.parse(call.arguments).value,
		});
	}
	expect(JSON.stringify(input)).not.toContain("Orphan");
});

it.each([
	{ kind: "function_call", alias: "bare" },
	{ kind: "function_call", alias: "prefixed" },
	{ kind: "custom_tool_call", alias: "bare" },
] as const)("completes one $kind through its registered $alias alias", async ({ kind, alias }) => {
	const replayModel = { ...model, applyPatchToolType: "freeform" as const };
	const output = emptyAssistant();
	const nativeItems: Array<Record<string, unknown>> = [];
	const stream = new AssistantMessageEventStream();
	const wireId = alias === "bare" ? "a" : "fc_a";
	const item = {
		type: kind,
		id: alias === "bare" ? "fc_a" : "native_a",
		call_id: "a",
		name: kind === "custom_tool_call" ? "apply_patch" : "echo",
		...(kind === "custom_tool_call" ? { input: "" } : { arguments: "" }),
	};
	const input = kind === "custom_tool_call" ? "patch contents" : '{"value":"one"}';
	await processResponsesStream(
		events([
			{ type: "response.output_item.added", item },
			{
				type:
					kind === "custom_tool_call"
						? "response.custom_tool_call_input.delta"
						: "response.function_call_arguments.delta",
				item_id: item.id,
				delta: input,
			},
			{ type: "response.output_item.done", item: { ...item, id: wireId } },
			// The old identity must no longer route late input into the completed call.
			{ type: "response.function_call_arguments.done", item_id: item.id, arguments: '{"value":"stale"}' },
			{ type: "response.completed", response: { status: "completed" } },
		]),
		output,
		stream,
		replayModel,
		{ onOutputItemDone: native => nativeItems.push(native as unknown as Record<string, unknown>) },
	);
	stream.end(output);
	const calls = output.content.filter(block => block.type === "toolCall");
	expect(calls.map(call => [call.id, call.arguments])).toEqual([
		[`a|${wireId}`, kind === "custom_tool_call" ? { input } : { value: "one" }],
	]);
	const endedIds: string[] = [];
	for await (const event of stream) if (event.type === "toolcall_end") endedIds.push(event.toolCall.id);
	expect(endedIds).toEqual([`a|${wireId}`]);
	output.providerPayload = createOpenAIResponsesHistoryPayload(model.provider, nativeItems);
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: calls[0]!.id,
		toolName: item.name,
		content: [{ type: "text", text: "executed once" }],
		isError: false,
		timestamp: 2,
	};
	const replay = buildParams(replayModel, { messages: [output, result] }, undefined, undefined).params.input;
	expect(replay).toMatchObject([
		{ type: kind, call_id: "a", ...(kind === "custom_tool_call" ? { input } : { arguments: input }) },
		{
			type: kind === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output",
			call_id: "a",
			output: "executed once",
		},
	]);
});

it("does not resolve an ambiguous registered alias to a distinct sibling", async () => {
	const output = emptyAssistant();
	const item = { type: "function_call", call_id: "a", name: "echo", arguments: "" };
	await processResponsesStream(
		events([
			{ type: "response.output_item.added", item: { ...item, id: "fc_first" } },
			{ type: "response.output_item.added", item: { ...item, id: "fc_second" } },
			{ type: "response.output_item.done", item: { ...item, id: "a", arguments: '{"value":"unmatched"}' } },
			{ type: "response.function_call_arguments.delta", item_id: "fc_first", delta: '{"value":"first"}' },
			{ type: "response.function_call_arguments.delta", item_id: "fc_second", delta: '{"value":"second"}' },
			{ type: "response.output_item.done", item: { ...item, id: "fc_second" } },
			{ type: "response.output_item.done", item: { ...item, id: "fc_first" } },
			{ type: "response.completed", response: { status: "completed" } },
		]),
		output,
		new AssistantMessageEventStream(),
		model,
	);
	expect(output.content.filter(block => block.type === "toolCall").map(call => [call.id, call.arguments])).toEqual([
		["a|fc_first", { value: "first" }],
		["a|fc_second", { value: "second" }],
		["a|a", { value: "unmatched" }],
	]);
});
