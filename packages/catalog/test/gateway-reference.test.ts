import { describe, expect, test } from "bun:test";
import { buildModel } from "../src/build";
import { Effort } from "../src/effort";
import { getBundledModelReferenceIndex } from "../src/identity/bundled";
import {
	buildModelReferenceIndex,
	getReferenceThinkingEfforts,
	inheritReferenceThinking,
	resolveModelReference,
} from "../src/identity/reference";
import type { ModelSpec, ThinkingConfig } from "../src/types";

function referenceModel(id: string) {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "catalog-reference",
		baseUrl: "https://upstream.example/v1",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.High, Effort.Max] },
		input: ["text", "image"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 393_216,
	});
}

describe("Bundled model references", () => {
	test("excludes providers isolated from cross-provider bare-id enrichment", () => {
		const reference = resolveModelReference("glm-5.3-flash", getBundledModelReferenceIndex());

		expect(reference).toBeDefined();
		expect(reference?.provider).not.toBe("cline-pass");
	});

	test("resolves namespace tails and the reviewed dated logical alias", () => {
		const canonical = referenceModel("deepseek/deepseek-v4.1-flash-1017");
		const exactTail = referenceModel("gpt-5.4");
		const index = buildModelReferenceIndex([canonical, exactTail]);

		expect(resolveModelReference("org/team/gpt-5.4", index)).toBe(exactTail);
		expect(resolveModelReference("nku/deepseek-v4-1-flash-261017", index)).toBe(canonical);
		expect(resolveModelReference("org/team/deepseek-v4-1-flash-261017", index)).toBe(canonical);
	});

	test("keeps exact full-id and tail matches ahead of logical alias recovery", () => {
		const canonical = referenceModel("deepseek/deepseek-v4.1-flash-1017");
		const exactFull = referenceModel("nku/deepseek-v4-1-flash-261017");
		const exactTail = referenceModel("deepseek-v4-1-flash-261017");
		const index = buildModelReferenceIndex([canonical, exactFull, exactTail]);

		expect(resolveModelReference(exactFull.id, index)).toBe(exactFull);
		expect(resolveModelReference("other/deepseek-v4-1-flash-261017", index)).toBe(exactTail);
	});

	test("does not guess unreviewed dates, generations, or opaque gateway ids", () => {
		const index = buildModelReferenceIndex([referenceModel("deepseek/deepseek-v4.1-flash-1017")]);
		for (const id of [
			"nku/deepseek-v4-1-flash-261018",
			"nku/deepseek-v4.1-flash-1018",
			"nku/deepseek-v4-2-flash-261017",
			"@nku/deepseek-v4-1-flash-261017",
			"opaque-deployment-261017",
		]) {
			expect(resolveModelReference(id, index), id).toBeUndefined();
		}
	});
});

describe("Portkey gateway model references", () => {
	test("@modal ids do not fuzzy-match bundled catalog entries", () => {
		const index = getBundledModelReferenceIndex();
		expect(resolveModelReference("@modal/GLM-5-2-FP8", index)).toBeUndefined();
	});

	test("strips compiled discovery and collapse markers for proxy recovery", () => {
		const index = getBundledModelReferenceIndex();
		for (const id of [
			"claude-opus-4-6-fp8",
			"claude-opus-4-6-search",
			"claude-opus-4-6-thinking",
			"claude-opus-4-6-free",
		]) {
			expect(resolveModelReference(id, index)?.id).toBe("claude-opus-4-6");
		}
	});

	test("cross-provider references do not inherit wire routing thinking", () => {
		const index = getBundledModelReferenceIndex();
		const kiloGigaPotato = resolveModelReference("giga-potato", index);
		expect(kiloGigaPotato?.provider).toBe("kilo");
		expect(kiloGigaPotato?.thinking?.effortRouting).toBeDefined();
		expect(inheritReferenceThinking(undefined, kiloGigaPotato, "gateway")).toBeUndefined();
		expect(getReferenceThinkingEfforts(kiloGigaPotato, "gateway", "openai-completions")).toBeUndefined();
	});
});

describe("Reference thinking inheritance", () => {
	test("borrows only the pure effort array for compatible cross-provider transports", () => {
		const reference = {
			provider: "upstream",
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.High, Effort.Max],
				defaultLevel: Effort.High,
				requiresEffort: true,
			} satisfies ThinkingConfig,
		};
		for (const api of [
			"openai-completions",
			"openai-responses",
			"openai-codex-responses",
			"azure-openai-responses",
		] as const) {
			expect(getReferenceThinkingEfforts(reference, "gateway", api)).toBe(reference.thinking.efforts);
		}
		for (const api of ["anthropic-messages", "google-generative-ai", "bedrock-converse-stream"] as const) {
			expect(getReferenceThinkingEfforts(reference, "gateway", api)).toBeUndefined();
		}
	});

	test("rejects routed, remapped, budgeted, adaptive, and transport-bound thinking", () => {
		const effort: ThinkingConfig = { mode: "effort", efforts: [Effort.Low, Effort.High] };
		const unsafe: ThinkingConfig[] = [
			{ ...effort, mode: "budget" },
			{ ...effort, mode: "anthropic-adaptive" },
			{ ...effort, mode: "anthropic-budget-effort" },
			{ ...effort, mode: "google-level" },
			{ ...effort, effortRouting: { high: "upstream-high" } },
			{ ...effort, effortMap: { high: "enabled" } },
			{ ...effort, effortBudgets: { high: 16_384 } },
			{ ...effort, supportsDisplay: true },
			{ ...effort, prefixBinding: true },
			{ ...effort, suppressWhenOff: true },
			{ ...effort, unverified: true },
		];
		for (const thinking of unsafe) {
			expect(
				getReferenceThinkingEfforts({ provider: "upstream", thinking }, "gateway", "openai-completions"),
			).toBeUndefined();
		}
	});

	test("preserves explicit caller thinking and same-provider wire metadata", () => {
		const thinking: ThinkingConfig = {
			mode: "effort",
			efforts: [Effort.High],
			effortRouting: { high: "upstream-high" },
		};
		const reference = { provider: "upstream", thinking };
		const explicit: ThinkingConfig = { mode: "budget", efforts: [Effort.Low] };

		expect(inheritReferenceThinking(explicit, reference, "gateway")).toBe(explicit);
		expect(inheritReferenceThinking(undefined, reference, "upstream")).toBe(thinking);
		expect(getReferenceThinkingEfforts(reference, "upstream", "openai-completions")).toBeUndefined();
	});
});

describe("Reference thinking fallback policy", () => {
	const spec = {
		id: "unclassified-reference-target",
		name: "Reference target",
		api: "openai-completions",
		provider: "target-provider",
		baseUrl: "https://target.example/v1",
		reasoning: true,
		referenceThinkingEfforts: [Effort.Low, Effort.High, Effort.Max],
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 32_768,
	} satisfies ModelSpec<"openai-completions">;

	test("fills only a missing target effort ladder and drops source-only metadata", () => {
		const model = buildModel(spec);
		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.High, Effort.Max],
		});
		expect(Object.hasOwn(model, "referenceThinkingEfforts")).toBe(false);
	});

	test("keeps reviewed target efforts above the reference but explicit thinking above both", () => {
		const target = {
			...spec,
			id: "deepseek/deepseek-v4-pro",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
		};
		expect(buildModel(target).thinking?.efforts).toEqual([Effort.High]);

		const explicit: ThinkingConfig = {
			mode: "effort",
			efforts: [Effort.Low, Effort.High, Effort.Max],
			defaultLevel: Effort.Low,
		};
		expect(buildModel({ ...target, thinking: explicit }).thinking).toMatchObject(explicit);
	});

	test("does not bypass target wire gates or turn a budget target into an effort target", () => {
		expect(buildModel({ ...spec, compat: { trustExplicitThinkingOnly: true } }).thinking).toBeUndefined();
		expect(
			buildModel({
				...spec,
				api: "openai-responses",
				compat: { supportsReasoningEffort: false },
			}).thinking,
		).toBeUndefined();
		const budget = buildModel({ ...spec, api: "anthropic-messages" });
		expect(budget.thinking?.mode).toBe("budget");
		expect(budget.thinking?.efforts).not.toContain(Effort.Max);
	});
});

describe("Vercel AI Gateway cache compat", () => {
	test("resolves Chat Completions caching controls only for the Vercel endpoint", () => {
		const model = buildModel({
			id: "anthropic/claude-sonnet-4.6",
			name: "Claude Sonnet 4.6",
			api: "openai-completions",
			provider: "vercel-ai-gateway",
			baseUrl: "https://ai-gateway.vercel.sh/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 16_384,
			compat: {
				vercelGatewayRouting: {
					only: ["anthropic"],
					order: ["anthropic", "bedrock"],
					caching: "auto",
				},
			},
		} satisfies ModelSpec<"openai-completions">);

		expect(model.compat.isVercelGatewayHost).toBe(true);
		expect(model.compat.vercelGatewayRouting).toEqual({
			only: ["anthropic"],
			order: ["anthropic", "bedrock"],
			caching: "auto",
		});
	});
});

test("resolves Responses cache controls only for the Vercel endpoint", () => {
	const routing = { caching: "auto" as const, cacheAnchorItems: 1, cacheTtl: "1h" as const };
	const vercel = buildModel({
		id: "anthropic/claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "openai-responses",
		provider: "vercel-ai-gateway",
		baseUrl: "https://ai-gateway.vercel.sh/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		compat: { vercelGatewayRouting: routing },
	} satisfies ModelSpec<"openai-responses">);
	const direct = buildModel({
		id: "anthropic/claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "openai-responses",
		provider: "custom",
		baseUrl: "https://api.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		compat: { vercelGatewayRouting: routing },
	} satisfies ModelSpec<"openai-responses">);

	expect(vercel.compat.isVercelGatewayHost).toBe(true);
	expect(vercel.compat.vercelGatewayRouting).toEqual(routing);
	expect(direct.compat.isVercelGatewayHost).toBe(false);
});
