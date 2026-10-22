import { logger } from "@oh-my-pi/pi-utils";
import { findPersistedRecall, persistRecall } from "../memory-backend/recall-entry";
import type { MemoryPromptPreparation } from "../memory-backend/types";
import type { AgentSession } from "../session/agent-session";
import type { SessionEntry } from "../session/session-entries";
import { type BankScope, ensureBankExists } from "./bank";
import { HINDSIGHT_TIMESTAMP_UNSET, hindsightEventTimestamp, type HindsightApi, type MemoryItemInput } from "./client";
import type { HindsightConfig } from "./config";
import {
	composeRecallQuery,
	formatMemories,
	hasSubstantiveContent,
	type HindsightMessage,
	HINDSIGHT_UI_RECEIPT_ROLE,
	prepareRetentionTranscript,
	sliceLastTurnsByUserBoundary,
	stripMemoryTags,
	truncateRecallQuery,
} from "./content";
import {
	ensureMentalModels,
	MENTAL_MODEL_FIRST_TURN_DEADLINE_MS,
	resolveSeedsForScope,
	tryLoadMentalModelsBlock,
} from "./mental-models";
import { countUserTurns, extractMessages } from "./transcript";

const RETAIN_FLUSH_BATCH_SIZE = 16;
const RETAIN_FLUSH_INTERVAL_MS = 5_000;
const MENTAL_MODEL_LOAD_TIMED_OUT = Symbol("mental-model-load-timed-out");

interface PendingRetainItem {
	content: string;
	context?: string;
	timestamp: Date;
}

interface RecallOutcome {
	context: string | null;
	ok: boolean;
}

export interface HindsightSessionStateOptions {
	/** Session id used for retain-queue metadata. */
	sessionId: string;
	client: HindsightApi;
	bankId: string;
	/** Tags applied to every retain — non-empty in per-project-tagged mode. */
	retainTags?: string[];
	/** Tag filter applied to every recall/reflect — non-empty in per-project-tagged mode. */
	recallTags?: string[];
	recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	config: HindsightConfig;
	session: AgentSession;
	banksSet: Set<string>;
	lastRetainedTurn?: number;
	hasRecalledForFirstTurn?: boolean;
	/**
	 * When set, this entry is a subagent alias that reuses the parent's bank,
	 * scope, config, client, and banksSet. Aliases skip auto-recall and
	 * auto-retain — those run on the parent only — but the recall/retain/reflect
	 * tools resolve via the alias so they persist to the same bank as the parent.
	 */
	aliasOf?: HindsightSessionState;
}

/**
 * Debounced batch queue for tool-initiated `retain` calls owned by one
 * Hindsight session state instance.
 *
 * Auto-retain (`HindsightSessionState.retainSession`) is intentionally not
 * routed through this queue — it submits a full transcript as one large item
 * and already runs `async: true` server-side.
 */
export class HindsightRetainQueue {
	readonly #state: HindsightSessionState;
	#items: PendingRetainItem[] = [];
	#timer?: NodeJS.Timeout;
	#flushing?: Promise<void>;
	#closed = false;

	constructor(state: HindsightSessionState) {
		this.#state = state;
	}

	get depth(): number {
		return this.#items.length;
	}

	enqueue(content: string, context?: string): void {
		if (this.#closed) {
			throw new Error("Hindsight retain queue is closed.");
		}
		this.#items.push({ content, context, timestamp: new Date() });

		if (this.#items.length >= RETAIN_FLUSH_BATCH_SIZE) {
			void this.flush();
			return;
		}
		if (!this.#timer) {
			this.#timer = setTimeout(() => {
				void this.flush();
			}, RETAIN_FLUSH_INTERVAL_MS);
			// Don't pin the event loop alive just for a pending retain flush.
			this.#timer.unref?.();
		}
	}

	async flush(): Promise<void> {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}

		if (this.#flushing) {
			// Coalesce: wait for the in-flight flush, then drain anything that
			// landed after it started so we don't strand items.
			await this.#flushing;
			if (this.#items.length > 0) await this.flush();
			return;
		}

		if (this.#items.length === 0) return;

		const items = this.#items.splice(0);
		const flushPromise = this.#doFlush(items);
		this.#flushing = flushPromise;
		try {
			await flushPromise;
		} finally {
			this.#flushing = undefined;
		}
	}

	dispose(): void {
		this.#closed = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#items = [];
	}

	async #doFlush(items: PendingRetainItem[]): Promise<void> {
		const state = this.#state;
		const sessionId = state.sessionId;
		if (state.session.getHindsightSessionState() !== state) {
			// Session went away before we could flush. We can't notify anyone, so
			// log and drop — these are best-effort facts, not transactional writes.
			logger.warn("Hindsight retain queue: session vanished, dropping batch", {
				sessionId,
				items: items.length,
			});
			return;
		}

		try {
			await ensureBankExists(state.client, state.bankId, state.config, state.banksSet);
			const batch: MemoryItemInput[] = items.map(item => ({
				content: item.content,
				context: item.context ?? state.config.retainContext,
				metadata: { session_id: sessionId },
				tags: state.retainTags,
				timestamp: item.timestamp,
			}));
			await state.client.retainBatch(state.bankId, batch, { async: true });
			if (state.config.debug) {
				logger.debug("Hindsight retain queue: batch flushed", {
					sessionId,
					bankId: state.bankId,
					items: items.length,
				});
			}
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			logger.warn("Hindsight retain queue: batch flush failed", {
				sessionId,
				bankId: state.bankId,
				items: items.length,
				error: errorText,
			});
			this.#notifyRetainFailure(items.length, errorText);
		}
	}

	#notifyRetainFailure(count: number, errorText: string): void {
		const noun = count === 1 ? "memory" : "memories";
		this.#state.session.emitNotice(
			"warning",
			`Memory retention failed for ${count} ${noun}: ${errorText}`,
			"Hindsight",
		);
	}
}

/**
 * Rolling hash of messages[0, to) for retention-cache validation (see #lastRetainedPrefixKey),
 * continued from `key` = the rolling hash of messages[0, from).
 */
function extendRetentionPrefixKey(key: string, messages: HindsightMessage[], from: number, to: number): string {
	for (let i = from; i < to; i++) {
		const m = messages[i];
		if (m === undefined) break;
		key = Bun.hash(`${key}\u0000${m.role}\u0000${m.content}\u0000${m.timestamp ?? ""}`).toString(36);
	}
	return key;
}

/**
 * Journal checkpoint for opt-in per-message retain. Latest entry on the active
 * branch wins. Not an external store: same custom-entry path as memory recall.
 */
export const HINDSIGHT_RETAIN_CHECKPOINT_TYPE = "hindsight_retain";

const UI_RECEIPT_ROLE = HINDSIGHT_UI_RECEIPT_ROLE;

interface RetainCutoverMarker {
	version: 1;
	kind: "cutover";
	scope: string;
	cutover: string[];
}

interface RetainAcceptedDelta {
	version: 1;
	kind: "accepted";
	scope: string;
	accepted: string[];
}

interface RetainCheckpointStore {
	getBranch?: () => SessionEntry[];
	getEntries?: () => SessionEntry[];
	appendCustomEntry?: (customType: string, data?: unknown) => string;
}

interface PerMessageRetainItem {
	item: MemoryItemInput;
	identities: string[];
}

interface FrozenRetain {
	epoch: number;
	userTurns: number;
	sessionId: string;
	bankId: string;
	retainTags?: string[];
	retainContext: string;
	scope: string;
	store: RetainCheckpointStore;
	sourceTimestamp: Date;
	cutover: string[];
	accepted: string[];
	cutoverPersisted: boolean;
	pendingCutover: string[];
}

/** Ledger identity: endpoint, account, bank, retain tags, and scoping. Not bank id alone. */
export function hindsightRetainScope(input: {
	apiUrl: string | null;
	apiToken: string | null;
	bankId: string;
	retainTags?: readonly string[];
	scoping: string;
}): string {
	return JSON.stringify([
		"hindsight-retain",
		input.apiUrl,
		Bun.hash(input.apiToken ?? "").toString(16),
		input.bankId,
		input.retainTags ?? [],
		input.scoping,
	]);
}

/** Stable retain identity. Receipts use entry id plus question id; other turns use entry id. */
function hindsightRetainIdentity(message: HindsightMessage): string | undefined {
	const entryId = message.entryId?.trim();
	if (!entryId) return undefined;
	if (message.role === UI_RECEIPT_ROLE) {
		const questionId = message.questionId?.trim();
		if (!questionId) return undefined;
		return `receipt:${entryId}:${questionId}`;
	}
	return `entry:${entryId}`;
}

/** Document id for a user or assistant journal entry. Stable across resume; not the session id. */
function hindsightMessageDocumentId(sessionId: string, entryId: string): string {
	return `omp-msg:${sessionId}:${entryId}`;
}

/** Document id for one qualified ask receipt. Same entry id can carry several question ids. */
function hindsightReceiptDocumentId(sessionId: string, entryId: string, questionId: string): string {
	return `omp-receipt:${sessionId}:${entryId}:${questionId}`;
}

function substantiveSource(content: string): string | undefined {
	const stripped = stripMemoryTags(content).trim();
	return hasSubstantiveContent(stripped) ? stripped : undefined;
}

function checkpointEntries(store: RetainCheckpointStore | undefined): SessionEntry[] {
	if (!store) return [];
	if (typeof store.getBranch === "function") return store.getBranch();
	if (typeof store.getEntries === "function") return store.getEntries();
	return [];
}

function stringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) return undefined;
	return value;
}

function readCheckpointRecord(data: unknown): RetainCutoverMarker | RetainAcceptedDelta | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (record.version !== 1 || typeof record.scope !== "string" || typeof record.kind !== "string") return undefined;
	if (record.kind === "cutover") {
		const cutover = stringList(record.cutover);
		if (!cutover) return undefined;
		return { version: 1, kind: "cutover", scope: record.scope, cutover };
	}
	if (record.kind === "accepted") {
		const accepted = stringList(record.accepted);
		if (!accepted) return undefined;
		return { version: 1, kind: "accepted", scope: record.scope, accepted };
	}
	return undefined;
}

/** Cutover marker plus accepted deltas for this scope, stopping at a reset boundary. */
function readRetainLedger(
	store: RetainCheckpointStore | undefined,
	scope: string,
): { cutover: string[]; accepted: string[] } | undefined {
	const entries = checkpointEntries(store);
	const accepted: string[] = [];
	let cutover: string[] | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry) continue;
		if (entry.type === "reset_boundary") break;
		if (entry.type !== "custom" || entry.customType !== HINDSIGHT_RETAIN_CHECKPOINT_TYPE) continue;
		const record = readCheckpointRecord(entry.data);
		if (!record || record.scope !== scope) continue;
		if (record.kind === "accepted") accepted.push(...record.accepted);
		else if (cutover === undefined) cutover = record.cutover;
	}
	if (!cutover) return undefined;
	return { cutover, accepted };
}

function writeRetainRecord(
	store: RetainCheckpointStore | undefined,
	data: RetainCutoverMarker | RetainAcceptedDelta,
): boolean {
	if (!store || typeof store.appendCustomEntry !== "function") return false;
	try {
		store.appendCustomEntry(HINDSIGHT_RETAIN_CHECKPOINT_TYPE, data);
		return true;
	} catch (error) {
		logger.warn("Hindsight: retain checkpoint write failed", { error: String(error) });
		return false;
	}
}

function branchReader(store: RetainCheckpointStore | undefined): { getEntries(): SessionEntry[] } | undefined {
	if (!store) return undefined;
	if (typeof store.getBranch === "function") {
		const readBranch = store.getBranch.bind(store);
		return { getEntries: () => readBranch() };
	}
	if (typeof store.getEntries === "function") {
		const readEntries = store.getEntries.bind(store);
		return { getEntries: () => readEntries() };
	}
	return undefined;
}

function formatSourcePart(source: HindsightMessage): string | undefined {
	const text = substantiveSource(source.content);
	if (!text) return undefined;
	const lines = [`[role: ${source.role}]`];
	const timestamp = source.timestamp?.trim();
	if (timestamp && hindsightEventTimestamp(timestamp) !== HINDSIGHT_TIMESTAMP_UNSET) {
		lines.push(`[timestamp: ${timestamp}]`);
	}
	if (source.role === UI_RECEIPT_ROLE) {
		if (source.toolCallId) lines.push(`[toolCallId: ${source.toolCallId}]`);
		if (source.questionId) lines.push(`[questionId: ${source.questionId}]`);
	}
	lines.push(text, `[${source.role}:end]`);
	return lines.join("\n");
}

function documentIdFor(sessionId: string, source: HindsightMessage, entryId: string): string | undefined {
	if (source.role === UI_RECEIPT_ROLE) {
		const questionId = source.questionId?.trim();
		if (!questionId) return undefined;
		return hindsightReceiptDocumentId(sessionId, entryId, questionId);
	}
	return hindsightMessageDocumentId(sessionId, entryId);
}

function buildPerMessageItems(
	messages: readonly HindsightMessage[],
	sessionId: string,
	retainContext: string,
	tags: string[] | undefined,
	covered: ReadonlySet<string>,
): { items: PerMessageRetainItem[]; skippedUnidentified: boolean } {
	const items: PerMessageRetainItem[] = [];
	let skippedUnidentified = false;
	for (const source of messages) {
		if (!source) continue;
		const text = formatSourcePart(source);
		if (!text) continue;
		const identity = hindsightRetainIdentity(source);
		const entryId = source.entryId?.trim();
		if (!identity || !entryId) {
			if (source.role === "user" || source.role === "assistant" || source.role === UI_RECEIPT_ROLE) {
				skippedUnidentified = true;
			}
			continue;
		}
		if (covered.has(identity)) continue;
		const documentId = documentIdFor(sessionId, source, entryId);
		if (!documentId) {
			skippedUnidentified = true;
			continue;
		}
		const metadata: Record<string, string> = {
			session_id: sessionId,
			entry_id: entryId,
			retain_mode: "per-message",
			source: "omp-transcript",
		};
		if (source.role === UI_RECEIPT_ROLE && source.questionId?.trim()) {
			metadata.question_id = source.questionId.trim();
		}
		if (source.toolCallId?.trim()) metadata.tool_call_id = source.toolCallId.trim();
		items.push({
			identities: [identity],
			item: {
				content: text,
				timestamp: hindsightEventTimestamp(source.timestamp),
				context: retainContext,
				metadata,
				documentId,
				tags,
			},
		});
	}
	return { items, skippedUnidentified };
}

/** Per-session Hindsight runtime state owned by its AgentSession. */
export class HindsightSessionState {
	/** Session id used for retain-queue metadata. */
	sessionId: string;
	client: HindsightApi;
	bankId: string;
	/** Tags applied to every retain — non-empty in per-project-tagged mode. */
	retainTags?: string[];
	/** Tag filter applied to every recall/reflect — non-empty in per-project-tagged mode. */
	recallTags?: string[];
	recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	config: HindsightConfig;
	session: AgentSession;
	banksSet: Set<string>;
	lastRetainedTurn: number;
	#lastRetainedMessageIndex: number = 0;
	#cachedTranscript: string = "";
	// Rolling hash of ALL messages in [0, #lastRetainedMessageIndex) at cache
	// time. The incremental full-session cache assumes the branch is append-only;
	// a rewind, branch switch, compaction, or in-place edit rewrites the prefix
	// without changing the session id. Re-hashing the current prefix at use time
	// makes the cache self-healing: on ANY prefix change (not just the boundary
	// message) we rebuild the full transcript instead of retaining stale content
	// or silently retaining nothing forever. Hashing is orders of magnitude
	// cheaper than the re-formatting this cache avoids.
	#lastRetainedPrefixKey: string = "";
	hasRecalledForFirstTurn: boolean;
	lastRecallSnippet?: string;
	#recallGeneration = 0;
	/** Cached `<mental_models>` block injected into developer instructions. */
	mentalModelsSnippet?: string;
	/** When the current bootstrap/boundary load settled; gates the first-turn race. */
	mentalModelsLoadedAt?: number;
	/**
	 * In-flight bootstrap or transcript-boundary load. `beforeAgentStartPrompt`
	 * awaits it on the first turn so a timely snapshot lands before generation,
	 * even though startup and transcript transitions remain non-blocking.
	 */
	mentalModelsLoadPromise?: Promise<void>;
	#mentalModelsLoadGeneration = 0;
	unsubscribe?: () => void;
	/** Alias states delegate persistence config to a primary parent state. */
	aliasOf?: HindsightSessionState;
	readonly retainQueue: HindsightRetainQueue;
	#automaticRetains = new Set<Promise<void>>();
	#automaticRetainSealed = false;
	#retainChain: Promise<void> = Promise.resolve();
	#retainEpoch = 0;
	/** Cutover ids frozen until the marker is durable. Not covered until then. */
	#pendingCutover: string[] | undefined;
	/** Identities present when per-message mode was first adopted. Not backfilled. */
	#perMessageCutover = new Set<string>();
	/** Identities whose retain POST was accepted. Failures stay out so resume retries them. */
	#perMessageAccepted = new Set<string>();
	#perMessageCheckpointReady = false;
	#loggedMissingIdentity = false;

	constructor(options: HindsightSessionStateOptions) {
		this.sessionId = options.sessionId;
		this.client = options.client;
		this.bankId = options.bankId;
		this.retainTags = options.retainTags;
		this.recallTags = options.recallTags;
		this.recallTagsMatch = options.recallTagsMatch;
		this.config = options.config;
		this.session = options.session;
		this.banksSet = options.banksSet;
		this.lastRetainedTurn = options.lastRetainedTurn ?? 0;
		this.#lastRetainedMessageIndex = 0;
		this.#cachedTranscript = "";
		this.#lastRetainedPrefixKey = "";
		this.hasRecalledForFirstTurn = options.hasRecalledForFirstTurn ?? false;
		this.aliasOf = options.aliasOf;
		this.retainQueue = new HindsightRetainQueue(this);
		this.#adoptPerMessageCheckpoint();
	}

	setSessionId(sessionId: string): void {
		if (this.sessionId !== sessionId) {
			this.#recallGeneration++;
			this.#retainEpoch++;
		}
		this.sessionId = sessionId;
		this.#lastRetainedMessageIndex = 0;
		this.#cachedTranscript = "";
		this.#lastRetainedPrefixKey = "";
	}

	resetConversationTracking(): void {
		this.#recallGeneration++;
		this.#retainEpoch++;
		this.lastRetainedTurn = 0;
		this.hasRecalledForFirstTurn = false;
		this.lastRecallSnippet = undefined;
		this.#lastRetainedMessageIndex = 0;
		this.#cachedTranscript = "";
		this.#lastRetainedPrefixKey = "";
		this.#reloadPerMessageCheckpoint();
	}

	enqueueRetain(content: string, context?: string): void {
		this.retainQueue.enqueue(content, context);
	}

	async flushRetainQueue(): Promise<void> {
		await this.retainQueue.flush();
	}

	async recallForContext(query: string, signal?: AbortSignal): Promise<RecallOutcome> {
		try {
			const response = await this.client.recall(this.bankId, query, {
				budget: this.config.recallBudget,
				maxTokens: this.config.recallMaxTokens,
				types: this.config.recallTypes.length > 0 ? this.config.recallTypes : undefined,
				tags: this.recallTags,
				tagsMatch: this.recallTagsMatch,
				signal,
			});
			if (signal?.aborted) return { context: null, ok: false };
			const results = response.results ?? [];
			if (results.length === 0) return { context: null, ok: true };
			const formatted = formatMemories(results);
			const block = `<memories>\n${this.config.recallPromptPreamble}\n\n${formatted}\n</memories>`;
			return { context: block, ok: true };
		} catch (err) {
			if (this.config.debug) {
				logger.debug("Hindsight: recall failed", { bankId: this.bankId, error: String(err) });
			}
			return { context: null, ok: false };
		}
	}

	#sessionSourceTimestamp(): Date | undefined {
		const header = this.session.sessionManager?.getHeader?.();
		const timestamp = header?.timestamp;
		if (typeof timestamp !== "string") return undefined;
		const trimmed = timestamp.trim();
		if (!trimmed) return undefined;
		const parsed = new Date(trimmed);
		return Number.isNaN(parsed.getTime()) ? undefined : parsed;
	}

	#checkpointStore(): RetainCheckpointStore | undefined {
		return this.session.sessionManager as RetainCheckpointStore | undefined;
	}

	#retainScope(): string {
		return hindsightRetainScope({
			apiUrl: this.config.hindsightApiUrl,
			apiToken: this.config.hindsightApiToken,
			bankId: this.bankId,
			retainTags: this.retainTags,
			scoping: this.config.scoping,
		});
	}

	#scanBranchIdentities(store: RetainCheckpointStore | undefined): string[] {
		const reader = branchReader(store);
		if (!reader) return [];
		try {
			const identities: string[] = [];
			for (const message of extractMessages(reader)) {
				const identity = hindsightRetainIdentity(message);
				if (identity) identities.push(identity);
			}
			return identities;
		} catch (error) {
			logger.warn("Hindsight: per-message cutover scan failed", {
				sessionId: this.sessionId,
				bankId: this.bankId,
				error: String(error),
			});
			return [];
		}
	}

	/** Load a durable ledger, or freeze a pending cutover that is not covered until saved. */
	#adoptPerMessageCheckpoint(): void {
		if (this.config.retainMode !== "per-message" || this.aliasOf) return;
		const store = this.#checkpointStore();
		const existing = readRetainLedger(store, this.#retainScope());
		if (existing) {
			this.#perMessageCutover = new Set(existing.cutover);
			this.#perMessageAccepted = new Set(existing.accepted);
			this.#pendingCutover = undefined;
			this.#perMessageCheckpointReady = true;
			return;
		}
		this.#pendingCutover ??= this.#scanBranchIdentities(store);
		this.#perMessageCutover = new Set();
		this.#perMessageAccepted = new Set();
		this.#perMessageCheckpointReady = false;
		if (this.#persistPendingCutover(store, this.#retainScope())) return;
		logger.warn("Hindsight: per-message cutover checkpoint was not persisted", {
			sessionId: this.sessionId,
			bankId: this.bankId,
		});
		this.#notifyRetainFailure("per-message cutover checkpoint was not saved; retention is paused until it saves");
	}

	#reloadPerMessageCheckpoint(): void {
		if (this.config.retainMode !== "per-message" || this.aliasOf) return;
		this.#perMessageCutover = new Set();
		this.#perMessageAccepted = new Set();
		this.#pendingCutover = undefined;
		this.#perMessageCheckpointReady = false;
		this.#adoptPerMessageCheckpoint();
	}

	#persistPendingCutover(store: RetainCheckpointStore | undefined, scope: string): boolean {
		if (this.#perMessageCheckpointReady) return true;
		const cutover = this.#pendingCutover ?? [];
		if (!writeRetainRecord(store, { version: 1, kind: "cutover", scope, cutover })) return false;
		this.#perMessageCutover = new Set(cutover);
		this.#pendingCutover = undefined;
		this.#perMessageCheckpointReady = true;
		return true;
	}

	#notifyRetainFailure(errorText: string): void {
		const notify = this.session.emitNotice;
		if (typeof notify !== "function") return;
		notify.call(this.session, "warning", `Memory retention failed: ${errorText}`, "Hindsight");
	}

	#freezeRetain(userTurns: number, store: RetainCheckpointStore): FrozenRetain {
		return {
			epoch: this.#retainEpoch,
			userTurns,
			sessionId: this.sessionId,
			bankId: this.bankId,
			retainTags: this.retainTags,
			retainContext: this.config.retainContext,
			scope: this.#retainScope(),
			store,
			sourceTimestamp: this.#sessionSourceTimestamp() ?? new Date(),
			cutover: [...this.#perMessageCutover],
			accepted: [...this.#perMessageAccepted],
			cutoverPersisted: this.#perMessageCheckpointReady,
			pendingCutover: [...(this.#pendingCutover ?? this.#perMessageCutover)],
		};
	}

	#startAutomaticRetain(): void {
		if (this.#automaticRetainSealed || this.aliasOf || !this.config.autoRetain) return;
		const store = this.#checkpointStore();
		const reader = branchReader(store);
		if (!reader || !store) return;
		const userTurns = countUserTurns(reader);
		if (userTurns - this.lastRetainedTurn < this.config.retainEveryNTurns) return;
		const messages = extractMessages(reader);
		if (messages.length === 0) return;
		const frozen = this.#freezeRetain(userTurns, store);
		const run = this.#retainChain.then(() => this.#finishFrozenRetain(messages, frozen));
		const tracked = run.finally(() => {
			this.#automaticRetains.delete(tracked);
		});
		this.#retainChain = tracked.then(
			() => undefined,
			() => undefined,
		);
		this.#automaticRetains.add(tracked);
	}

	async #finishFrozenRetain(messages: HindsightMessage[], frozen: FrozenRetain): Promise<void> {
		try {
			await this.retainSession(messages, frozen);
			if (this.#retainEpoch === frozen.epoch) this.lastRetainedTurn = frozen.userTurns;
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			logger.warn("Hindsight: auto-retain failed", {
				sessionId: frozen.sessionId,
				bankId: frozen.bankId,
				error: errorText,
			});
			this.#notifyRetainFailure(errorText);
		}
	}

	async #retainPerMessage(messages: HindsightMessage[], frozen?: FrozenRetain): Promise<void> {
		const store = frozen?.store ?? this.#checkpointStore();
		const scope = frozen?.scope ?? this.#retainScope();
		const sessionId = frozen?.sessionId ?? this.sessionId;
		const bankId = frozen?.bankId ?? this.bankId;
		const live = !frozen || frozen.epoch === this.#retainEpoch;
		let cutover = frozen ? [...frozen.cutover] : [...this.#perMessageCutover];
		const accepted = frozen ? [...frozen.accepted] : [...this.#perMessageAccepted];
		if (!(frozen ? frozen.cutoverPersisted : this.#perMessageCheckpointReady)) {
			const pending = frozen?.pendingCutover ?? this.#pendingCutover ?? cutover;
			if (!writeRetainRecord(store, { version: 1, kind: "cutover", scope, cutover: pending })) {
				const errorText = "per-message cutover checkpoint was not saved";
				this.#notifyRetainFailure(errorText);
				throw new Error(`Hindsight ${errorText}`);
			}
			cutover = pending;
			if (live) {
				this.#perMessageCutover = new Set(pending);
				this.#pendingCutover = undefined;
				this.#perMessageCheckpointReady = true;
			}
		}
		const covered = new Set<string>([...cutover, ...accepted]);
		const { items, skippedUnidentified } = buildPerMessageItems(
			messages,
			sessionId,
			frozen?.retainContext ?? this.config.retainContext,
			frozen?.retainTags ?? this.retainTags,
			covered,
		);
		if (skippedUnidentified && !this.#loggedMissingIdentity) {
			this.#loggedMissingIdentity = true;
			logger.warn("Hindsight: per-message retain skipped a message with no stable journal identity", {
				sessionId,
				bankId,
			});
		}
		if (items.length === 0) {
			if (skippedUnidentified) {
				throw new Error("Hindsight per-message retain skipped a message with no stable journal identity");
			}
			return;
		}
		await ensureBankExists(this.client, bankId, this.config, this.banksSet);
		await this.client.retainBatch(
			bankId,
			items.map(entry => entry.item),
			{ async: true },
		);
		const fresh = items.flatMap(entry => entry.identities).filter(identity => !covered.has(identity));
		if (fresh.length > 0 && !writeRetainRecord(store, { version: 1, kind: "accepted", scope, accepted: fresh })) {
			const errorText = "accepted per-message retain was not checkpointed";
			this.#notifyRetainFailure(errorText);
			throw new Error(`Hindsight ${errorText}`);
		}
		if (live) {
			for (const identity of fresh) this.#perMessageAccepted.add(identity);
		}
		if (skippedUnidentified) {
			throw new Error("Hindsight per-message retain skipped a message with no stable journal identity");
		}
	}

	async retainSession(messages: HindsightMessage[], frozen?: FrozenRetain): Promise<void> {
		if (this.config.retainMode === "per-message") {
			await this.#retainPerMessage(messages, frozen);
			return;
		}
		const sessionId = frozen?.sessionId ?? this.sessionId;
		const bankId = frozen?.bankId ?? this.bankId;
		const retainTags = frozen?.retainTags ?? this.retainTags;
		const retainContext = frozen?.retainContext ?? this.config.retainContext;
		const retainedAt = new Date();
		const sourceTimestamp = frozen?.sourceTimestamp ?? this.#sessionSourceTimestamp() ?? retainedAt;
		const retainFullWindow = this.config.retainMode === "full-session";
		const commitCache = !frozen || frozen.epoch === this.#retainEpoch;
		let documentId: string;
		let transcript: string;
		let nextCachedTranscript: string | undefined;
		let prefixKey = "";
		let hashedThrough = 0;

		if (retainFullWindow) {
			documentId = sessionId;
			const boundary = this.#lastRetainedMessageIndex;
			if (boundary <= messages.length) prefixKey = extendRetentionPrefixKey("", messages, 0, boundary);
			if (boundary > messages.length || prefixKey !== this.#lastRetainedPrefixKey) {
				this.#lastRetainedMessageIndex = 0;
				this.#cachedTranscript = "";
				this.#lastRetainedPrefixKey = "";
				prefixKey = "";
			}
			hashedThrough = this.#lastRetainedMessageIndex;
			const newMessages = messages.slice(hashedThrough);
			const { transcript: newPart } = prepareRetentionTranscript(newMessages, true, { includeTimestamps: true });
			if (!newPart) return;
			nextCachedTranscript = this.#cachedTranscript ? `${this.#cachedTranscript}\n\n${newPart}` : newPart;
			transcript = nextCachedTranscript;
		} else {
			const windowTurns = this.config.retainEveryNTurns + this.config.retainOverlapTurns;
			const target = sliceLastTurnsByUserBoundary(messages, windowTurns);
			documentId = `${sessionId}-${(frozen?.sourceTimestamp ?? retainedAt).getTime()}`;
			this.#lastRetainedMessageIndex = 0;
			this.#cachedTranscript = "";
			this.#lastRetainedPrefixKey = "";
			const { transcript: windowTranscript } = prepareRetentionTranscript(target, true, { includeTimestamps: true });
			if (!windowTranscript) return;
			transcript = windowTranscript;
		}

		await ensureBankExists(this.client, bankId, this.config, this.banksSet);
		await this.client.retain(bankId, transcript, {
			documentId,
			context: retainContext,
			metadata: { session_id: sessionId },
			tags: retainTags,
			timestamp: sourceTimestamp,
			async: true,
		});
		if (nextCachedTranscript !== undefined && commitCache) {
			this.#cachedTranscript = nextCachedTranscript;
			this.#lastRetainedPrefixKey = extendRetentionPrefixKey(prefixKey, messages, hashedThrough, messages.length);
			this.#lastRetainedMessageIndex = messages.length;
		}
	}

	async maybeRetainOnAgentEnd(): Promise<void> {
		if (!this.config.autoRetain || this.aliasOf) return;
		const store = this.#checkpointStore();
		const reader = branchReader(store);
		if (!reader) return;
		const userTurns = countUserTurns(reader);
		if (userTurns - this.lastRetainedTurn < this.config.retainEveryNTurns) return;
		const messages = extractMessages(reader);
		if (messages.length === 0 || !store) return;
		const frozen = this.#freezeRetain(userTurns, store);
		try {
			await this.retainSession(messages, frozen);
			if (this.#retainEpoch === frozen.epoch) this.lastRetainedTurn = userTurns;
			if (this.config.debug) {
				logger.debug("Hindsight: auto-retain succeeded", {
					sessionId: this.sessionId,
					bankId: this.bankId,
					userTurns,
					messages: messages.length,
				});
			}
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			logger.warn("Hindsight: auto-retain failed", {
				sessionId: this.sessionId,
				bankId: this.bankId,
				error: errorText,
			});
			this.#notifyRetainFailure(errorText);
		}
	}

	async forceRetainCurrentSession(): Promise<void> {
		const reader = branchReader(this.#checkpointStore());
		const messages = reader ? extractMessages(reader) : [];
		if (messages.length === 0) return;
		// Forced retains are user-initiated rebuilds (`/memory enqueue`): drop the
		// incremental cache so the full transcript is reformatted and resent even
		// when no new messages arrived since the last auto-retain — otherwise a
		// rebuild could never recover an upstream document that was deleted or a
		// previous async retain that never materialized. Per-message rebuilds
		// resend post-cutover identities only; the one-time cutover is not cleared.
		this.#lastRetainedMessageIndex = 0;
		this.#cachedTranscript = "";
		this.#lastRetainedPrefixKey = "";
		if (this.config.retainMode === "per-message") this.#perMessageAccepted.clear();
		try {
			await this.retainSession(messages);
			this.lastRetainedTurn = messages.filter(m => m.role === "user").length;
		} catch (err) {
			logger.warn("Hindsight: forced retain failed", {
				sessionId: this.sessionId,
				bankId: this.bankId,
				error: String(err),
			});
		}
	}

	async beforeAgentStartPrompt(
		promptText: string,
		signal?: AbortSignal,
	): Promise<MemoryPromptPreparation | undefined> {
		if (this.config.mentalModelsEnabled && this.mentalModelsLoadPromise && this.mentalModelsLoadedAt === undefined) {
			await Promise.race([this.mentalModelsLoadPromise, Bun.sleep(MENTAL_MODEL_FIRST_TURN_DEADLINE_MS)]);
		}

		if (!this.config.autoRecall || this.hasRecalledForFirstTurn) return undefined;

		const latestPrompt = promptText.trim();
		if (!latestPrompt) return undefined;
		const generation = ++this.#recallGeneration;
		// Reuse this transcript's recall so a resumed session sends the same prompt. Hindsight
		// memories cannot be looked up by id, so changes since are not reported.
		const persisted = findPersistedRecall(this.session.sessionManager, this.#recallScope());
		if (persisted !== undefined) {
			return {
				context: persisted.text || undefined,
				commit: () => this.#commitRecall(generation, persisted.text, false),
			};
		}

		const history = extractMessages(this.session.sessionManager);
		const queryMessages = [...history, { role: "user" as const, content: latestPrompt }];
		const query = composeRecallQuery(latestPrompt, queryMessages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, latestPrompt, this.config.recallMaxQueryChars);
		const { context, ok } = await this.recallForContext(truncated, signal);
		if (!ok) return undefined;

		return {
			context: context ?? undefined,
			commit: () => this.#commitRecall(generation, context ?? "", true),
		};
	}

	/** Adopts a first-turn recall unless a newer turn or reset superseded it; `""` means it found nothing. */
	#commitRecall(generation: number, context: string, persist: boolean): boolean {
		if (this.#recallGeneration !== generation) return false;
		this.hasRecalledForFirstTurn = true;
		if (context) this.lastRecallSnippet = context;
		if (persist) persistRecall(this.session.sessionManager, this.#recallScope(), { text: context, memories: [] });
		return true;
	}

	/**
	 * Identifies the server, account, bank and tag filter a recall reads, so a persisted
	 * recall is only reused for the same ones. The account is a hash of the API token.
	 */
	#recallScope(): string {
		return JSON.stringify([
			"hindsight",
			this.config.hindsightApiUrl,
			Bun.hash(this.config.hindsightApiToken ?? "").toString(16),
			this.bankId,
			this.recallTags ?? [],
			this.recallTagsMatch ?? null,
		]);
	}

	async recallForCompaction(messages: HindsightMessage[]): Promise<string | undefined> {
		const lastUser = messages.findLast(m => m.role === "user");
		if (!lastUser) return undefined;

		const query = composeRecallQuery(lastUser.content, messages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, lastUser.content, this.config.recallMaxQueryChars);
		const { context } = await this.recallForContext(truncated);
		return context ?? undefined;
	}

	async runMentalModelLoad(scope: BankScope): Promise<void> {
		if (!this.config.mentalModelsEnabled) return;
		const generation = ++this.#mentalModelsLoadGeneration;
		const previousSnippet = this.mentalModelsSnippet;
		this.mentalModelsLoadedAt = undefined;

		const bootstrap = (async () => {
			// Create/ensure the bank BEFORE the first mental-model POST so we don't
			// land `createMentalModel` against a bank the server has never seen —
			// that surfaces as a FK / 404 on Hindsight's side. `ensureBankExists`
			// is idempotent (PUT) and skips after the first call via `banksSet`.
			await ensureBankExists(this.client, this.bankId, this.config, this.banksSet);

			// Seeding is opt-in (`hindsight.mentalModelAutoSeed`). Default behaviour is
			// read-only: we surface whatever models the operator has curated on the
			// bank, but we do NOT POST to create new ones unless they explicitly
			// asked. `/memory mm seed` remains the explicit-write entry point.
			if (this.config.mentalModelAutoSeed) {
				const seeds = resolveSeedsForScope(scope, this.config.scoping);
				if (seeds.length > 0) {
					await ensureMentalModels(this.client, this.bankId, seeds, this.config.debug);
				}
			}

			await this.#loadAndPublishMentalModels(generation, previousSnippet, "MM load");
		})();
		await this.#settleMentalModelsLoadWithinDeadline(bootstrap, generation, previousSnippet);
	}

	/**
	 * Starts a bounded reload for a new transcript without blocking the session
	 * transition. A result that misses the first-turn deadline is discarded so
	 * the previous snapshot stays frozen for the whole transcript.
	 */
	beginMentalModelsTranscriptReload(): void {
		if (!this.config.mentalModelsEnabled) return;
		const generation = ++this.#mentalModelsLoadGeneration;
		const previousSnippet = this.mentalModelsSnippet;
		this.mentalModelsLoadedAt = undefined;
		const reload = this.#settleMentalModelsLoadWithinDeadline(
			this.#loadAndPublishMentalModels(generation, previousSnippet, "MM transcript reload"),
			generation,
			previousSnippet,
		).catch(error => {
			if (generation === this.#mentalModelsLoadGeneration) {
				this.mentalModelsSnippet = previousSnippet;
				this.mentalModelsLoadedAt = Date.now();
			}
			logger.debug("Hindsight: mental-model transcript reload failed", { error: String(error) });
		});
		this.mentalModelsLoadPromise = reload;
	}

	async #settleMentalModelsLoadWithinDeadline(
		load: Promise<void>,
		generation: number,
		previousSnippet: string | undefined,
	): Promise<void> {
		const outcome = await Promise.race([
			load,
			Bun.sleep(MENTAL_MODEL_FIRST_TURN_DEADLINE_MS).then(() => MENTAL_MODEL_LOAD_TIMED_OUT),
		]);
		if (outcome !== MENTAL_MODEL_LOAD_TIMED_OUT || generation !== this.#mentalModelsLoadGeneration) return;

		// Invalidate the still-running load before restoring the stable snapshot.
		// SessionTools checks the same generation before committing a prompt build,
		// so a queued publication cannot rewrite the prefix after this deadline.
		this.#mentalModelsLoadGeneration++;
		this.mentalModelsSnippet = previousSnippet;
		this.mentalModelsLoadedAt = Date.now();
	}

	async #loadAndPublishMentalModels(
		generation: number,
		previousSnippet: string | undefined,
		reason: "MM load" | "MM reload" | "MM transcript reload",
	): Promise<void> {
		const result = await tryLoadMentalModelsBlock(
			this.client,
			this.bankId,
			this.config.mentalModelMaxRenderChars,
			this.recallTags,
		);
		if (generation !== this.#mentalModelsLoadGeneration) return;
		if (!result.ok) {
			this.mentalModelsLoadedAt = Date.now();
			return;
		}

		this.mentalModelsSnippet = result.block;
		const published = await this.#refreshBaseSystemPromptAfter(
			reason,
			() => generation === this.#mentalModelsLoadGeneration,
		);
		if (generation !== this.#mentalModelsLoadGeneration) return;
		if (!published) this.mentalModelsSnippet = previousSnippet;
		this.mentalModelsLoadedAt = Date.now();
	}

	async reloadMentalModels(): Promise<boolean> {
		if (this.aliasOf) return false;
		if (!this.config.mentalModelsEnabled) return false;
		const generation = ++this.#mentalModelsLoadGeneration;
		const previousSnippet = this.mentalModelsSnippet;
		await this.#loadAndPublishMentalModels(generation, previousSnippet, "MM reload");
		return generation === this.#mentalModelsLoadGeneration;
	}

	attachSessionListeners(): void {
		this.unsubscribe?.();
		this.unsubscribe = this.session.subscribe(event => {
			if (event.type === "agent_end") {
				this.#startAutomaticRetain();
				// Drain any queued tool-initiated retain calls now that the turn
				// is settled. The queue is also debounced/size-bounded, but
				// flushing here keeps the bank fresh between turns.
				void this.flushRetainQueue();
				// Mental models are deliberately NOT re-listed here. Rewriting the
				// cached <mental_models> block mid-session changes the base system
				// prompt bytes and busts the provider prompt-cache prefix (#11961).
				// The block is frozen for the current transcript — like local-memory
				// guidance after #3745 — so a background reflect applies when the
				// next transcript/session boundary reloads it. `/memory mm reload`
				// stays the explicit in-session invalidation.
			}
		});
	}

	/** Wait for retains that have already started. Does not seal or start a new retain. */
	async awaitPendingAutomaticRetain(): Promise<void> {
		while (this.#automaticRetains.size > 0) {
			await Promise.allSettled(this.#automaticRetains);
		}
	}

	/**
	 * Seal and wait for automatic retains that have already started. Does not
	 * start a retain for turns still under the cadence. Waits for API acceptance
	 * (`async: true`), not server-side extraction.
	 */
	async drainAutomaticRetain(): Promise<void> {
		this.#automaticRetainSealed = true;
		await this.awaitPendingAutomaticRetain();
	}

	dispose(): void {
		this.#automaticRetainSealed = true;
		this.#recallGeneration++;
		this.#mentalModelsLoadGeneration++;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.retainQueue.dispose();
	}

	async #refreshBaseSystemPromptAfter(
		reason: "MM load" | "MM reload" | "MM transcript reload",
		commitIf?: () => boolean,
	): Promise<boolean> {
		try {
			await this.session.refreshBaseSystemPrompt(commitIf);
			return !commitIf || commitIf();
		} catch (err) {
			logger.debug(`Hindsight: refreshBaseSystemPrompt after ${reason} failed`, { error: String(err) });
			return false;
		}
	}
}
