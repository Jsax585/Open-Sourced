import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { vercelAiGatewayModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

function mockModelsList(data: unknown[]): typeof fetch {
	return (async () =>
		Response.json({
			object: "list",
			data,
		})) as unknown as typeof fetch;
}

function byId<T extends { id: string }>(models: readonly T[] | null | undefined): Map<string, T> {
	return new Map((models ?? []).map(model => [model.id, model]));
}

describe("Vercel AI Gateway provider", () => {
	test("caps meta/muse-spark-1.2-contributor output allowance to 131072 while preserving context window", async () => {
		// Vercel currently reports both context_window and max_tokens as 1M for the
		// contributor model, which makes Anthropic messages requests fail with 400
		// when prompt + max_tokens exceeds the shared context window. The mapper
		// must cap the output allowance while leaving the context window intact.
		const contributorId = "meta/muse-spark-1.2-contributor";
		const controlId = "anthropic/claude-sonnet-4-5-20250929";
		const options = vercelAiGatewayModelManagerOptions({
			fetch: mockModelsList([
				{
					id: contributorId,
					object: "model",
					owned_by: "meta",
					tags: ["tool-use", "reasoning", "vision"],
					context_window: 1_048_576,
					max_tokens: 1_048_576,
					pricing: { input: 0.0000001, output: 0.0000002 },
				},
				{
					id: controlId,
					object: "model",
					owned_by: "anthropic",
					tags: ["tool-use", "reasoning"],
					context_window: 200_000,
					max_tokens: 8192,
					pricing: { input: 0.000003, output: 0.000015 },
				},
			]),
		});

		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const map = byId(models);

		const contributor = map.get(contributorId);
		expect(contributor).toBeDefined();
		expect(contributor?.contextWindow).toBe(1_048_576);
		expect(contributor?.maxTokens).toBe(131_072);

		const control = map.get(controlId);
		expect(control).toBeDefined();
		expect(control?.contextWindow).toBe(200_000);
		expect(control?.maxTokens).toBe(8192);
	});

	test("strips a trailing /v1 from custom eval base URLs so the route does not double-prefix", async () => {
		const options = vercelAiGatewayModelManagerOptions({
			baseUrl: "https://proxy.example/v1",
			fetch: mockModelsList([{ id: "typesafe-ai/jev", type: "evaluation" }]),
		});
		const models = await options.fetchDynamicModels?.();
		const jev = byId(models).get("typesafe-ai/jev");
		expect(jev?.baseUrl).toBe("https://proxy.example");
	});

	test("maps type:evaluation rows to api typesafe kind judge beside chat rows", async () => {
		const chatId = "anthropic/claude-sonnet-4-5-20250929";
		const jevId = "typesafe-ai/jev";
		const options = vercelAiGatewayModelManagerOptions({
			fetch: mockModelsList([
				{
					id: chatId,
					name: "Claude Sonnet 4.5",
					object: "model",
					owned_by: "anthropic",
					tags: ["tool-use"],
					context_window: 200_000,
					max_tokens: 8192,
					pricing: { input: 0.000003, output: 0.000015 },
				},
				{
					id: jevId,
					name: "Jev",
					object: "model",
					owned_by: "typesafe-ai",
					type: "evaluation",
					context_window: 32_000,
					pricing: { input: 0.000000042, output: 0 },
				},
			]),
		});

		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const map = byId(models);

		const chat = map.get(chatId);
		expect(chat?.api).toBe("anthropic-messages");
		expect(chat?.kind ?? "chat").toBe("chat");

		const jev = map.get(jevId);
		expect(jev).toBeDefined();
		expect(jev?.api).toBe("typesafe");
		expect(jev?.kind).toBe("judge");
		expect(jev?.name).toBe("Jev");
		expect(jev?.reasoning).toBe(false);
		expect(jev?.input).toEqual(["text"]);
		expect(jev?.supportsTools).toBe(false);
		expect(jev?.cost?.input).toBeCloseTo(0.042, 9);
		expect(jev?.cost?.output).toBe(0);
		expect(jev?.contextWindow).toBe(32_000);
		// The mapper carries no judgment: the vercel-ai-gateway KDL default
		// supplies the /v1/evaluate wire contract through buildModel.
		expect(jev).not.toHaveProperty("judgment");
		// The judgment defaults must survive discovery → buildModel so ChainJudge routes at /v1/evaluate.
		if (!jev) throw new Error("expected the jev evaluation row");
		expect(buildModel(jev).judgment).toEqual({
			route: "/v1/evaluate",
			typeMap: { noul: "boolean" },
			valueMap: { noul: "probability" },
			usageMap: { input: "inputTokens", output: "outputTokens" },
		});
		// Spec (user modelOverrides merged pre-rebuild) replaces catalog keys shallowly.
		expect(buildModel({ ...jev, judgment: { route: "/v1/custom", typeMap: { score: "number" } } }).judgment).toEqual({
			route: "/v1/custom",
			typeMap: { score: "number" },
			valueMap: { noul: "probability" },
			usageMap: { input: "inputTokens", output: "outputTokens" },
		});
	});

	test("chat filter drops non-tool-use rows while keeping evaluation rows", async () => {
		const chatId = "anthropic/claude-sonnet-4-5-20250929";
		const droppedChatId = "anthropic/claude-haiku-4-5-20251001";
		const jevId = "typesafe-ai/jev";
		const options = vercelAiGatewayModelManagerOptions({
			fetch: mockModelsList([
				{
					id: chatId,
					object: "model",
					owned_by: "anthropic",
					tags: ["tool-use"],
					context_window: 200_000,
					max_tokens: 8192,
					pricing: { input: 0.000003, output: 0.000015 },
				},
				{
					id: droppedChatId,
					object: "model",
					owned_by: "anthropic",
					tags: ["reasoning"],
					context_window: 200_000,
					max_tokens: 8192,
					pricing: { input: 0.000001, output: 0.000005 },
				},
				{
					id: jevId,
					object: "model",
					owned_by: "typesafe-ai",
					type: "evaluation",
					context_window: 32_000,
					pricing: { input: 0.000000042, output: 0 },
				},
			]),
		});

		const models = await options.fetchDynamicModels?.();
		const map = byId(models);
		expect(map.get(chatId)).toBeDefined();
		expect(map.get(droppedChatId)).toBeUndefined();
		expect(map.get(jevId)).toBeDefined();
	});

	test("detects image capability on evaluation rows via modalities.input or vision tag", async () => {
		const options = vercelAiGatewayModelManagerOptions({
			fetch: mockModelsList([
				{
					id: "typesafe-ai/modal-jev",
					object: "model",
					type: "evaluation",
					modalities: { input: ["text", "image"] },
				},
				{
					id: "typesafe-ai/tagged-jev",
					object: "model",
					type: "evaluation",
					tags: ["vision"],
				},
				{
					id: "typesafe-ai/plain-jev",
					object: "model",
					type: "evaluation",
				},
			]),
		});

		const models = await options.fetchDynamicModels?.();
		const map = byId(models);
		expect(map.get("typesafe-ai/modal-jev")?.input).toEqual(["text", "image"]);
		expect(map.get("typesafe-ai/tagged-jev")?.input).toEqual(["text", "image"]);
		expect(map.get("typesafe-ai/plain-jev")?.input).toEqual(["text"]);
	});
	test("registers dropCachedModelIdsOnStaticMismatch for seeded eval models", () => {
		const options = vercelAiGatewayModelManagerOptions();
		expect(options.dropCachedModelIdsOnStaticMismatch).toEqual([
			"typesafe-ai/jev",
			"microsoft/microsoft-decision-1",
			"liquid/d1",
			"openai/gpt-6-luna-decisions",
		]);
	});

	test("bundled seed resolves with kind judge and KDL judgment contract", () => {
		const seededIds = [
			"typesafe-ai/jev",
			"microsoft/microsoft-decision-1",
			"liquid/d1",
			"openai/gpt-6-luna-decisions",
		];
		const seeds = seedModels("vercel-ai-gateway");
		expect(seeds.length).toBeGreaterThanOrEqual(seededIds.length);
		for (const id of seededIds) {
			const seed = seeds.find(model => model.id === id);
			expect(seed).toBeDefined();
			if (!seed) continue;
			const built = buildModel(seed);
			expect(built.kind).toBe("judge");
			expect(built.api).toBe("typesafe");
			expect(built.supportsTools).toBe(false);
			expect(built.judgment).toEqual({
				route: "/v1/evaluate",
				typeMap: { noul: "boolean" },
				valueMap: { noul: "probability" },
				usageMap: { input: "inputTokens", output: "outputTokens" },
			});
		}
	});

	test("seeded id is replaced cleanly by live discovery row (explicitKindModels replace, not dup)", async () => {
		const seeds = seedModels("vercel-ai-gateway").map(seed => buildModel(seed));
		const jevSeed = seeds.find(model => model.id === "typesafe-ai/jev");
		expect(jevSeed).toBeDefined();

		const options = vercelAiGatewayModelManagerOptions({
			fetch: mockModelsList([
				{
					id: "typesafe-ai/jev",
					name: "Jev (Discovered)",
					object: "model",
					owned_by: "typesafe-ai",
					type: "evaluation",
					context_window: 64_000,
					pricing: { input: 0.00000005, output: 0 },
				},
			]),
		});

		const result = await resolveProviderModels(
			{
				...options,
				staticModels: seeds,
				cacheDbPath: ":memory:",
			},
			"online",
		);

		const jevRows = result.models.filter(model => model.id === "typesafe-ai/jev");
		expect(jevRows).toHaveLength(1);
		const jev = jevRows[0];
		expect(jev?.name).toBe("Jev (Discovered)");
		expect(jev?.kind).toBe("judge");
		expect(jev?.contextWindow).toBe(64_000);
		expect(jev?.cost?.input).toBeCloseTo(0.05, 9);
		expect(jev?.judgment).toEqual({
			route: "/v1/evaluate",
			typeMap: { noul: "boolean" },
			valueMap: { noul: "probability" },
			usageMap: { input: "inputTokens", output: "outputTokens" },
		});
	});
});
