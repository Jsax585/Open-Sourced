import { isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { GatewayErrorDisposition } from "../error/gateway";
import type { RouteDefinition, RouteNode } from "./route-graph";

const GATEWAY_ERROR_DISPOSITIONS = {
	cancelled: true,
	context_overflow: true,
	credential_permanent: true,
	credential_quota: true,
	credential_transient: true,
	gateway_terminal: true,
	model_unavailable: true,
	policy_terminal: true,
	provider_transient: true,
	provider_unavailable: true,
	request_terminal: true,
} as const satisfies Record<GatewayErrorDisposition, true>;

const MAX_ROUTE_NODE_DEPTH = 256;

function parseDisposition(value: unknown): GatewayErrorDisposition {
	if (typeof value !== "string" || !Object.hasOwn(GATEWAY_ERROR_DISPOSITIONS, value)) {
		throw new AIError.ValidationError(`Unknown gateway error disposition: ${String(value)}`);
	}
	return value as GatewayErrorDisposition;
}

function parseNode(input: unknown, ancestors = new Set<object>(), depth = 0): RouteNode {
	if (!isRecord(input)) {
		throw new AIError.ValidationError("Route node must be an object");
	}
	if (ancestors.has(input)) throw new AIError.ValidationError("Route tree contains a structural cycle");
	if (depth > MAX_ROUTE_NODE_DEPTH)
		throw new AIError.ValidationError(`Route tree exceeds the maximum depth of ${MAX_ROUTE_NODE_DEPTH}`);
	ancestors.add(input);
	try {
		const type = input.type;
		if (type === "target") {
			if (typeof input.model !== "string" || input.model.trim().length === 0) {
				throw new AIError.ValidationError("Target node missing model");
			}
			if (
				input.weight !== undefined &&
				(typeof input.weight !== "number" || !Number.isFinite(input.weight) || input.weight <= 0)
			)
				throw new AIError.ValidationError("Target weight must be positive and finite");
			return {
				type: "target",
				model: input.model,
				...(input.weight !== undefined ? { weight: input.weight as number } : {}),
			};
		}
		if (type === "fallback") {
			if (!Array.isArray(input.on)) {
				throw new AIError.ValidationError("Fallback node missing on dispositions");
			}
			if (!Array.isArray(input.children) || input.children.length === 0) {
				throw new AIError.ValidationError("Fallback node has empty children");
			}
			const on = input.on.map(parseDisposition);
			const children = input.children.map(child => parseNode(child, ancestors, depth + 1));
			return { type: "fallback", on, children };
		}
		if (type === "route-ref") {
			if (typeof input.route !== "string" || !input.route.trim())
				throw new AIError.ValidationError("Route-ref node missing route");
			return { type, route: input.route };
		}
		if (type === "balance" || type === "conditional" || type === "domain") {
			if (!Array.isArray(input.children) || !input.children.length)
				throw new AIError.ValidationError("Route node has empty children");
			const children = input.children.map(child => parseNode(child, ancestors, depth + 1));
			if (type === "balance") {
				if (input.strategy !== "rr" && input.strategy !== "weighted")
					throw new AIError.ValidationError("Unknown balance strategy");
				return { type, strategy: input.strategy, children };
			}
			if (type === "domain") {
				if (typeof input.name !== "string" || !input.name.trim())
					throw new AIError.ValidationError("Domain node missing name");
				return { type, name: input.name, children };
			}
			if (children.length > 2)
				throw new AIError.ValidationError("Conditional routes accept a matching branch and optional alternative");
			if (!isRecord(input.when) || (input.when.vision !== undefined && typeof input.when.vision !== "boolean"))
				throw new AIError.ValidationError("Conditional node requires a boolean when.vision predicate");
			return {
				type,
				when: input.when.vision === undefined ? {} : { vision: input.when.vision as boolean },
				children,
			};
		}
		throw new AIError.ValidationError(`Unknown route node type: ${String(type)}`);
	} finally {
		ancestors.delete(input);
	}
}

/** Validate a single definition before an atomic registry replacement. */
export function parseRouteDefinition(input: unknown): RouteDefinition {
	if (!isRecord(input)) {
		throw new AIError.ValidationError("Route definition must be an object");
	}
	if (typeof input.id !== "string" || input.id.trim().length === 0 || input.id === "." || input.id === "..") {
		throw new AIError.ValidationError("Route definition missing id");
	}
	if (!("root" in input)) {
		throw new AIError.ValidationError("Route definition missing root");
	}
	return { id: input.id, root: parseNode(input.root) };
}

/**
 * Parse virtual route definitions from a JSON/JSON5 document body.
 * Accepts `{ routes: RouteDefinition[] }` or `RouteDefinition[]`.
 * Rejects structural cycles, excessive nesting and duplicate route IDs.
 * Does not detect model-id cycles — {@link RouteRegistry.register} does.
 */
export function parseRouteDefinitions(input: unknown): RouteDefinition[] {
	const entries = Array.isArray(input)
		? input
		: isRecord(input) && Array.isArray(input.routes)
			? input.routes
			: undefined;
	if (!entries)
		throw new AIError.ValidationError("Route definitions must be an array or an object with a routes array");
	const routes = entries.map(parseRouteDefinition);
	const ids = new Set<string>();
	for (const route of routes) {
		if (ids.has(route.id)) throw new AIError.ValidationError(`Duplicate route id: ${route.id}`);
		ids.add(route.id);
	}
	return routes;
}

/**
 * Read UTF-8 JSON5 from `path` and parse it as route definitions.
 * Missing files and JSON5 syntax errors become {@link AIError.ValidationError}.
 */
export async function loadRouteDefinitionsFile(path: string): Promise<RouteDefinition[]> {
	let text: string;
	try {
		text = await Bun.file(path).text();
	} catch (error) {
		if (isEnoent(error)) {
			throw new AIError.ValidationError(`Route definitions file not found: ${path}`, { cause: error });
		}
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = Bun.JSON5.parse(text);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new AIError.ValidationError(`Invalid JSON5 in route definitions file ${path}: ${detail}`, {
			cause: error,
		});
	}
	return parseRouteDefinitions(parsed);
}
