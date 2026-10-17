import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { type } from "@oh-my-pi/omptype";
import { Effort, THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import {
	clampThinkingLevelForModel,
	defaultSupportedEffort,
	getSupportedEfforts,
	mapEffortToAnthropicAdaptiveEffort,
	mapEffortToGoogleThinkingLevel,
	resolveWireModelId,
} from "@oh-my-pi/pi-catalog/model-thinking";
import type { Model, SimpleStreamOptions } from "./types";
import { supportsModelPolicyEffort } from "./api-registry";
import { ANTHROPIC_THINKING, GOOGLE_THINKING } from "./thinking-budgets";

export type ModelPolicyEffort = Effort | "off";
export interface ModelPolicy {
	id: string;
	allowedEfforts(model: Model): readonly ModelPolicyEffort[];
	/** Optional ascending preference; finite values only. Admission never depends on rank. */
	rank?(model: Model, effort: ModelPolicyEffort): number;
}
export interface ModelPolicyCandidate {
	model: Model;
	effort: ModelPolicyEffort;
}
export class ModelPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelPolicyError";
	}
}
const active = new AsyncLocalStorage<ModelPolicyScope>();
const sessions = new Map<string, WeakRef<ModelPolicyScope>>();
// Retain only an id tombstone after a protected session is collected; stale options must not reopen admission.
const protectedSessions = new Set<string>();
const collectedSessions = new FinalizationRegistry<string>(sessionId => {
	if (!sessions.get(sessionId)?.deref() && !protectedSessions.has(sessionId)) sessions.delete(sessionId);
});
const owners = new WeakMap<object, ModelPolicyScope | null>();
const OFF = ["off"] as const;
export class ModelPolicyScope {
	readonly policies = new Map<string, ModelPolicy>();
	readonly required = new Set<string>();
	failure: string | undefined;
	constructor(readonly parent = active.getStore()) {}
	get enabled(): boolean {
		return !!(this.failure || this.required.size || this.policies.size || this.parent?.enabled);
	}
	register(policy: ModelPolicy): void {
		if (
			!policy ||
			typeof policy.id !== "string" ||
			!policy.id.trim() ||
			typeof policy.allowedEfforts !== "function" ||
			(policy.rank !== undefined && typeof policy.rank !== "function")
		) {
			this.failure = "Invalid model policy registration";
			throw new ModelPolicyError(this.failure);
		}
		if (this.policies.has(policy.id)) {
			this.failure = `Duplicate model policy: ${policy.id}`;
			throw new ModelPolicyError(this.failure);
		}
		this.policies.set(policy.id, policy);
	}
	assertReady(): void {
		this.parent?.assertReady();
		if (this.failure) throw new ModelPolicyError(this.failure);
		for (const id of this.required)
			if (!this.policies.has(id)) throw new ModelPolicyError(`Required model policy not registered: ${id}`);
	}
}
export function withModelPolicyScope<T>(scope: ModelPolicyScope | undefined, fn: () => T): T {
	return scope ? active.run(scope, fn) : fn();
}
export function bindModelPolicyScope(owner: object, scope: ModelPolicyScope, sessionId?: string): void {
	const prior = owners.get(owner);
	owners.set(
		owner,
		prior === null || (prior !== undefined && prior !== scope && (prior.enabled || scope.enabled)) ? null : scope,
	);
	if (sessionId) {
		sessions.set(sessionId, new WeakRef(scope));
		if (scope.enabled) protectedSessions.add(sessionId);
		collectedSessions.register(scope, sessionId);
	}
}
export function getModelPolicyScope(owner?: object, sessionId?: string): ModelPolicyScope | undefined {
	const contextual = active.getStore();
	const session = sessionId ? sessions.get(sessionId)?.deref() : undefined;
	if (sessionId && !session && protectedSessions.has(sessionId))
		throw new ModelPolicyError("Model policy session is no longer available");
	if (sessionId && session?.enabled) protectedSessions.add(sessionId);
	// Session hosts supply both owner and id; raw transports cannot escape an active scope by changing an id.
	if (owner && session) return session;
	if (session && contextual) {
		for (let ancestor: ModelPolicyScope | undefined = session; ancestor; ancestor = ancestor.parent) {
			if (ancestor === contextual) return session;
		}
	}
	if (contextual || session) return contextual ?? session;
	const owned = owner && owners.get(owner);
	if (owned === null) throw new ModelPolicyError("Shared policy owner requires an explicit session scope");
	return owned || undefined;
}
export function nativeModelEfforts(model: Model): readonly ModelPolicyEffort[] {
	const efforts = getSupportedEfforts(model);
	if (!supportsModelPolicyEffort(model.api)) return [];
	if (model.reasoning === false) return OFF;
	if (model.reasoning !== true) return [];
	if (!model.thinking || !efforts.length) return [];
	if (
		(model.api === "openai-completions" ||
			model.api === "openai-responses" ||
			model.api === "openrouter" ||
			model.api === "azure-openai-responses") &&
		!(model.compat && "supportsReasoningParams" in model.compat && model.compat.supportsReasoningParams === true)
	) {
		const routes = model.thinking.effortRouting;
		if (!routes) return [];
		const routed = efforts.filter(effort => routes[effort] !== undefined);
		return routes.off !== undefined && (!model.thinking.requiresEffort || model.thinking.suppressWhenOff)
			? ["off", ...routed]
			: routed;
	}
	return model.thinking.requiresEffort && !model.thinking.suppressWhenOff ? efforts : ["off", ...efforts];
}
export function effectiveModelEffort(model: Model, requested?: ModelPolicyEffort): ModelPolicyEffort {
	if (!model.reasoning) return "off";
	if (requested && requested !== "off") return clampThinkingLevelForModel(model, requested) ?? "off";
	return model.thinking?.requiresEffort && !model.thinking.suppressWhenOff
		? (defaultSupportedEffort(model) ?? "off")
		: "off";
}
export function allowedModelEfforts(model: Model, scope = getModelPolicyScope()): readonly ModelPolicyEffort[] {
	const native = nativeModelEfforts(model);
	if (!scope?.enabled) return native;
	scope.assertReady();
	let allowed = scope.parent ? allowedModelEfforts(model, scope.parent) : native;
	for (const policy of scope.policies.values()) {
		let result: readonly ModelPolicyEffort[];
		try {
			result = policy.allowedEfforts(model);
		} catch {
			throw new ModelPolicyError(`Model policy ${policy.id} failed`);
		}
		if (!Array.isArray(result) || result.some(value => value !== "off" && !THINKING_EFFORTS.includes(value)))
			throw new ModelPolicyError(`Model policy ${policy.id} returned invalid efforts`);
		allowed = allowed.filter(effort => result.includes(effort));
	}
	return allowed;
}
export function getModelPolicyCandidates(
	models: readonly Model[],
	requested?: ModelPolicyEffort,
	scope = getModelPolicyScope(),
): ModelPolicyCandidate[] {
	const candidates: ModelPolicyCandidate[] = [];
	if (scope?.enabled) scope.assertReady();
	for (const model of models) {
		const allowed = allowedModelEfforts(model, scope);
		const preferred = effectiveModelEffort(model, requested);
		if (requested !== undefined && allowed.includes(preferred)) candidates.push({ model, effort: preferred });
		else for (const effort of allowed) candidates.push({ model, effort });
	}
	if (scope?.enabled) {
		const rank = (candidate: ModelPolicyCandidate): number => {
			let total = 0;
			for (let current: ModelPolicyScope | undefined = scope; current; current = current.parent) {
				for (const policy of current.policies.values())
					if (policy.rank) {
						let value: number;
						try {
							value = policy.rank(candidate.model, candidate.effort);
						} catch {
							throw new ModelPolicyError(`Model policy ${policy.id} rank failed`);
						}
						if (!Number.isFinite(value))
							throw new ModelPolicyError(`Model policy ${policy.id} returned invalid rank`);
						total += value;
					}
			}
			return total;
		};
		const ranked = candidates.map(candidate => ({ candidate, rank: rank(candidate) }));
		ranked.sort((a, b) => a.rank - b.rank);
		return ranked.map(row => row.candidate);
	}
	return candidates;
}
export function assertModelPolicyAdmission(
	model: Model,
	effort: ModelPolicyEffort,
	scope = getModelPolicyScope(),
): void {
	if (!scope?.enabled) return;
	if (!allowedModelEfforts(model, scope).includes(effort))
		throw new ModelPolicyError(`Model policy denied ${model.provider}/${model.id}:${effort}`);
}
export function applyModelPolicyOptions(model: Model, options?: SimpleStreamOptions): SimpleStreamOptions | undefined {
	const scope = getModelPolicyScope(undefined, options?.sessionId);
	if (!scope?.enabled) return options;
	const requested = options?.disableReasoning || options?.forceReasoningOff ? "off" : (options?.reasoning ?? "off");
	if (requested !== "off" && !THINKING_EFFORTS.includes(requested))
		throw new ModelPolicyError("Unsupported model policy effort");
	const effective = effectiveModelEffort(model, requested);
	const allowed = allowedModelEfforts(model, scope);
	const effort = allowed.includes(effective)
		? effective
		: getModelPolicyCandidates([model], undefined, scope)[0]?.effort;
	if (effort === undefined) throw new ModelPolicyError(`Model policy denied ${model.provider}/${model.id}`);
	return {
		...options,
		reasoning: effort === "off" ? undefined : effort,
		disableReasoning: effort === "off",
		forceReasoningOff: effort === "off",
	};
}

// Only the core mapper can attest a raw provider option's effective normalized effort.
const mappedEffort = Symbol("modelPolicyEffort");
const MODEL_POLICY_CONTROL_KEYS = [
	"reasoning",
	"effort",
	"thinkingEnabled",
	"thinkingBudgetTokens",
	"thinking",
	"thinkingBudgets",
	"disableReasoning",
	"forceReasoningOff",
	"requestModelId",
] as const;
export function attestModelPolicyOptions<T extends object>(options: T, model: Model, simple?: SimpleStreamOptions): T {
	if (!getModelPolicyScope(undefined, simple?.sessionId)?.enabled) return options;
	const raw = options as Record<string | symbol, unknown>;
	const effort = effectiveModelEffort(
		model,
		simple?.disableReasoning || simple?.forceReasoningOff ? "off" : simple?.reasoning,
	);
	Object.defineProperty(options, mappedEffort, {
		value: { effort, controls: structuredClone(MODEL_POLICY_CONTROL_KEYS.map(key => raw[key])) },
		enumerable: true,
	});
	return options;
}
export function assertRawModelPolicyAdmission(model: Model, options?: object): void {
	const raw = options as Record<string | symbol, unknown> | undefined;
	const scope = getModelPolicyScope(undefined, typeof raw?.sessionId === "string" ? raw.sessionId : undefined);
	if (!scope?.enabled) return;
	const attestation = raw?.[mappedEffort] as { effort: ModelPolicyEffort; controls: unknown[] } | undefined;
	if (
		attestation &&
		!isDeepStrictEqual(
			attestation.controls,
			MODEL_POLICY_CONTROL_KEYS.map(key => raw?.[key]),
		)
	)
		throw new ModelPolicyError("Raw thinking options changed after model policy normalization");
	let effort: unknown = attestation?.effort;
	if (effort === undefined) {
		if (raw?.thinkingEnabled === false || raw?.disableReasoning || raw?.forceReasoningOff) effort = "off";
		else if (typeof raw?.reasoning === "string") effort = raw.reasoning;
		else if (typeof raw?.effort === "string" && model.thinking?.mode === "anthropic-adaptive") effort = raw.effort;
		else if (!model.reasoning) effort = "off";
		else throw new ModelPolicyError(`Unverifiable raw thinking effort for ${model.provider}/${model.id}`);
	}
	if (effort !== "off" && !THINKING_EFFORTS.includes(effort as Effort))
		throw new ModelPolicyError("Unsupported raw model policy effort");
	assertModelPolicyAdmission(model, effort as ModelPolicyEffort, scope);
}

const OpenAIModelPolicyPayload = type({
	model: "string",
	"reasoning_effort?": "string | null",
	"reasoning?": { "effort?": "string", "enabled?": "boolean", "mode?": "string" },
	"thinking?": { "type?": "string", "effort?": "string" },
	"enable_thinking?": "boolean",
	"chat_template_kwargs?": { "reasoning_effort?": "string", "enable_thinking?": "boolean", "thinking?": "boolean" },
});

/** Final OpenAI-family wire admission, after compatibility shaping, native retries, and payload hooks. */
export function assertOpenAIModelPolicyRequest(
	model: Model,
	payload: object,
	options: object | undefined,
	expectedModel: unknown,
): void {
	const raw = options as Record<string | symbol, unknown> | undefined;
	const scope = getModelPolicyScope(undefined, typeof raw?.sessionId === "string" ? raw.sessionId : undefined);
	if (!scope?.enabled) return;
	assertRawModelPolicyAdmission(model, options);
	const body = OpenAIModelPolicyPayload.assert(payload);
	if (body.model !== expectedModel) throw new ModelPolicyError("Payload changed the admitted model identity");
	const attestation = raw?.[mappedEffort] as { effort: ModelPolicyEffort } | undefined;
	const effort =
		attestation?.effort ??
		((raw?.disableReasoning || raw?.forceReasoningOff || !model.reasoning
			? "off"
			: raw?.reasoning) as ModelPolicyEffort);
	const wireEffort =
		body.reasoning_effort ??
		body.reasoning?.effort ??
		body.thinking?.effort ??
		body.chat_template_kwargs?.reasoning_effort;
	if (
		(body.reasoning_effort !== undefined && body.reasoning_effort !== wireEffort) ||
		(body.reasoning?.effort !== undefined && body.reasoning.effort !== wireEffort) ||
		(body.thinking?.effort !== undefined && body.thinking.effort !== wireEffort) ||
		(body.chat_template_kwargs?.reasoning_effort !== undefined &&
			body.chat_template_kwargs.reasoning_effort !== wireEffort)
	) {
		throw new ModelPolicyError("Payload contains conflicting reasoning efforts");
	}
	const enabled =
		body.reasoning?.enabled === true ||
		body.thinking?.type === "enabled" ||
		body.enable_thinking === true ||
		body.chat_template_kwargs?.enable_thinking === true ||
		body.chat_template_kwargs?.thinking === true;
	const disabled =
		body.reasoning?.enabled === false ||
		body.thinking?.type === "disabled" ||
		body.enable_thinking === false ||
		body.chat_template_kwargs?.enable_thinking === false ||
		body.chat_template_kwargs?.thinking === false;
	if (effort === "off") {
		const routedOff = model.thinking?.effortRouting?.off !== undefined;
		if (
			enabled ||
			(wireEffort !== undefined && wireEffort !== "none" && wireEffort !== "off") ||
			(model.reasoning && wireEffort === undefined && !disabled && !routedOff)
		)
			throw new ModelPolicyError("Payload enabled reasoning for an admitted reasoning-off request");
	} else {
		const compat = model.compat as { reasoningEffortMap?: Partial<Record<Effort, string>> };
		const expected = compat.reasoningEffortMap?.[effort] ?? model.thinking?.effortMap?.[effort] ?? effort;
		const routed = wireEffort === undefined && model.thinking?.effortRouting?.[effort] !== undefined;
		if (disabled || expected === "none" || expected === "off" || (!routed && wireEffort !== expected))
			throw new ModelPolicyError("Payload omitted or changed the admitted reasoning effort");
		if (model.reasoningMode && body.reasoning?.mode !== model.reasoningMode)
			throw new ModelPolicyError("Payload changed the admitted reasoning mode");
	}
	assertModelPolicyAdmission(model, effort, scope);
}

const AnthropicModelPolicyPayload = type({
	model: "string",
	"thinking?": { type: "string", "budget_tokens?": "number" },
	"output_config?": { "effort?": "string" },
	"messages?": type({ "role?": "string", "clear_at?": "string", "output_config?": { "effort?": "string" } }).array(),
	"fallbacks?": "unknown[]",
});

/** Admit the effective final Anthropic effort, including per-message effort transitions. */
export function assertAnthropicModelPolicyRequest(model: Model, payload: object, options: object | undefined): void {
	const raw = options as Record<string | symbol, unknown> | undefined;
	const scope = getModelPolicyScope(undefined, typeof raw?.sessionId === "string" ? raw.sessionId : undefined);
	if (!scope?.enabled) return;
	assertRawModelPolicyAdmission(model, options);
	const effort =
		(raw?.[mappedEffort] as { effort: ModelPolicyEffort } | undefined)?.effort ??
		((raw?.thinkingEnabled === false || raw?.disableReasoning || raw?.forceReasoningOff || !model.reasoning
			? "off"
			: (raw?.reasoning ?? raw?.effort)) as ModelPolicyEffort);
	const body = AnthropicModelPolicyPayload.assert(payload);
	if (body.fallbacks?.length) throw new ModelPolicyError("Unverifiable native fallback under model policy");
	if (body.model !== resolveWireModelId(model, effort === "off" ? undefined : effort))
		throw new ModelPolicyError("Payload changed the admitted model identity");
	let wireEffort = body.output_config?.effort;
	for (const message of body.messages ?? []) {
		if (message.output_config?.effort === undefined) continue;
		if (message.role !== "system" || (message.clear_at !== undefined && message.clear_at !== "never"))
			throw new ModelPolicyError("Unverifiable per-message reasoning effort");
		wireEffort = message.output_config.effort;
	}
	if (effort === "off") {
		if (
			(body.thinking !== undefined && body.thinking.type !== "disabled") ||
			wireEffort !== undefined ||
			(model.reasoning &&
				body.thinking?.type !== "disabled" &&
				!(model.compat && "disabledThinking" in model.compat && model.compat.disabledThinking === "omit"))
		) {
			throw new ModelPolicyError("Payload enabled reasoning for an admitted reasoning-off request");
		}
	} else {
		const expected = mapEffortToAnthropicAdaptiveEffort(model, effort);
		const budgetMode = model.thinking?.mode === "budget" || model.thinking?.mode === "anthropic-budget-effort";
		if (budgetMode) {
			if (
				body.thinking?.type !== "enabled" ||
				body.thinking.budget_tokens !== ANTHROPIC_THINKING[effort] ||
				(model.thinking?.mode === "anthropic-budget-effort" && wireEffort !== expected) ||
				(model.thinking?.mode === "budget" && wireEffort !== undefined)
			) {
				throw new ModelPolicyError("Payload omitted or changed the admitted reasoning effort");
			}
		} else if (
			body.thinking?.type !== "adaptive" ||
			body.thinking.budget_tokens !== undefined ||
			(expected === "adaptive" ? wireEffort !== undefined : wireEffort !== expected)
		) {
			throw new ModelPolicyError("Payload omitted or changed the admitted reasoning effort");
		}
	}
	assertModelPolicyAdmission(model, effort, scope);
}

const GooglePolicyThinkingConfig = type({
	"thinkingLevel?": "string",
	"thinkingBudget?": "number",
	"includeThoughts?": "boolean",
});
const GoogleModelPolicyPayload = type({
	"model?": "string",
	"generationConfig?": { "thinkingConfig?": GooglePolicyThinkingConfig },
	"request?": { "generationConfig?": { "thinkingConfig?": GooglePolicyThinkingConfig } },
});

/** Admit the final Google wire body; direct Gemini/Vertex identity is carried by the URL model. */
export function assertGoogleModelPolicyRequest(
	model: Model,
	payload: object,
	options: object | undefined,
	requestModel?: string,
): void {
	const raw = options as Record<string | symbol, unknown> | undefined;
	const scope = getModelPolicyScope(undefined, typeof raw?.sessionId === "string" ? raw.sessionId : undefined);
	if (!scope?.enabled) return;
	assertRawModelPolicyAdmission(model, options);
	const effort =
		(raw?.[mappedEffort] as { effort: ModelPolicyEffort } | undefined)?.effort ??
		((raw?.disableReasoning || raw?.forceReasoningOff || !model.reasoning
			? "off"
			: raw?.reasoning) as ModelPolicyEffort);
	const body = GoogleModelPolicyPayload.assert(payload);
	const cli = model.api === "google-gemini-cli";
	const expectedModel = cli ? resolveWireModelId(model, effort === "off" ? undefined : effort) : model.id;
	if (
		(cli ? body.model : requestModel) !== expectedModel ||
		(!cli && body.model !== undefined && body.model !== expectedModel)
	)
		throw new ModelPolicyError("Payload changed the admitted model identity");
	const thinking = (cli ? body.request?.generationConfig : body.generationConfig)?.thinkingConfig;
	if (effort === "off") {
		const suppressionLevel =
			model.thinking?.mode === "google-level" && model.thinking.suppressWhenOff ? "MINIMAL" : undefined;
		const suppressionBudget = suppressionLevel === undefined ? 0 : undefined;
		const routedOff = cli && model.thinking?.effortRouting?.off !== undefined && thinking === undefined;
		if (
			model.reasoning &&
			!routedOff &&
			(thinking === undefined ||
				thinking.includeThoughts !== false ||
				thinking.thinkingLevel !== suppressionLevel ||
				thinking.thinkingBudget !== suppressionBudget)
		) {
			throw new ModelPolicyError("Payload enabled reasoning for an admitted reasoning-off request");
		}
		if (
			!model.reasoning &&
			thinking !== undefined &&
			(thinking.thinkingLevel !== undefined || (thinking.thinkingBudget ?? 0) !== 0)
		)
			throw new ModelPolicyError("Payload enabled reasoning for an admitted reasoning-off request");
	} else {
		const expectedLevel =
			model.thinking?.mode === "google-level" ? mapEffortToGoogleThinkingLevel(effort, model) : undefined;
		const expectedBudget =
			expectedLevel === undefined
				? (model.thinking?.effortBudgets?.[effort] ?? (cli ? GOOGLE_THINKING[effort] : undefined))
				: undefined;
		if (
			!thinking ||
			thinking.thinkingLevel !== expectedLevel ||
			thinking.thinkingBudget !== expectedBudget ||
			(expectedLevel === undefined && (expectedBudget === undefined || expectedBudget <= 0))
		) {
			throw new ModelPolicyError("Payload omitted or changed the admitted reasoning effort");
		}
	}
	assertModelPolicyAdmission(model, effort, scope);
}
