import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type AuthGatewayRouter, createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import {
	convertCodexResponsesMessages,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { parseRequest } from "@oh-my-pi/pi-ai/providers/openai-responses-server";
import { buildResponsesInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { indexModelsByRequestId, resolveGatewayModel } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-cli";

const model = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-5.6-terra");
const models = [model];
const modelIndex = indexModelsByRequestId(models, new Set([model.provider]));
const token = `aaa.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_synthetic_replay" } }),
).toBase64()}.bbb`;
const reasoning = { type: "reasoning", id: "rs_prior", summary: [], encrypted_content: "synthetic-reasoning" };
const histories = {
	function: {
		call: {
			type: "function_call" as const,
			id: "item_sleep",
			call_id: "call_sleep",
			name: "sleep",
			namespace: "clock",
			arguments: '{ "ms" : 3 }',
		},
		output: { type: "function_call_output" as const, call_id: "call_sleep", output: "slept" },
		tools: [
			{
				type: "namespace",
				name: "clock",
				tools: [
					{
						type: "function",
						name: "sleep",
						parameters: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
					},
				],
			},
		],
	},
	custom: {
		call: { type: "custom_tool_call" as const, id: "item_exec", call_id: "call_exec", name: "exec", input: "echo synthetic" },
		output: { type: "custom_tool_call_output" as const, call_id: "call_exec", output: "synthetic output" },
		tools: [{ type: "custom", name: "exec", format: { type: "text" } }],
	},
};
type HistoryKind = keyof typeof histories;

function requestBody(modelId: string, kind: HistoryKind, withReasoning: boolean) {
	const history = histories[kind];
	return {
		model: modelId,
		stream: false,
		input: [
			{ role: "user", content: "synthetic request" },
			...(withReasoning ? [reasoning] : []),
			history.call,
			history.output,
		],
		tools: history.tools,
	};
}

	function completedEvents(items: Record<string, unknown>[]): Record<string, unknown>[] {
	return [
		...items.flatMap((item, output_index) => [
			{ type: "response.output_item.added", output_index, item },
			{ type: "response.output_item.done", output_index, item },
		]),
		{
			type: "response.completed",
			response: {
				id: "resp_synthetic_replay",
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
}

const textEvents = completedEvents([
	{
		type: "message",
		id: "msg_final",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "ok", annotations: [] }],
	},
]);

let storage: AuthStorage | undefined;
let router: AuthGatewayRouter | undefined;

	beforeEach(() => {
		vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
			throw new Error("Live network disabled in qualified replay tests");
		}) as unknown as typeof fetch);
	});

afterEach(() => {
	router?.close();
	storage?.close();
	router = undefined;
	storage = undefined;
	vi.restoreAllMocks();
});

async function createFixture(events: Record<string, unknown>[]) {
	storage = await AuthStorage.create(":memory:");
	storage.keys.setRuntime(model.provider, token);
	const captured: { model: string; input: Record<string, unknown>[] }[] = [];
	const fakeFetch: FetchImpl = async (input, init) => {
		const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
		if (request.url.endsWith("/responses")) {
			const bytes = new Uint8Array(await request.arrayBuffer());
			const decoded = request.headers.get("content-encoding") === "zstd" ? Bun.zstdDecompressSync(bytes) : bytes;
			captured.push(JSON.parse(new TextDecoder().decode(decoded)));
			return new Response(
				`${events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		}
		if (request.url === "https://api.github.com/repos/openai/codex/releases/latest") {
			return Response.json({ tag_name: "rust-v0.0.0" });
		}
		if (request.url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
			return new Response("SYNTHETIC PROMPT");
		}
		throw new Error(`Unexpected fake endpoint: ${request.url}`);
	};
	const gateway = createAuthGatewayRouter({
		storage,
		resolveModel: id => resolveGatewayModel(id, modelIndex, models),
		fetch: fakeFetch,
	});
	router = gateway;
	return { gateway, captured, fakeFetch };
}

function gatewayRequest(body: unknown): Request {
	return new Request("http://no-network.invalid/v1/responses", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("auth-gateway qualified model native replay", () => {
	for (const kind of ["function", "custom"] as const) {
		for (const withReasoning of [false, true]) {
			it(`preserves ${kind} history for bare and qualified IDs, reasoning=${withReasoning}`, async () => {
				const { gateway, captured } = await createFixture(textEvents);
				for (const requestId of [model.id, `${model.provider}/${model.id}`]) {
					const before = captured.length;
					const body = requestBody(requestId, kind, withReasoning);
					const parsed = parseRequest(body);
					expect(parsed.modelId).toBe(requestId);
					expect(resolveGatewayModel(requestId, modelIndex, models)).toBe(model);
					const assistant = parsed.context.messages.find(message => message.role === "assistant");
					expect(assistant).toMatchObject({
						model: requestId,
						provider: "openai",
						api: "openai-responses",
						stopReason: "stop",
					});
					if (withReasoning) {
						expect(assistant?.content).toContainEqual({
							type: "thinking",
							thinking: "",
							thinkingSignature: JSON.stringify(reasoning),
							itemId: "rs_prior",
						});
					}
					const replay = convertCodexResponsesMessages(model, parsed.context);
					expect(
						replay.filter(
							item => item.type === histories[kind].call.type || item.type === histories[kind].output.type,
						),
					).toEqual([histories[kind].call, histories[kind].output]);
					const response = await gateway.route(gatewayRequest(body), "synthetic");
					const result = await response.json();
					expect(typeof result).toBe("object");
					expect(response.status).toBe(200);
					expect(captured.length).toBe(before + 1);
					const upstream = captured.at(-1);
					expect(upstream?.model).toBe(captured[0]?.model);
					expect(
						upstream?.input.filter(
							item => item.type === histories[kind].call.type || item.type === histories[kind].output.type,
						),
					).toEqual([histories[kind].call, histories[kind].output]);
					// Parser placeholders end with stop, so their tool-bound signatures remain untrusted.
					expect(upstream?.input.some(item => item.type === "reasoning")).toBe(false);
				}
				expect(captured.map(entry => entry.input.filter(item => item.type === histories[kind].call.type))).toEqual([
					captured[0]?.input.filter(item => item.type === histories[kind].call.type),
					captured[0]?.input.filter(item => item.type === histories[kind].call.type),
				]);
			});

			it(`preserves ${kind} identity for qualified same-provenance Responses placeholders, reasoning=${withReasoning}`, () => {
				const target = getBundledModel<"openai-responses">("openai", "gpt-5-mini");
				const index = indexModelsByRequestId([target], new Set([target.provider]));
				for (const requestId of [target.id, `${target.provider}/${target.id}`]) {
					expect(resolveGatewayModel(requestId, index, [target])).toBe(target);
					const parsed = parseRequest(requestBody(requestId, kind, withReasoning));
					const replay = buildResponsesInput({
						model: target,
						context: parsed.context,
						strictResponsesPairing: true,
						supportsImageDetailOriginal: false,
					});
					expect(
						replay.filter(
							item => item.type === histories[kind].call.type || item.type === histories[kind].output.type,
						),
					).toEqual([histories[kind].call, histories[kind].output]);
					expect(replay.some(item => item.type === "reasoning")).toBe(false);
				}
			});
		}

		it(`rejects a wrong-provider qualifier and does not revive its ${kind} native ID`, async () => {
			const { gateway, captured } = await createFixture(textEvents);
			const requestId = `foreign-provider/${model.id}`;
			const body = requestBody(requestId, kind, true);
			expect(resolveGatewayModel(requestId, modelIndex, models)).toBeUndefined();
			const parsed = parseRequest(body);
			const replay = convertCodexResponsesMessages(model, parsed.context);
			const call = replay.find(item => item.type === histories[kind].call.type);
			expect(call).toBeDefined();
			expect(call).not.toHaveProperty("id");
			expect(replay).toContainEqual(histories[kind].output);
			expect(replay.some(item => item.type === "reasoning")).toBe(false);
			const response = await gateway.route(gatewayRequest(body), "synthetic");
			expect(response.status).toBe(404);
			expect(captured).toEqual([]);
		});

		it(`keeps decoded ${kind} signatures model/provider-bound`, async () => {
			const { fakeFetch } = await createFixture(completedEvents([reasoning, histories[kind].call]));
			const parsed = parseRequest(requestBody(model.id, kind, true));
			const decoded = await streamOpenAICodexResponses(
				model,
				{
					systemPrompt: [],
					messages: [{ role: "user", content: "synthetic request", timestamp: 1 }],
					tools: parsed.context.tools,
				},
				{ apiKey: token, fetch: fakeFetch },
			).result();
			expect(decoded.stopReason).toBe("toolUse");
			const context = {
				...parsed.context,
				messages: parsed.context.messages.map(message => (message.role === "assistant" ? decoded : message)),
			};
			const same = convertCodexResponsesMessages(model, context);
			// Native payload replay strips server-owned reasoning IDs by
			// construction; the trace itself must survive with its content.
			const { id: _droppedReasoningId, ...expectedReasoning } = reasoning;
			expect(same.find(item => item.type === "reasoning")).toMatchObject(expectedReasoning);
			expect(same.find(item => item.type === "reasoning")).not.toHaveProperty("id");
			// Native payload replay likewise strips item IDs; call pairing rides call_id.
			const { id: _droppedCallId, ...expectedCall } = histories[kind].call;
			expect(same.find(item => item.type === histories[kind].call.type)).toMatchObject(expectedCall);
			expect(same.find(item => item.type === histories[kind].call.type)).not.toHaveProperty("id");
			for (const target of [
				{ ...model, id: "gpt-5.6-other" },
				{ ...model, provider: "foreign-provider" },
			]) {
				const replay = convertCodexResponsesMessages(target, context);
				const call = replay.find(item => item.type === histories[kind].call.type);
				expect(call).toBeDefined();
				expect(call).not.toMatchObject({ id: histories[kind].call.id });
				expect(call).toMatchObject({ call_id: histories[kind].call.call_id, name: histories[kind].call.name });
				expect(replay).toContainEqual(histories[kind].output);
				expect(replay.some(item => item.type === "reasoning")).toBe(false);
			}
		});
	}
});
