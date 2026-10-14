import type { Api, Model } from "../types";

export type TargetNode = { type: "target"; model: string };

export interface CompiledRoute {
	generation: number;
	id: string;
	root: TargetNode;
}

type ResolveModel = (modelId: string) => Model<Api> | undefined;

/**
 * Wave A compiled-route shim: wrap a model resolver so a known model is one
 * {@link TargetNode} at a frozen generation. Unknown ids stay undefined
 * (gateway 404). No YAML loader, no nested nodes.
 */
export class RouteRegistry {
	#generation = 1;
	#resolveModel: ResolveModel;
	#models = new WeakMap<CompiledRoute, Model<Api>>();

	constructor(resolveModel: ResolveModel) {
		this.#resolveModel = resolveModel;
	}

	get generation(): number {
		return this.#generation;
	}

	/** The resolved target snapshot stays private rather than entering route JSON. */
	getModel(route: CompiledRoute): Model<Api> | undefined {
		return this.#models.get(route);
	}

	resolve(modelId: string): CompiledRoute | undefined {
		const model = this.#resolveModel(modelId);
		if (!model) return undefined;
		// Preserve provider-qualified ids (`openai/gpt-5`) as the compiled target.
		const target = `${model.provider}/${model.id}`;
		const route: CompiledRoute = {
			generation: this.#generation,
			id: modelId,
			root: { type: "target", model: target },
		};
		this.#models.set(route, model);
		return route;
	}
}
