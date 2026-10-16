import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type AzureOpenAIResponsesOptions,
	streamAzureOpenAIResponses,
} from "@oh-my-pi/pi-ai/providers/azure-openai-responses";
import type { Context, FetchImpl, Model, ModelSpec, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const azureModel: Model<"azure-openai-responses"> = buildModel({
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://example.openai.azure.com/openai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
});

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function createSseResponse(events: unknown[]): Response {
	const sse = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(sse));
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createAssistantMessage(text: string, textSignature?: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text, ...(textSignature ? { textSignature } : {}) }],
		api: "azure-openai-responses" as const,
		provider: "azure" as const,
		model: "gpt-5-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

async function captureAzurePayload(
	context: Context,
	model: Model<"azure-openai-responses"> = azureModel,
	options: Partial<AzureOpenAIResponsesOptions> = {},
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamAzureOpenAIResponses(model, context, {
		apiKey: "test-key",
		azureBaseUrl: model.baseUrl,
		azureApiVersion: "v1",
		...options,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("azure openai responses streaming", () => {
	it("serializes each system prompt as an Azure Responses system input item for non-reasoning models", async () => {
		const payload = await captureAzurePayload({
			systemPrompt: ["First instruction", "", "Second instruction"],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});

		expect(payload.input).toEqual([
			{ role: "system", content: "First instruction" },
			{ role: "system", content: "Second instruction" },
			{ role: "user", content: [{ type: "input_text", text: "Say hello" }] },
		]);
	});

	it("replays a malformed native function call with parseable arguments so its output stays paired", async () => {
		const previous = {
			...createAssistantMessage(""),
			stopReason: "toolUse" as const,
			providerPayload: {
				type: "openaiResponsesHistory" as const,
				provider: "azure" as const,
				items: [
					{
						type: "function_call",
						id: "fc_bad",
						call_id: "call_bad",
						name: "bash",
						arguments: '{"command":"unterminated',
					},
					{ type: "function_call_output", call_id: "call_bad", output: "durable result" },
				],
			},
		};

		const payload = await captureAzurePayload({
			messages: [previous, { role: "user", content: "continue", timestamp: Date.now() }],
		});
		const input = payload.input as Array<Record<string, unknown>>;

		const badCall = input.find(item => item.type === "function_call" && item.call_id === "call_bad");
		expect(JSON.parse(String(badCall?.arguments))).toMatchObject({ __rawJson: '{"command":"unterminated' });
		expect(input).toContainEqual(
			expect.objectContaining({ type: "function_call_output", call_id: "call_bad", output: "durable result" }),
		);
		expect(JSON.stringify(input)).not.toContain("Orphan");
	});

	it("replays shared call_ids with distinct final item ids and keeps each result paired", async () => {
		const calls = ["first", "second"].map(value => ({
			type: "function_call",
			id: `fc_${value}`,
			call_id: "call_shared",
			name: "echo",
			arguments: JSON.stringify({ value }),
			encrypted_function_args: [`encrypted-${value}`],
		}));
		const stream = streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Echo both values", timestamp: 0 }] },
			{
				apiKey: "test-key",
				azureBaseUrl: azureModel.baseUrl,
				azureApiVersion: "v1",
				fetch: async () =>
					createSseResponse([
						...calls.map((call, output_index) => ({
							type: "response.output_item.added",
							output_index,
							item: { type: call.type, call_id: call.call_id, name: call.name, arguments: "" },
						})),
						{ type: "response.output_item.done", output_index: 0, item: calls[0] },
						// Closing the first call must not delete the second call's shared alias.
						{
							type: "response.function_call_arguments.delta",
							item_id: "call_shared",
							delta: calls[1]!.arguments,
						},
						{ type: "response.output_item.done", output_index: 1, item: { ...calls[1], arguments: "" } },
						{ type: "response.completed", response: { id: "resp_final_ids", status: "completed" } },
					]),
			},
		);
		const endedIds: string[] = [];
		for await (const event of stream) {
			if (event.type === "toolcall_end") endedIds.push(event.toolCall.id);
		}
		const result = await stream.result();
		expect(result.stopReason).toBe("toolUse");
		const toolCalls = result.content.filter(block => block.type === "toolCall");
		expect(toolCalls.map(call => call.id)).toEqual(["call_shared|fc_first", "call_shared|fc_second"]);
		expect(endedIds).toEqual(toolCalls.map(call => call.id));
		expect(result.providerPayload).toMatchObject({ items: calls });
		const payload = await captureAzurePayload({
			messages: [
				result,
				...toolCalls.map(call => ({
					role: "toolResult" as const,
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text" as const, text: `result-${call.arguments.value}` }],
					isError: false,
					timestamp: 1,
				})),
			],
		});
		const input = payload.input as Array<Record<string, unknown>>;
		const replayCalls = input.filter(item => item.type === "function_call");
		const replayResults = input.filter(item => item.type === "function_call_output");
		expect(replayCalls).toHaveLength(2);
		expect(new Set(replayCalls.map(call => call.call_id)).size).toBe(2);
		expect(replayResults).toHaveLength(2);
		for (const [index, call] of replayCalls.entries()) {
			const value = index === 0 ? "first" : "second";
			expect(JSON.parse(String(call.arguments))).toEqual({ value });
			expect(call.encrypted_function_args).toEqual([`encrypted-${value}`]);
			expect(replayResults.find(item => item.call_id === call.call_id)).toMatchObject({ output: `result-${value}` });
		}
		expect(JSON.stringify(input)).not.toContain("Orphan");
	});

	it("replays both indexless calls with empty item ids and their real results", async () => {
		const calls = ["first", "second"].map(value => ({
			type: "function_call",
			id: "",
			call_id: `call_${value}`,
			name: "echo",
			arguments: JSON.stringify({ value }),
			encrypted_function_args: [`encrypted-${value}`],
		}));
		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Echo both values", timestamp: 0 }] },
			{
				apiKey: "test-key",
				azureBaseUrl: azureModel.baseUrl,
				azureApiVersion: "v1",
				fetch: async () =>
					createSseResponse([
						...calls.map(call => ({ type: "response.output_item.added", item: { ...call, arguments: "" } })),
						{ type: "response.output_item.done", item: calls[1] },
						{ type: "response.output_item.done", item: calls[0] },
						{ type: "response.completed", response: { id: "resp_empty_ids", status: "completed" } },
					]),
			},
		).result();
		expect(result.stopReason).toBe("toolUse");
		const toolCalls = result.content.filter(block => block.type === "toolCall");
		expect(toolCalls.map(call => call.arguments)).toEqual([{ value: "first" }, { value: "second" }]);
		const payload = await captureAzurePayload({
			messages: [
				result,
				...toolCalls.map(call => ({
					role: "toolResult" as const,
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text" as const, text: `result-${call.arguments.value}` }],
					isError: false,
					timestamp: 1,
				})),
			],
		});
		const input = payload.input as Array<Record<string, unknown>>;
		const replayCalls = input.filter(item => item.type === "function_call");
		const replayResults = input.filter(item => item.type === "function_call_output");
		expect(replayCalls.map(call => [call.call_id, call.arguments, call.encrypted_function_args])).toEqual(
			calls.map(call => [call.call_id, call.arguments, call.encrypted_function_args]),
		);
		expect(replayResults.map(item => [item.call_id, item.output])).toEqual([
			["call_first", "result-first"],
			["call_second", "result-second"],
		]);
		expect(JSON.stringify(input)).not.toContain("Orphan");
	});

	it.each(["input done", "delta", "item done"] as const)(
		"replays custom input from %s rather than an empty or stale invocation",
		async source => {
			const model = { ...azureModel, applyPatchToolType: "freeform" as const };
			const patch = "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch";
			const item = { type: "custom_tool_call", id: "ctc_patch", call_id: "call_patch", name: "apply_patch" };
			const result = await streamAzureOpenAIResponses(
				model,
				{ messages: [{ role: "user", content: "Apply patch", timestamp: 0 }] },
				{
					apiKey: "test-key",
					azureBaseUrl: model.baseUrl,
					azureApiVersion: "v1",
					fetch: async () =>
						createSseResponse([
							{ type: "response.output_item.added", output_index: 0, item: { ...item, input: "" } },
							...(source === "delta"
								? [{ type: "response.custom_tool_call_input.delta", output_index: 0, delta: patch }]
								: [
										{
											type: "response.custom_tool_call_input.done",
											output_index: 0,
											input: source === "item done" ? "stale input" : patch,
										},
									]),
							{
								type: "response.output_item.done",
								output_index: 0,
								item: { ...item, input: source === "item done" ? patch : "" },
							},
							{ type: "response.completed", response: { id: "resp_custom", status: "completed" } },
						]),
				},
			).result();
			expect(result.stopReason).toBe("toolUse");
			const call = result.content.find(block => block.type === "toolCall");
			if (!call) throw new Error("Expected patch call");
			expect(call.arguments).toEqual({ input: patch });
			const payload = await captureAzurePayload(
				{
					messages: [
						result,
						{
							role: "toolResult",
							toolCallId: call.id,
							toolName: call.name,
							content: [{ type: "text", text: "patch applied" }],
							isError: false,
							timestamp: 1,
						},
					],
				},
				model,
			);
			const input = payload.input as Array<Record<string, unknown>>;
			expect(input.filter(entry => entry.type === "custom_tool_call")).toEqual([
				expect.objectContaining({ call_id: "call_patch", name: "apply_patch", input: patch }),
			]);
			expect(input.filter(entry => entry.type === "custom_tool_call_output")).toEqual([
				expect.objectContaining({ call_id: "call_patch", output: "patch applied" }),
			]);
			expect(JSON.stringify(input)).not.toContain("Orphan");
		},
	);

	it.each(["completed", "incomplete"] as const)(
		"replays pending text and calls beside completed native items after response.%s",
		async status => {
			const reasoning = { type: "reasoning", id: "rs_replay", summary: [], encrypted_content: "opaque-replay" };
			const commentary = {
				type: "message",
				id: "msg_comment",
				role: "assistant",
				content: [{ type: "output_text", text: "Calling echo now.", annotations: [] }],
			};
			const call = {
				type: "function_call",
				id: "fc_pending",
				call_id: "call_pending",
				name: "echo",
				arguments: "",
				encrypted_function_args: [],
			};
			const result = await streamAzureOpenAIResponses(
				azureModel,
				{ messages: [{ role: "user", content: "Echo hello", timestamp: 0 }] },
				{
					apiKey: "test-key",
					azureBaseUrl: azureModel.baseUrl,
					azureApiVersion: "v1",
					fetch: async () =>
						createSseResponse([
							{ type: "response.created", response: { id: "resp_replay" } },
							{ type: "response.output_item.added", output_index: 0, item: reasoning },
							{ type: "response.output_item.done", output_index: 0, item: reasoning },
							{ type: "response.output_item.added", output_index: 1, item: { ...commentary, content: [] } },
							{ type: "response.output_item.done", output_index: 1, item: commentary },
							{
								type: "response.output_item.added",
								output_index: 2,
								item: { type: "message", id: "msg_pending", role: "assistant", content: [] },
							},
							{
								type: "response.output_text.delta",
								output_index: 2,
								item_id: "msg_pending",
								delta: "Keep this explanation on the next turn.",
							},
							{ type: "response.output_item.added", output_index: 3, item: call },
							{
								type: "response.function_call_arguments.delta",
								output_index: 3,
								item_id: call.id,
								delta: '{"value":"hello"}',
							},
							{
								type: `response.${status}`,
								response: {
									id: "resp_replay",
									status,
									...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
								},
							},
						]),
				},
			).result();
			expect(result.stopReason).toBe("toolUse");
			const payload = await captureAzurePayload({
				messages: [
					result,
					{
						role: "toolResult",
						toolCallId: "call_pending|fc_pending",
						toolName: "echo",
						content: [{ type: "text", text: "hello" }],
						isError: false,
						timestamp: 1,
					},
				],
			});
			const input = payload.input as Array<Record<string, unknown>>;
			expect(input.filter(item => item.type === "function_call")).toMatchObject([
				{ call_id: "call_pending", name: "echo", arguments: '{"value":"hello"}', encrypted_function_args: [] },
			]);
			expect(input).toContainEqual(
				expect.objectContaining({ type: "function_call_output", call_id: "call_pending", output: "hello" }),
			);
			expect(input).toContainEqual(
				expect.objectContaining({ type: "reasoning", encrypted_content: "opaque-replay" }),
			);
			const messages = input.filter(item => item.type === "message");
			expect(messages).toMatchObject([
				{ content: [{ type: "output_text", text: "Calling echo now." }] },
				{ content: [{ type: "output_text", text: "Keep this explanation on the next turn." }] },
			]);
		},
	);

	it.each([false, true])("reconciles a late indexless message id with empty done=%s", async emptyDone => {
		const message = { type: "message", role: "assistant", content: [] };
		const stream = streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: 0 }] },
			{
				apiKey: "test-key",
				azureBaseUrl: azureModel.baseUrl,
				azureApiVersion: "v1",
				fetch: async () =>
					createSseResponse([
						{ type: "response.output_item.added", item: message },
						{ type: "response.output_text.delta", delta: "Hello" },
						{
							type: "response.output_item.done",
							item: {
								...message,
								id: "msg_final",
								content: emptyDone ? [] : [{ type: "output_text", text: "Hello", annotations: [] }],
							},
						},
						{ type: "response.completed", response: { id: "resp_late_message", status: "completed" } },
					]),
			},
		);
		const endedIndices: number[] = [];
		for await (const event of stream) if (event.type === "text_end") endedIndices.push(event.contentIndex);
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content.filter(block => block.type === "text").map(block => block.text)).toEqual(["Hello"]);
		expect(endedIndices).toEqual([0]);
		if (result.providerPayload?.type !== "openaiResponsesHistory") throw new Error("Expected native history");
		expect(result.providerPayload.items.map(item => item.id)).toEqual(["msg_final"]);
		const payload = await captureAzurePayload({ messages: [result] });
		expect(payload.input).toEqual([
			expect.objectContaining({
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Hello", annotations: [] }],
			}),
		]);
	});

	it.each(["known identity", "ambiguous anonymous"] as const)(
		"does not steal a pending message with %s for a new final id",
		async pending => {
			const message = { type: "message", role: "assistant", content: [] };
			const result = await streamAzureOpenAIResponses(
				azureModel,
				{ messages: [{ role: "user", content: "Continue", timestamp: 0 }] },
				{
					apiKey: "test-key",
					azureBaseUrl: azureModel.baseUrl,
					azureApiVersion: "v1",
					fetch: async () =>
						createSseResponse([
							{
								type: "response.output_item.added",
								item: { ...message, ...(pending === "known identity" ? { id: "msg_known" } : {}) },
							},
							{ type: "response.output_text.delta", delta: "Hello" },
							...(pending === "ambiguous anonymous"
								? [
										{ type: "response.output_item.added", item: message },
										{ type: "response.output_text.delta", delta: "Other" },
									]
								: []),
							{
								type: "response.output_item.done",
								item: {
									...message,
									id: "msg_final",
									content: [{ type: "output_text", text: "Hello", annotations: [] }],
								},
							},
							{ type: "response.completed", response: { id: "resp_distinct_messages", status: "completed" } },
						]),
				},
			).result();
			expect(result.stopReason).toBe("stop");
			const expectedText = pending === "known identity" ? ["Hello", "Hello"] : ["Hello", "Other", "Hello"];
			expect(result.content.filter(block => block.type === "text").map(block => block.text)).toEqual(expectedText);
			if (result.providerPayload?.type !== "openaiResponsesHistory") throw new Error("Expected native history");
			expect(result.providerPayload.items.map(item => item.id)).toEqual(
				pending === "known identity" ? ["msg_known", "msg_final"] : [undefined, undefined, "msg_final"],
			);
			const payload = await captureAzurePayload({ messages: [result] });
			expect(payload.input).toEqual(
				expectedText.map(text =>
					expect.objectContaining({
						type: "message",
						content: [{ type: "output_text", text, annotations: [] }],
					}),
				),
			);
		},
	);

	it.each(["text delta", "refusal delta", "atomic text done", "authoritative message done"] as const)(
		"replays %s beside a completed call without losing recovered or authoritative content",
		async source => {
			const text = source === "refusal delta" ? "I cannot provide that information." : "Calling echo now.";
			const streamedText = source === "authoritative message done" ? "Superseded draft." : text;
			const message = {
				type: "message",
				id: "msg_empty_done",
				role: "assistant",
				phase: "commentary",
				content: [],
			};
			const call = {
				type: "function_call",
				id: "fc_after_message",
				call_id: "call_after_message",
				name: "echo",
				arguments: '{"value":"hello"}',
				status: "completed",
				encrypted_function_args: [],
			};
			const result = await streamAzureOpenAIResponses(
				azureModel,
				{ messages: [{ role: "user", content: "Echo hello", timestamp: 0 }] },
				{
					apiKey: "test-key",
					azureBaseUrl: azureModel.baseUrl,
					azureApiVersion: "v1",
					fetch: async () =>
						createSseResponse([
							{ type: "response.created", response: { id: "resp_empty_done" } },
							{ type: "response.output_item.added", output_index: 0, item: message },
							{
								type:
									source === "atomic text done"
										? "response.output_text.done"
										: source === "refusal delta"
											? "response.refusal.delta"
											: "response.output_text.delta",
								output_index: 0,
								item_id: message.id,
								content_index: 0,
								...(source === "atomic text done" ? { text } : { delta: streamedText }),
							},
							{
								type: "response.output_item.done",
								output_index: 0,
								item: {
									...message,
									status: "completed",
									...(source === "authoritative message done"
										? { content: [{ type: "output_text", text, annotations: [] }] }
										: {}),
								},
							},
							{
								type: "response.output_item.added",
								output_index: 1,
								item: { ...call, arguments: "", status: "in_progress" },
							},
							{ type: "response.output_item.done", output_index: 1, item: call },
							{ type: "response.completed", response: { id: "resp_empty_done", status: "completed" } },
						]),
				},
			).result();

			expect(result.stopReason).toBe("toolUse");
			expect(result.content).toMatchObject([
				{ type: "text", text },
				{
					type: "toolCall",
					id: "call_after_message|fc_after_message",
					name: "echo",
					arguments: { value: "hello" },
				},
			]);
			const payload = await captureAzurePayload({
				messages: [
					result,
					{
						role: "toolResult",
						toolCallId: "call_after_message|fc_after_message",
						toolName: "echo",
						content: [{ type: "text", text: "hello" }],
						isError: false,
						timestamp: 1,
					},
				],
			});
			expect(payload.input).toMatchObject([
				{
					type: "message",
					role: "assistant",
					phase: "commentary",
					content:
						source === "refusal delta"
							? [{ type: "refusal", refusal: text }]
							: [{ type: "output_text", text, annotations: [] }],
				},
				{
					type: "function_call",
					call_id: call.call_id,
					name: call.name,
					arguments: call.arguments,
					encrypted_function_args: [],
				},
				{ type: "function_call_output", call_id: call.call_id, output: "hello" },
			]);
		},
	);

	it.each([true, false])(
		"replays a terminal-recovered message before a later completed message (output indices: %s)",
		async indexed => {
			const earlier = {
				type: "message",
				id: "msg_earlier_pending",
				role: "assistant",
				phase: "commentary",
				content: [],
			};
			const later = {
				type: "message",
				id: "msg_later_completed",
				role: "assistant",
				phase: "final_answer",
				status: "completed",
				content: [{ type: "output_text", text: "Later completed answer.", annotations: [] }],
			};
			const result = await streamAzureOpenAIResponses(
				azureModel,
				{ messages: [{ role: "user", content: "Explain", timestamp: 0 }] },
				{
					apiKey: "test-key",
					azureBaseUrl: azureModel.baseUrl,
					azureApiVersion: "v1",
					fetch: async () =>
						createSseResponse([
							{ type: "response.created", response: { id: "resp_order" } },
							{ type: "response.output_item.added", ...(indexed ? { output_index: 0 } : {}), item: earlier },
							{
								type: "response.output_text.delta",
								...(indexed ? { output_index: 0 } : {}),
								item_id: earlier.id,
								content_index: 0,
								delta: "Earlier streamed answer.",
							},
							{
								type: "response.output_item.added",
								...(indexed ? { output_index: 1 } : {}),
								item: { ...later, content: [], status: "in_progress" },
							},
							{ type: "response.output_item.done", ...(indexed ? { output_index: 1 } : {}), item: later },
							{ type: "response.completed", response: { id: "resp_order", status: "completed" } },
						]),
				},
			).result();

			expect(result.stopReason).toBe("stop");
			expect(result.content).toMatchObject([
				{ type: "text", text: "Earlier streamed answer." },
				{ type: "text", text: "Later completed answer." },
			]);
			const payload = await captureAzurePayload({
				messages: [result, { role: "user", content: "Continue", timestamp: 1 }],
			});
			expect(payload.input).toMatchObject([
				{
					type: "message",
					role: "assistant",
					phase: "commentary",
					content: [{ type: "output_text", text: "Earlier streamed answer.", annotations: [] }],
				},
				{
					type: "message",
					role: "assistant",
					phase: "final_answer",
					content: [{ type: "output_text", text: "Later completed answer.", annotations: [] }],
				},
				{ role: "user", content: [{ type: "input_text", text: "Continue" }] },
			]);
		},
	);

	it("sends an async onPayload replacement body", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
			return createSseResponse([
				{
					type: "response.completed",
					response: {
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]);
		});

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{
				apiKey: "test-key",
				fetch: fetchMock as unknown as typeof fetch,
				azureBaseUrl: azureModel.baseUrl,
				azureApiVersion: "v1",
				onPayload: async payload => ({
					...(payload as Record<string, unknown>),
					input: [{ role: "user", content: [{ type: "input_text", text: "replacement" }] }],
				}),
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(capturedBody?.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "replacement" }] }]);
	});

	it("uses developer role for Azure Responses reasoning model system prompts", async () => {
		const reasoningModel: Model<"azure-openai-responses"> = buildModel({
			...azureModel,
			reasoning: true,
			compat: azureModel.compatConfig,
		} as ModelSpec<"azure-openai-responses">);
		const payload = await captureAzurePayload(
			{
				systemPrompt: ["Reasoning instruction", "Second instruction"],
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			reasoningModel,
		);

		expect(payload.input).toEqual([
			{ role: "developer", content: "Reasoning instruction" },
			{ role: "developer", content: "Second instruction" },
			{ role: "user", content: [{ type: "input_text", text: "Say hello" }] },
		]);
	});

	it("omits reasoning summaries when model compatibility disables them", async () => {
		const model: Model<"azure-openai-responses"> = buildModel({
			...azureModel,
			reasoning: true,
			compat: { ...azureModel.compatConfig, supportsReasoningSummary: false },
		} as ModelSpec<"azure-openai-responses">);

		const payload = await captureAzurePayload(
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			model,
			{ reasoning: "high", reasoningSummary: "detailed" },
		);

		expect(payload.reasoning).toEqual({ effort: "high" });
	});

	it("keeps Azure Responses prompt_cache_key separate from Anthropic cache controls", async () => {
		const payload = await captureAzurePayload(
			{
				systemPrompt: ["Cache-stable instruction"],
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			azureModel,
			{ sessionId: "azure-session" },
		);

		expect(payload.prompt_cache_key).toBe("azure-session");
		expect(payload.prompt_cache_retention).toBeUndefined();
		expect(payload.cache_control).toBeUndefined();
	});

	it("rewrites oneOf tool schemas to anyOf for Azure Responses", async () => {
		const tool: Tool = {
			name: "choose",
			description: "choose a branch",
			parameters: {
				type: "object",
				properties: {
					item: {
						oneOf: [
							{
								type: "object",
								properties: { kind: { const: "a" }, value: { type: "string" } },
								required: ["kind", "value"],
								additionalProperties: false,
							},
							{
								type: "object",
								properties: { kind: { const: "b" }, count: { type: "integer" } },
								required: ["kind", "count"],
								additionalProperties: false,
							},
						],
					},
				},
				required: ["item"],
			},
		};

		const payload = await captureAzurePayload({
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			tools: [tool],
		});

		const tools = payload.tools as Array<{ parameters: { properties: { item: Record<string, unknown> } } }>;
		expect(tools[0].parameters.properties.item.oneOf).toBeUndefined();
		expect(Array.isArray(tools[0].parameters.properties.item.anyOf)).toBe(true);
	});

	it("serializes computer and its forced choice as a function on unsupported models", async () => {
		const computer: Tool = {
			name: "computer",
			description: "Control the desktop",
			parameters: { type: "object", properties: {} },
			native: { type: "computer" },
		};
		const read: Tool = {
			name: "read_file",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		};
		const payload = await captureAzurePayload(
			{
				messages: [{ role: "user", content: "Inspect", timestamp: Date.now() }],
				tools: [computer, read],
			},
			azureModel,
			{ toolChoice: { type: "computer" } },
		);
		expect(payload.tools).toEqual([
			expect.objectContaining({ type: "function", name: "computer" }),
			expect.objectContaining({ type: "function", name: "read_file" }),
		]);
		expect(JSON.stringify(payload.tools)).not.toContain('{"type":"computer"}');
		expect(payload.tool_choice).toEqual({ type: "function", name: "computer" });
	});

	it("serializes native GA computer and forced choice for a supported GPT-5.4 Azure model", async () => {
		const supportedModel: Model<"azure-openai-responses"> = buildModel({
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "azure-openai-responses",
			provider: "azure",
			baseUrl: azureModel.baseUrl,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		});
		const computer: Tool = {
			name: "computer",
			description: "Control the desktop",
			parameters: { type: "object", properties: {} },
			native: { type: "computer" },
		};
		const nativeItem = {
			type: "message" as const,
			role: "user" as const,
			content: [
				{ type: "input_text" as const, text: "Inspect" },
				{ type: "input_image" as const, file_id: "file_azure_screen_雪", detail: "auto" as const },
				{ type: "input_file" as const, file_id: "file_azure_context_电脑" },
			],
		};
		const payload = await captureAzurePayload(
			{
				messages: [
					{
						role: "user",
						content: "Inspect",
						providerPayload: { type: "openaiResponsesHistory", items: [nativeItem], dt: true },
						timestamp: Date.now(),
					},
				],
				tools: [computer],
			},
			supportedModel,
			{
				toolChoice: { type: "function", name: "computer" },
				include: ["computer_call_output.output.image_url", "reasoning.encrypted_content"],
			},
		);
		expect(supportedModel.supportsComputerUse).toBe(true);
		expect(payload.tools).toEqual([{ type: "computer" }]);
		expect(payload.tool_choice).toEqual({ type: "computer" });
		expect(payload.input).toEqual([nativeItem]);
		expect(payload.include).toEqual(["computer_call_output.output.image_url", "reasoning.encrypted_content"]);
		expect(JSON.stringify(payload)).not.toContain("display_width");
		expect(JSON.stringify(payload)).not.toContain("display_height");

		const gatewayPayload = await captureAzurePayload(
			{
				messages: [{ role: "user", content: "Inspect", timestamp: Date.now() }],
				tools: [computer],
			},
			supportedModel,
			{
				azureBaseUrl: "https://gateway.example/openai/v1",
				toolChoice: { type: "function", name: "computer" },
			},
		);
		expect(gatewayPayload.tools).toMatchObject([
			{
				type: "function",
				name: "computer",
				description: "Control the desktop",
				parameters: { type: "object", properties: {} },
				strict: false,
			},
		]);
		expect(gatewayPayload.tool_choice).toEqual({ type: "function", name: "computer" });
	});

	it("surfaces nested response.failed provider errors", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			createSseResponse([
				{
					type: "response.failed",
					response: {
						error: { code: "server_error", message: "backend exploded" },
					},
				},
			]),
		);

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{ apiKey: "test-key", azureBaseUrl: azureModel.baseUrl, azureApiVersion: "v1", fetch: fetchMock },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("server_error: backend exploded");
	});

	it("surfaces response.failed incomplete reasons", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			createSseResponse([
				{
					type: "response.failed",
					response: {
						incomplete_details: { reason: "max_output_tokens" },
					},
				},
			]),
		);

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{ apiKey: "test-key", azureBaseUrl: azureModel.baseUrl, azureApiVersion: "v1", fetch: fetchMock },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("incomplete: max_output_tokens");
	});

	it("surfaces response.completed failed status_details errors", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			createSseResponse([
				{
					type: "response.completed",
					response: {
						status: "failed",
						status_details: {
							error: { code: "server_error", message: "backend exploded late" },
						},
					},
				},
			]),
		);

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{ apiKey: "test-key", azureBaseUrl: azureModel.baseUrl, azureApiVersion: "v1", fetch: fetchMock },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("server_error: backend exploded late");
	});
	it("preserves assistant message phase when rebuilding fallback replay history", async () => {
		const payload = await captureAzurePayload({
			messages: [
				{ role: "user", content: "first user", timestamp: Date.now() },
				createAssistantMessage(
					"Commentary answer",
					JSON.stringify({ v: 1, id: "msg_commentary", phase: "final_answer" }),
				),
				{ role: "user", content: "follow-up", timestamp: Date.now() },
			],
		});

		expect(payload.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "first user" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Commentary answer", annotations: [] }],
				status: "completed",
				id: "msg_commentary",
				phase: "final_answer",
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up" }] },
		]);
	});

	it("keeps legacy plain-string text signatures when rebuilding fallback replay history", async () => {
		const payload = await captureAzurePayload({
			messages: [
				{ role: "user", content: "first user", timestamp: Date.now() },
				createAssistantMessage("Legacy answer", "msg_legacy"),
				{ role: "user", content: "follow-up", timestamp: Date.now() },
			],
		});

		expect(payload.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "first user" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Legacy answer", annotations: [] }],
				status: "completed",
				id: "msg_legacy",
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up" }] },
		]);
	});
});
