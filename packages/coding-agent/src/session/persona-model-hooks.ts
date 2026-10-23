import type { Api, Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";

import type { AgentSession } from "./agent-session";
import type { DiscoveredAgent, PersonaExplicitOverrides } from "./tool-policy";

export type { PersonaExplicitOverrides };

import { type ModelLookupRegistry, resolveModelOverride } from "../config/model-resolver";
import type { ModelRegistry } from "../config/model-registry";
import { type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

/**
 * Model/thinking apply seam between the persona runtime and the session's
 * model machinery (PR 9510 re-architecture): the runtime calls these hooks
 * instead of touching `AgentSession` model APIs directly, so each host surface
 * (TUI queues, ACP notices) can override the mid-turn channels.
 *
 * Baseline OWNERSHIP note: the runtime captures the pre-apply model/thinking
 * itself and restores it on exit/rollback — a hooks instance's internal
 * baseline does NOT survive exit (callers build fresh hooks objects), so there
 * is no per-instance restore channel.
 */
export interface PersonaModelApplyHooks {
	/**
	 * Apply the agent's model + thinking preference to the session. The runtime
	 * owns the lifecycle baseline.
	 */
	apply(agent: DiscoveredAgent, explicit?: PersonaExplicitOverrides): Promise<void>;

	/**
	 * Defer a mid-turn persona model switch (ACP semantics: notice + skip,
	 * tools/prompt still apply immediately). Absent on the default hooks.
	 */
	deferModelSwitchWhileStreaming?(agent: DiscoveredAgent): void | Promise<void>;

	/**
	 * Defer a mid-turn persona model RESTORE (exit path): the persona teardown
	 * (policy/prompt/spawns/presentation) applies immediately, but reverting the
	 * session model/thinking to the pre-persona baseline must not mutate a live
	 * turn. The RUNTIME passes its own captured baseline (the hook instance that
	 * ran `apply` does not survive to exit); surfaces queue the baseline flush
	 * (TUI: `#pendingModelSwitch` on agent_end) or notice (ACP). Absent on the
	 * default hooks — without it a deferred mid-turn exit skips the model
	 * restore rather than mutating the streaming session.
	 */
	deferModelRestoreWhileStreaming?(baseline: ModelBaseline): void;
	/**
	 * The runtime rolled a persona switch/exits back after the surface's
	 * defer channels ran (queue mutation, notice). Surfaces that queued a
	 * pending model mutation on behalf of the failed transaction clear it
	 * here — otherwise the turn-end flush would apply a model switch
	 * belonging to a switch that no longer exists. Absent on the default
	 * hooks (no queue to clear).
	 */
	onPersonaSwitchFailed?(): void;
	/**
	 * Whether a persona model switch should be deferred right now (e.g. the
	 * session is streaming). Absent on the default hooks.
	 */
	shouldDeferModelSwitch?(): boolean;
	/**
	 * Reads any model switch the SURFACE has queued for its next turn boundary
	 * and drops it (TUI: `#pendingModelSwitch`; ACP: the session-level deferred
	 * slot). A non-deferred (pre-turn) enter calls this in its `apply`: the
	 * queued entry — whether it came from THIS runtime transaction or an
	 * earlier failed flush — predates the new persona and must not land
	 * mid-persona at the next boundary. Absent on surfaces with no queue.
	 */
	getSurfaceDeferredRestore?(): ModelBaseline | undefined;
	/** Drops a queued surface restore without applying it. */
	clearSurfaceDeferredRestore?(): void;
}

/** Effective model + thinking level captured before a persona apply. */
export interface ModelBaseline {
	model: Model | undefined;
	thinkingLevel: ConfiguredThinkingLevel | undefined;
}

/**
 * One discovery-aware resolution attempt: resolve against the catalog as it
 * stands; on a MISS whose provider is a configured discovery provider still
 * pending in this process (cold offline cache), await the background refresh
 * scoped to that provider and re-resolve. Interactive startup begins online
 * model discovery only after init, so a persona's `model:` naming a
 * discovery-backed model otherwise silently stays unresolved for the whole
 * session — the post-discovery rebind refreshes only the CURRENTLY selected
 * model, never the persona selector. Missing registry seams (test stubs,
 * registry flavors without discovery) skip straight to the miss.
 */
export async function resolveWithDiscoveryRetry(
	patterns: string[],
	session: AgentSession,
): Promise<{
	model?: Model<Api>;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
	warning?: string;
}> {
	const registry = session.modelRegistry as ModelLookupRegistry & Partial<ModelRegistry>;
	const resolved = resolveModelOverride(patterns, session.modelRegistry, session.settings);
	if (resolved.model) return resolved;
	// Which providers COULD still supply the selector: a miss whose provider is
	// not even configured for discovery can never resolve — no retry.
	const pending = new Set<string>();
	for (const pattern of patterns) {
		const provider = pattern.trim().split(/[/:@]/)[0]?.toLowerCase();
		if (provider && registry.getDiscoverableProviders?.().includes(provider)) pending.add(provider);
	}
	if (pending.size === 0) return resolved;
	if (typeof registry.refreshDiscoverableProviders !== "function") return resolved;
	await registry.refreshDiscoverableProviders(pending);
	return resolveModelOverride(patterns, session.modelRegistry, session.settings);
}

/**
 * Default hooks bound to one session. Baseline capture reads `session.model`
 * and `session.configuredThinkingLevel()` immediately before any mutation; the
 * runtime owns the restore (it never calls back into this instance).
 */
export function createDefaultPersonaModelHooks(session: AgentSession): PersonaModelApplyHooks {
	return {
		// The session-level deferred slot (ACP/headless carrier): the runtime
		// reads+drops any owed entry on a non-deferred enter through here.
		getSurfaceDeferredRestore: () => session.getDeferredModelRestore?.(),
		clearSurfaceDeferredRestore: () => session.clearDeferredModelRestore?.(),
		async apply(agent: DiscoveredAgent, explicit?: PersonaExplicitOverrides): Promise<void> {
			// j2v: the resolved pattern can carry a THINKING level too (an
			// explicit `:level` suffix on the pattern, or a configured role whose
			// value ends in `:level`). Capture it and adopt it below when the
			// persona's own frontmatter declared none.
			const resolvedThinking: Array<ConfiguredThinkingLevel | undefined> = [];
			const explicitModelPattern = explicit?.model?.trim();
			if (explicitModelPattern) {
				const resolved = await resolveWithDiscoveryRetry([explicitModelPattern], session);
				if (resolved.model) {
					await session.setModel(resolved.model);
					resolvedThinking.push(resolved.thinkingLevel);
				} else {
					logger.warn(
						`Agent persona "${agent.name}": explicit model pattern did not resolve; keeping the session model`,
						{ pattern: explicitModelPattern },
					);
				}
			} else if (agent.model && agent.model.length > 0) {
				const resolved = await resolveWithDiscoveryRetry(agent.model, session);
				if (resolved.model) {
					await session.setModel(resolved.model);
					resolvedThinking.push(resolved.thinkingLevel);
				} else {
					logger.warn(
						`Agent persona "${agent.name}": model frontmatter did not resolve; keeping the session model`,
						{ patterns: agent.model },
					);
				}
			}
			const explicitThinking =
				explicit?.thinking !== undefined ? parseConfiguredThinkingLevel(explicit.thinking) : undefined;
			// fw2QC: a thinking suffix on the EXPLICIT model selector
			// (`--model provider/model:high`) is itself an explicit CLI
			// override — it outranks the persona's frontmatter thinking, same
			// as `--thinking` does.
			const explicitModelThinking = explicitModelPattern ? resolvedThinking[0] : undefined;
			const thinking: ConfiguredThinkingLevel | undefined =
				explicitThinking ??
				explicitModelThinking ??
				(agent.thinkingLevel !== undefined
					? agent.thinkingLevel
					: explicitModelPattern
						? undefined // explicit path already considered above
						: resolvedThinking[0]);
			if (thinking !== undefined) {
				session.setThinkingLevel(thinking);
			}
		},
	};
}

/**
 * Headless (ACP/RPC/print) persona-model hooks: mid-turn switches defer
 * through the session-level deferred slot (flushed at the surface's
 * `agent_end`), with in-band text notices; everything else falls through to
 * the shared default hooks. Without this a mid-turn `/agent` throws instead
 * of deferring — the documented behavior is "tools/prompt now, model at turn
 * end" on every surface.
 */
export function createHeadlessPersonaModelHooks(
	session: AgentSession,
	emitNotice: (text: string) => void | Promise<void>,
): PersonaModelApplyHooks {
	const defaultHooks = createDefaultPersonaModelHooks(session);
	const priorPending = session.getDeferredModelRestore?.();
	const resolveQueuedSelection = async (
		agent: DiscoveredAgent,
	): Promise<{ model: Model | undefined; thinkingLevel?: ConfiguredThinkingLevel } | undefined> => {
		if (!agent.model || agent.model.length === 0) {
			// Thinking-only persona: the flush forwards both halves to
			// setModelTemporary, which applies a thinking-only change without
			// touching the model.
			if (agent.thinkingLevel === undefined) return undefined;
			const current = session.model;
			return current ? { model: current, thinkingLevel: agent.thinkingLevel } : undefined;
		}
		const resolved = await resolveWithDiscoveryRetry(agent.model, session);
		if (!resolved.model) {
			logger.warn(`Agent persona "${agent.name}": model frontmatter did not resolve; keeping the session model`, {
				patterns: agent.model,
			});
			return undefined;
		}
		const queuedThinking =
			agent.thinkingLevel ?? (resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined);
		return { model: resolved.model, thinkingLevel: queuedThinking };
	};
	return {
		...defaultHooks,
		shouldDeferModelSwitch: () => session.isStreaming,
		deferModelSwitchWhileStreaming: async agent => {
			// Chained switches (A active, mid-turn enter of modeled B): the
			// runtime already queued A's pre-persona restore through the exit
			// channel. B's selection must REPLACE it — leaving A's restore queued
			// would apply the pre-A model at agent_end while B runs (and B's
			// model would never land).
			// Thinking-only selections carry the LIVE model, so they keep an
			// already-queued entry's model and only take over the thinking
			// level — replacing wholesale would swap A's owed baseline restore
			// for A's persona model.
			const selection = await resolveQueuedSelection(agent);
			if (selection?.model) {
				const thinkingOnly = !agent.model || agent.model.length === 0;
				const prior = thinkingOnly ? session.getDeferredModelRestore?.() : undefined;
				session.queueDeferredModelRestore?.(
					prior?.model ?? selection.model,
					selection.thinkingLevel ?? prior?.thinkingLevel,
				);
				void emitNotice(
					`Agent "${agent.name}" model switch deferred: mid-turn. Its tools and prompt apply now; the model stays until the turn ends.`,
				);
			}
		},
		deferModelRestoreWhileStreaming: baseline => {
			// Mid-turn persona exit: queue the pre-persona restore on the
			// session; `agent_end` applies it. A thinking-only persona (or an
			// unresolvable baseline model) leaves baseline.model undefined —
			// fall back to the live model so the thinking-level half still
			// restores instead of stranding the persona level.
			const model = baseline.model ?? session.model;
			if (!model) return;
			session.queueDeferredModelRestore?.(model, baseline.thinkingLevel);
			void emitNotice("Agent persona cleared: model restore deferred until the turn ends.");
		},
		// Rollback safety: undo THIS transaction's queue mutation by restoring
		// the transaction-start entry (not blanket-clearing): a failed chained
		// switch rolls the runtime back to A, whose own owed switch (or an
		// earlier successful exit's restore) must survive.
		onPersonaSwitchFailed: () => {
			if (priorPending) session.queueDeferredModelRestore?.(priorPending.model, priorPending.thinkingLevel);
			else session.clearDeferredModelRestore?.();
		},
	};
}
