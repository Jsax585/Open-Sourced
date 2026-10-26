/**
 * Approval for the per-call `model` selector on task items, eval `agent()` and
 * `workpool()`.
 *
 * A model-facing selector may only pick a chat model the operator already
 * routes to: a configured chat role's value, the selected agent's own
 * frontmatter model (only when that agent is bundled or user-level), or the
 * parent's live model. Catalog membership, credentials, built-in role
 * defaults, project agent frontmatter, other agents' frontmatter and saved
 * transcripts grant nothing. `task.perCallModelAllow`, when set, narrows the
 * result to the models its exact, `@role` or glob entries match. Under
 * `task.perCallModelFallbacks: runtime` a running worker may also send to
 * concrete `retry.fallbackChains` entries; those are never requestable.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { factoryDroidServerSideFallbackModels } from "@oh-my-pi/pi-ai/providers/factory-droid";
import { MAX_THINKING_SUFFIX_OPTIONS, splitThinkingSuffix } from "@oh-my-pi/pi-tui/overlays/model-selector";
import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";
import type { ModelRegistry } from "../config/model-registry";
import {
	filterAvailableModelsByEnabledPatterns,
	formatModelStringWithRouting,
	normalizeModelPatternList,
	resolveExplicitModelRole,
	resolveModelOverride,
} from "../config/model-resolver";
import { isKindRole } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { cfgRetryFallbackChains } from "../session/settings";
import { cfgTaskDisabledAgents, cfgTaskPerCallModelAllow, cfgTaskPerCallModelFallbacks } from "./settings";

/** A per-call model was rejected: not approved by the operator's configuration. */
export class PerCallModelError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PerCallModelError";
	}
}

/**
 * Inputs that grant per-call models; nothing here is persisted as a grant. `settings` is read live,
 * so a configuration change applies to the next request; the agent and parent fields are captured
 * when the child spawns (or is revived).
 */
export interface PerCallModelGrants {
	settings: Settings;
	agentName: string;
	agentSource?: AgentSource;
	/** The selected agent's frontmatter `model`. */
	agentModel?: string | string[];
	/** The selected agent is no longer discovered (cold revival): its frontmatter grants nothing. */
	agentRemoved?: boolean;
	/** The parent session's live model, as `provider/model-id` plus any `@upstream` pin. */
	parentModelPattern?: string;
}

type ApprovalRegistry = Pick<ModelRegistry, "getAvailable">;

/**
 * The one model an exact entry names: a literal catalog id wins over a `:level`
 * split, and an `@upstream` pin stays part of the identity. Undefined when the
 * entry is not an exact selector for an available chat model.
 */
function exactIdentity(entry: string, chat: Model<Api>[]): string | undefined {
	const model = resolveModelOverride([entry], { getAvailable: () => chat }, undefined, { exactOnly: true }).model;
	return model ? formatModelStringWithRouting(model) : undefined;
}

/** Skip aliases: a configured role's value is a grant of its own, and an unconfigured role would only route through built-in defaults. */
function grantablePatterns(source: string | string[] | undefined, settings: Settings): string[] {
	return normalizeModelPatternList(source).filter(pattern => {
		const bare = pattern.toLowerCase();
		return bare !== "default" && bare !== "inherit" && resolveExplicitModelRole(pattern, settings) === undefined;
	});
}

/**
 * Operator-configured selectors that grant a per-call model. Role aliases are
 * skipped rather than expanded: a configured role's value is a grant of its
 * own, and an unconfigured role would only route through built-in defaults.
 */
export function perCallModelGrantPatterns(grants: PerCallModelGrants): string[] {
	const settings = grants.settings.rootSettings();
	const { agentName } = grants;
	const trustedAgent =
		(grants.agentSource === "bundled" || grants.agentSource === "user") &&
		!grants.agentRemoved &&
		!cfgTaskDisabledAgents.get(settings).includes(agentName);
	const sources = [
		...Object.entries(settings.getModelRoles())
			.filter(([role]) => !isKindRole(role))
			.map(([, value]) => value),
		trustedAgent ? grants.agentModel : undefined,
		grants.parentModelPattern,
	];
	return [...new Set(sources.flatMap(source => grantablePatterns(source, settings)))];
}

/**
 * Whether `pattern` approves the routed identity `target`: an exact selector names
 * one model; otherwise every match of a glob, or the one model a selector resolves to.
 */
function patternApproves(pattern: string, target: string, chat: Model<Api>[], settings: Settings): boolean {
	// An exact selector names one model; brackets in real ids (`glm-5.2[1m]`) never act as a glob.
	const exact = exactIdentity(pattern, chat);
	if (exact !== undefined) return exact === target;
	if (/[*?[]/.test(pattern)) {
		return filterAvailableModelsByEnabledPatterns(chat, [pattern], settings).some(
			granted => formatModelStringWithRouting(granted) === target,
		);
	}
	const resolved = resolveModelOverride([pattern], { getAvailable: () => chat }, settings).model;
	return resolved !== undefined && formatModelStringWithRouting(resolved) === target;
}

/**
 * Whether an allowlist pattern admits `target`. The allowlist only narrows, so
 * a provider-qualified glob (`openai/*`) matches the full `provider/id`, never
 * another provider's model whose bare id happens to match (`openrouter/openai/gpt-5`).
 */
function allowPatternAdmits(pattern: string, target: string, chat: Model<Api>[], settings: Settings): boolean {
	const exact = exactIdentity(pattern, chat);
	if (exact !== undefined) return exact === target;
	const base = splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS).base;
	if (base.includes("/") && /[*?[]/.test(base)) {
		return new Bun.Glob(base.toLowerCase()).match(target.toLowerCase());
	}
	return patternApproves(pattern, target, chat, settings);
}

/**
 * Whether `task.perCallModelAllow` admits `target`. An exact or glob entry
 * matches the model directly; a `@role` entry matches what its configured value grants.
 */
function allowlistAdmits(target: string, chat: Model<Api>[], settings: Settings): boolean {
	const allow = cfgTaskPerCallModelAllow.get(settings);
	if (allow.length === 0) return true;
	return allow.some(entry => {
		const selector = entry.trim();
		const role = resolveExplicitModelRole(selector, settings);
		if (role === undefined) return selector.length > 0 && allowPatternAdmits(selector, target, chat, settings);
		if (isKindRole(role)) return false;
		return grantablePatterns(settings.getModelRole(role), settings).some(pattern =>
			allowPatternAdmits(pattern, target, chat, settings),
		);
	});
}

/** Whether the operator's configuration names `model` itself (see {@link isPerCallModelApproved}). */
function isGranted(model: Model<Api>, grants: PerCallModelGrants, chat: Model<Api>[]): boolean {
	const settings = grants.settings.rootSettings();
	const target = formatModelStringWithRouting(model);
	if (!chat.some(candidate => candidate.provider === model.provider && candidate.id === model.id)) return false;
	if (!allowlistAdmits(target, chat, settings)) return false;
	return perCallModelGrantPatterns(grants).some(pattern => patternApproves(pattern, target, chat, settings));
}

/**
 * Whether a running worker may switch to `model` as a runtime fallback: under
 * `task.perCallModelFallbacks: runtime`, a concrete `retry.fallbackChains`
 * entry names its routed identity and the allowlist admits it. Read from the
 * operator's settings, never the subagent overlay that installs its own chain.
 */
function isRuntimeFallback(model: Model<Api>, grants: PerCallModelGrants, chat: Model<Api>[]): boolean {
	const settings = grants.settings.rootSettings();
	if (cfgTaskPerCallModelFallbacks.get(settings) !== "runtime") return false;
	const target = formatModelStringWithRouting(model);
	if (!chat.some(candidate => candidate.provider === model.provider && candidate.id === model.id)) return false;
	if (!allowlistAdmits(target, chat, settings)) return false;
	return grantablePatterns(concreteChainEntries(settings), settings).some(pattern =>
		patternApproves(pattern, target, chat, settings),
	);
}

/**
 * Server-side fallback targets of `model` that are not themselves approved. Factory Droid
 * sends Fable's refusal chain on the Anthropic upstream unconditionally, so the model
 * is approved only while every model it may switch to is. `runtime` also accepts a target
 * a running worker could reach as a runtime fallback.
 */
function unapprovedServerSideFallbacks(
	model: Model<Api>,
	grants: PerCallModelGrants,
	chat: Model<Api>[],
	runtime = false,
): string[] {
	if (model.api !== "factory-droid-agent") return [];
	return factoryDroidServerSideFallbackModels(model as Model<"factory-droid-agent">)
		.map(id => `${model.provider}/${id}`)
		.filter(selector => {
			const fallback = chat.find(candidate => `${candidate.provider}/${candidate.id}` === selector);
			if (!fallback) return true;
			return !isGranted(fallback, grants, chat) && !(runtime && isRuntimeFallback(fallback, grants, chat));
		});
}

/**
 * Whether `model` is one the operator routes to under the current configuration.
 * Identities are exact: an `@upstream`-pinned route and the unpinned model are
 * different models here, in either direction, and an entry that is itself a
 * catalog id (even one ending in a level-shaped segment) names only that id.
 */
export function isPerCallModelApproved(
	model: Model<Api>,
	grants: PerCallModelGrants,
	registry: ApprovalRegistry,
): boolean {
	// Subagents run chat models only; a grant naming an image, search, speech or judge model does not count.
	const chat = registry.getAvailable("chat");
	return isGranted(model, grants, chat) && unapprovedServerSideFallbacks(model, grants, chat).length === 0;
}

/** Throw {@link PerCallModelError} unless `model` is approved. */
export function assertPerCallModelApproved(
	model: Model<Api>,
	grants: PerCallModelGrants,
	registry: ApprovalRegistry,
): void {
	const chat = registry.getAvailable("chat");
	if (isGranted(model, grants, chat)) {
		const fallbacks = unapprovedServerSideFallbacks(model, grants, chat);
		if (fallbacks.length === 0) return;
		throw new PerCallModelError(
			`Per-call model ${formatModelStringWithRouting(model)} is not approved for agent "${grants.agentName}": its provider always attaches a server-side fallback to ${fallbacks.join(", ")}, which is not approved. Approve the fallback model too, or use a model without one.`,
		);
	}
	const allowGuidance =
		cfgTaskPerCallModelAllow.get(grants.settings.rootSettings()).length > 0
			? " It must also match an entry in task.perCallModelAllow."
			: "";
	throw new PerCallModelError(
		`Per-call model ${formatModelStringWithRouting(model)} is not approved for agent "${grants.agentName}": use a model named by a configured chat role, the selected agent's own frontmatter (bundled or user-level agents only), or the parent's model.${allowGuidance} Catalog or credentials alone do not approve a model.`,
	);
}

/** Concrete `retry.fallbackChains` entries; wildcard entries are relative provider swaps, not models the operator named. */
function concreteChainEntries(settings: Settings): string[] {
	return Object.entries(cfgRetryFallbackChains.get(settings))
		.filter(([key]) => !isKindRole(key))
		.flatMap(([, chain]) => (Array.isArray(chain) ? chain.filter(entry => !entry.includes("*")) : []));
}

/**
 * Throw {@link PerCallModelError} unless a running per-call worker may send to
 * `model`: an approved model, or under `task.perCallModelFallbacks: runtime` a
 * concrete `retry.fallbackChains` entry the allowlist admits. Either way a Factory
 * Droid model is refused while a server-side fallback target it always sends is not
 * itself reachable.
 */
export function assertPerCallDispatchModel(
	model: Model<Api>,
	grants: PerCallModelGrants,
	registry: ApprovalRegistry,
): void {
	const settings = grants.settings.rootSettings();
	const runtime = cfgTaskPerCallModelFallbacks.get(settings) === "runtime";
	if (!runtime) {
		try {
			assertPerCallModelApproved(model, grants, registry);
		} catch (error) {
			if (!(error instanceof PerCallModelError)) throw error;
			throw new PerCallModelError(`${error.message} Runtime fallbacks need task.perCallModelFallbacks: runtime.`);
		}
		return;
	}
	const chat = registry.getAvailable("chat");
	const target = formatModelStringWithRouting(model);
	if (isGranted(model, grants, chat) || isRuntimeFallback(model, grants, chat)) {
		const fallbacks = unapprovedServerSideFallbacks(model, grants, chat, true);
		if (fallbacks.length === 0) return;
		throw new PerCallModelError(
			`Per-call subagent "${grants.agentName}" cannot send to ${target}: its provider always attaches a server-side fallback to ${fallbacks.join(", ")}, which is not approved and not a configured runtime fallback.`,
		);
	}
	const allowGuidance =
		cfgTaskPerCallModelAllow.get(settings).length > 0
			? ", and it must also match an entry in task.perCallModelAllow"
			: "";
	throw new PerCallModelError(
		`Per-call subagent "${grants.agentName}" cannot send to ${target}: the model is not approved and not a concrete retry.fallbackChains entry${allowGuidance}.`,
	);
}
