import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { encodeResponse } from "@oh-my-pi/pi-ai/providers/openai-responses-server";
import { convertResponsesAssistantMessage } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Context, FetchImpl, Message, ToolCall } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createCodexModel } from "./helpers";
import { mockFetch } from "./helpers/fetch-mock";

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
		throw new Error("Network disabled in replay execution tests");
	}) as unknown as typeof fetch);
});
afterEach(() => vi.restoreAllMocks());

const codexModel = createCodexModel("gpt-5.6-terra", { applyPatchToolType: "freeform" });
const responsesModel = buildModel({
	id: "gpt-5.6-terra",
	name: "Synthetic Responses model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 272_000,
	maxTokens: 128_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	applyPatchToolType: "freeform",
});
const syntheticToken = `aaa.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_synthetic_replay" } }),
).toBase64()}.bbb`;

const providers = [
	{
		name: "Codex Responses",
		model: codexModel,
		stream: (context: Context, fetch: FetchImpl) =>
			streamOpenAICodexResponses(codexModel, context, { apiKey: syntheticToken, fetch, preferWebsockets: false }),
	},
	{
		name: "OpenAI Responses",
		model: responsesModel,
		stream: (context: Context, fetch: FetchImpl) =>
			streamOpenAIResponses(responsesModel, context, { apiKey: syntheticToken, fetch }),
	},
];

function requireRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Expected a wire object");
	}
	return value as Record<string, unknown>;
}

function wireItems(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) throw new Error("Expected wire items");
	return value.map(requireRecord);
}

function sse(events: Array<Record<string, unknown>>): Response {
	const frames = [
		...events,
		{
			type: "response.completed",
			response: {
				id: "resp_synthetic",
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	return new Response(
		`${frames.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`,
		{
			headers: { "content-type": "text/event-stream" },
		},
	);
}

function functionEvents(raw: string, terminal = raw): Array<Record<string, unknown>> {
	const item = { type: "function_call", id: "fc_probe", call_id: "call_probe", name: "probe" };
	return [
		{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: raw },
		{ type: "response.output_item.done", output_index: 0, item: { ...item, arguments: terminal } },
	];
}

async function runToolTurn(
	provider: (typeof providers)[number],
	events: Array<Record<string, unknown>>,
	tools: AgentContext["tools"],
) {
	const requests: Array<Record<string, unknown>> = [];
	const fakeFetch = mockFetch((input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!url.endsWith("/responses")) throw new Error(`Unexpected fake endpoint: ${url}`);
		const body = init?.body;
		// Codex can compress even synthetic request bodies; inspect the real transmitted JSON.
		const text =
			typeof body === "string"
				? body
				: body instanceof Uint8Array
					? new TextDecoder().decode(Bun.zstdDecompressSync(body))
					: undefined;
		if (text === undefined) throw new Error("Expected a Responses request body");
		const parsed: unknown = JSON.parse(text);
		requests.push(requireRecord(parsed));
		if (requests.length === 1) return sse(events);
		if (requests.length !== 2) throw new Error("Unexpected extra agent turn");
		const item = {
			type: "message",
			id: "msg_done",
			role: "assistant",
			content: [{ type: "output_text", text: "done", annotations: [] }],
		};
		return sse([
			{ type: "response.output_item.added", output_index: 0, item },
			{ type: "response.output_item.done", output_index: 0, item },
		]);
	});
	const stream = agentLoop(
		[{ role: "user", content: "Run the synthetic probe", timestamp: 0 }],
		{ systemPrompt: [], messages: [], tools },
		{
			model: provider.model,
			apiKey: syntheticToken,
			convertToLlm: messages =>
				messages.filter(
					(message): message is Message =>
						message.role === "user" || message.role === "assistant" || message.role === "toolResult",
				),
		},
		undefined,
		(_model, context) => provider.stream(context, fakeFetch),
	);
	const emitted: ToolCall[] = [];
	for await (const event of stream) {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_end") {
			emitted.push(event.assistantMessageEvent.toolCall);
		}
	}
	const messages = await stream.result();
	const assistant = messages.find(
		message => message.role === "assistant" && message.content.some(block => block.type === "toolCall"),
	);
	if (assistant?.role !== "assistant") throw new Error("Expected the stored tool-call turn");
	const call = assistant.content.find(block => block.type === "toolCall");
	if (call?.type !== "toolCall") throw new Error("Expected the stored tool call");
	const result = messages.find(message => message.role === "toolResult");
	if (result?.role !== "toolResult") throw new Error("Expected the actual agent tool result");
	expect(emitted).toHaveLength(1);
	expect(result.toolCallId).toBe(call.id);
	expect(requests).toHaveLength(2);
	expect(messages.at(-1)).toMatchObject({
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "done" }],
	});
	const replay = convertResponsesAssistantMessage(assistant, provider.model, 0, new Set());
	const encoded = wireItems(encodeResponse(assistant, provider.model.id).output);
	const upstream = wireItems(requests[1].input);
	const callType = call.customWireName ? "custom_tool_call" : "function_call";
	const replayCall = replay.find(item => item.type === callType);
	const encodedCall = encoded.find(item => item.type === callType);
	const upstreamCall = upstream.find(item => item.type === callType);
	const upstreamResult = upstream.find(item => item.type === `${callType}_output`);
	expect(replayCall).toMatchObject({ call_id: "call_probe", name: "probe" });
	expect(encodedCall).toMatchObject({ call_id: "call_probe", name: "probe" });
	expect(upstreamCall).toMatchObject({ call_id: "call_probe", name: "probe" });
	expect(upstreamResult).toMatchObject({ call_id: "call_probe" });
	expect(upstream.indexOf(upstreamCall as Record<string, unknown>)).toBeLessThan(
		upstream.indexOf(upstreamResult as Record<string, unknown>),
	);
	return { assistant, call, emitted: emitted[0], result, replayCall, encodedCall, upstreamCall, upstreamResult };
}

const functionSchema = type({ name: "string", count: "number" });

for (const provider of providers) {
	describe(`${provider.name}: execution and replay`, () => {
		for (const fixture of [
			{
				name: "repairs malformed JSON before execution, block replay, and gateway encoding",
				raw: '{"name": , "count":1}',
				terminal: '{"name": , "count":1}',
				replay: '{"name":"","count":1}',
			},
			{
				name: "preserves the exact whitespace of valid JSON",
				raw: ' {\n  "name": "",\n  "count": 1\n}\t ',
				terminal: ' {\n  "name": "",\n  "count": 1\n}\t ',
				replay: ' {\n  "name": "",\n  "count": 1\n}\t ',
			},
			{
				name: "retains accumulated arguments when the terminal item is empty",
				raw: '{"name":"","count":1}',
				terminal: "",
				replay: '{"name":"","count":1}',
			},
		]) {
			it(fixture.name, async () => {
				const executed: Array<{ name: string; count: number }> = [];
				const tool: AgentTool<typeof functionSchema, { persisted: boolean }> = {
					name: "probe",
					label: "Probe",
					description: "Synthetic argument receiver",
					parameters: functionSchema,
					async execute(_id, args) {
						executed.push(args);
						return { content: [{ type: "text", text: "durable probe output" }], details: { persisted: true } };
					},
				};
				const turn = await runToolTurn(provider, functionEvents(fixture.raw, fixture.terminal), [tool]);
				expect(executed).toEqual([{ name: "", count: 1 }]);
				for (const call of [turn.emitted, turn.call]) {
					expect(call.arguments).toEqual({ name: "", count: 1 });
					expect(call.responsesArguments).toBe(fixture.replay);
				}
				for (const call of [turn.replayCall, turn.encodedCall, turn.upstreamCall]) {
					expect(call).toMatchObject({ arguments: fixture.replay });
				}
				expect(JSON.parse(fixture.replay)).toEqual(executed[0]);
				expect(turn.assistant.providerPayload).toMatchObject({
					type: "openaiResponsesHistory",
					items: [expect.objectContaining({ type: "function_call", arguments: fixture.replay })],
				});
				expect(turn.result).toMatchObject({
					isError: false,
					content: [{ type: "text", text: "durable probe output" }],
					details: { persisted: true },
				});
				expect(turn.upstreamResult).toMatchObject({ output: "durable probe output" });
			});
		}

		it("keeps unrepairable raw JSON and diagnostics without executing the tool", async () => {
			const raw = '{"tasks": [{"task": "x" "y"}]] }}';
			const executed: unknown[] = [];
			const tool: AgentTool<typeof functionSchema, Record<string, never>> = {
				name: "probe",
				label: "Probe",
				description: "Must not execute invalid arguments",
				parameters: functionSchema,
				async execute(_id, args) {
					executed.push(args);
					return { content: [{ type: "text", text: "unexpected execution" }], details: {} };
				},
			};
			const turn = await runToolTurn(provider, functionEvents(raw), [tool]);
			expect(executed).toEqual([]);
			for (const call of [turn.emitted, turn.call]) {
				expect(call.arguments).toEqual({ __parseError: expect.any(String), __rawJson: raw });
				expect(call.responsesArguments).toBe(raw);
			}
			expect(turn.replayCall).toMatchObject({ arguments: raw });
			expect(turn.encodedCall).toMatchObject({ arguments: raw });
			expect(turn.result.isError).toBe(true);
			expect(JSON.stringify(turn.result.content)).toContain("Tool call arguments are not valid JSON");
			if (typeof turn.upstreamCall?.arguments !== "string") throw new Error("Expected native replay arguments");
			const diagnostic: unknown = JSON.parse(turn.upstreamCall.arguments);
			expect(diagnostic).toEqual({ __parseError: expect.any(String), __rawJson: raw });
			expect(turn.upstreamResult?.output).toBe(
				turn.result.content.map(block => (block.type === "text" ? block.text : "")).join("\n"),
			);
		});

		it("executes and replays custom plaintext without JSON normalization", async () => {
			const raw = 'echo {"name": , "count":1}\n  keep this spacing\t';
			const schema = type({ input: "string" });
			const executed: Array<{ input: string }> = [];
			const tool: AgentTool<typeof schema, Record<string, never>> = {
				name: "probe",
				label: "Probe",
				description: "Synthetic plaintext receiver",
				parameters: schema,
				customWireName: "probe",
				customFormat: { syntax: "regex", definition: "[\\s\\S]*" },
				async execute(_id, args) {
					executed.push(args);
					return { content: [{ type: "text", text: "durable custom output" }], details: {} };
				},
			};
			const item = { type: "custom_tool_call", id: "ctc_probe", call_id: "call_probe", name: "probe" };
			const turn = await runToolTurn(
				provider,
				[
					{ type: "response.output_item.added", output_index: 0, item: { ...item, input: "" } },
					{ type: "response.custom_tool_call_input.delta", output_index: 0, item_id: item.id, delta: raw },
					{ type: "response.output_item.done", output_index: 0, item: { ...item, input: raw } },
				],
				[tool],
			);
			expect(executed).toEqual([{ input: raw }]);
			for (const call of [turn.emitted, turn.call]) {
				expect(call.arguments).toEqual({ input: raw });
				expect(call.responsesArguments).toBe(raw);
				expect(call.customWireName).toBe("probe");
			}
			for (const call of [turn.replayCall, turn.encodedCall, turn.upstreamCall]) {
				expect(call).toMatchObject({ input: raw });
			}
			expect(turn.result).toMatchObject({
				isError: false,
				content: [{ type: "text", text: "durable custom output" }],
			});
			expect(turn.upstreamResult).toMatchObject({
				type: "custom_tool_call_output",
				output: "durable custom output",
			});
		});
	});
}
