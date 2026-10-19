import { describe, expect, it } from "bun:test";
import {
	buildTransformedCodexRequestBody,
	convertCodexResponsesMessages,
	normalizeCodexToolChoice,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { convertTools } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { encodeStream, parseRequest } from "@oh-my-pi/pi-ai/providers/openai-responses-server";
import {
	appendResponsesToolResultMessages,
	buildResponsesInput,
	convertResponsesAssistantMessage,
	processResponsesStream,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { ResponseStreamEvent } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import type { AssistantMessage, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createCodexModel } from "./helpers";

function codexTools() {
	return [
		{ type: "custom", name: "exec", format: { type: "text" } },
		{
			type: "namespace",
			name: "clock",
			tools: [
				{ type: "function", name: "sleep", parameters: { type: "object", properties: {} } },
				{ type: "function", name: "wake", parameters: { type: "object", properties: {} } },
			],
		},
		{
			type: "namespace",
			name: "alarm",
			tools: [{ type: "function", name: "sleep", parameters: { type: "object", properties: {} } }],
		},
	];
}

function codexSse(items: Array<Record<string, unknown>>): string {
	const events: Array<Record<string, unknown>> = [
		...items,
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	return `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
}

function codexFetch(sse: string): FetchImpl {
	return (async (input: string | URL, _init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
			return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
		}
		if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
			return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
		}
		if (url.endsWith("/responses")) {
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		}
		return new Response("not found", { status: 404 });
	}) as FetchImpl;
}

function testToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let out = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		out += decoder.decode(value, { stream: true });
	}
	out += decoder.decode();
	return out;
}

function parseSse(raw: string): Array<{ event: string; data: unknown }> {
	const frames: Array<{ event: string; data: unknown }> = [];
	for (const chunk of raw.split("\n\n")) {
		if (!chunk.trim()) continue;
		let event = "";
		let dataLine = "";
		for (const line of chunk.split("\n")) {
			if (line.startsWith("event: ")) event = line.slice("event: ".length);
			else if (line.startsWith("data: ")) dataLine = line.slice("data: ".length);
		}
		if (dataLine === "[DONE]" || !dataLine) continue;
		frames.push({ event, data: JSON.parse(dataLine) as unknown });
	}
	return frames;
}

describe("native Responses tools for Codex", () => {
	it("decodes namespaced Codex SSE calls without colliding same-named leaves", async () => {
		const model = createCodexModel("gpt-5.6-terra");
		const sse = codexSse([
			{
				type: "response.output_item.added",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_clock",
					call_id: "call_1",
					name: "sleep",
					namespace: "clock",
					arguments: "",
				},
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_clock",
					call_id: "call_1",
					name: "sleep",
					namespace: "clock",
					arguments: '{ "ms" : 3 }',
				},
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: {
					type: "function_call",
					id: "fc_alarm",
					call_id: "call_2",
					name: "sleep",
					namespace: "alarm",
					arguments: "",
				},
			},
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "function_call",
					id: "fc_alarm",
					call_id: "call_2",
					name: "sleep",
					namespace: "alarm",
					arguments: '{"ms":4}',
				},
			},
		]);
		const context: Context = { messages: [{ role: "user", content: "go", timestamp: Date.now() }] };
		const message = await streamOpenAICodexResponses(model, context, {
			apiKey: testToken(),
			fetch: codexFetch(sse),
		}).result();
		const calls = message.content.filter(part => part.type === "toolCall");
		expect(calls).toHaveLength(2);
		expect(calls[0]).toMatchObject({ name: "clock.sleep", namespace: "clock", responsesItemId: "fc_clock" });
		expect(calls[1]).toMatchObject({ name: "alarm.sleep", namespace: "alarm", responsesItemId: "fc_alarm" });
		expect(calls[0]?.arguments).toEqual({ ms: 3 });
	});

	it("replays decoded namespace calls with leaf wire names and exact item IDs", async () => {
		const model = createCodexModel("gpt-5.6-terra");
		const parsed = parseRequest({
			model: model.id,
			input: "Use the declared tools.",
			tools: codexTools(),
		});
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1|fc_clock",
					name: "clock.sleep",
					namespace: "clock",
					arguments: { ms: 3 },
					responsesItemId: "fc_clock",
					responsesArguments: '{ "ms" : 3 }',
				},
			],
			api: "openai-codex-responses",
			provider: "openai-codex",
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
			timestamp: Date.now(),
		};
		const toolResult = {
			role: "toolResult",
			toolCallId: "call_1|fc_clock",
			toolName: "clock.sleep",
			content: [{ type: "text", text: "slept" }],
			timestamp: Date.now(),
		} as Context["messages"][number];
		const body = await buildTransformedCodexRequestBody(
			model,
			{ ...parsed.context, messages: [...parsed.context.messages, assistant, toolResult] },
			{},
		);
		const input = body.input as Array<Record<string, unknown>>;
		expect(input).toContainEqual({
			type: "function_call",
			id: "fc_clock",
			call_id: "call_1",
			namespace: "clock",
			name: "sleep",
			arguments: '{ "ms" : 3 }',
		});
		expect(input).toContainEqual({ type: "function_call_output", call_id: "call_1", output: "slept" });
	});

	it("emits namespace identity through the gateway stream for decoded calls", async () => {
		const model = createCodexModel("gpt-5.6-terra");
		const sse = codexSse([
			{
				type: "response.output_item.added",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_exact",
					call_id: "call_sleep",
					name: "sleep",
					namespace: "clock",
					arguments: "",
				},
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_exact",
					call_id: "call_sleep",
					name: "sleep",
					namespace: "clock",
					arguments: '{ "ms" : 3 }',
				},
			},
		]);
		const context: Context = { messages: [{ role: "user", content: "go", timestamp: Date.now() }] };
		const message = await streamOpenAICodexResponses(model, context, {
			apiKey: testToken(),
			fetch: codexFetch(sse),
		}).result();
		const call = message.content.find(part => part.type === "toolCall");
		if (!call || call.type !== "toolCall") throw new Error("expected a decoded tool call");
		const gatewayStream = new AssistantMessageEventStream();
		const partial: AssistantMessage = { ...message, content: [call] };
		queueMicrotask(() => {
			gatewayStream.push({ type: "start", partial });
			gatewayStream.push({ type: "toolcall_start", contentIndex: 0, partial });
			gatewayStream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial });
			gatewayStream.push({ type: "done", reason: "toolUse", message: partial });
		});
		const raw = await collectStream(encodeStream(gatewayStream, model.id));
		const frames = parseSse(raw);
		const done = frames.find(frame => frame.event === "response.output_item.done");
		expect(done?.data).toMatchObject({ item: { type: "function_call", name: "sleep", namespace: "clock" } });
	});
	it("decodes namespaces through the shared Responses stream", async () => {
		const model = buildModel({
			api: "openai-responses",
			id: "shared-ns",
			name: "shared ns",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			contextWindow: 8192,
			maxTokens: 2048,
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			timestamp: Date.now(),
			provider: "openai",
			model: "shared-ns",
			api: "openai-responses",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		};
		const emitted: Array<Record<string, unknown>> = [];
		const stream = {
			push: (event: unknown) => emitted.push(event as Record<string, unknown>),
			end: () => {},
		} as never;
		async function* events(): AsyncIterable<ResponseStreamEvent> {
			yield {
				type: "response.output_item.added",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_shared",
					call_id: "call_shared",
					name: "sleep",
					namespace: "clock",
					arguments: "",
				},
			} as ResponseStreamEvent;
			yield {
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_shared",
					call_id: "call_shared",
					name: "sleep",
					namespace: "clock",
					arguments: '{"ms":3}',
				},
			} as ResponseStreamEvent;
		}
		await processResponsesStream(events(), output, stream, model);
		const call = output.content.find(block => block.type === "toolCall");
		expect(call).toMatchObject({ name: "clock.sleep", namespace: "clock", responsesItemId: "fc_shared" });
	});

	it("forces custom tools by internal and wire names", () => {
		const model = createCodexModel("gpt-5.1-codex");
		const edit = {
			name: "edit",
			description: "edit",
			parameters: { type: "object" },
			customWireName: "apply_patch",
			customFormat: { syntax: "lark", definition: "start: /.+/" },
		} as Context["tools"] extends (infer T)[] | undefined ? T : never;
		expect(normalizeCodexToolChoice({ type: "tool", name: "edit" }, [edit], model)).toEqual({
			type: "custom",
			name: "apply_patch",
		});
		expect(normalizeCodexToolChoice({ type: "tool", name: "apply_patch" }, [edit], model)).toEqual({
			type: "custom",
			name: "apply_patch",
		});
	});

	it("retains inbound namespaced choices through full and Lite requests", async () => {
		const model = createCodexModel("gpt-5.6-terra");
		const parsed = parseRequest({
			model: model.id,
			input: "go",
			tools: codexTools(),
			tool_choice: { type: "function", name: "sleep", namespace: "clock" },
		});
		expect(parsed.options.toolChoice).toEqual({ name: "clock.sleep" });
		// The auth-gateway adapter wraps bare parsed names as { type: "tool", name }.
		const gatewayChoice = { type: "tool", name: "clock.sleep" } as const;
		const full = await buildTransformedCodexRequestBody(model, parsed.context, { toolChoice: gatewayChoice });
		expect(full.tool_choice).toEqual({ type: "function", name: "sleep", namespace: "clock" });
		const lite = await buildTransformedCodexRequestBody(model, parsed.context, {
			toolChoice: gatewayChoice,
			responsesLite: true,
		});
		const liteInput = lite.input as Array<{
			type?: string;
			tools?: Array<{ name?: string; tools?: Array<{ name?: string }> }>;
		}>;
		expect(liteInput[0]?.tools).toHaveLength(1);
		expect(liteInput[0]?.tools?.[0]).toMatchObject({ type: "namespace", name: "clock", tools: [{ name: "sleep" }] });
	});

	it("isolates forced custom choices in Lite and rejects missing native choices", async () => {
		const model = createCodexModel("gpt-5.6-terra");
		const parsed = parseRequest({
			model: model.id,
			input: "go",
			tools: codexTools(),
			tool_choice: { type: "custom", name: "exec" },
		});
		const lite = await buildTransformedCodexRequestBody(model, parsed.context, {
			toolChoice: { type: "tool", name: "exec" },
			responsesLite: true,
		});
		expect(lite.tool_choice).toBe("required");
		const liteInput = lite.input as Array<{ tools?: Array<Record<string, unknown>> }>;
		expect(liteInput[0]?.tools).toEqual([{ type: "custom", name: "exec", format: { type: "text" } }]);
		await expect(
			buildTransformedCodexRequestBody(model, parsed.context, {
				toolChoice: { type: "tool", name: "missing" },
				responsesLite: true,
			}),
		).rejects.toThrow(/no matching declaration/);
	});

	it("accepts nullable descriptions and boolean leaf parameters without losing false-schema meaning", () => {
		const parsed = parseRequest({
			model: "gpt-5.6-terra",
			input: "go",
			tools: [
				{
					type: "namespace",
					name: "clock",
					description: null,
					tools: [
						{ type: "function", name: "any", description: null },
						{ type: "function", name: "none", parameters: false },
						{ type: "function", name: "bare" },
					],
				},
			],
		});
		expect(parsed.context.tools?.map(tool => tool.name)).toEqual(["clock.any", "clock.none", "clock.bare"]);
		const none = parsed.context.tools?.find(tool => tool.name === "clock.none");
		expect(none?.parameters).toEqual({ not: {} });
		expect(parsed.context.tools?.find(tool => tool.name === "clock.any")?.description).toBe("");
	});

	it("rejects malformed Lite inventory before opaque input handling", () => {
		expect(() =>
			parseRequest({ model: "gpt-5.6-terra", input: [{ type: "additional_tools", role: "developer" }] }),
		).toThrow(/openai-responses:/);
		expect(() =>
			parseRequest({
				model: "gpt-5.6-terra",
				input: [{ type: "additional_tools", role: "user", tools: [] }],
			}),
		).toThrow(/openai-responses:/);
	});

	it("refuses namespaces on transports without namespace support", () => {
		const model = buildModel({
			api: "openai-responses",
			id: "strict-target",
			name: "strict target",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			contextWindow: 8192,
			maxTokens: 2048,
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const parsed = parseRequest({ model: model.id, input: "go", tools: codexTools() });
		expect(() => convertTools(parsed.context.tools ?? [], true, model)).toThrow(/namespace support/);
	});

	it("prefers validated native item IDs on same-model replay and strips them cross-model", () => {
		const model = createCodexModel("gpt-5.6-terra");
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "plan",
					thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_1", summary: [] }),
				},
				{
					type: "toolCall",
					id: "call_sleep",
					name: "clock.sleep",
					namespace: "clock",
					arguments: { ms: 3 },
					responsesItemId: "fc_exact",
				},
			],
			api: "openai-codex-responses",
			provider: "openai-codex",
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
			timestamp: Date.now(),
		};
		const same = convertResponsesAssistantMessage(assistant, model, 0, new Set());
		expect(same.find(item => item.type === "function_call")).toMatchObject({
			id: "fc_exact",
			name: "sleep",
			namespace: "clock",
		});
		const other: AssistantMessage = { ...assistant, model: "gpt-5.6-luna" };
		const crossed = convertResponsesAssistantMessage(other, model, 0, new Set());
		expect(crossed.find(item => item.type === "function_call")).not.toMatchObject({ id: "fc_exact" });
	});

	it("uses generic tool-result encoding unless the transport opts into native output", () => {
		const native = createCodexModel("gpt-5.6-terra");
		expect((native.compat as { supportsNativeResponsesOutput?: boolean }).supportsNativeResponsesOutput).toBe(true);
		const generic = buildModel({
			api: "openai-responses",
			id: "generic-target",
			name: "generic target",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			contextWindow: 8192,
			maxTokens: 2048,
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const messages: Array<Record<string, unknown>> = [];
		const toolResult = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "sleep",
			content: [{ type: "text", text: "slept" }],
			responsesOutput: [{ type: "output_text", text: "native" }],
			timestamp: Date.now(),
		} as unknown as Context["messages"][number];
		appendResponsesToolResultMessages(
			messages as never,
			toolResult as never,
			generic as Model<"openai-responses">,
			false,
			true,
			new Set(),
		);
		expect(messages[0]).toMatchObject({ type: "function_call_output", output: "slept" });
	});

	it("keeps the namespace guard reachable for externally supplied root definitions", () => {
		const model = createCodexModel("gpt-5.6-terra");
		const root = {
			name: "clock",
			description: "",
			parameters: { type: "object" },
			responsesDefinition: { type: "namespace", name: "clock", tools: [] },
		} as unknown as Context["tools"] extends (infer T)[] | undefined ? T : never;
		expect(() => normalizeCodexToolChoice({ type: "tool", name: "clock" }, [root], model)).toThrow(
			/must select a leaf tool/,
		);
	});

	it("falls back to accumulated arguments when the terminal item is empty", async () => {
		const model = createCodexModel("gpt-5.6-terra");
		const sse = codexSse([
			{
				type: "response.output_item.added",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_empty",
					call_id: "call_empty",
					name: "sleep",
					namespace: "clock",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_empty", delta: '{"ms":' },
			{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_empty", delta: "3}" },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_empty",
					call_id: "call_empty",
					name: "sleep",
					namespace: "clock",
					arguments: "",
				},
			},
		]);
		const message = await streamOpenAICodexResponses(
			model,
			{ messages: [{ role: "user", content: "go", timestamp: Date.now() }] },
			{ apiKey: testToken(), fetch: codexFetch(sse) },
		).result();
		expect(message.content).toContainEqual(
			expect.objectContaining({ type: "toolCall", name: "clock.sleep", arguments: { ms: 3 } }),
		);
		// The replayed wire item must carry the accumulated arguments, not the
		// empty terminal snapshot, when converted directly.
		const replayed = convertResponsesAssistantMessage(message, model, 0, new Set());
		expect(replayed.find(item => item.type === "function_call")).toMatchObject({
			id: "fc_empty",
			name: "sleep",
			namespace: "clock",
			arguments: '{"ms":3}',
		});
		expect(convertCodexResponsesMessages(model, { messages: [message] })).toContainEqual(
			expect.objectContaining({
				type: "function_call",
				name: "sleep",
				namespace: "clock",
				arguments: '{"ms":3}',
			}),
		);
	});

	it("replays shared-decoder accumulated arguments after an empty terminal item", async () => {
		const model = buildModel({
			api: "openai-responses",
			id: "shared-empty",
			name: "shared empty",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			contextWindow: 8192,
			maxTokens: 2048,
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			timestamp: Date.now(),
			provider: "openai",
			model: "shared-empty",
			api: "openai-responses",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		};
		const stream = { push: () => {}, end: () => {} } as never;
		async function* events(): AsyncIterable<ResponseStreamEvent> {
			yield {
				type: "response.output_item.added",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_acc",
					call_id: "call_acc",
					name: "sleep",
					namespace: "clock",
					arguments: "",
				},
			} as ResponseStreamEvent;
			yield {
				type: "response.function_call_arguments.delta",
				output_index: 0,
				item_id: "fc_acc",
				delta: '{"ms":3}',
			} as ResponseStreamEvent;
			yield {
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_acc",
					call_id: "call_acc",
					name: "sleep",
					namespace: "clock",
					arguments: "",
				},
			} as ResponseStreamEvent;
		}
		await processResponsesStream(events(), output, stream, model);
		const replayed = convertResponsesAssistantMessage(output, model, 0, new Set());
		expect(replayed.find(item => item.type === "function_call")).toMatchObject({
			name: "sleep",
			namespace: "clock",
			arguments: '{"ms":3}',
		});
	});

	it("replays accumulated custom input after an empty terminal item", async () => {
		const model = createCodexModel("gpt-5.6-terra");
		const sse = codexSse([
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "custom_tool_call", id: "ctc_acc", call_id: "call_acc", name: "exec", input: "" },
			},
			{ type: "response.custom_tool_call_input.delta", output_index: 0, item_id: "ctc_acc", delta: "echo hi" },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "custom_tool_call", id: "ctc_acc", call_id: "call_acc", name: "exec", input: "" },
			},
		]);
		const message = await streamOpenAICodexResponses(
			model,
			{ messages: [{ role: "user", content: "go", timestamp: Date.now() }] },
			{ apiKey: testToken(), fetch: codexFetch(sse) },
		).result();
		const replayed = convertResponsesAssistantMessage(message, model, 0, new Set());
		expect(replayed.find(item => item.type === "custom_tool_call")).toMatchObject({
			name: "exec",
			input: "echo hi",
		});
	});

	it("serializes custom input as JSON when falling back to a function call", async () => {
		const model = createCodexModel("gpt-5.6-terra");
		const patch = "*** Begin Patch\n*** End Patch";
		const sse = codexSse([
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "custom_tool_call", id: "ctc_patch", call_id: "call_patch", name: "apply_patch", input: "" },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "custom_tool_call",
					id: "ctc_patch",
					call_id: "call_patch",
					name: "apply_patch",
					input: patch,
				},
			},
		]);
		const message = await streamOpenAICodexResponses(
			model,
			{ messages: [{ role: "user", content: "go", timestamp: Date.now() }] },
			{ apiKey: testToken(), fetch: codexFetch(sse) },
		).result();
		const replayed = convertResponsesAssistantMessage(message, model, 0, new Set(), true, undefined, false, false);
		const call = replayed.find(item => item.type === "function_call");
		expect(call).toMatchObject({ name: "edit" });
		expect(JSON.parse((call as { arguments: string }).arguments)).toEqual({ input: patch });
	});

	it("strips native item IDs when replaying across providers", async () => {
		const codexModel = createCodexModel("gpt-5.6-terra");
		const sse = codexSse([
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_codex", call_id: "call_cross", name: "sleep", arguments: "" },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_codex",
					call_id: "call_cross",
					name: "sleep",
					arguments: '{"ms":1}',
				},
			},
		]);
		const message = await streamOpenAICodexResponses(
			codexModel,
			{ messages: [{ role: "user", content: "go", timestamp: Date.now() }] },
			{ apiKey: testToken(), fetch: codexFetch(sse) },
		).result();
		const foreign = buildModel({
			api: "openai-responses",
			id: "foreign-target",
			name: "foreign target",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			contextWindow: 8192,
			maxTokens: 2048,
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const replayed = convertResponsesAssistantMessage(message, foreign, 0, new Set());
		const call = replayed.find(item => item.type === "function_call") as Record<string, unknown> | undefined;
		expect(call?.call_id).toBe("call_cross");
		expect(call).not.toHaveProperty("id");
	});

	it("preserves deferred custom tools through full and Lite requests", async () => {
		const model = createCodexModel("gpt-5.6-terra");
		const parsed = parseRequest({
			model: model.id,
			input: "go",
			tools: [{ type: "custom", name: "exec", defer_loading: true, format: { type: "text" } }],
		});
		const full = await buildTransformedCodexRequestBody(model, parsed.context, {});
		expect((full.tools as Array<Record<string, unknown>>)?.[0]).toMatchObject({
			type: "custom",
			name: "exec",
			defer_loading: true,
		});
		const lite = await buildTransformedCodexRequestBody(model, parsed.context, { responsesLite: true });
		const liteInput = lite.input as Array<{ tools?: Array<Record<string, unknown>> }>;
		expect(liteInput[0]?.tools?.[0]).toMatchObject({ type: "custom", name: "exec", defer_loading: true });
	});

	it("preserves Lite inventory and history replay for native declarations", async () => {
		const model = createCodexModel("gpt-5.6-terra");
		const parsed = parseRequest({
			model: model.id,
			input: [
				{ type: "additional_tools", role: "developer", tools: codexTools() },
				{ type: "custom_tool_call", id: "item_exec", call_id: "call_exec", name: "exec", input: "echo hi" },
				{ type: "custom_tool_call_output", call_id: "call_exec", output: "ok" },
				{
					type: "function_call",
					id: "item_sleep",
					call_id: "call_sleep",
					namespace: "clock",
					name: "sleep",
					arguments: '{ "ms" : 3 }',
				},
				{ type: "function_call_output", call_id: "call_sleep", output: "slept" },
			],
		});
		expect(parsed.options.responsesLite).toBe(true);
		const body = await buildTransformedCodexRequestBody(model, parsed.context, { responsesLite: true });
		const input = body.input as Array<Record<string, unknown>>;
		expect(input[0]).toMatchObject({ type: "additional_tools", role: "developer" });
		expect(input).toContainEqual(
			expect.objectContaining({ type: "function_call", id: "item_sleep", namespace: "clock", name: "sleep" }),
		);
		expect(
			buildResponsesInput({
				model,
				context: parsed.context,
				strictResponsesPairing: false,
				supportsImageDetailOriginal: true,
			}),
		).toBeDefined();
	});
});
