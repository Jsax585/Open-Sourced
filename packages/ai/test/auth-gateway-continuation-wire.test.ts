import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { startAuthGateway } from "../src/auth-gateway";
import { AuthStorage } from "../src/auth-storage";

function completedResponse(id: string): Response {
	const events = [
		{ type: "response.created", response: { id } },
		{
			type: "response.output_item.added",
			item: { type: "message", id: `msg_${id}`, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "ok" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: `msg_${id}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "ok" }],
			},
		},
		{
			type: "response.completed",
			response: { id, status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } },
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		headers: { "Content-Type": "text/event-stream" },
	});
}

it("rejects pi-native Codex continuation IDs before any upstream request", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-codex-continuation-"));
	const storage = await AuthStorage.create(path.join(directory, "auth.db"));
	const model = buildModel({
		id: "codex-fixture",
		name: "codex-fixture",
		provider: "unit-codex",
		api: "openai-codex-responses",
		baseUrl: "https://codex.example",
		reasoning: false,
		input: ["text"],
		contextWindow: 10000,
		maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	storage.keys.setRuntime(model.provider, "fixture-key");
	let requests = 0;
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["client"],
		storage,
		resolveModel: () => model,
		fetch: async () => {
			requests++;
			return completedResponse("unexpected");
		},
	});
	try {
		const response = await fetch(`${gateway.url}/v1/pi/stream`, {
			method: "POST",
			headers: { Authorization: "Bearer client", "Content-Type": "application/json" },
			body: JSON.stringify({
				modelId: model.id,
				context: { messages: [{ role: "user", content: "next", timestamp: 0 }] },
				options: { previousResponseId: "resp_seed" },
				stream: false,
			}),
		});
		expect(response.status).toBe(400);
		expect(requests).toBe(0);
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

for (const native of [false, true]) {
	it(`keeps ${native ? "pi-native" : "Responses"} returned IDs on their owning stored credential and rejects replacement accounts`, async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-response-owner-"));
		const storage = await AuthStorage.create(path.join(directory, "auth.db"));
		const provider = "unit-response-owner";
		await storage.credentials.set(provider, [
			{ type: "api_key", key: "first-account" },
			{ type: "api_key", key: "second-account" },
		]);
		const model = buildModel({
			id: "owner-model",
			name: "owner-model",
			provider,
			api: "openai-responses",
			baseUrl: "https://owner.example/v1",
			reasoning: false,
			input: ["text"],
			contextWindow: 10000,
			maxTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const requests: Array<{ authorization: string | null; payload: Record<string, unknown> }> = [];
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["client"],
			storage,
			resolveModel: id => (id === model.id ? model : undefined),
			fetch: async (_input, init) => {
				requests.push({
					authorization: new Headers(init?.headers).get("authorization"),
					payload: JSON.parse(String(init?.body)) as Record<string, unknown>,
				});
				return completedResponse(`resp_owned_${requests.length}`);
			},
		});
		const post = (text: string, previous?: string) =>
			fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/responses"}`, {
				method: "POST",
				headers: { Authorization: "Bearer client", "Content-Type": "application/json" },
				body: JSON.stringify(
					native
						? {
								modelId: model.id,
								context: { messages: [{ role: "user", content: text, timestamp: 0 }] },
								stream: false,
								options: { store: true, previousResponseId: previous },
							}
						: { model: model.id, input: text, stream: false, store: true, previous_response_id: previous },
				),
			});
		try {
			const first = await post("conversation seed");
			expect(first.status).toBe(200);
			const firstBody = (await first.json()) as { id?: string; message?: { responseId?: string } };
			const responseId = native ? firstBody.message?.responseId : firstBody.id;
			expect(responseId).toBe("resp_owned_1");
			const next = await post("different continuation input", responseId);
			expect(next.status).toBe(200);
			expect(requests).toHaveLength(2);
			expect(requests[1]?.authorization).toBe(requests[0]?.authorization);
			expect(requests[1]?.payload.previous_response_id).toBe(responseId);
			storage.keys.setRuntime(provider, "replacement-account");
			const rejected = await post("cannot cross accounts", responseId);
			expect(rejected.status).toBe(400);
			expect(requests).toHaveLength(2);
		} finally {
			await gateway.close();
			storage.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
}

for (const native of [false, true]) {
	for (const override of ["runtime", "config"] as const) {
		it(`forwards ${native ? "pi-native" : "Responses"} continuations with a pinned ${override} key despite stale stored rows`, async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-continuation-wire-"));
			const storage = await AuthStorage.create(path.join(directory, "auth.db"));
			const provider = "unit-continuation-wire";
			await storage.credentials.set(provider, [
				{ type: "api_key", key: "stale-first" },
				{ type: "api_key", key: "stale-second" },
			]);
			if (override === "runtime") storage.keys.setRuntime(provider, "pinned-key");
			else storage.keys.setConfig(provider, "pinned-key");
			const model = buildModel({
				id: "wire-model",
				name: "wire-model",
				provider,
				api: "openai-responses",
				baseUrl: "https://fixture.example/v1",
				reasoning: false,
				input: ["text"],
				contextWindow: 10000,
				maxTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			});
			const requests: Array<{ authorization: string | null; payload: Record<string, unknown> }> = [];
			const gateway = startAuthGateway({
				bind: "127.0.0.1:0",
				bearerTokens: ["client"],
				storage,
				resolveModel: id => (id === model.id ? model : undefined),
				fetch: async (_input, init) => {
					requests.push({
						authorization: new Headers(init?.headers).get("authorization"),
						payload: JSON.parse(String(init?.body)) as Record<string, unknown>,
					});
					return completedResponse("resp_followup");
				},
			});
			try {
				const body = native
					? {
							modelId: model.id,
							context: { messages: [{ role: "user", content: "next", timestamp: 0 }] },
							stream: false,
							options: {
								previousResponseId: "resp_seed",
								store: true,
								parallelToolCalls: false,
								user: "fixture-user",
								responseFormat: { type: "json_object" },
							},
						}
					: {
							model: model.id,
							input: "next",
							previous_response_id: "resp_seed",
							store: true,
							stream: false,
							parallel_tool_calls: false,
							user: "fixture-user",
							text: { format: { type: "json_object" } },
						};
				const response = await fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/responses"}`, {
					method: "POST",
					headers: { Authorization: "Bearer client", "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				expect(response.status).toBe(200);
				expect(requests).toHaveLength(1);
				expect(requests[0]).toMatchObject({
					authorization: "Bearer pinned-key",
					payload: {
						previous_response_id: "resp_seed",
						store: true,
						parallel_tool_calls: false,
						user: "fixture-user",
						text: { format: { type: "json_object" } },
					},
				});
				expect(await response.text()).toContain("resp_followup");
			} finally {
				await gateway.close();
				storage.close();
				await fs.rm(directory, { recursive: true, force: true });
			}
		});
	}
}
