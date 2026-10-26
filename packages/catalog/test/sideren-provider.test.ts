import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import {
	isCredentialScopedModelCacheProvider,
	resolveModelCacheProviderId,
} from "@oh-my-pi/pi-catalog/provider-models/cache-provider-id";
import { siderenModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { TempDir } from "@oh-my-pi/pi-utils";

// Row shape of Sideren's key-protected `/v1/models` (verified 2026-10-26).
function row(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		object: "model",
		owned_by: "sideren",
		context_window: 272_000,
		max_output: 384_000,
		capabilities: {
			tools: true,
			vision: true,
			reasoning: true,
			reasoning_efforts: ["none", "low", "medium", "high", "xhigh", "max"],
		},
		sideren: {
			kind: "chat",
			display_name: "DeepSeek V4.1 Flash 1017",
			access: { allowed: true, required_plan: null },
		},
		...overrides,
	};
}

describe("Sideren model discovery", () => {
	test("lists only chat rows the key's plan can call", async () => {
		const options = siderenModelManagerOptions({
			apiKey: "sdn_test_key",
			fetch: async () =>
				Response.json({
					data: [
						row("@sdn/deepseek-v4.1-flash-1017"),
						row("sonnet-5.5", { sideren: { kind: "chat", access: { allowed: false, required_plan: "max" } } }),
						row("@sdn/embed-small", { sideren: { kind: "embedding", access: { allowed: true } } }),
					],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["@sdn/deepseek-v4.1-flash-1017"]);
	});

	test("reads limits, modalities, tools and the advertised effort vocabulary off the row", async () => {
		const options = siderenModelManagerOptions({
			apiKey: "sdn_test_key",
			fetch: async () => Response.json({ data: [row("@sdn/deepseek-v4.1-flash-1017")] }),
		});
		const [discovered] = (await options.fetchDynamicModels?.()) ?? [];
		const model = buildModel(discovered!);
		expect(model).toMatchObject({
			name: "DeepSeek V4.1 Flash 1017",
			contextWindow: 272_000,
			maxTokens: 384_000,
			input: ["text", "image"],
			supportsTools: true,
			reasoning: true,
			pricingStatus: "included",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			thinking: { efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] },
		});
		expect(model.compat?.reasoningDisableMode).toBe("none-effort");
	});

	test("keeps the dialect off switch when a row advertises no none tier", async () => {
		const options = siderenModelManagerOptions({
			apiKey: "sdn_test_key",
			fetch: async () =>
				Response.json({
					data: [
						row("@sdn/glm-5.3", {
							context_window: 1_000_000,
							max_output: 128_000,
							capabilities: {
								tools: true,
								vision: false,
								reasoning: true,
								reasoning_efforts: ["low", "medium", "high", "max"],
							},
							sideren: { kind: "chat", display_name: "GLM 5.3", access: { allowed: true } },
						}),
					],
				}),
		});
		const [discovered] = (await options.fetchDynamicModels?.()) ?? [];
		const model = buildModel(discovered!);
		expect(model).toMatchObject({ name: "GLM 5.3", input: ["text"], pricingStatus: "included", reasoning: true });
		expect(model.compat?.reasoningDisableMode).toBe("lowest-effort");
	});

	test("keeps Sideren's 272K GPT-5.4 window over the class-wide 1M patch", async () => {
		const seed = seedModels("sideren").find(model => model.id === "gpt-5.4");
		expect(buildModel(seed!).contextWindow).toBe(272_000);

		const options = siderenModelManagerOptions({
			apiKey: "sdn_test_key",
			fetch: async () =>
				Response.json({
					data: [
						row("gpt-5.4", {
							max_output: 128_000,
							sideren: { kind: "chat", display_name: "GPT-5.4", access: { allowed: true } },
						}),
					],
				}),
		});
		const [discovered] = (await options.fetchDynamicModels?.()) ?? [];
		expect(buildModel(discovered!).contextWindow).toBe(272_000);
	});

	test("clears the reference ladder when a row reports no usable effort", async () => {
		const options = siderenModelManagerOptions({
			apiKey: "sdn_test_key",
			fetch: async () =>
				Response.json({
					data: [
						row("@sdn/glm-5.3", {
							capabilities: { tools: true, vision: false, reasoning: true, reasoning_efforts: ["none"] },
							sideren: { kind: "chat", display_name: "GLM 5.3", access: { allowed: true } },
						}),
					],
				}),
		});
		const [discovered] = (await options.fetchDynamicModels?.()) ?? [];
		const model = buildModel(discovered!);
		expect(model.thinking).toBeUndefined();
		expect(model.compat?.trustExplicitThinkingOnly).toBe(true);
		expect(model.compat?.reasoningDisableMode).toBe("none-effort");
	});

	test("keeps a live capability downgrade over the seed row", async () => {
		await using temp = await TempDir.create("@sideren-downgrade-");
		const options = {
			...siderenModelManagerOptions({
				apiKey: "sdn_test_key",
				fetch: async () =>
					Response.json({
						data: [
							row("@sdn/deepseek-v4.1-flash-1017", {
								capabilities: { tools: true, vision: false, reasoning: false, reasoning_efforts: [] },
							}),
						],
					}),
			}),
			cacheDbPath: temp.join("models.db"),
		};
		const { models } = await resolveProviderModels(options, "online");
		expect(models.find(model => model.id === "@sdn/deepseek-v4.1-flash-1017")).toMatchObject({
			input: ["text"],
			reasoning: false,
		});
	});

	test("scopes the model cache to the key", () => {
		expect(isCredentialScopedModelCacheProvider("sideren")).toBe(true);
		const first = resolveModelCacheProviderId("sideren", { apiKey: "sdn_a" });
		expect(first).not.toBe(resolveModelCacheProviderId("sideren", { apiKey: "sdn_b" }));
		expect(siderenModelManagerOptions({ apiKey: "sdn_a" }).cacheProviderId).toBe(first);
	});

	test("serves the bundled seed without a key and keeps the live roster through an outage", async () => {
		expect(siderenModelManagerOptions().fetchDynamicModels).toBeUndefined();
		expect(seedModels("sideren").map(model => model.id)).toContain("@sdn/deepseek-v4.1-flash-1017");

		await using temp = await TempDir.create("@sideren-roster-");
		let unavailable = false;
		const options = {
			...siderenModelManagerOptions({
				apiKey: "sdn_test_key",
				fetch: async () =>
					unavailable ? new Response(null, { status: 503 }) : Response.json({ data: [row("@sdn/glm-5.3")] }),
			}),
			cacheDbPath: temp.join("models.db"),
		};
		const online = await resolveProviderModels(options, "online");
		expect(online.models.map(model => model.id)).toEqual(["@sdn/glm-5.3"]);

		unavailable = true;
		const fallback = await resolveProviderModels(options, "online");
		expect(fallback.models.map(model => model.id)).toEqual(["@sdn/glm-5.3"]);
	});
});
