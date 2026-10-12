import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { friendliModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { type OpenAICompletionsOptions, streamOpenAICompletions } from "../src/providers/openai-completions";
import { getProviderDefinition } from "../src/registry/registry";
import type { Context } from "../src/types";

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
	test("binary picker enables and disables thinking without top-level effort", async () => {
		const model = await discovered("zai-org/GLM-5.1", [{ type: "toggle" }]);
		expect(model.thinking?.efforts).toEqual([Effort.High]);
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
	});

	test("real efforts serialize distinct high/max values alongside the toggle", async () => {
		const model = await discovered("zai-org/GLM-5.2", [
			{ type: "toggle" },
			{ type: "effort", values: ["high", "max"] },
		]);
		for (const reasoning of ["high", "max"] as const) {
			const body = await capture(model, { reasoning });
			expect(body.reasoning_effort).toBe(reasoning);
			expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
		}
	});

	test("effort-only models cannot grow a toggle or expose Thinking Off", async () => {
		const model = await discovered("zai-org/GLM-5.3", [{ type: "effort", values: ["low", "high", "max"] }]);
		expect(model.thinking?.requiresEffort).toBe(true);
		const body = await capture(model, { reasoning: "max" });
		expect(body.reasoning_effort).toBe("max");
		expect(body.chat_template_kwargs).toBeUndefined();
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
							...(thinking
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

	test("custom Friendli endpoints reuse KDL without changing the caller's provider identity", async () => {
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
		const body = await capture(model, { reasoning: "max" });
		expect(body.reasoning_effort).toBe("max");
		expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
	});
});
