import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import {
	encodeResponse,
	encodeStream,
	parseRequest,
	readRequest,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses-server";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai/types";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { readSseJson } from "@oh-my-pi/pi-utils/stream";
import { createCodexModel } from "./helpers";

interface Frame {
	type: string;
	item_id?: string;
	item?: Record<string, unknown>;
	response?: {
		id: string;
		status: string;
		output: Record<string, unknown>[];
		usage?: Record<string, unknown>;
		error?: { code: string };
	};
}

async function frames(response: Response): Promise<Frame[]> {
	const result: Frame[] = [];
	for await (const frame of readSseJson<Frame>(response.body!)) result.push(frame);
	return result;
}

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	clearCustomApis();
});

async function gateway() {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-codex-"));
	cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	cleanup.push(() => storage.close());
	storage.keys.setRuntime("openai", "upstream-key");
	const model = createMockModel({ provider: "openai", id: "codex-test" });
	const server = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["gateway-token"],
		storage,
		resolveModel: id => (id === model.id ? model : undefined),
		version: "test",
	});
	cleanup.push(() => server.close());
	return { server, model };
}

async function responsesGateway(outputItem?: Record<string, unknown>, argumentDone?: string) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-codex-replay-"));
	cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	cleanup.push(() => storage.close());
	storage.keys.setRuntime("openai", "upstream-key");
	const model = buildModel({
		id: "gpt-5.3-codex",
		name: "GPT-5.3 Codex",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "http://127.0.0.1:1/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	});
	const requests: unknown[] = [];
	const server = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["gateway-token"],
		storage,
		resolveModel: id => (id === "choice-model" ? model : undefined),
		async fetch(_input, init) {
			if (typeof init?.body !== "string") throw new Error("Expected an upstream JSON request");
			const body: unknown = JSON.parse(init.body);
			requests.push(body);
			const item = outputItem ?? {
				type: "message",
				id: "msg_choice",
				role: "assistant",
				content: [{ type: "output_text", text: "received" }],
			};
			const events = [
				{ type: "response.created", response: { id: "resp_choice" } },
				{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
				...(argumentDone === undefined
					? []
					: [
							{
								type: "response.function_call_arguments.done",
								output_index: 0,
								item_id: item.id,
								arguments: argumentDone,
							},
						]),
				{ type: "response.output_item.done", output_index: 0, item },
				{
					type: "response.completed",
					response: {
						id: "resp_choice",
						status: "completed",
						output: [item],
						usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
					},
				},
			];
			return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	cleanup.push(() => server.close());
	return { server, requests };
}

const headers = { "content-type": "application/json", authorization: "Bearer gateway-token" };
const tools = [
	{
		type: "namespace",
		name: "editor",
		description: "editor tools",
		tools: [
			{
				type: "custom",
				name: "apply_patch",
				description: "Apply patch",
				format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
			},
		],
	},
];

const functionTool = {
	type: "function",
	name: "apply_patch",
	parameters: { type: "object", properties: {} },
};
const functionTools = [{ type: "namespace", name: "editor", tools: [functionTool] }];

describe("auth-gateway Codex Responses", () => {
	it("rejects decoded zstd data over a small caller-supplied limit", async () => {
		const json = JSON.stringify({ model: "model", input: "hello" });
		const bytes = new Uint8Array(await Bun.zstdCompress(json));
		const request = () =>
			new Request("http://localhost/v1/codex/responses", {
				method: "POST",
				headers: { "content-encoding": "zstd" },
				body: bytes,
			});
		expect(await readRequest(request(), json.length)).toEqual({ model: "model", input: "hello" });
		await expect(readRequest(request(), json.length - 1)).rejects.toThrow();
	});

	it.each([
		{
			label: "nonempty metadata, omitted format, late search discovery",
			format: undefined,
			encryptedArgs: ["opaque-text-args"],
			discovery: "tool_search_output",
		},
		{
			label: "empty metadata, text format, late additional tools",
			format: { type: "text" },
			encryptedArgs: [],
			discovery: "additional_tools",
		},
		{
			label: "absent metadata, text format, declared tools",
			format: { type: "text" },
			encryptedArgs: undefined,
			discovery: undefined,
		},
	] as const)(
		"round-trips text custom tools through the function bridge: $label",
		async ({ format, encryptedArgs, discovery }) => {
			const rawInput = "hello\nworld";
			const metadata = encryptedArgs === undefined ? {} : { encrypted_function_args: encryptedArgs };
			const { server, requests } = await responsesGateway({
				type: "function_call",
				id: "fc_text",
				call_id: "call_text",
				name: "editor__echo",
				arguments: JSON.stringify({ input: rawInput }),
				...metadata,
			});
			const input = [{ role: "user", content: "Echo this" }];
			const offeredTools = [
				{
					type: "namespace",
					name: "editor",
					tools: [{ type: "custom", name: "echo", ...(format === undefined ? {} : { format }) }],
				},
			];
			const discoveryItems =
				discovery === "tool_search_output"
					? [
							{ type: "tool_search_call", call_id: "search_text", execution: "client", arguments: {} },
							{ type: discovery, call_id: "search_text", execution: "client", tools: offeredTools },
						]
					: discovery === "additional_tools"
						? [{ type: discovery, role: "developer", tools: offeredTools }]
						: [];
			const body = {
				model: "choice-model",
				input: [...input, ...discoveryItems],
				stream: true,
				tools: discovery === undefined ? offeredTools : undefined,
				tool_choice: { type: "custom", name: "echo" },
			};
			const response = await fetch(`${server.url}/v1/codex/responses`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(200);
			const events = await frames(response);
			const done = events.find(event => event.type === "response.output_item.done")!.item!;
			expect(done).toMatchObject({
				type: "custom_tool_call",
				id: "fc_text",
				call_id: "call_text",
				namespace: "editor",
				name: "echo",
				input: rawInput,
				...metadata,
			});
			expect(done).not.toHaveProperty("arguments");
			if (encryptedArgs === undefined) expect(done).not.toHaveProperty("encrypted_function_args");
			expect(requests[0]).toMatchObject({
				tool_choice: { type: "function", name: "editor__echo" },
				tools: expect.arrayContaining([
					expect.objectContaining({
						type: "function",
						name: "editor__echo",
						parameters: expect.objectContaining({ required: ["input"] }),
					}),
				]),
			});
			const replayBody = {
				...body,
				stream: false,
				input: [
					...input,
					done,
					{ type: "custom_tool_call_output", call_id: done.call_id, output: "echoed" },
					...discoveryItems,
				],
			};
			const before = JSON.stringify(replayBody);
			parseRequest(replayBody, undefined, createCodexModel("gpt-5.3-codex"));
			expect(JSON.stringify(replayBody)).toBe(before);
			const followup = await fetch(`${server.url}/v1/codex/responses`, {
				method: "POST",
				headers,
				body: JSON.stringify(replayBody),
			});
			expect(followup.status).toBe(200);
			const next = (await followup.json()) as { output: Record<string, unknown>[] };
			expect(next.output).toEqual([
				expect.objectContaining({
					type: "custom_tool_call",
					id: "fc_text",
					call_id: "call_text",
					namespace: "editor",
					name: "echo",
					input: rawInput,
					...metadata,
				}),
			]);
			if (encryptedArgs === undefined) expect(next.output[0]).not.toHaveProperty("encrypted_function_args");
			expect(structuredClone(requests[1])).toMatchObject({
				input: expect.arrayContaining([
					expect.objectContaining({
						type: "function_call",
						call_id: "call_text",
						name: "editor__echo",
						arguments: JSON.stringify({ input: rawInput }),
						...metadata,
					}),
					expect.objectContaining({ type: "function_call_output", call_id: "call_text", output: "echoed" }),
				]),
			});
			const upstream = requests[1] as { input: Record<string, unknown>[] };
			const replayed = upstream.input.filter(item => item.call_id === "call_text");
			expect(replayed).toHaveLength(2);
			expect(replayed.some(item => item.type === "custom_tool_call")).toBe(false);
			if (encryptedArgs === undefined) {
				for (const item of replayed) expect(item).not.toHaveProperty("encrypted_function_args");
			}
		},
	);

	it("keeps grammar custom replay native without injecting function metadata", async () => {
		const { server, requests } = await responsesGateway();
		const response = await fetch(`${server.url}/v1/codex/responses`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: "choice-model",
				stream: false,
				input: [
					{ role: "user", content: "Apply and echo" },
					{
						type: "custom_tool_call",
						id: "ctc_patch",
						call_id: "call_patch",
						name: "apply_patch",
						namespace: "editor",
						input: "patch",
						encrypted_function_args: ["not-function-metadata"],
					},
					{
						type: "custom_tool_call",
						id: "fc_echo",
						call_id: "call_echo",
						name: "echo",
						namespace: "editor",
						input: "hello",
						encrypted_function_args: ["text-function-metadata"],
					},
					{ type: "custom_tool_call_output", call_id: "call_patch", output: "applied" },
					{ type: "custom_tool_call_output", call_id: "call_echo", output: "echoed" },
					{
						type: "additional_tools",
						role: "developer",
						tools: [...tools, { type: "namespace", name: "editor", tools: [{ type: "custom", name: "echo" }] }],
					},
				],
			}),
		});
		expect(response.status).toBe(200);
		await response.text();
		const upstream = requests[0] as { input: Record<string, unknown>[] };
		expect(upstream.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "custom_tool_call",
					call_id: "call_patch",
					name: "editor__apply_patch",
					input: "patch",
				}),
				expect.objectContaining({
					type: "function_call",
					call_id: "call_echo",
					name: "editor__echo",
					arguments: JSON.stringify({ input: "hello" }),
					encrypted_function_args: ["text-function-metadata"],
				}),
				expect.objectContaining({ type: "custom_tool_call_output", call_id: "call_patch", output: "applied" }),
				expect.objectContaining({ type: "function_call_output", call_id: "call_echo", output: "echoed" }),
			]),
		);
		const grammarCall = upstream.input.find(item => item.type === "custom_tool_call");
		expect(grammarCall).not.toHaveProperty("encrypted_function_args");
		expect(grammarCall).not.toHaveProperty("arguments");
	});

	it.each([{ encryptedArgs: null }, { encryptedArgs: "opaque-not-an-array" }, { encryptedArgs: [42] }])(
		"rejects malformed text bridge encrypted arguments $encryptedArgs before contacting the upstream",
		async ({ encryptedArgs }) => {
			const { server, requests } = await responsesGateway();
			const response = await fetch(`${server.url}/v1/codex/responses`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					model: "choice-model",
					stream: false,
					input: [
						{
							type: "custom_tool_call",
							call_id: "call_text",
							name: "echo",
							namespace: "editor",
							input: "hello",
							encrypted_function_args: encryptedArgs,
						},
						{
							type: "additional_tools",
							role: "developer",
							tools: [{ type: "namespace", name: "editor", tools: [{ type: "custom", name: "echo" }] }],
						},
					],
				}),
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error" } });
			expect(requests).toEqual([]);
		},
	);

	it.each([
		["short function name", functionTools, { type: "function", name: "apply_patch" }, "editor__apply_patch"],
		["short custom name", tools, { type: "custom", name: "apply_patch" }, "editor__apply_patch"],
		[
			"explicit namespace among duplicate names",
			[...functionTools, { ...functionTools[0], name: "files" }],
			{ type: "function", name: "apply_patch", namespace: "files" },
			"files__apply_patch",
		],
		["flattened name", tools, { type: "custom", name: "editor__apply_patch" }, "editor__apply_patch"],
		[
			"exact name before namespaced short names",
			[functionTool, ...functionTools],
			{ type: "function", name: "apply_patch" },
			"apply_patch",
		],
		[
			"default functions namespace",
			[{ ...functionTools[0], name: "functions" }, ...functionTools],
			{ type: "function", name: "apply_patch", namespace: "functions" },
			"apply_patch",
		],
	] as const)("preserves the upstream forced choice for %s", async (_label, offeredTools, choice, name) => {
		const { server, requests } = await responsesGateway();
		const response = await fetch(`${server.url}/v1/codex/responses`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: "choice-model",
				input: "Apply the patch",
				stream: false,
				tools: offeredTools,
				tool_choice: choice,
			}),
		});
		expect(response.status).toBe(200);
		await response.text();
		expect(requests[0]).toMatchObject({
			tool_choice: { type: choice.type, name },
			tools: expect.arrayContaining([expect.objectContaining({ type: choice.type, name })]),
		});
	});

	it.each(["additional_tools", "tool_search_output"] as const)(
		"resolves forced choices after collecting tools from %s",
		async source => {
			const { server, requests } = await responsesGateway();
			const input =
				source === "additional_tools"
					? [{ type: source, role: "developer", tools }]
					: [
							{ type: "tool_search_call", call_id: "search_1", execution: "client", arguments: {} },
							{ type: source, call_id: "search_1", execution: "client", tools },
						];
			const response = await fetch(`${server.url}/v1/codex/responses`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					model: "choice-model",
					input: [...input, { role: "user", content: "Apply the patch" }],
					stream: false,
					tool_choice: { type: "custom", name: "apply_patch" },
				}),
			});
			expect(response.status).toBe(200);
			await response.text();
			expect(requests[0]).toMatchObject({
				tool_choice: { type: "custom", name: "editor__apply_patch" },
				tools: expect.arrayContaining([expect.objectContaining({ type: "custom", name: "editor__apply_patch" })]),
			});
		},
	);

	it.each([
		[
			"ambiguous short name",
			[...functionTools, { ...functionTools[0], name: "files" }],
			{ type: "function", name: "apply_patch" },
		],
		["unknown tool", functionTools, { type: "function", name: "missing" }],
		["wrong tool type", functionTools, { type: "custom", name: "editor__apply_patch" }],
		[
			"unknown namespace without a short-name fallback",
			[functionTool, ...functionTools],
			{ type: "function", name: "apply_patch", namespace: "missing" },
		],
		[
			"a namespace that only collides after flattening",
			[{ type: "namespace", name: "editor__files", tools: [functionTool] }],
			{ type: "function", name: "files__apply_patch", namespace: "editor" },
		],
		["malformed namespace", functionTools, { type: "function", name: "apply_patch", namespace: 42 }],
	] as const)("rejects %s before contacting the upstream", async (_label, offeredTools, choice) => {
		const { server, requests } = await responsesGateway();
		const response = await fetch(`${server.url}/v1/codex/responses`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: "choice-model",
				input: "Apply the patch",
				tools: offeredTools,
				tool_choice: choice,
			}),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error" } });
		expect(requests).toEqual([]);
	});

	it("round-trips namespaced custom tools and encrypted reasoning through authoritative done items", async () => {
		const { server, model } = await gateway();
		model.push({
			content: [
				{
					type: "thinking",
					thinking: "Inspecting",
					thinkingSignature: JSON.stringify({
						type: "reasoning",
						id: "rs_upstream",
						summary: [],
						encrypted_content: "opaque-reasoning",
					}),
				},
				{
					type: "toolCall",
					id: "call_patch|fc_upstream",
					name: "editor__apply_patch",
					arguments: { input: "*** Begin Patch\n*** End Patch" },
				},
			],
			usage: { input: 8, cacheRead: 4, output: 6, reasoningTokens: 2 },
		});
		const input = [
			{ type: "message", role: "developer", content: [{ type: "input_text", text: "Follow the project rules" }] },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Edit the file" }] },
		];
		const body = {
			model: model.id,
			input,
			tools,
			stream: true,
			store: false,
			reasoning: null,
			include: ["reasoning.encrypted_content"],
			prompt_cache_key: "session-1",
		};
		const response = await fetch(`${server.url}/v1/codex/responses`, {
			method: "POST",
			headers: { ...headers, "content-encoding": "zstd" },
			body: await Bun.zstdCompress(JSON.stringify(body)),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const events = await frames(response);
		const done = events.filter(event => event.type === "response.output_item.done").map(event => event.item!);
		expect(done[0]).toMatchObject({
			type: "reasoning",
			encrypted_content: "opaque-reasoning",
			summary: [{ type: "summary_text", text: "Inspecting" }],
		});
		expect(done[1]).toMatchObject({
			type: "custom_tool_call",
			namespace: "editor",
			name: "apply_patch",
			call_id: "call_patch",
			input: "*** Begin Patch\n*** End Patch",
		});
		const completed = events.find(event => event.type === "response.completed")!.response!;
		expect(completed.output).toEqual(done);
		expect(completed.id).toBe(events[0].response!.id);
		expect(completed.usage).toMatchObject({
			input_tokens: 12,
			input_tokens_details: { cached_tokens: 4 },
			output_tokens: 6,
			output_tokens_details: { reasoning_tokens: 2 },
			total_tokens: 18,
		});
		model.push(context => {
			const result = context.messages.at(-1);
			return {
				content: [
					result?.role === "toolResult" && result.toolName === "editor__apply_patch"
						? "Patch applied"
						: "Tool result lost",
				],
			};
		});
		const followup = await fetch(`${server.url}/v1/codex/responses`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				...body,
				input: [
					...input,
					...done,
					{
						type: "custom_tool_call_output",
						call_id: "call_patch",
						output: [{ type: "input_text", text: "success" }],
					},
				],
			}),
		});
		const final = (await frames(followup)).find(event => event.type === "response.output_item.done")!.item!;
		expect(final.content).toEqual([{ type: "output_text", text: "Patch applied", annotations: [] }]);
	});

	it("keeps legacy JSON routes working and leaves Codex normalization isolated", async () => {
		const { server, model } = await gateway();
		for (const [route, request, outputField] of [
			["/v1/responses", { input: "hello" }, "output"],
			["/v1/chat/completions", { messages: [{ role: "user", content: "hello" }] }, "choices"],
			["/v1/messages", { messages: [{ role: "user", content: "hello" }], max_tokens: 32 }, "content"],
		] as const) {
			model.push({ content: ["legacy-ok"] });
			const response = await fetch(`${server.url}${route}`, {
				method: "POST",
				headers,
				body: JSON.stringify({ ...request, model: model.id, stream: false }),
			});
			expect(response.status).toBe(200);
			const payload = (await response.json()) as Record<string, unknown>;
			expect(JSON.stringify(payload[outputField])).toContain("legacy-ok");
		}
		const response = await fetch(`${server.url}/v1/responses`, {
			method: "POST",
			headers,
			body: JSON.stringify({ model: model.id, input: "hello", reasoning: null }),
		});
		expect(response.status).toBe(400);
		const unauthorized = await fetch(`${server.url}/v1/codex/responses`, { method: "POST", body: "{}" });
		expect(unauthorized.status).toBe(401);
		const upgrade = Promise.withResolvers<number>();
		const request = http.get(
			`${server.url}/v1/codex/responses`,
			{ headers: { ...headers, connection: "Upgrade", upgrade: "websocket" } },
			response => {
				response.resume();
				upgrade.resolve(response.statusCode!);
			},
		);
		request.on("error", upgrade.reject);
		expect(await upgrade.promise).toBe(426);
	});

	it("uses Codex error codes on failed streams and never follows failure with completion", async () => {
		const { server, model } = await gateway();
		model.push({ throw: "context_length_exceeded: maximum context length is 100 tokens" });
		const response = await fetch(`${server.url}/v1/codex/responses`, {
			method: "POST",
			headers,
			body: JSON.stringify({ model: model.id, input: "hello", stream: true }),
		});
		const events = await frames(response);
		expect(events.at(-1)?.response?.error?.code).toBe("context_length_exceeded");
		expect(events.some(event => event.type === "response.completed")).toBe(false);
	});

	it("normalizes Lite tool discovery and namespaced history without modifying the caller's input", () => {
		const body = {
			model: "openai-codex/gpt-5.3-codex",
			reasoning: { effort: "none" },
			input: [
				{ type: "additional_tools", role: "developer", tools },
				{ type: "tool_search_call", call_id: "search_1", execution: "client", arguments: { query: "editor" } },
				{ type: "tool_search_output", call_id: "search_1", status: "completed", execution: "client", tools },
				{
					type: "message",
					id: "msg_partial",
					role: "assistant",
					phase: "partial_answer",
					content: [{ type: "output_text", text: "Working" }],
				},
			],
		};
		const before = JSON.stringify(body);
		const parsed = parseRequest(body, undefined, createCodexModel("gpt-5.3-codex"));
		expect(JSON.stringify(body)).toBe(before);
		expect(parsed.options.forceReasoningOff).toBe(true);
		const message = parsed.context.messages.at(-1)!;
		expect(message.role).toBe("assistant");
		if (message.role !== "assistant") throw new Error("missing assistant");
		expect(message.model).toBe("gpt-5.3-codex");
		expect(message.content[0]).toMatchObject({
			type: "text",
			textSignature: JSON.stringify({ v: 1, id: "msg_partial", phase: "partial_answer" }),
		});
	});

	it.each([
		["openai-responses", "openai", "openai/gpt-5.3-codex"],
		["azure-openai-responses", "azure", "gateway-alias"],
		["openai-codex-responses", "openai-codex", "openai-codex/gpt-5.3-codex"],
	] as const)("replays encrypted done items and explicit controls through %s", async (api, provider, requestedId) => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-codex-upstream-"));
		cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		cleanup.push(() => storage.close());
		storage.keys.setRuntime(provider, "upstream-key");
		const requests: Record<string, unknown>[] = [];
		const encryptedContent = "opaque-replay";
		const toolItem = {
			type: "function_call",
			id: "fc_message",
			call_id: "call_message",
			name: "editor__send_message",
			arguments: JSON.stringify({ message: "hello" }),
			encrypted_function_args: [],
		};
		const ordinaryToolItem = {
			type: "function_call",
			id: "fc_read",
			call_id: "call_read",
			name: "editor__send_message",
			arguments: JSON.stringify({ message: "ordinary" }),
		};
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				requests.push((await req.json()) as Record<string, unknown>);
				const reasoning = {
					type: "reasoning",
					id: "rs_upstream",
					summary: [],
					encrypted_content: encryptedContent,
				};
				const item = {
					type: "message",
					id: "msg_answer",
					role: "assistant",
					phase: "final_answer",
					content: [{ type: "output_text", text: "continued" }],
				};
				const events = [
					{ type: "response.created", response: { id: "resp_upstream" } },
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { type: "reasoning", id: reasoning.id, summary: [] },
					},
					{ type: "response.output_item.done", output_index: 0, item: reasoning },
					{ type: "response.output_item.added", output_index: 1, item: { ...item, content: [] } },
					{
						type: "response.output_text.delta",
						item_id: item.id,
						output_index: 1,
						content_index: 0,
						delta: "continued",
					},
					{ type: "response.output_item.done", output_index: 1, item },
					{ type: "response.output_item.added", output_index: 2, item: { ...toolItem, arguments: "" } },
					{ type: "response.output_item.added", output_index: 3, item: { ...ordinaryToolItem, arguments: "" } },
					{ type: "response.output_item.done", output_index: 3, item: ordinaryToolItem },
					{
						type: "response.function_call_arguments.delta",
						output_index: 2,
						item_id: toolItem.id,
						delta: toolItem.arguments,
					},
					{ type: "response.output_item.done", output_index: 2, item: toolItem },
					{
						type: "response.completed",
						response: {
							id: "resp_upstream",
							status: "completed",
							output: [reasoning, item, toolItem, ordinaryToolItem],
							usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
						},
					},
				];
				return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
		cleanup.push(() => upstream.stop(true));
		const model = buildModel({
			id: "gpt-5.3-codex",
			name: "GPT-5.3 Codex",
			api,
			provider,
			baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
			preferWebsockets: false,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272000,
			maxTokens: 128000,
		});
		const server = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gateway-token"],
			storage,
			resolveModel: id => (id === requestedId ? model : undefined),
			// Keep Azure environment overrides from sending this fixture outside loopback.
			fetch: (_input, init) => fetch(upstream.url, init),
			version: "test",
		});
		cleanup.push(() => server.close());
		const input: Record<string, unknown>[] = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
			{
				type: "message",
				id: "msg_partial",
				role: "assistant",
				phase: "partial_answer",
				content: [{ type: "output_text", text: "Working" }],
			},
		];
		const body = {
			model: requestedId,
			stream: true,
			parallel_tool_calls: false,
			text: {
				verbosity: "low",
				format: {
					type: "json_schema",
					name: "answer",
					strict: true,
					schema: { type: "object", properties: {} },
				},
			},
			input,
			tools: [{ type: "namespace", name: "editor", tools: [{ ...functionTool, name: "send_message" }] }],
		};
		const response = await fetch(`${server.url}/v1/codex/responses`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		const result = await frames(response);
		expect(result.at(-1)?.type).toBe("response.completed");
		expect(requests[0].input).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "message", phase: "partial_answer" })]),
		);
		const done = result.filter(event => event.type === "response.output_item.done").map(event => event.item!);
		expect(done).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "reasoning", encrypted_content: encryptedContent })]),
		);
		const doneCall = done.find(item => item.call_id === toolItem.call_id)!;
		expect(doneCall).toMatchObject({
			call_id: toolItem.call_id,
			name: "send_message",
			namespace: "editor",
			encrypted_function_args: [],
		});
		expect(done.find(item => item.call_id === ordinaryToolItem.call_id)).not.toHaveProperty(
			"encrypted_function_args",
		);
		const followup = await fetch(`${server.url}/v1/codex/responses`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				...body,
				input: [
					...input,
					...done,
					{ type: "function_call_output", call_id: toolItem.call_id, output: "delivered" },
					{ type: "function_call_output", call_id: ordinaryToolItem.call_id, output: "read" },
					{ type: "message", role: "user", content: [{ type: "input_text", text: "Finish" }] },
				],
			}),
		});
		expect((await frames(followup)).at(-1)?.type).toBe("response.completed");
		expect(requests[1]).toMatchObject({
			model: model.id,
			parallel_tool_calls: false,
			text: { verbosity: "low", format: { type: "json_schema", name: "answer" } },
			input: expect.arrayContaining([
				expect.objectContaining({ type: "reasoning", encrypted_content: encryptedContent }),
				expect.objectContaining({ type: "function_call", name: toolItem.name, encrypted_function_args: [] }),
			]),
		});
		const nonstream = await fetch(`${server.url}/v1/codex/responses`, {
			method: "POST",
			headers,
			body: JSON.stringify({ ...body, stream: false }),
		});
		expect(nonstream.status).toBe(200);
		expect(await nonstream.json()).toMatchObject({
			output: expect.arrayContaining([
				expect.objectContaining({
					type: "function_call",
					namespace: "editor",
					name: "send_message",
					encrypted_function_args: [],
				}),
			]),
		});
	});

	it("keeps encrypted arguments on their own call when IDs repeat across turns", async () => {
		const { server, requests } = await responsesGateway();
		const input: Record<string, unknown>[] = [
			{ role: "user", content: "Find tools" },
			{ type: "tool_search_call", call_id: "search_1", execution: "client", arguments: {} },
			{ type: "tool_search_output", call_id: "search_1", execution: "client", tools },
			{
				type: "custom_tool_call",
				call_id: "call_patch",
				name: "apply_patch",
				namespace: "editor",
				input: "patch",
			},
			{ type: "custom_tool_call_output", call_id: "call_patch", output: "applied" },
		];
		for (const [turn, encryptedArgs] of [
			["first", ["first-opaque"]],
			["ordinary", undefined],
			["last", ["last-opaque"]],
		] as const) {
			input.push(
				{ role: "user", content: turn },
				{
					type: "function_call",
					call_id: "call_reused",
					name: "send_message",
					namespace: "editor",
					arguments: JSON.stringify({ message: turn }),
					...(encryptedArgs === undefined ? {} : { encrypted_function_args: encryptedArgs }),
				},
				{ type: "function_call_output", call_id: "call_reused", output: `delivered ${turn}` },
			);
		}
		const response = await fetch(`${server.url}/v1/codex/responses`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: "choice-model",
				stream: false,
				input,
				tools: [{ type: "namespace", name: "editor", tools: [{ ...functionTool, name: "send_message" }] }],
			}),
		});
		expect(response.status).toBe(200);
		await response.text();
		const upstream = requests[0] as { input: Record<string, unknown>[] };
		// Every repeated native call must keep its own metadata AND real result.
		const calls = upstream.input.filter(
			item => item.type === "function_call" && item.name === "editor__send_message",
		);
		expect(calls).toMatchObject([
			{ arguments: JSON.stringify({ message: "first" }), encrypted_function_args: ["first-opaque"] },
			{ arguments: JSON.stringify({ message: "ordinary" }) },
			{ arguments: JSON.stringify({ message: "last" }), encrypted_function_args: ["last-opaque"] },
		]);
		expect(calls[1]).not.toHaveProperty("encrypted_function_args");
		expect(new Set(calls.map(call => call.call_id)).size).toBe(3);
		const outputs = upstream.input.filter(item => item.type === "function_call_output");
		for (const [index, turn] of ["first", "ordinary", "last"].entries()) {
			expect(outputs.filter(output => output.call_id === calls[index]!.call_id)).toEqual([
				expect.objectContaining({ output: `delivered ${turn}` }),
			]);
		}
		const nativeCallIds = new Set(
			upstream.input
				.filter(item => item.type === "function_call" || item.type === "custom_tool_call")
				.map(item => item.call_id),
		);
		expect(outputs.every(output => nativeCallIds.has(output.call_id))).toBe(true);
		expect(JSON.stringify(upstream.input)).not.toContain("No result provided");
		expect(JSON.stringify(upstream.input)).not.toContain("[Orphan tool result");
	});

	it.each(["unrepairable", "completed arguments"] as const)(
		"round-trips normalized %s through JSON and SSE without losing native metadata",
		async scenario => {
			const raw = scenario === "unrepairable" ? '{"tasks": [{"task": "x" "y"}]] }}' : "{}";
			const completed = scenario === "completed arguments" ? '{"path":"README.md"}' : undefined;
			const { server, requests } = await responsesGateway(
				{
					type: "function_call",
					id: "fc_normalized",
					call_id: "call_normalized",
					name: "read",
					arguments: raw,
					encrypted_function_args: ["opaque-normalized"],
				},
				completed,
			);
			const callSchema = type({
				type: "'function_call'",
				"id?": "string",
				call_id: "string",
				name: "string",
				arguments: "string",
				"encrypted_function_args?": "string[]",
			});
			const responseSchema = type({ output: callSchema.array() });
			const requestSchema = type({
				input: callSchema.or(type({ type: "'function_call_output'", call_id: "string", output: "string" })).array(),
			});
			for (const stream of [false, true]) {
				const response = await fetch(`${server.url}/v1/codex/responses`, {
					method: "POST",
					headers,
					body: JSON.stringify({ model: "choice-model", input: "Read the file", stream }),
				});
				expect(response.status).toBe(200);
				const items = stream
					? (await frames(response))
							.filter(frame => frame.type === "response.output_item.done")
							.map(frame => callSchema.assert(frame.item))
					: responseSchema.assert(await response.json()).output;
				expect(items).toHaveLength(1);
				const item = items[0]!;
				const args = JSON.parse(String(item.arguments));
				if (scenario === "unrepairable") {
					expect(args).toEqual({ __parseError: expect.any(String), __rawJson: raw });
				} else {
					expect(args).toEqual({ path: "README.md" });
				}
				expect(item.call_id).toBe("call_normalized");
				expect(item.encrypted_function_args).toEqual(["opaque-normalized"]);
				expect(item.id).toBe("fc_normalized");
				const replay = await fetch(`${server.url}/v1/codex/responses`, {
					method: "POST",
					headers,
					body: JSON.stringify({
						model: "choice-model",
						input: [...items, { type: "function_call_output", call_id: item.call_id, output: "tool result" }],
					}),
				});
				expect(replay.status).toBe(200);
				await replay.text();
				const input = requestSchema.assert(requests.at(-1)).input;
				const calls = input.filter(entry => entry.type === "function_call");
				expect(calls).toHaveLength(1);
				expect(JSON.parse(String(calls[0]!.arguments))).toEqual(args);
				expect(calls[0]!.encrypted_function_args).toEqual(["opaque-normalized"]);
				expect(
					input.filter(entry => entry.type === "function_call_output").map(entry => [entry.call_id, entry.output]),
				).toEqual([[calls[0]!.call_id, "tool result"]]);
			}
		},
	);

	it.each([
		["function", "openai-responses", "fc_function"],
		["native custom", "azure-openai-responses", "ctc_custom"],
		["text custom bridge", "openai-codex-responses", "fc_text"],
		["missing item ID", "openai-responses", undefined],
		["empty item ID", "openai-responses", ""],
		["opaque foreign ID", "openai-completions", "not_a_responses_item"],
	] as const)("keeps %s identity stable when native history arrives after item-added", async (kind, api, itemId) => {
		const nativeCustom = kind === "native custom";
		const textCustom = kind === "text custom bridge";
		const foreign = kind === "opaque foreign ID";
		const model = buildModel({
			id: "gpt-test",
			name: "Identity test",
			api,
			provider: "openai",
			baseUrl: "http://127.0.0.1:1/v1",
			input: ["text"],
			reasoning: false,
			contextWindow: 8192,
			maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const parsed = parseRequest(
			{
				model: model.id,
				input: "Echo",
				tools: [
					{
						type: "namespace",
						name: "editor",
						tools: [
							nativeCustom
								? {
										type: "custom",
										name: "echo",
										format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
									}
								: textCustom
									? { type: "custom", name: "echo", format: { type: "text" } }
									: { type: "function", name: "echo", parameters: { type: "object", properties: {} } },
						],
					},
				],
			},
			undefined,
			model,
		);
		const toolCall: ToolCall = {
			type: "toolCall",
			id: itemId === undefined ? "call_identity" : `call_identity|${itemId}`,
			name: "editor__echo",
			arguments: { input: "hello" },
			...(nativeCustom ? { customWireName: "editor__echo" } : {}),
		};
		const partial: AssistantMessage = {
			role: "assistant",
			api,
			provider: model.provider,
			model: model.id,
			content: [toolCall],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		};
		const original = structuredClone(partial);
		const events = new AssistantMessageEventStream();
		const stream = readSseJson<Frame>(encodeStream(events, model.id, parsed.options));
		try {
			events.push({ type: "toolcall_start", contentIndex: 0, partial });
			expect((await stream.next()).value).toMatchObject({ type: "response.created" });
			const added = (await stream.next()).value as Frame;
			expect(added).toMatchObject({
				type: "response.output_item.added",
				item: {
					type: nativeCustom || textCustom ? "custom_tool_call" : "function_call",
					name: "echo",
					namespace: "editor",
				},
			});
			const emittedId = added.item!.id;
			if (typeof emittedId !== "string") throw new Error("Expected a string SSE item ID");
			if (itemId && !foreign) expect(emittedId).toBe(itemId);
			else {
				expect(emittedId).toMatch(/^fc_[a-f0-9]{32}$/);
				if (foreign) expect(emittedId).not.toBe(itemId);
			}
			// Do not expose final native history until the client has consumed added.
			const message: AssistantMessage = {
				...partial,
				providerPayload: foreign
					? undefined
					: createOpenAIResponsesHistoryPayload(model.provider, [
							{
								type: nativeCustom ? "custom_tool_call" : "function_call",
								...(itemId ? { id: itemId } : {}),
								call_id: "call_identity",
								name: "editor__echo",
								...(nativeCustom
									? { input: "hello" }
									: { arguments: JSON.stringify(toolCall.arguments), encrypted_function_args: [] }),
							},
						]),
			};
			events.push({
				type: "toolcall_delta",
				contentIndex: 0,
				delta: nativeCustom ? "hello" : JSON.stringify(toolCall.arguments),
				partial,
			});
			events.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
			events.push({ type: "done", reason: "toolUse", message });
			const remaining: Frame[] = [];
			for await (const frame of stream) remaining.push(frame);
			const deltas = remaining.filter(frame => frame.type.endsWith(".delta"));
			if (textCustom) expect(deltas).toEqual([]);
			else
				expect(deltas.map(frame => [frame.type, frame.item_id])).toEqual([
					[
						nativeCustom ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta",
						emittedId,
					],
				]);
			const done = remaining.filter(frame => frame.type === "response.output_item.done");
			expect(done).toHaveLength(1);
			expect(done[0]!.item).toMatchObject({
				id: emittedId,
				name: "echo",
				namespace: "editor",
				...(nativeCustom || textCustom ? { input: "hello" } : { arguments: JSON.stringify(toolCall.arguments) }),
				...(!nativeCustom && !foreign ? { encrypted_function_args: [] } : {}),
			});
			expect(remaining.at(-1)).toMatchObject({ type: "response.completed", response: { output: [done[0]!.item] } });
			expect(partial).toEqual(original);
		} finally {
			events.end();
			await stream.return(undefined);
		}
	});

	it.each([
		["reversed native order", ["fc_first", "fc_second"], ["fc_second", "fc_first"], [1, 0]],
		["anonymous before identified", [undefined, "fc_first"], ["fc_first", "fc_second"], [1, 0]],
		["missing item IDs", [undefined, undefined, undefined], [undefined, undefined], [0, 1, undefined]],
		["different known item IDs", ["fc_first", "fc_other"], ["fc_second", "fc_first"], [1, undefined]],
		["duplicate full identities", ["fc_first", "fc_first"], ["fc_first", "fc_first"], [0, 1]],
	] as const)("keeps repeated call metadata separate in JSON and SSE: %s", async (_label, ids, nativeIds, matches) => {
		const nativeItems = nativeIds.map((id, index) => ({
			type: "function_call",
			...(id === undefined ? {} : { id }),
			call_id: "call_reused",
			name: `native_${index}`,
			arguments: JSON.stringify({ source: "native", index }),
			encrypted_function_args: [`opaque_${index}`],
		}));
		const message: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.3-codex",
			content: ids.map((id, index) => ({
				type: "toolCall",
				id: id === undefined ? "call_reused" : `call_reused|${id}`,
				name: `generic_${index}`,
				arguments: { source: "generic", index },
			})),
			providerPayload: createOpenAIResponsesHistoryPayload("openai", nativeItems),
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
		const jsonItems = encodeResponse(message, message.model).output as Record<string, unknown>[];
		const outputs = [jsonItems];
		for (const nativeAtStart of [false, true]) {
			const partial = nativeAtStart ? message : { ...message, providerPayload: undefined };
			const events = new AssistantMessageEventStream();
			for (const [contentIndex, toolCall] of message.content.entries()) {
				if (toolCall.type !== "toolCall") throw new Error("Expected tool call");
				events.push({ type: "toolcall_start", contentIndex, partial });
				events.push({ type: "toolcall_end", contentIndex, toolCall, partial });
			}
			events.push({ type: "done", reason: "toolUse", message });
			const result = await frames(new Response(encodeStream(events, message.model)));
			const added = result.filter(event => event.type === "response.output_item.added").map(event => event.item!);
			const done = result.filter(event => event.type === "response.output_item.done").map(event => event.item!);
			expect(done.map(item => item.id)).toEqual(added.map(item => item.id));
			expect(result.at(-1)).toMatchObject({ type: "response.completed", response: { output: done } });
			if (nativeAtStart) {
				for (const [index, match] of matches.entries()) {
					expect(added[index]).toMatchObject({
						name: match === undefined ? `generic_${index}` : `native_${match}`,
						arguments: "",
					});
					if (match === undefined) expect(added[index]).not.toHaveProperty("encrypted_function_args");
					else expect(added[index].encrypted_function_args).toEqual([`opaque_${match}`]);
					if (match !== undefined && nativeIds[match] !== undefined) {
						expect(added[index].id).toBe(nativeIds[match]);
					}
				}
			}
			outputs.push(done);
		}
		for (const output of outputs) {
			expect(output).toHaveLength(ids.length);
			for (const [index, match] of matches.entries()) {
				expect(output[index]).toMatchObject({
					type: "function_call",
					call_id: "call_reused",
					name: match === undefined ? `generic_${index}` : `native_${match}`,
				});
				if (match === undefined) expect(output[index]).not.toHaveProperty("encrypted_function_args");
				else expect(output[index].encrypted_function_args).toEqual([`opaque_${match}`]);
			}
		}
		for (const [index, match] of matches.entries()) {
			if (match !== undefined && nativeIds[match] !== undefined) expect(jsonItems[index].id).toBe(nativeIds[match]);
		}
	});

	it("does not relabel Responses encrypted history as Anthropic signed thinking", () => {
		const model = buildModel({
			id: "claude-fable-5-1",
			name: "Claude Fable 5.1",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		});
		const parsed = parseRequest(
			{
				model: model.id,
				input: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: "Start" }] },
					{ type: "reasoning", id: "rs_foreign", summary: [], encrypted_content: "foreign-encrypted-content" },
					{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Working" }] },
					{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
				],
			},
			undefined,
			model,
		);
		const wire = convertAnthropicMessages(parsed.context.messages, model, false);
		const assistant = wire.find(message => message.role === "assistant");
		expect(assistant?.content).toEqual([{ type: "text", text: "Working" }]);
		expect(JSON.stringify(wire)).not.toContain("foreign-encrypted-content");
	});

	it("returns client tool-search calls in JSON and length-limited streams as incomplete", async () => {
		const { server, model } = await gateway();
		model.push({
			content: [{ type: "toolCall", id: "search_1", name: "tool_search", arguments: { query: "editor" } }],
		});
		const response = await fetch(`${server.url}/v1/codex/responses`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: model.id,
				input: "Find editor tools",
				stream: false,
				tools: [
					{
						type: "tool_search",
						execution: "client",
						description: "Search available tools",
						parameters: { type: "object", properties: { query: { type: "string" } } },
					},
				],
			}),
		});
		const payload = (await response.json()) as { output: Record<string, unknown>[] };
		expect(payload.output[0]).toMatchObject({
			type: "tool_search_call",
			execution: "client",
			call_id: "search_1",
			arguments: { query: "editor" },
		});
		model.push({ content: ["cut off"], stopReason: "length" });
		const limited = await fetch(`${server.url}/v1/codex/responses`, {
			method: "POST",
			headers,
			body: JSON.stringify({ model: model.id, input: "continue", stream: true }),
		});
		const events = await frames(limited);
		expect(events.at(-1)).toMatchObject({
			type: "response.incomplete",
			response: { incomplete_details: { reason: "max_output_tokens" } },
		});
		expect(events.some(event => event.type === "response.completed")).toBe(false);
	});

	it("propagates response cancellation and reports truncated upstream streams as failures", async () => {
		const events = new AssistantMessageEventStream();
		let cancellation: unknown;
		const reader = encodeStream(events, "model", undefined, {
			onCancel: reason => {
				cancellation = reason;
			},
		}).getReader();
		await reader.read();
		await reader.cancel("disconnect");
		expect(cancellation).toBe("disconnect");
		events.end();
		const truncated = new AssistantMessageEventStream();
		truncated.end();
		const result = await frames(new Response(encodeStream(truncated, "model")));
		expect(result.at(-1)?.type).toBe("response.failed");
	});
});
