/**
 * Proxy/reseller reference lookup: given a custom model id served through a
 * proxy (`[Kiro] claude-opus-4-8`, `gpt-5.4:cloud`, `vendor/claude-sonnet-4-6-thinking`),
 * find the bundled upstream model so missing pricing/capability metadata can be
 * inherited while keeping the custom transport.
 *
 * Kept separate from canonical-id resolution (`./equivalence`): this lookup
 * may strip `search`-style markers and prefers cache-pricing-complete
 * references, both of which would be wrong for canonical coalescing.
 */
import { classifyModel, collapseVocabulary, discoveryVocabulary } from "../compat/taxonomy";
import type { Effort } from "../effort";
import type { Api, Model, ThinkingConfig } from "../types";
import { getBracketStrippedModelIdCandidates, getLongestModelLikeIdSegment, getModelLikeIdSegments } from "./id";
export interface ModelReferenceIndex {
	exact: Map<string, Model<Api>>;
	suffixAlias: Map<string, Model<Api>>;
}

const REFERENCE_MARKER_SUFFIXES = (() => {
	const discovery = discoveryVocabulary();
	const suffixes: string[] = [];
	for (const marker of discovery.trailingMarkers) {
		suffixes.push(`-${marker}`, `:${marker}`);
	}
	for (const marker of discovery.referenceOnlyTrailingMarkers) {
		suffixes.push(`-${marker}`, `:${marker}`);
	}
	return suffixes;
})();

// xai-oauth subscription entries carry zero public pricing and inflated maxTokens;
// keep them provider-local so they cannot outrank paid/public Grok references.
export function isZeroCostXaiOAuthReference(candidate: Model<Api>): boolean {
	return (
		candidate.provider === "xai-oauth" &&
		candidate.cost.input === 0 &&
		candidate.cost.output === 0 &&
		candidate.cost.cacheRead === 0 &&
		candidate.cost.cacheWrite === 0
	);
}

// Prefer the reference with the largest limits and complete cache pricing, then
// first-party OpenAI entries.
function shouldReplaceReference(existing: Model<Api> | undefined, candidate: Model<Api>): boolean {
	if (!existing) return true;
	if (candidate.contextWindow !== existing.contextWindow) {
		return (candidate.contextWindow ?? 0) > (existing.contextWindow ?? 0);
	}
	if (candidate.maxTokens !== existing.maxTokens) {
		return (candidate.maxTokens ?? 0) > (existing.maxTokens ?? 0);
	}
	const existingHasCachePricing = existing.cost.cacheRead > 0 || existing.cost.cacheWrite > 0;
	const candidateHasCachePricing = candidate.cost.cacheRead > 0 || candidate.cost.cacheWrite > 0;
	if (candidateHasCachePricing !== existingHasCachePricing) {
		return candidateHasCachePricing;
	}
	return existing.provider !== "openai" && candidate.provider === "openai";
}

function normalizeReferenceKey(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * Build a reference index from a model catalog (typically the bundled models).
 * Pure: callers are responsible for memoizing the result.
 */
export function buildModelReferenceIndex(models: Iterable<Model<Api>>): ModelReferenceIndex {
	const exact = new Map<string, Model<Api>>();
	for (const candidate of models) {
		if (isZeroCostXaiOAuthReference(candidate)) {
			continue;
		}
		const key = normalizeReferenceKey(candidate.id);
		if (shouldReplaceReference(exact.get(key), candidate)) {
			exact.set(key, candidate);
		}
	}
	return { exact, suffixAlias: buildSuffixAliasMap(exact) };
}

function buildSuffixAliasMap(exactReferences: ReadonlyMap<string, Model<Api>>): Map<string, Model<Api>> {
	const aliases = new Map<string, Model<Api>>();
	for (const reference of exactReferences.values()) {
		const slashIndex = reference.id.lastIndexOf("/");
		if (slashIndex === -1) {
			continue;
		}
		const suffix = reference.id.slice(slashIndex + 1);
		const alias = getLongestModelLikeIdSegment(suffix);
		if (!alias) {
			continue;
		}
		if (shouldReplaceReference(aliases.get(alias), reference)) {
			aliases.set(alias, reference);
		}
	}
	return aliases;
}

function stripReferenceTrailingMarker(candidate: string): string | undefined {
	const lower = candidate.toLowerCase();
	let suffixLength = 0;
	const discovery = discoveryVocabulary();
	for (const suffix of discovery.billingVariantSuffixes) {
		if (lower.endsWith(suffix) && suffix.length > suffixLength) suffixLength = suffix.length;
	}
	for (const suffix of REFERENCE_MARKER_SUFFIXES) {
		if (lower.endsWith(suffix) && suffix.length > suffixLength) suffixLength = suffix.length;
	}
	const collapse = collapseVocabulary();
	for (const rule of collapse.suffixes) {
		if (lower.endsWith(rule.suffix) && rule.suffix.length > suffixLength) suffixLength = rule.suffix.length;
	}
	for (const rule of collapse.routingVariants) {
		if (lower.endsWith(rule.suffix) && rule.suffix.length > suffixLength) suffixLength = rule.suffix.length;
	}
	return suffixLength > 0 && suffixLength < candidate.length ? candidate.slice(0, -suffixLength) : undefined;
}

/**
 * Expand a proxied/affixed model id into the ids it may be catalogued under,
 * least-stripped first: bracket affixes, model-like segments, `:cloud`,
 * namespace prefix, `:`→`-`, lowercase, and declared trailing markers.
 * Shared by reference recovery and catalog-metric matching (`./metrics`).
 */
export function getReferenceCandidateIds(modelId: string): string[] {
	const candidates = new Set<string>();
	const queue = [modelId];
	for (let index = 0; index < queue.length; index += 1) {
		const candidate = queue[index]?.trim();
		if (!candidate || candidates.has(candidate)) continue;
		candidates.add(candidate);

		for (const stripped of getBracketStrippedModelIdCandidates(candidate)) {
			queue.push(stripped);
		}
		for (const segment of getModelLikeIdSegments(candidate)) {
			queue.push(segment);
		}

		for (const suffix of [":cloud", "-cloud"] as const) {
			if (candidate.toLowerCase().endsWith(suffix)) {
				queue.push(candidate.slice(0, -suffix.length));
			}
		}

		const slashIndex = candidate.lastIndexOf("/");
		if (slashIndex !== -1) {
			queue.push(candidate.slice(slashIndex + 1));
		}

		const colonToDash = candidate.replace(/:/g, "-");
		if (colonToDash !== candidate) {
			queue.push(colonToDash);
		}

		const lowercased = candidate.toLowerCase();
		if (lowercased !== candidate) {
			queue.push(lowercased);
		}

		const strippedMarker = stripReferenceTrailingMarker(candidate);
		if (strippedMarker) {
			queue.push(strippedMarker);
		}
	}
	return [...candidates];
}

/** Explicit caller thinking and same-provider transport metadata are authoritative. */
export function inheritReferenceThinking(
	modelThinking: ThinkingConfig | undefined,
	reference: Pick<Model<Api>, "provider" | "thinking"> | undefined,
	provider: string,
): ThinkingConfig | undefined {
	if (modelThinking !== undefined) return modelThinking;
	if (!reference || reference.provider !== provider) return undefined;
	return reference.thinking;
}

/**
 * A pure cross-provider effort ladder is a policy fallback, never explicit target
 * thinking. Routing, remaps, budgets, and transport controls stay source-local;
 * defaults and mandatory/off behavior are left to the target model's policy.
 */
export function getReferenceThinkingEfforts(
	reference: Pick<Model<Api>, "provider" | "thinking"> | undefined,
	provider: string,
	targetApi: Api,
): readonly Effort[] | undefined {
	if (!reference?.thinking || reference.provider === provider) return undefined;
	const thinking = reference.thinking;
	if (
		targetApi !== "openai-completions" &&
		targetApi !== "openrouter" &&
		targetApi !== "openai-responses" &&
		targetApi !== "openai-codex-responses" &&
		targetApi !== "azure-openai-responses"
	) {
		return undefined;
	}
	if (
		thinking.mode !== "effort" ||
		thinking.efforts.length === 0 ||
		thinking.effortRouting !== undefined ||
		thinking.effortMap !== undefined ||
		thinking.effortBudgets !== undefined ||
		thinking.supportsDisplay !== undefined ||
		thinking.prefixBinding !== undefined ||
		thinking.suppressWhenOff !== undefined ||
		thinking.unverified === true
	) {
		return undefined;
	}
	return thinking.efforts;
}

/** Resolve a (possibly proxied/affixed) model id to its bundled upstream reference. */
export function resolveModelReference(modelId: string, index: ModelReferenceIndex): Model<Api> | undefined {
	// Portkey/gateway wire ids (`@provider/model`) are opaque; fuzzy matching would
	// map them to unrelated bundled entries (e.g. `@modal/GLM-5-2-FP8` → devin/glm-5-2).
	if (modelId.startsWith("@")) return undefined;
	const candidates = getReferenceCandidateIds(modelId);
	for (const candidate of candidates) {
		const key = normalizeReferenceKey(candidate);
		const reference = index.exact.get(key) ?? index.suffixAlias.get(key);
		if (reference) return reference;
	}
	// Reviewed provider-agnostic identity aliases are a last resort, after all
	// existing full-id and slash-tail matches. Classify the original wire id so
	// stripping a marker cannot grant an alias that target policy does not know.
	// Never guess a family or drop a release date: the logical id must itself
	// name an exact catalog reference.
	const logicalId = classifyModel("", modelId, { lenient: true }).logicalId;
	if (!logicalId) return undefined;
	const key = normalizeReferenceKey(logicalId);
	return index.exact.get(key) ?? index.suffixAlias.get(key);
}
