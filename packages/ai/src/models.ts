import { enrichModelThinking } from "./model-thinking";
import MODELS from "./models.json" with { type: "json" };
import type { Api, KnownProvider, Model, Usage } from "./types";

/**
 * Static bundled model registry loaded from `models.json`.
 *
 * This module intentionally exposes compile-time defaults only.
 * It does not include runtime discovery, models.dev overlays, or on-disk cache state.
 *
 * For runtime-aware resolution, use `createModelManager()` / `resolveProviderModels()`.
 */
const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, enrichModelThinking(model as Model<Api>));
	}
	modelRegistry.set(provider, providerModels);
}

export type GeneratedProvider = keyof typeof MODELS;

export function getBundledModel<TApi extends Api = Api>(
	provider: GeneratedProvider | (string & {}),
	modelId: string,
): Model<TApi> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId) as Model<TApi>;
}

export function getBundledProviders(): string[] {
	return Array.from(modelRegistry.keys());
}

export function getBundledModels(provider: GeneratedProvider | (string & {})): Model<Api>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<Api>[]) : [];
}

/**
 * 1h cache writes bill at 2x input; any remainder `cttl` doesn't attribute bills at the flat 5m rate.
 */
function cacheWriteCost<TApi extends Api>(model: Model<TApi>, usage: Usage): number {
	const rate5m = model.cost.cacheWrite / 1000000;
	const cttl = usage.cttl;
	if (!cttl) return rate5m * usage.cacheWrite;
	const fiveMinute = cttl.ephemeral5m ?? 0;
	const oneHour = cttl.ephemeral1h ?? 0;
	const residual = Math.max(0, usage.cacheWrite - fiveMinute - oneHour);
	return rate5m * (fiveMinute + residual) + ((model.cost.input * 2) / 1000000) * oneHour;
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = cacheWriteCost(model, usage);
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}
/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
