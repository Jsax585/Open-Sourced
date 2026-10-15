import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { encodeStream, parseRequest } from "@oh-my-pi/pi-ai/providers/openai-codex-responses-server";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { readSseJson } from "@oh-my-pi/pi-utils/stream";
import { createCodexModel } from "./helpers";

interface Frame {
	type: string;
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

describe("auth-gateway Codex Responses", () => {
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
					{
						type: "response.completed",
						response: {
							id: "resp_upstream",
							status: "completed",
							output: [reasoning, item],
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
		const followup = await fetch(`${server.url}/v1/codex/responses`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				...body,
				input: [
					...input,
					...done,
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
			]),
		});
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
