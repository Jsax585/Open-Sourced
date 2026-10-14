import { logger } from "@oh-my-pi/pi-utils";
import type { Provider } from "../types";
import type { RankingStrategyResolver } from "../usage/registry";
import { credentialBlockScopesForRequest, providerTypeKey } from "./blocks";
import type { CredentialBlocks } from "./blocks";
import type { SessionAffinity } from "./affinity";
import type { CredentialPool } from "./pool";
import { QuotaProbeLeaseBook } from "./probe-lease";
import type { ApiKeySelection } from "./rank";
import { extractOAuthCredentialPhysicalIdentifiers } from "./sqlite-credential-store";
import type { UsageCache } from "./usage-cache";
import type { AuthApiKeyOptions, AuthCredential } from "./types";

/** True only when an identifier present in both snapshots disagrees. A field
 * missing from either side is inconclusive (ordinary metadata loss on reload),
 * never a switch: bumping would purge quota blocks, usage state, and session
 * affinity for an unchanged account. */
function credentialIdentitiesConflict(previous: AuthCredential, next: AuthCredential): boolean {
	if (previous.type !== "oauth" || next.type !== "oauth") return false;
	const oldFields = extractOAuthCredentialPhysicalIdentifiers(previous);
	const newFields = extractOAuthCredentialPhysicalIdentifiers(next);
	return oldFields.some(value => {
		const prefix = value.slice(0, value.indexOf(":") + 1);
		return newFields.some(candidate => candidate.startsWith(prefix) && candidate !== value);
	});
}

export function anonymousProbeRequestKey(credentialId: number, blockScope: string): string {
	return `anon-probe:${credentialId}:${blockScope}`;
}

export interface CredentialCoordinationDeps {
	pool: CredentialPool;
	blocks: CredentialBlocks;
	affinity: SessionAffinity;
	usageCache: UsageCache;
	strategies: RankingStrategyResolver;
	probeLeases: QuotaProbeLeaseBook;
}

/**
 * In-process credential coordination layered over the pool/blocks modules:
 * per-row incarnation counters and single-flight quota-probe leases. All state is in-memory — it exists to
 * keep *concurrent requests in this process* from double-vending one
 * credential row, and to arbitrate which request may probe a blocked
 * credential's quota. Persisted blocks/affinity live in their own modules.
 */
export class CredentialCoordination {
	/** Per-credential generation counter, bumped when a row's physical identity changes. */
	#credentialIncarnation = new Map<number, number>();
	#inflightProbes = new Map<string, { credentialId: number; blockScope: string; leaseId: string }>();
	#probeLeases: QuotaProbeLeaseBook;
	readonly #deps: CredentialCoordinationDeps;

	constructor(deps: CredentialCoordinationDeps) {
		this.#deps = deps;
		this.#probeLeases = deps.probeLeases;
	}

	// ------------------------------------------------------------------
	// Incarnation
	// ------------------------------------------------------------------

	getCredentialIncarnation(credentialId: number): number {
		return this.#credentialIncarnation.get(credentialId) ?? 1;
	}

	/**
	 * Bump the incarnation when a stored row's physical identity changes
	 * (type swap, different API key bytes, or an OAuth identity-field change
	 * that is not a conservative enrichment). Called by the pool whenever a
	 * replace observes a differing credential at the same durable row id.
	 */
	maybeBumpIncarnation(provider: string, credentialId: number, previous: AuthCredential, next: AuthCredential): void {
		if (
			previous.type !== next.type ||
			(previous.type === "api_key" && next.type === "api_key" && previous.key !== next.key)
		) {
			this.#bumpCredentialIncarnation(provider, credentialId);
			return;
		}
		if (!credentialIdentitiesConflict(previous, next)) return;
		this.#bumpCredentialIncarnation(provider, credentialId);
	}

	#bumpCredentialIncarnation(provider: string, credentialId: number): void {
		const incarnation = (this.#credentialIncarnation.get(credentialId) ?? 1) + 1;
		this.#credentialIncarnation.set(credentialId, incarnation);
		this.#deps.affinity.clearCredential(provider, credentialId);
		this.#deps.blocks.clearCredential(provider, credentialId);
		this.#probeLeases.purgeCredential(credentialId);
		for (const [requestId, probe] of this.#inflightProbes) {
			if (probe.credentialId === credentialId) this.#inflightProbes.delete(requestId);
		}
		this.#deps.usageCache.invalidate(provider);
		logger.info("auth-storage credential incarnation bumped after identity change", {
			provider,
			credentialId,
			incarnation,
		});
	}

	/**
	 * {@link CredentialBlocks.blockedUntil} scoped per request. The requestId
	 * parameter is carried for signature stability across the gateway stack;
	 * request-scoped overlays arrive with turn reservations.
	 */
	blockedUntilForRequest(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockScopeOrScopes: string | readonly string[] | undefined = undefined,
		_requestId?: string,
	): number | undefined {
		return this.#deps.blocks.blockedUntil(provider, providerKey, credentialIndex, blockScopeOrScopes);
	}

	isBlockedForRequest(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockScopeOrScopes: string | readonly string[] | undefined = undefined,
		requestId?: string,
	): boolean {
		return (
			this.blockedUntilForRequest(provider, providerKey, credentialIndex, blockScopeOrScopes, requestId) !==
			undefined
		);
	}

	// ------------------------------------------------------------------
	// Quota probe leases
	// ------------------------------------------------------------------

	tryAcquireQuotaProbeLease(credentialId: number, blockScope: string): string | null {
		for (const provider of this.#deps.pool.providers()) {
			const entries = this.#deps.pool.entries(provider);
			const index = entries.findIndex(entry => entry.id === credentialId);
			if (index < 0) continue;
			const providerKey = providerTypeKey(provider, entries[index]!.credential.type);
			if (
				this.#deps.blocks.isBlocked(provider, providerKey, index, blockScope) &&
				this.#deps.blocks.quotaProbeScope(provider, providerKey, index, blockScope) !== blockScope
			)
				return null;
			return this.#probeLeases.tryAcquire(credentialId, blockScope);
		}
		return null;
	}

	/**
	 * Acquire a probe lease for `requestId`, or reuse the request-owned lease when
	 * auth retry re-enters while the same request still holds it (tryAcquire would
	 * otherwise return null and clearQuotaProbe would be unreachable).
	 */
	acquireOrReuseQuotaProbeLease(requestId: string, credentialId: number, probeScope: string): boolean {
		const existing = this.#inflightProbes.get(requestId);
		if (
			existing &&
			existing.credentialId === credentialId &&
			existing.blockScope === probeScope &&
			this.#probeLeases.isCurrentLease(credentialId, probeScope, existing.leaseId)
		) {
			return true;
		}
		const lease = this.tryAcquireQuotaProbeLease(credentialId, probeScope);
		if (!lease) return false;
		this.clearQuotaProbe(requestId);
		this.#inflightProbes.set(requestId, {
			credentialId,
			blockScope: probeScope,
			leaseId: lease,
		});
		return true;
	}

	hasInflightProbe(requestId: string): boolean {
		return this.#inflightProbes.has(requestId);
	}

	isCurrentProbe(requestId: string, credentialId: number, blockScope: string): boolean {
		const probe = this.#inflightProbes.get(requestId);
		return (
			probe?.credentialId === credentialId &&
			probe.blockScope === blockScope &&
			this.#probeLeases.isCurrentLease(credentialId, blockScope, probe.leaseId)
		);
	}

	recordQuotaProbeSuccess(credentialId: number, blockScope: string, leaseId: string | null): boolean {
		for (const provider of this.#deps.pool.providers()) {
			const entries = this.#deps.pool.entries(provider);
			const index = entries.findIndex(entry => entry.id === credentialId);
			if (index < 0) continue;
			const providerKey = providerTypeKey(provider, entries[index]!.credential.type);
			if (this.#deps.blocks.quotaProbeScope(provider, providerKey, index, blockScope) !== blockScope) return false;
			if (!this.#probeLeases.recordSuccess(credentialId, blockScope, leaseId)) return false;
			return this.#deps.blocks.clearScope(provider, credentialId, providerKey, blockScope || undefined);
		}
		return false;
	}

	noteTransientSoftAvoid(credentialId: number, blockScope: string, untilMs: number): void {
		this.#probeLeases.noteSoftAvoid(credentialId, blockScope, untilMs);
	}

	/**
	 * Drop an inflight quota probe for `requestId` without clearing cooldown.
	 * Call when the attempt is abandoned (fallback / turn release) so a later
	 * request can acquire a fresh lease.
	 */
	clearQuotaProbe(requestId: string): void {
		const probe = this.#inflightProbes.get(requestId);
		if (!probe) return;
		this.#inflightProbes.delete(requestId);
		this.#probeLeases.release(probe.credentialId, probe.blockScope, probe.leaseId);
	}

	settleQuotaProbeSuccess(requestId: string): boolean {
		const probe = this.#inflightProbes.get(requestId);
		if (!probe) return false;
		this.#inflightProbes.delete(requestId);
		return this.recordQuotaProbeSuccess(probe.credentialId, probe.blockScope, probe.leaseId);
	}

	clearAnonymousQuotaProbe(credentialId: number, blockScope: string): void {
		const key = anonymousProbeRequestKey(credentialId, blockScope);
		if (!this.#inflightProbes.has(key)) return;
		this.clearQuotaProbe(key);
	}

	settleAnonymousQuotaProbe(credentialId: number, blockScope: string): boolean {
		const key = anonymousProbeRequestKey(credentialId, blockScope);
		if (!this.#inflightProbes.has(key)) return false;
		return this.settleQuotaProbeSuccess(key);
	}

	// ------------------------------------------------------------------
	// Selection-time probes and cooldown inspection
	// ------------------------------------------------------------------

	/**
	 * Probe path for a blocked API-key candidate: acquires the single-flight
	 * quota-probe lease (anonymous probes keyed by credential+scope). Returns
	 * true only when the candidate may be vended as a probe.
	 */
	tryApiKeyProbe(
		provider: string,
		providerKey: string,
		selection: ApiKeySelection,
		options: AuthApiKeyOptions | undefined,
		blockScope?: string,
		blockScopes?: readonly string[],
	): boolean {
		if (
			!this.isBlockedForRequest(
				provider,
				providerKey,
				selection.index,
				blockScopes ?? blockScope,
				options?.requestId,
			)
		)
			return false;
		const credentialId = this.#deps.pool.entries(provider)[selection.index]?.id;
		if (credentialId === undefined) return false;
		const scope = this.resolveQuotaProbeLeaseScope(provider, providerKey, selection.index, blockScopes ?? blockScope);
		if (scope === null) return false;
		const requestId = options?.requestId ?? anonymousProbeRequestKey(credentialId, scope);
		if (!options?.requestId && this.#inflightProbes.has(requestId)) return false;
		if (!this.acquireOrReuseQuotaProbeLease(requestId, credentialId, scope)) return false;
		selection.probeRequestId = requestId;
		return true;
	}

	resolveQuotaProbeLeaseScope(
		provider: string,
		providerKey: string,
		index: number,
		scopes?: string | readonly string[],
	): string | null {
		return this.#deps.blocks.quotaProbeScope(provider, providerKey, index, scopes);
	}

	/**
	 * True when the provider has stored credentials but every candidate is under
	 * an active backoff / Retry-After / probe-lease hold (so getApiKey returned
	 * undefined for quota reasons rather than missing auth).
	 */
	hasCoolingDownCredentials(provider: Provider, modelId?: string): boolean {
		const entries = this.#deps.pool.entries(provider);
		if (entries.length === 0) return false;
		const rankingContext = { modelId };
		const strategy = this.#deps.strategies(provider);
		for (const credType of ["oauth", "api_key"] as const) {
			const typed = entries
				.map((entry, index) => ({ entry, index }))
				.filter(item => item.entry.credential.type === credType);
			if (typed.length === 0) continue;
			const providerKey = providerTypeKey(provider, credType);
			const blockScope = strategy?.blockScope?.(rankingContext);
			const blockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, blockScope);
			const anyUnblocked = typed.some(
				item => !this.isBlockedForRequest(provider, providerKey, item.index, blockScopes ?? blockScope),
			);
			if (anyUnblocked) return false;
		}
		return true;
	}
}
