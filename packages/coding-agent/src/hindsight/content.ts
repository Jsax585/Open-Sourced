/**
 * Pure content utilities for the Hindsight backend.
 *
 * Ports the semantics of the upstream OpenCode plugin
 * (vectorize-io/hindsight @ hindsight-integrations/opencode/src/content.ts):
 *   - tag stripping for anti-feedback (a recalled <memories> block must
 *     never end up retained as a new memory)
 *   - recall query composition + truncation under a character budget
 *   - retention transcript framing
 */

/** Role for a native ask picker receipt. A UI participant response, not a typed turn and not assistant prose. */
export const HINDSIGHT_UI_RECEIPT_ROLE = "ui-receipt";

export type HindsightAskReceiptKind = "selection" | "custom" | "selection-and-custom" | "none";

/**
 * Assistant-offered description of a selected label. Not participant-authored.
 * A receipt does not by itself establish identity or implementation.
 */
export interface HindsightAskReceiptScope {
	label: string;
	description: string;
}

/**
 * Why an ask UI receipt was accepted. Present only on receipts.
 * A match is not identity proof: `authorUI` means the primary session's ask picker, not a named person.
 */
export interface HindsightAskReceiptConditions {
	kind: HindsightAskReceiptKind;
	/** Offered labels the picker recorded, in picker order. Empty for custom-only or explicit none. */
	selected: string[];
	/** Picker recorded custom text, which is not a predefined selection. */
	custom: boolean;
	/** Offered question allowed more than one predefined selection. */
	multi: boolean;
	/** Index of the question in the matched ask call. */
	questionIndex: number;
	/** Kept labels were offered by the matched call. */
	matchedOffered: true;
	notError: true;
	notTimeout: true;
	notCancelled: true;
	notMalformed: true;
	/** Journal is a primary session, not a child `session_init` transcript. */
	primary: true;
	/** Response came from the ask picker, not a typed chat turn. */
	authorUI: true;
	/** Assistant-offered recommendation label, when the call named a valid recommended index. */
	recommendation?: string;
	/** Offered labels the picker did not select, in offered order. */
	unselected: string[];
	/** Assistant-offered descriptions of selected labels, in selection order. */
	selectedScope: HindsightAskReceiptScope[];
}

export interface HindsightMessage {
	role: string;
	content: string;
	/** Original SessionEntry.timestamp; omitted when the source had none. */
	timestamp?: string;
	/** Session entry that produced this record. Optional so existing callers stay valid. */
	entryId?: string;
	/** Ask tool call this UI receipt answers. */
	toolCallId?: string;
	/** Offered question id this UI receipt answers. */
	questionId?: string;
	/** Acceptance record for a UI receipt. Absent on ordinary turns. */
	conditions?: HindsightAskReceiptConditions;
}

export interface RecallResultLike {
	text: string;
	type?: string | null;
	mentioned_at?: string | null;
}

const MEMORIES_REGEX = /<memories>[\s\S]*?<\/memories>/g;
const LEGACY_HINDSIGHT_MEMORIES_REGEX = /<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g;
const LEGACY_RELEVANT_MEMORIES_REGEX = /<relevant_memories>[\s\S]*?<\/relevant_memories>/g;
const MENTAL_MODELS_REGEX = /<mental_models>[\s\S]*?<\/mental_models>/g;

const RETENTION_PROTOCOL_MARKER_REGEX = /^\[(?:role:\s*[-_a-zA-Z0-9]+|[-_a-zA-Z0-9]+:end|timestamp:\s+.+)\]$/;
/**
 * Strip `<memories>`, `<mental_models>`, and legacy memory blocks.
 *
 * Both `<memories>` (per-turn recall) and `<mental_models>` (curated semantic
 * memory) are injected into the system prompt. If either leaks into the
 * retention transcript, every retain becomes a tighter feedback loop —
 * paraphrased memories feed the next consolidation, which feeds the next
 * mental-model refresh, which feeds the next retain. Always strip before
 * retaining.
 */
export function stripMemoryTags(content: string): string {
	return content
		.replace(MEMORIES_REGEX, "")
		.replace(MENTAL_MODELS_REGEX, "")
		.replace(LEGACY_HINDSIGHT_MEMORIES_REGEX, "")
		.replace(LEGACY_RELEVANT_MEMORIES_REGEX, "");
}

// At least one letter or digit means the message carries a token a retriever
// can actually match on. Punctuation/whitespace-only strings (e.g. the lone
// `.` some providers emit for tool-call-only or thinking-only assistant turns)
// are dropped before retain/recall touches them — see issue #1806.
const SUBSTANTIVE_CHAR_RE = /[\p{L}\p{N}]/u;

/**
 * True when `content` carries at least one letter or digit. Used by retain
 * and recall paths to drop placeholder assistant turns ("." / "..." / pure
 * whitespace) that would otherwise pollute the bank and waste tokens on
 * embeddings with no semantic content.
 */
export function hasSubstantiveContent(content: string): boolean {
	return SUBSTANTIVE_CHAR_RE.test(content);
}

/** Format recall results into a bullet list for context injection. */
export function formatMemories(results: RecallResultLike[]): string {
	if (results.length === 0) return "";
	return results
		.map(r => {
			const typeStr = r.type ? ` [${r.type}]` : "";
			const dateStr = r.mentioned_at ? ` (${r.mentioned_at})` : "";
			return `- ${r.text}${typeStr}${dateStr}`;
		})
		.join("\n\n");
}

/** Format current UTC time for the recall preamble. */
export function formatCurrentTime(now: Date = new Date()): string {
	const y = now.getUTCFullYear();
	const m = String(now.getUTCMonth() + 1).padStart(2, "0");
	const d = String(now.getUTCDate()).padStart(2, "0");
	const h = String(now.getUTCHours()).padStart(2, "0");
	const min = String(now.getUTCMinutes()).padStart(2, "0");
	return `${y}-${m}-${d} ${h}:${min}`;
}

/**
 * Slice messages to the last N turns, where a turn boundary is a user message.
 * Returns the trailing tail starting at the (N-th from the end) user message.
 */
export function sliceLastTurnsByUserBoundary(messages: HindsightMessage[], turns: number): HindsightMessage[] {
	if (messages.length === 0 || turns <= 0) return [];

	let userTurnsSeen = 0;
	let startIndex = -1;

	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			userTurnsSeen += 1;
			if (userTurnsSeen >= turns) {
				startIndex = i;
				break;
			}
		}
	}

	return startIndex === -1 ? [...messages] : messages.slice(startIndex);
}

/**
 * Compose a recall query from the latest user prompt plus optional prior context.
 *
 * When `recallContextTurns <= 1` the query is just the trimmed latest prompt.
 * Otherwise we prepend a `Prior context:` block built from the trailing
 * `recallContextTurns` user-bounded turns (memory tags stripped, latest prompt
 * suppressed to avoid duplicating it inside the context block).
 */
export function composeRecallQuery(
	latestQuery: string,
	messages: HindsightMessage[],
	recallContextTurns: number,
): string {
	const latest = latestQuery.trim();
	if (recallContextTurns <= 1 || messages.length === 0) return latest;

	const contextual = sliceLastTurnsByUserBoundary(messages, recallContextTurns);
	const contextLines: string[] = [];

	for (const msg of contextual) {
		const content = stripMemoryTags(msg.content).trim();
		if (!content) continue;
		if (msg.role === "user" && content === latest) continue;
		contextLines.push(`${msg.role}: ${content}`);
	}

	if (contextLines.length === 0) return latest;
	return ["Prior context:", contextLines.join("\n"), latest].join("\n\n");
}

/**
 * Truncate a composed recall query to `maxChars`.
 *
 * Always preserves the latest user message. Drops oldest context lines first
 * and degrades gracefully when even the latest message exceeds the budget.
 */
export function truncateRecallQuery(query: string, latestQuery: string, maxChars: number): string {
	if (maxChars <= 0 || query.length <= maxChars) return query;

	const latest = latestQuery.trim();
	const latestOnly = latest.length > maxChars ? latest.slice(0, maxChars) : latest;

	if (!query.includes("Prior context:")) return latestOnly;

	const contextMarker = "Prior context:\n\n";
	const markerIndex = query.indexOf(contextMarker);
	if (markerIndex === -1) return latestOnly;

	const suffix = `\n\n${latest}`;
	const suffixIndex = query.lastIndexOf(suffix);
	if (suffixIndex === -1) return latestOnly;
	if (suffix.length >= maxChars) return latestOnly;

	const contextBody = query.slice(markerIndex + contextMarker.length, suffixIndex);
	const contextLines = contextBody.split("\n").filter(Boolean);

	const kept: string[] = [];
	for (let i = contextLines.length - 1; i >= 0; i--) {
		kept.unshift(contextLines[i]);
		const candidate = `${contextMarker}${kept.join("\n")}${suffix}`;
		if (candidate.length > maxChars) {
			kept.shift();
			break;
		}
	}

	if (kept.length > 0) return `${contextMarker}${kept.join("\n")}${suffix}`;
	return latestOnly;
}

export interface RetentionTranscript {
	transcript: string | null;
	messageCount: number;
}

/**
 * Format messages into a retention transcript using `[role: ...]` markers.
 *
 * - When `retainFullWindow` is true, all messages are included (used when the
 *   caller pre-sliced the window itself).
 * - Otherwise, only the last user turn (last user message → end) is retained.
 *
 * Messages are tag-stripped before framing to break the recall→retain loop.
 * Returns `{ transcript: null }` when nothing meaningful survives.
 */
function formatRetentionMessage(msg: HindsightMessage, includeTimestamps = false): string | null {
	const content = stripMemoryTags(msg.content).trim();
	if (!hasSubstantiveContent(content)) return null;
	const header = `[role: ${msg.role}]`;
	const timestamp = includeTimestamps ? msg.timestamp?.trim() : undefined;
	const stamped = timestamp ? `${header}\n[timestamp: ${timestamp}]` : header;
	return `${stamped}\n${content}\n[${msg.role}:end]`;
}

function formatRetentionMessages(messages: HindsightMessage[], includeTimestamps = false): RetentionTranscript {
	const parts: string[] = [];
	for (const msg of messages) {
		const formatted = formatRetentionMessage(msg, includeTimestamps);
		if (formatted) parts.push(formatted);
	}

	if (parts.length === 0) return { transcript: null, messageCount: 0 };

	const transcript = parts.join("\n\n");
	if (transcript.trim().length < 10) return { transcript: null, messageCount: 0 };

	return { transcript, messageCount: parts.length };
}

function formatEmbeddableRetentionMessages(messages: HindsightMessage[]): RetentionTranscript {
	const parts: string[] = [];
	for (const msg of messages) {
		const content = stripRetentionProtocolMarkers(stripMemoryTags(msg.content)).trim();
		if (!hasSubstantiveContent(content)) continue;
		parts.push(content);
	}

	if (parts.length === 0) return { transcript: null, messageCount: 0 };

	const transcript = parts.join("\n\n");
	if (transcript.trim().length < 10) return { transcript: null, messageCount: 0 };

	return { transcript, messageCount: parts.length };
}

/** Remove retention framing lines from a stored coding-agent episode transcript. */
export function stripRetentionProtocolMarkers(content: string): string {
	return content
		.split(/\r?\n/)
		.filter(line => !RETENTION_PROTOCOL_MARKER_REGEX.test(line.trim()))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function prepareRetentionTranscript(
	messages: HindsightMessage[],
	retainFullWindow = false,
	options?: { includeTimestamps?: boolean },
): RetentionTranscript {
	if (messages.length === 0) return { transcript: null, messageCount: 0 };

	let targetMessages: HindsightMessage[];
	if (retainFullWindow) {
		targetMessages = messages;
	} else {
		let lastUserIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				lastUserIdx = i;
				break;
			}
		}
		if (lastUserIdx === -1) return { transcript: null, messageCount: 0 };
		targetMessages = messages.slice(lastUserIdx);
	}

	return formatRetentionMessages(targetMessages, options?.includeTimestamps === true);
}

/** Format all retention messages without protocol markers for embedding, FTS, and recall display. */
export function prepareEmbeddableRetentionTranscript(messages: HindsightMessage[]): RetentionTranscript {
	return formatEmbeddableRetentionMessages(messages);
}
/** Format only user-authored messages for memory fact/entity extraction. */
export function prepareUserRetentionTranscript(messages: HindsightMessage[]): RetentionTranscript {
	return formatRetentionMessages(messages.filter(message => message.role === "user"));
}
