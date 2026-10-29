import { describe, expect, test } from "bun:test";
import { getModelPricingStatus } from "@oh-my-pi/pi-catalog/models";
import { togetherModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

function rosterFetch(data: unknown[], calls?: Array<{ url: string; authorization: string | null }>): FetchImpl {
	return async (input: string | URL | Request, init?: RequestInit) => {
		calls?.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
		// Together returns a bare array, not the OpenAI `{ data }` envelope.
		return Response.json(data);
	};
}

describe("Together discovery", () => {
	test("maps the live per-million token tariff, limits, and display name", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const models =
			(await togetherModelManagerOptions({
				apiKey: "together-test-key",
				fetch: rosterFetch(
					[
						{
							id: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
							type: "chat",
							display_name: "DeepSeek V4.1 Flash 1017",
							context_length: 1000000,
							pricing: { hourly: 0, input: 0.3, output: 1.2, cached_input: 0.006 },
						},
					],
					calls,
				),
			}).fetchDynamicModels?.()) ?? [];

		expect(calls).toEqual([{ url: "https://api.together.xyz/v1/models", authorization: "Bearer together-test-key" }]);
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
			name: "DeepSeek V4.1 Flash 1017",
			contextWindow: 1000000,
			cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
		});
		expect(getModelPricingStatus(models[0])).toBe("fixed");
	});

	test("keeps non-token, dedicated, and genuinely free rows distinct", async () => {
		const models =
			(await togetherModelManagerOptions({
				apiKey: "together-test-key",
				fetch: rosterFetch([
					{
						id: "black-forest-labs/FLUX.2-pro",
						type: "image",
						pricing: { hourly: 0, input: 0.03, output: 0, image: 0.03 },
					},
					{
						id: "meta-llama/Llama-4-70B-Instruct-Reference",
						type: "chat",
						pricing: { hourly: 3.5, input: 0, output: 0 },
					},
					{
						id: "Prism-ML/Ternary-Bonsai-27B",
						type: "chat",
						pricing: { hourly: 0, input: 0, output: 0 },
					},
					{
						id: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
						type: "code",
						pricing: { hourly: 0, input: 2, output: 2 },
					},
				]),
			}).fetchDynamicModels?.()) ?? [];

		const byId = Object.fromEntries(models.map(model => [model.id, model]));
		// An image row's per-image rate must not become a per-token rate.
		expect(byId["black-forest-labs/FLUX.2-pro"].cost).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(getModelPricingStatus(byId["meta-llama/Llama-4-70B-Instruct-Reference"])).toBe("variable");
		expect(getModelPricingStatus(byId["Prism-ML/Ternary-Bonsai-27B"])).toBe("free");
		expect(byId["Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8"].cost).toEqual({
			input: 2,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	test("a missing cache leg keeps the bundled cache rate; an explicit zero does not", async () => {
		const models =
			(await togetherModelManagerOptions({
				apiKey: "together-test-key",
				fetch: rosterFetch([
					{ id: "deepseek-ai/DeepSeek-V4.1-Flash", type: "chat", pricing: { input: 0.3, output: 1.2 } },
					{
						id: "deepseek-ai/DeepSeek-V3.1",
						type: "chat",
						pricing: { input: 0.6, output: 1.25, cached_input: 0 },
					},
				]),
			}).fetchDynamicModels?.()) ?? [];

		const byId = Object.fromEntries(models.map(model => [model.id, model]));
		expect(byId["deepseek-ai/DeepSeek-V4.1-Flash"].cost).toEqual({
			input: 0.3,
			output: 1.2,
			cacheRead: 0.006,
			cacheWrite: 0,
		});
		expect(byId["deepseek-ai/DeepSeek-V3.1"].cost).toEqual({
			input: 0.6,
			output: 1.25,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	test("an unreadable pricing block keeps the bundled card", async () => {
		const models =
			(await togetherModelManagerOptions({
				apiKey: "together-test-key",
				fetch: rosterFetch([{ id: "deepseek-ai/DeepSeek-V4.1-Flash", type: "chat", pricing: { input: "n/a" } }]),
			}).fetchDynamicModels?.()) ?? [];

		expect(models[0].cost).toEqual({ input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 });
		expect(getModelPricingStatus(models[0])).toBe("fixed");
	});
});
