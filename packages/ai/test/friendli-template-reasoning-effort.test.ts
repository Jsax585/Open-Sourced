import { describe, expect, test } from "bun:test";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/env-api-key";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { friendliModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { type OpenAICompletionsOptions, streamOpenAICompletions } from "../src/providers/openai-completions";
import { getProviderDefinition } from "../src/registry/registry";
import type { Context } from "../src/types";
import { withEnv } from "./helpers";

async function discovered(id: string, reasoningOptions: Record<string, unknown>[]) {
	const options = friendliModelManagerOptions({
		apiKey: "test-key",
		fetch: async () => Response.json({ data: [{ id, reasoning: true, reasoning_options: reasoningOptions }] }),
	});
	const specs = await options.fetchDynamicModels?.();
	if (!specs?.[0]) throw new Error("Expected discovered Friendli model");
	return buildModel(specs[0]);
}

async function capture(
	model: Model<"openai-completions">,
	options: Pick<OpenAICompletionsOptions, "reasoning" | "disableReasoning">,
	context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
) {
	let body: Record<string, unknown> | undefined;
	const stream = streamOpenAICompletions(model, context, {
		...options,
		apiKey: "test-key",
		fetch: async (_input, init) => {
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				'data: {"id":"x","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
				{
					headers: { "content-type": "text/event-stream" },
				},
			);
		},
	});
	for await (const event of stream) {
		if (event.type === "error") throw new Error(event.error.errorMessage);
	}
	if (!body) throw new Error("Expected serialized request");
	return body;
}

describe("Friendli discovery-to-wire contracts", () => {
	test("uses the documented token variable while preserving API-key precedence", async () => {
		await withEnv({ FRIENDLI_API_KEY: undefined, FRIENDLI_TOKEN: "sdk-token" }, () => {
			expect(getEnvApiKey("friendli")).toBe("sdk-token");
		});
		await withEnv({ FRIENDLI_API_KEY: "existing-key", FRIENDLI_TOKEN: "sdk-token" }, () => {
			expect(getEnvApiKey("friendli")).toBe("existing-key");
		});
	});

	test("live binary controls override both unknown and effort-capable KDL defaults", async () => {
		for (const id of ["zai-org/GLM-5.1", "zai-org/GLM-5.2", "zai-org/GLM-5.3", "vendor/opaque"]) {
			const model = await discovered(id, [{ type: "toggle" }]);
			const on = await capture(model, { reasoning: "high" });
			expect(on.chat_template_kwargs).toEqual({ enable_thinking: true });
			expect(on.reasoning_effort).toBeUndefined();
			expect(on.parse_reasoning).toBe(true);
			expect(on.include_reasoning).toBe(true);
			const off = await capture(model, { disableReasoning: true });
			expect(off.chat_template_kwargs).toEqual({ enable_thinking: false });
			expect(off.reasoning_effort).toBeUndefined();
			expect(off.parse_reasoning).toBeUndefined();
			expect(off.include_reasoning).toBeUndefined();
		}
	});

	test("real efforts serialize distinct high/max values alongside the toggle", async () => {
		for (const id of ["zai-org/GLM-5.2", "zai-org/GLM-5.3"]) {
			const model = await discovered(id, [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }]);
			for (const reasoning of ["high", "max"] as const) {
				const body = await capture(model, { reasoning });
				expect(body.reasoning_effort).toBe(reasoning);
				expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
			}
			const off = await capture(model, { disableReasoning: true });
			expect(off.chat_template_kwargs).toEqual({ enable_thinking: false });
			expect(off.reasoning_effort).toBeUndefined();
		}
	});

	test("live non-GLM efforts override the no-effort KDL baseline", async () => {
		const model = await discovered("vendor/opaque", [{ type: "toggle" }, { type: "effort", values: ["low", "max"] }]);
		for (const reasoning of ["low", "max"] as const) {
			const body = await capture(model, { reasoning });
			expect(body.reasoning_effort).toBe(reasoning);
			expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
		}
	});

	test("custom non-GLM declared efforts emit tiers while a sparse model retains endpoint defaults", async () => {
		const spec = {
			...seedModels<"openai-completions">("friendli")[0],
			id: "vendor/opaque",
			provider: "custom-friendli",
		};
		const sparse = buildModel(spec);
		const body = await capture(sparse, {});
		expect(body.chat_template_kwargs).toBeUndefined();
		expect(body.reasoning_effort).toBeUndefined();
		const sparseRequested = await capture(sparse, { reasoning: "high" });
		expect(sparseRequested.reasoning_effort).toBeUndefined();
		expect(sparseRequested.chat_template_kwargs).toEqual({ enable_thinking: true });
		const explicitOff = await capture(sparse, { disableReasoning: true });
		expect(explicitOff.chat_template_kwargs).toEqual({ enable_thinking: false });
		const declared = buildModel({
			...spec,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Max] },
		});
		for (const reasoning of ["low", "max"] as const) {
			const enabled = await capture(declared, { reasoning });
			expect(enabled.reasoning_effort).toBe(reasoning);
			expect(enabled.chat_template_kwargs).toEqual({ enable_thinking: true });
		}
		const unrequested = await capture(declared, {});
		expect(unrequested.chat_template_kwargs).toEqual({ enable_thinking: false });
	});

	test("explicit flat and nested effort capabilities outrank a rule-owned empty dial", async () => {
		const spec = {
			...seedModels<"openai-completions">("friendli")[0],
			id: "vendor/opaque",
			provider: "custom-friendli",
		};
		const flat = buildModel({ ...spec, compat: { supportsReasoningEffort: true } });
		expect((await capture(flat, { reasoning: "max" })).reasoning_effort).toBe("max");
		const nested = buildModel({
			...spec,
			compat: {
				supportsReasoningEffort: false,
				whenThinking: {
					thinkingFormat: "openai",
					supportsReasoningEffort: true,
					omitReasoningEffort: false,
				},
			},
		});
		expect((await capture(nested, { reasoning: "high" })).reasoning_effort).toBe("high");
	});

	test("enabled views preserve baseline routing fields and nested template configuration", async () => {
		const model = buildModel({
			...seedModels<"openai-completions">("friendli")[0],
			compat: {
				extraBody: {
					gateway: "route-a",
					chat_template_kwargs: { template_option: "keep", enable_thinking: false },
				},
			},
		});
		const body = await capture(model, { reasoning: "high" });
		expect(body.gateway).toBe("route-a");
		expect(body.chat_template_kwargs).toMatchObject({ template_option: "keep", enable_thinking: true });
	});

	test("flat effort omission wins unless explicitly overridden in the enabled view", async () => {
		const spec = seedModels<"openai-completions">("friendli")[0];
		const omitted = buildModel({ ...spec, compat: { omitReasoningEffort: true } });
		expect((await capture(omitted, { reasoning: "high" })).reasoning_effort).toBeUndefined();
		const overridden = buildModel({
			...spec,
			compat: {
				omitReasoningEffort: true,
				whenThinking: { thinkingFormat: "openai", supportsReasoningEffort: true, omitReasoningEffort: false },
			},
		});
		expect((await capture(overridden, { reasoning: "high" })).reasoning_effort).toBe("high");
	});

	test("effort-only models cannot grow a toggle or expose Thinking Off", async () => {
		const model = await discovered("zai-org/GLM-5.3", [{ type: "effort", values: ["low", "high", "max"] }]);
		expect(model.thinking?.requiresEffort).toBe(true);
		const body = await capture(model, { reasoning: "max" });
		expect(body.reasoning_effort).toBe("max");
		expect(body.chat_template_kwargs).toBeUndefined();
		const off = await capture(model, { disableReasoning: true });
		expect(off.reasoning_effort).toBe("low");
		expect(off.chat_template_kwargs).toBeUndefined();
	});

	test("tool continuation preserves real reasoning and fulfills a missing-reasoning contract", async () => {
		const model = await discovered("zai-org/GLM-5.1", [{ type: "toggle" }]);
		for (const thinking of [undefined, "captured reasoning"]) {
			const context: Context = {
				messages: [
					{ role: "user", content: "use tool", timestamp: 0 },
					{
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						content: [
							...(thinking !== undefined
								? [{ type: "thinking" as const, thinking, thinkingSignature: "reasoning_content" }]
								: []),
							{ type: "toolCall", id: "call1", name: "lookup", arguments: {} },
						],
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
					},
					{
						role: "toolResult",
						toolCallId: "call1",
						toolName: "lookup",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: 2,
					},
				],
			};
			const body = await capture(model, { reasoning: "high" }, context);
			const messages = body.messages as Record<string, unknown>[];
			const assistant = messages.find(message => message.role === "assistant");
			expect(assistant?.reasoning_content).toBe(thinking ?? "");
		}
	});

	test("direct DeepSeek retains its explicit disabled thinking dialect", async () => {
		const model = buildModel({
			id: "deepseek-v4-flash",
			name: "DeepSeek",
			api: "openai-completions",
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 32768,
		});
		const body = await capture(model, { disableReasoning: true });
		expect(body.thinking).toEqual({ type: "disabled" });
		expect(body.reasoning_effort).toBeUndefined();
	});

	test("login probes authenticated chat rather than the public catalog and rejects an invalid key", async () => {
		const login = getProviderDefinition("friendli")?.login;
		if (!login) throw new Error("Friendli login is not registered");
		const key = await login({
			onPrompt: async () => " flp-test ",
			fetch: async (input, init) => {
				expect(String(input)).toBe("https://api.friendli.ai/serverless/v1/chat/completions");
				expect(init?.method).toBe("POST");
				expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer flp-test");
				expect(JSON.parse(String(init?.body)).model).toBe("zai-org/GLM-5.2");
				return Response.json({ choices: [] });
			},
		});
		expect(key).toBe("flp-test");
		await expect(
			login({
				onPrompt: async () => "invalid",
				fetch: async () => Response.json({ error: "Invalid key" }, { status: 401 }),
			}),
		).rejects.toThrow("FriendliAI API key validation failed (401)");
	});

	test("custom Friendli backend metadata survives a JSON rebuild and streams high/max over a proxy", async () => {
		const discoveredModel = await discovered("zai-org/GLM-5.2", [
			{ type: "toggle" },
			{ type: "effort", values: ["high", "max"] },
		]);
		const model = buildModel({
			...discoveredModel,
			provider: "custom-friendli",
			compat: undefined,
			thinking: undefined,
		});
		expect(model.provider).toBe("custom-friendli");
		expect(model.identity?.class).toBe("glm");
		expect(model.providerType).toBe("friendli");
		const bodies: Record<string, unknown>[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				bodies.push((await request.json()) as Record<string, unknown>);
				return new Response(
					'data: {"id":"x","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		try {
			const cached: ModelSpec<"openai-completions"> = JSON.parse(JSON.stringify(model));
			const rebuilt = buildModel({
				...cached,
				baseUrl: `${server.url}v1`,
				compat: undefined,
				thinking: undefined,
			});
			expect(rebuilt.provider).toBe("custom-friendli");
			expect(rebuilt.providerType).toBe("friendli");
			for (const reasoning of ["high", "max"] as const) {
				const stream = streamOpenAICompletions(
					rebuilt,
					{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
					{ apiKey: "test-key", reasoning },
				);
				for await (const event of stream) {
					if (event.type === "error") throw new Error(event.error.errorMessage);
				}
			}
			expect(bodies.map(body => body.reasoning_effort)).toEqual(["high", "max"]);
			for (const body of bodies) expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
		} finally {
			await server.stop(true);
		}
	});
});
