import { describe, expect, test } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const deepseek = buildModel(
	seedModels<"openai-completions">("sideren").find(model => model.id === "@sdn/deepseek-v4.1-flash-1017")!,
);
const qwen = buildModel(seedModels<"openai-completions">("sideren").find(model => model.id === "@sdn/qwen3.8-27b")!);
const context: Context = {
	systemPrompt: ["You are a coding assistant."],
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

describe("Sideren chat requests", () => {
	test.each([
		{ options: { reasoning: Effort.High }, wireEffort: "high" },
		{ options: { disableReasoning: true }, wireEffort: "none" },
	])("serializes $options as plain Chat Completions", async ({ options, wireEffort }) => {
		let payload: Record<string, unknown> | undefined;
		const controller = new AbortController();
		controller.abort();
		const stream = streamOpenAICompletions(deepseek, context, {
			...options,
			apiKey: "sdn_test_key",
			maxTokens: 32_000,
			signal: controller.signal,
			onPayload: body => {
				payload = body as Record<string, unknown>;
			},
		});
		await stream.result();
		expect(payload?.model).toBe("@sdn/deepseek-v4.1-flash-1017");
		expect(payload?.reasoning_effort).toBe(wireEffort);
		expect(payload?.max_tokens).toBe(32_000);
		expect(payload).not.toHaveProperty("max_completion_tokens");
		expect(payload).not.toHaveProperty("store");
		expect(payload?.messages).toEqual([
			expect.objectContaining({ role: "system" }),
			expect.objectContaining({ role: "user" }),
		]);
	});

	test.each([
		{ options: { reasoning: Effort.Medium }, wireEffort: "medium" },
		{ options: { disableReasoning: true }, wireEffort: "low" },
	])("sends Qwen thinking for $options as reasoning_effort", async ({ options, wireEffort }) => {
		let payload: Record<string, unknown> | undefined;
		const controller = new AbortController();
		controller.abort();
		const stream = streamOpenAICompletions(qwen, context, {
			...options,
			apiKey: "sdn_test_key",
			signal: controller.signal,
			onPayload: body => {
				payload = body as Record<string, unknown>;
			},
		});
		await stream.result();
		expect(payload?.reasoning_effort).toBe(wireEffort);
		expect(payload).not.toHaveProperty("enable_thinking");
		expect(payload).not.toHaveProperty("chat_template_kwargs");
	});
});

describe("Sideren API-key login", () => {
	test("rejects invalid credentials with a models probe that bills nothing", async () => {
		const login = getProviderDefinition("sideren")!.login!;
		let endpoint = "";
		await expect(
			login({
				onAuth: () => {},
				onPrompt: async () => "sdn_invalid",
				fetch: async input => {
					endpoint = String(input);
					return Response.json(
						{ error: { message: "unknown api key", code: "unknown_api_key" } },
						{ status: 401 },
					);
				},
			}),
		).rejects.toThrow();
		expect(endpoint).toBe("https://api.sideren.io/v1/models");
	});
});
