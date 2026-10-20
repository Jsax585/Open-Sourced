import { logger } from "@oh-my-pi/pi-utils";
import { findPersistedRecall, persistRecall } from "../memory-backend/recall-entry";
import type { MemoryPromptPreparation } from "../memory-backend/types";
import type { AgentSession } from "../session/agent-session";
import type { SessionEntry } from "../session/session-entries";
import { type BankScope, computeBankScope, ensureBankExists } from "./bank";
import type { HindsightApi, MemoryItemInput } from "./client";
import type { HindsightConfig } from "./config";
import {
	composeRecallQuery,
	formatMemories,
	type HindsightMessage,
	prepareRetentionTranscript,
	sliceLastTurnsByUserBoundary,
	truncateRecallQuery,
} from "./content";
import {
	ensureMentalModels,
	MENTAL_MODEL_FIRST_TURN_DEADLINE_MS,
	resolveSeedsForScope,
	tryLoadMentalModelsBlock,
} from "./mental-models";
import { extractEntryMessages, extractMessages } from "./transcript";

const RETAIN_FLUSH_BATCH_SIZE = 16;
const RETAIN_FLUSH_INTERVAL_MS = 5_000;
const MENTAL_MODEL_LOAD_TIMED_OUT = Symbol("mental-model-load-timed-out");
const RETENTION_SEGMENT_TYPE = "hindsight_retention_segment";
const RETENTION_DOCUMENT_TYPE = "hindsight_retention_document";

interface RetentionSegment {
	documentId: string;
	sessionId: string;
	sourceTimestamp?: string;
	bankId: string;
	tags?: string[];
}

interface RetentionDocument {
	segmentId: string;
	sessionId: string;
	documentId: string;
	messageCount: number;
	prefixKey: string;
	userTurns: number;
	deleted?: boolean;
}

interface SegmentTranscript {
	segment: RetentionSegment;
	entries: SessionEntry[];
	documents: Map<string, RetentionDocument>;
	documentHistory: Map<string, RetentionDocument[]>;
}

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
	#retentionTransition: Promise<void> = Promise.resolve();
	#cachedDocumentId?: string;
	#finishedRetentionScope?: { sessionId: string; leafId: string | null };
	#finishingRetentionScope?: Promise<void>;

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
	}

	setSessionId(sessionId: string): void {
		if (this.sessionId !== sessionId) this.#recallGeneration++;
		this.sessionId = sessionId;
		this.#lastRetainedMessageIndex = 0;
		this.#cachedTranscript = "";
		this.#lastRetainedPrefixKey = "";
	}

	resetConversationTracking(): void {
		this.#recallGeneration++;
		this.lastRetainedTurn = 0;
		this.hasRecalledForFirstTurn = false;
		this.lastRecallSnippet = undefined;
		this.#lastRetainedMessageIndex = 0;
		this.#cachedTranscript = "";
		this.#lastRetainedPrefixKey = "";
	}

	enqueueRetain(content: string, context?: string): void {
		this.retainQueue.enqueue(content, context);
	}

	/** Drain tool writes and conversation-source receipts before replacing or releasing the ledger. */
	async flushRetainQueue(): Promise<void> {
		await this.retainQueue.flush();
		await this.#retentionTransition;
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

	/** Retains a conversation snapshot, reusing a source id when repairing a deleted document. */
	async retainSession(
		messages: HindsightMessage[],
		target?: RetentionSegment,
		options?: { documentId?: string },
	): Promise<string | undefined> {
		const retainedAt = new Date();
		const sourceTimestamp =
			(target?.sourceTimestamp ? new Date(target.sourceTimestamp) : this.#sessionSourceTimestamp()) ?? retainedAt;
		const retainFullWindow = this.config.retainMode === "full-session";
		let documentId: string;
		let transcript: string;
		let nextCachedTranscript: string | undefined;
		let prefixKey = "";
		let hashedThrough = 0;

		if (retainFullWindow) {
			documentId = target?.documentId ?? this.sessionId;
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
			const window = sliceLastTurnsByUserBoundary(messages, windowTurns);
			documentId = options?.documentId ?? `${target?.documentId ?? this.sessionId}-${crypto.randomUUID()}`;
			this.#lastRetainedMessageIndex = 0;
			this.#cachedTranscript = "";
			this.#lastRetainedPrefixKey = "";
			const { transcript: windowTranscript } = prepareRetentionTranscript(window, true, { includeTimestamps: true });
			if (!windowTranscript) return;
			transcript = windowTranscript;
		}

		const bankId = target?.bankId ?? this.bankId;
		await ensureBankExists(this.client, bankId, this.config, this.banksSet);
		await this.client.retain(bankId, transcript, {
			documentId,
			context: this.config.retainContext,
			metadata: {
				session_id: target?.sessionId ?? this.sessionId,
				segment_id: target?.documentId ?? this.sessionId,
			},
			tags: target ? target.tags : this.retainTags,
			updateMode: "replace",
			timestamp: sourceTimestamp,
			async: true,
		});
		if (nextCachedTranscript !== undefined) {
			this.#cachedTranscript = nextCachedTranscript;
			// prefixKey hashes [0, hashedThrough) of this same snapshot; extend it instead of rehashing from 0.
			this.#lastRetainedPrefixKey = extendRetentionPrefixKey(prefixKey, messages, hashedThrough, messages.length);
			this.#lastRetainedMessageIndex = messages.length;
		}
		return documentId;
	}

	bindRetentionScope(): void {
		const manager = this.session.sessionManager;
		const sessionId = manager.getSessionId();
		const entries = manager.getEntries();
		const record = entries.findLast(entry => entry.type === "custom" && entry.customType === RETENTION_SEGMENT_TYPE);
		const current = record?.type === "custom" ? (record.data as RetentionSegment) : undefined;
		if (current && current.bankId === this.bankId && Bun.deepEquals(current.tags, this.retainTags)) return;
		manager.appendCustomEntry(RETENTION_SEGMENT_TYPE, {
			documentId: current ? `${sessionId}-${crypto.randomUUID()}` : sessionId,
			sessionId,
			bankId: this.bankId,
			tags: this.retainTags,
			sourceTimestamp: current ? new Date().toISOString() : this.#sessionSourceTimestamp()?.toISOString(),
		} satisfies RetentionSegment);
	}

	async prepareForCwdMove(newCwd: string): Promise<void> {
		const next = computeBankScope(this.config, newCwd);
		if (next.bankId === this.bankId && Bun.deepEquals(next.retainTags, this.retainTags)) return;
		await this.finishRetentionScope();
	}

	/** Finish an unchanged outgoing ledger once, including overlapping move/rebuild handoffs. */
	async finishRetentionScope(): Promise<void> {
		if (this.aliasOf || !this.config.autoRetain) return;
		while (this.#finishingRetentionScope) await this.#finishingRetentionScope;
		const manager = this.session.sessionManager;
		const sessionId = manager.getSessionId();
		const leafId = manager.getLeafId();
		if (this.#finishedRetentionScope?.sessionId === sessionId && this.#finishedRetentionScope.leafId === leafId)
			return;
		const finishing = this.#retainSelectedSegments(true);
		this.#finishingRetentionScope = finishing;
		try {
			await finishing;
			this.#finishedRetentionScope = { sessionId, leafId: manager.getLeafId() };
		} finally {
			this.#finishingRetentionScope = undefined;
		}
	}

	#segmentTranscripts(): SegmentTranscript[] {
		const manager = this.session.sessionManager;
		const sessionId = manager.getSessionId();
		const entries = manager.getEntries();
		const segments: SegmentTranscript[] = [];
		const byId = new Map<string, SegmentTranscript>();
		const branch = new Set(manager.getBranch().map(entry => entry.id));
		let active: SegmentTranscript | undefined;
		const initialEntries: SessionEntry[] = [];
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === RETENTION_SEGMENT_TYPE) {
				const source = entry.data as RetentionSegment;
				const documentId = source.sessionId === sessionId ? source.documentId : `${sessionId}-${source.documentId}`;
				const segment = { ...source, documentId, sessionId };
				active = byId.get(documentId);
				if (!active) {
					active = { segment, entries: [], documents: new Map(), documentHistory: new Map() };
					if (segments.length === 0) active.entries = initialEntries;
					segments.push(active);
					byId.set(documentId, active);
				}
			} else if (entry.type === "custom" && entry.customType === RETENTION_DOCUMENT_TYPE) {
				const document = entry.data as RetentionDocument;
				if (document.sessionId !== sessionId) continue;
				const transcript = byId.get(document.segmentId);
				if (!transcript) continue;
				transcript.documents.set(document.documentId, document);
				let history = transcript.documentHistory.get(document.documentId);
				if (!history) transcript.documentHistory.set(document.documentId, (history = []));
				history.push(document);
			} else if (entry.type === "message" && branch.has(entry.id)) {
				(active?.entries ?? initialEntries).push(entry);
			}
		}
		return segments;
	}

	async #retainSelectedSegments(force = false, invalidationOnly = false): Promise<void> {
		const run = this.#retentionTransition.then(async () => {
			this.bindRetentionScope();
			const segments = this.#segmentTranscripts();
			for (const [index, { segment, entries, documents, documentHistory }] of segments.entries()) {
				const messages = extractEntryMessages(entries);
				const userTurns = messages.reduce((count, message) => count + Number(message.role === "user"), 0);
				let lastRetainedTurn = 0;
				let lastRetainedMessageCount = 0;
				let invalidated = false;
				const deletedDocuments: RetentionDocument[] = [];
				const prefixKeys = new Map<number, string>();
				for (const history of documentHistory.values()) {
					for (const document of history) prefixKeys.set(document.messageCount, "");
				}
				let prefixKey = "";
				for (let i = 0; i < messages.length; i++) {
					prefixKey = extendRetentionPrefixKey(prefixKey, messages, i, i + 1);
					if (prefixKeys.has(i + 1)) prefixKeys.set(i + 1, prefixKey);
				}
				for (let document of documents.values()) {
					let unchanged =
						document.messageCount <= messages.length &&
						prefixKeys.get(document.messageCount) === document.prefixKey;
					// A replacement reuses its source id, but older receipts still describe
					// previously retained suffixes that navigation is allowed to restore.
					let restore: RetentionDocument | undefined;
					for (const previous of documentHistory.get(document.documentId) ?? []) {
						if (
							previous.deleted ||
							previous.messageCount > messages.length ||
							prefixKeys.get(previous.messageCount) !== previous.prefixKey ||
							(!document.deleted && unchanged && previous.messageCount <= document.messageCount) ||
							(restore && previous.messageCount <= restore.messageCount)
						)
							continue;
						restore = previous;
					}
					if (restore) {
						this.#lastRetainedMessageIndex = 0;
						this.#cachedTranscript = "";
						this.#lastRetainedPrefixKey = "";
						this.#cachedDocumentId = segment.documentId;
						const restoredId = await this.retainSession(messages.slice(0, restore.messageCount), segment, {
							documentId: document.documentId,
						});
						if (!restoredId) continue;
						document = { ...restore, deleted: false };
						this.session.sessionManager.appendCustomEntry(RETENTION_DOCUMENT_TYPE, document);
						unchanged = true;
					}
					if (document.deleted) continue;
					if (unchanged) {
						lastRetainedTurn = Math.max(lastRetainedTurn, document.userTurns);
						lastRetainedMessageCount = Math.max(lastRetainedMessageCount, document.messageCount);
						continue;
					}
					invalidated = true;
					if (
						this.config.retainMode !== "full-session" ||
						document.documentId !== segment.documentId ||
						messages.length === 0
					) {
						await this.client.deleteDocument(segment.bankId, document.documentId);
						deletedDocuments.push(document);
					}
				}
				const active = index === segments.length - 1;
				if (active) this.lastRetainedTurn = lastRetainedTurn;
				const due = active && !invalidationOnly && userTurns - lastRetainedTurn >= this.config.retainEveryNTurns;
				const needsRepair = invalidated && lastRetainedMessageCount < messages.length;
				if (messages.length > 0 && (needsRepair || due || (force && (active || documents.size === 0)))) {
					if (this.#cachedDocumentId !== segment.documentId || invalidated || force) {
						this.#lastRetainedMessageIndex = 0;
						this.#cachedTranscript = "";
						this.#lastRetainedPrefixKey = "";
						this.#cachedDocumentId = segment.documentId;
					}
					const documentId = await this.retainSession(messages, segment);
					if (!documentId) continue;
					this.session.sessionManager.appendCustomEntry(RETENTION_DOCUMENT_TYPE, {
						segmentId: segment.documentId,
						sessionId: segment.sessionId,
						documentId,
						messageCount: messages.length,
						prefixKey,
						userTurns,
					} satisfies RetentionDocument);
					if (active) this.lastRetainedTurn = userTurns;
				}
				// Keep invalid receipts retryable until the replacement has succeeded.
				// Repeating an already successful DELETE is safe (404 is accepted).
				for (const document of deletedDocuments) {
					this.session.sessionManager.appendCustomEntry(RETENTION_DOCUMENT_TYPE, {
						...document,
						deleted: true,
					} satisfies RetentionDocument);
				}
			}
			const active = segments.at(-1)?.segment;
			if (
				active &&
				!this.session.sessionManager
					.getBranch()
					.some(
						entry =>
							entry.type === "custom" &&
							entry.customType === RETENTION_SEGMENT_TYPE &&
							(entry.data as RetentionSegment).documentId === active.documentId,
					)
			) {
				this.session.sessionManager.appendCustomEntry(RETENTION_SEGMENT_TYPE, active);
			}
		});
		this.#retentionTransition = run.catch(() => {});
		await run;
	}

	/** Repairs tracked sources without letting a remote failure reject a committed local navigation. */
	async synchronizeRetainedBranch(): Promise<void> {
		if (this.aliasOf || !this.config.autoRetain) return;
		try {
			await this.#retainSelectedSegments(false, true);
		} catch (err) {
			logger.warn("Hindsight: branch reconciliation failed", {
				sessionId: this.sessionId,
				bankId: this.bankId,
				error: String(err),
			});
		}
	}

	async maybeRetainOnAgentEnd(): Promise<void> {
		if (!this.config.autoRetain) return;
		try {
			await this.#retainSelectedSegments();
		} catch (err) {
			logger.warn("Hindsight: auto-retain failed", {
				sessionId: this.sessionId,
				bankId: this.bankId,
				error: String(err),
			});
		}
	}

	async forceRetainCurrentSession(): Promise<void> {
		try {
			await this.#retainSelectedSegments(true);
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
				void this.maybeRetainOnAgentEnd();
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

	dispose(): void {
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
