/**
 * Pull conversation records out of a session manager.
 *
 * User and assistant `{role, content, timestamp}` records stay the internal
 * conversation shape. Tool calls, bash results, custom messages, and other
 * non-turns are still dropped. A native `ask` tool result is the exception:
 * when it matches the preceding ask call in a primary session, each accepted
 * question becomes a `ui-receipt`. That receipt is a UI participant response.
 * It is not a typed user turn, not assistant prose, and by itself it does not
 * establish identity or implementation.
 */

import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionEntry, SessionMessageEntry } from "../session/session-entries";
import {
	HINDSIGHT_UI_RECEIPT_ROLE,
	type HindsightAskReceiptConditions,
	type HindsightAskReceiptKind,
	type HindsightAskReceiptScope,
	type HindsightMessage,
	hasSubstantiveContent,
} from "./content";

export interface ReadonlySessionManagerLike {
	getEntries(): SessionEntry[];
}

const TIMEOUT_MARKER = "(auto-selected after timeout)";
const CANCEL_MARKERS = ["Ask tool was cancelled", "Ask input was cancelled", "User cancelled the selection"];
const CHILD_ALIAS_KEYS = ["alias", "extractedToolData", "inflightTaskDetails", "agent"] as const;
const CONDITIONS_LINE =
	"Conditions: matched ask call; matched offered question; primary session; no child alias; not error; not timeout; not cancelled; not malformed; authorUI not typed.";

interface OfferedQuestion {
	id: string;
	question: string;
	labels: string[];
	/** Assistant-offered description by label. Absent when the option had none. */
	descriptions: Readonly<Record<string, string>>;
	labelSet: ReadonlySet<string>;
	multi: boolean;
	index: number;
	recommendation?: string;
}

interface RawAnswer {
	id?: string;
	question?: string;
	selectedOptions: string[];
	options?: string[];
	multi?: boolean;
	customInput?: string;
	note?: string;
	timedOut: boolean;
}

/**
 * Walk session entries top-to-bottom, returning user, assistant, and accepted ask receipts.
 *
 * Ordinary turns are unchanged: only user and assistant text is kept, thinking and
 * tool-call blocks stay dropped, and `countUserTurns` still counts user text only.
 * Ask receipts are inserted at the tool-result entry, after the call that offered them.
 */
export function extractMessages(sessionManager: ReadonlySessionManagerLike): HindsightMessage[] {
	const entries = sessionManager.getEntries();
	const childJournal = isChildJournal(entries);
	const calls = new Map<string, OfferedQuestion[]>();
	const messages: HindsightMessage[] = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role === "assistant") indexAskCalls(msg, calls);
		if (!childJournal && isAskToolResult(msg)) {
			for (const receipt of extractAskReceipts(entry, msg, calls)) messages.push(receipt);
			continue;
		}
		if (msg.role !== "user" && msg.role !== "assistant") continue;

		const text = msg.role === "user" ? extractUserText(msg) : extractAssistantText(msg);
		if (!hasSubstantiveContent(text)) continue;
		messages.push({ role: msg.role, content: text, timestamp: entry.timestamp, entryId: entry.id });
	}

	return messages;
}

/**
 * Count user turns exactly as `extractMessages(sessionManager).filter(m => m.role === "user").length`,
 * without extracting assistant text or allocating the message list. Not memoized: messages may be
 * rewritten in place (e.g. image stripping), so each call re-inspects current content.
 * Ask UI receipts are not user turns and are not counted here.
 */
export function countUserTurns(sessionManager: ReadonlySessionManagerLike): number {
	let count = 0;
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		if (hasSubstantiveContent(extractUserText(entry.message))) count++;
	}
	return count;
}

function isChildJournal(entries: readonly SessionEntry[]): boolean {
	for (const entry of entries) {
		if (entry.type === "session_init") return true;
		if (entry.type === "custom" && entry.customType === "source_session_init") return true;
	}
	return false;
}

function isAskToolResult(message: SessionMessageEntry["message"]): message is ToolResultMessage {
	return message.role === "toolResult" && message.toolName === "ask";
}

function indexAskCalls(message: AssistantMessage, calls: Map<string, OfferedQuestion[]>): void {
	for (const block of message.content) {
		if (block.type !== "toolCall" || block.name !== "ask") continue;
		if (block.id.length === 0) continue;
		const questions = parseOfferedQuestions(block.arguments);
		if (!questions) continue;
		calls.set(block.id, questions);
	}
}

function extractAskReceipts(
	entry: SessionMessageEntry,
	message: ToolResultMessage,
	calls: ReadonlyMap<string, OfferedQuestion[]>,
): HindsightMessage[] {
	if (message.isError !== false) return [];
	const toolCallId = message.toolCallId;
	if (toolCallId.length === 0) return [];
	const offered = calls.get(toolCallId);
	if (!offered) return [];

	const text = toolResultText(message.content);
	if (CANCEL_MARKERS.some(marker => text.includes(marker))) return [];
	if (!isRecord(message.details)) return [];
	const details = message.details;
	if (details.chatRedirect === true) return [];
	if (CHILD_ALIAS_KEYS.some(key => details[key] !== undefined)) return [];

	const answers = parseAnswers(details);
	if (!answers) return [];

	const used = new Set<number>();
	const accepted: AcceptedAnswer[] = [];
	for (const answer of answers) {
		if (answerTimedOut(answer, text, answers.length)) continue;
		const question = matchQuestion(offered, answer, used);
		if (!question || !consistentWithCall(question, answer)) continue;
		const custom = answer.customInput;
		const note = answer.note;
		const selected = selectionSet(question, answer.selectedOptions);
		if (selected === undefined || (!question.multi && selected.length > 1)) {
			if (custom === undefined) continue;
			used.add(question.index);
			accepted.push({ question, selected: [], custom, note, kind: "custom", selectedScope: [] });
			continue;
		}
		const explicitNone = question.multi && selected.length === 0 && custom === undefined;
		if (selected.length === 0 && custom === undefined && !explicitNone) continue;
		used.add(question.index);
		accepted.push({
			question,
			selected,
			custom,
			note,
			kind: receiptKind(selected, custom, explicitNone),
			selectedScope: scopeFor(question, selected),
		});
	}

	accepted.sort((left, right) => left.question.index - right.question.index);
	const receipts: HindsightMessage[] = [];
	for (const answer of accepted) {
		const content = formatReceipt(entry.id, toolCallId, entry.timestamp, answer);
		if (!hasSubstantiveContent(content)) continue;
		receipts.push({
			role: HINDSIGHT_UI_RECEIPT_ROLE,
			content,
			timestamp: entry.timestamp,
			entryId: entry.id,
			toolCallId,
			questionId: answer.question.id,
			conditions: receiptConditions(answer),
		});
	}
	return receipts;
}

interface AcceptedAnswer {
	question: OfferedQuestion;
	selected: string[];
	custom?: string;
	note?: string;
	kind: HindsightAskReceiptKind;
	selectedScope: HindsightAskReceiptScope[];
}

function extractUserText(msg: { content: unknown }): string {
	const content = msg.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

function extractAssistantText(msg: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of msg.content) {
		if (block.type === "text" && block.text) parts.push(block.text);
	}
	return parts.join("\n");
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function quote(value: string): string {
	return JSON.stringify(value);
}

/**
 * Persisted ask call shape: `arguments.questions[]` with `id`, `question`,
 * `options[].label`, optional `multi` and `recommended`. A call that does not
 * parse is not registered, so its result cannot match.
 */
function parseOfferedQuestions(args: unknown): OfferedQuestion[] | undefined {
	if (!isRecord(args) || !Array.isArray(args.questions) || args.questions.length === 0) return undefined;
	const questions: OfferedQuestion[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < args.questions.length; index++) {
		const raw = args.questions[index];
		if (!isRecord(raw)) return undefined;
		if (typeof raw.id !== "string" || raw.id.length === 0) return undefined;
		if (typeof raw.question !== "string") return undefined;
		if (seen.has(raw.id)) return undefined;
		seen.add(raw.id);
		if (raw.multi !== undefined && typeof raw.multi !== "boolean") return undefined;
		const parsed = parseOptions(raw.options);
		if (!parsed) return undefined;
		questions.push({
			id: raw.id,
			question: raw.question,
			labels: parsed.labels,
			descriptions: parsed.descriptions,
			labelSet: new Set(parsed.labels),
			multi: raw.multi === true,
			index,
			recommendation:
				typeof raw.recommended === "number" &&
				Number.isInteger(raw.recommended) &&
				raw.recommended >= 0 &&
				raw.recommended < parsed.labels.length
					? parsed.labels[raw.recommended]
					: undefined,
		});
	}
	return questions;
}

function parseOptions(raw: unknown): { labels: string[]; descriptions: Record<string, string> } | undefined {
	if (!Array.isArray(raw)) return undefined;
	const labels: string[] = [];
	const descriptions: Record<string, string> = {};
	for (const entry of raw) {
		if (typeof entry === "string") {
			if (entry.length === 0 || labels.includes(entry)) return undefined;
			labels.push(entry);
			continue;
		}
		if (!isRecord(entry) || typeof entry.label !== "string" || entry.label.length === 0) return undefined;
		if (entry.description !== undefined && typeof entry.description !== "string") return undefined;
		if (labels.includes(entry.label)) return undefined;
		labels.push(entry.label);
		const description = typeof entry.description === "string" ? entry.description.trim() : "";
		if (description.length > 0) descriptions[entry.label] = description;
	}
	return { labels, descriptions };
}

function parseAnswers(details: Record<string, unknown>): RawAnswer[] | undefined {
	if ("results" in details) {
		if (!Array.isArray(details.results)) return undefined;
		const answers: RawAnswer[] = [];
		for (const item of details.results) {
			const parsed = parseOneAnswer(item, true);
			if (!parsed) return undefined;
			answers.push(parsed);
		}
		return answers;
	}
	const parsed = parseOneAnswer(details, false);
	return parsed ? [parsed] : undefined;
}

function parseOneAnswer(value: unknown, requireId: boolean): RawAnswer | undefined {
	if (!isRecord(value)) return undefined;
	if (!isStringArray(value.selectedOptions)) return undefined;
	if (value.options !== undefined && !isStringArray(value.options)) return undefined;
	if (value.customInput !== undefined && typeof value.customInput !== "string") return undefined;
	if (value.note !== undefined && typeof value.note !== "string") return undefined;
	if (value.question !== undefined && typeof value.question !== "string") return undefined;
	if (value.timedOut !== undefined && typeof value.timedOut !== "boolean") return undefined;
	if (value.multi !== undefined && typeof value.multi !== "boolean") return undefined;
	if (value.id !== undefined && typeof value.id !== "string") return undefined;
	if (requireId && (typeof value.id !== "string" || value.id.length === 0)) return undefined;
	return {
		id: typeof value.id === "string" && value.id.length > 0 ? value.id : undefined,
		question: typeof value.question === "string" ? value.question : undefined,
		selectedOptions: value.selectedOptions,
		...(isStringArray(value.options) ? { options: value.options } : {}),
		...(typeof value.multi === "boolean" ? { multi: value.multi } : {}),
		customInput:
			typeof value.customInput === "string" && value.customInput.trim().length > 0
				? value.customInput.trim()
				: undefined,
		note: typeof value.note === "string" && value.note.trim().length > 0 ? value.note.trim() : undefined,
		timedOut: value.timedOut === true,
	};
}

function matchQuestion(
	offered: readonly OfferedQuestion[],
	answer: RawAnswer,
	used: ReadonlySet<number>,
): OfferedQuestion | undefined {
	if (answer.id !== undefined) {
		const found = offered.find(question => question.id === answer.id);
		if (!found || used.has(found.index)) return undefined;
		if (answer.question !== undefined && answer.question !== found.question) return undefined;
		return found;
	}
	if (answer.question === undefined) return undefined;
	const matches = offered.filter(question => question.question === answer.question && !used.has(question.index));
	return matches.length === 1 ? matches[0] : undefined;
}

/** Undefined when any value is not offered or is repeated. Does not drop those values. */
function selectionSet(question: OfferedQuestion, selected: readonly string[]): string[] | undefined {
	const seen = new Set<string>();
	for (const value of selected) {
		if (!question.labelSet.has(value) || seen.has(value)) return undefined;
		seen.add(value);
	}
	return [...selected];
}

function consistentWithCall(question: OfferedQuestion, answer: RawAnswer): boolean {
	if (answer.multi !== undefined && answer.multi !== question.multi) return false;
	const options = answer.options;
	if (options === undefined) return true;
	if (options.length !== question.labels.length) return false;
	for (let index = 0; index < options.length; index++) {
		if (options[index] !== question.labels[index]) return false;
	}
	return true;
}

function scopeFor(question: OfferedQuestion, selected: readonly string[]): HindsightAskReceiptScope[] {
	const scope: HindsightAskReceiptScope[] = [];
	for (const label of selected) {
		const description = question.descriptions[label];
		if (description !== undefined) scope.push({ label, description });
	}
	return scope;
}

function answerTimedOut(answer: RawAnswer, text: string, answerCount: number): boolean {
	if (answer.timedOut) return true;
	if (!text.includes(TIMEOUT_MARKER)) return false;
	if (answer.id !== undefined) {
		return text.split(/\r?\n/).some(line => line.startsWith(`${answer.id}:`) && line.includes(TIMEOUT_MARKER));
	}
	return answerCount === 1;
}

function toolResultText(content: ToolResultMessage["content"]): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && block.text) parts.push(block.text);
	}
	return parts.join("\n");
}

function receiptKind(
	selected: readonly string[],
	custom: string | undefined,
	explicitNone: boolean,
): HindsightAskReceiptKind {
	if (selected.length > 0 && custom !== undefined) return "selection-and-custom";
	if (selected.length > 0) return "selection";
	if (custom !== undefined) return "custom";
	if (explicitNone) return "none";
	return "none";
}

function receiptConditions(answer: AcceptedAnswer): HindsightAskReceiptConditions {
	return {
		kind: answer.kind,
		selected: answer.selected,
		custom: answer.custom !== undefined,
		multi: answer.question.multi,
		questionIndex: answer.question.index,
		matchedOffered: true,
		notError: true,
		notTimeout: true,
		notCancelled: true,
		notMalformed: true,
		primary: true,
		authorUI: true,
		...(answer.question.recommendation !== undefined ? { recommendation: answer.question.recommendation } : {}),
		unselected: answer.question.labels.filter(label => !answer.selected.includes(label)),
		selectedScope: answer.selectedScope,
	};
}

function formatReceipt(entryId: string, toolCallId: string, timestamp: string, answer: AcceptedAnswer): string {
	const lines = [
		"UI participant response (authorUI, not a typed message). This receipt alone does not establish identity or implementation.",
		`Session entry id: ${entryId}`,
		`Tool call id: ${toolCallId}`,
		`Question id: ${answer.question.id}`,
		`Result timestamp: ${timestamp}`,
		`Offered question: ${answer.question.question}`,
	];
	if (answer.selected.length > 0) lines.push(`Selected: ${answer.selected.map(quote).join(", ")}`);
	else if (answer.kind === "none") lines.push("Selected: none");
	for (const scope of answer.selectedScope) {
		lines.push(`Assistant-offered scope for ${quote(scope.label)}: ${scope.description}`);
	}
	if (answer.custom !== undefined) {
		lines.push(`Custom UI response (not a predefined selection): ${answer.custom}`);
	}
	if (answer.note !== undefined) lines.push(`UI note (picker note, not a typed message): ${answer.note}`);
	if (answer.question.recommendation !== undefined) {
		lines.push(`Assistant recommendation: ${quote(answer.question.recommendation)}`);
	}
	const unselected = answer.question.labels.filter(label => !answer.selected.includes(label));
	lines.push(unselected.length > 0 ? `Unselected: ${unselected.map(quote).join(", ")}` : "Unselected: none");
	lines.push(CONDITIONS_LINE);
	return lines.join("\n");
}
