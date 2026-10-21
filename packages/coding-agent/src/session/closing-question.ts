import type { AssistantMessage } from "@oh-my-pi/pi-ai";

/**
 * Closing-question classification shared by subsystems that must know whether the
 * assistant ended its turn expecting an answer (todo reminders, autopilot).
 *
 * The classifier is deliberately structured: it works on the last paragraph of
 * visible assistant text, scores the final line and the last two prose sentences,
 * and ranks how strongly control was handed back — `cue` (an explicit instruction
 * such as "tell me…") outranks `request` (an outright question) outranks
 * `question` (question-shaped prose, possibly a heading). Options lists, a
 * recommendation line and a one-line closing note after a cue are handled
 * explicitly instead of being matched by one fragile regex.
 */

const MARKDOWN_PROMPT_PREFIX_RE = /^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*/;
const PROMPT_LABEL_RE = /^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*/i;
const INLINE_EMPHASIS_RE = /(\*\*|__)(.*?)\1/g;
const OPTION_LINE_RE = /^(?:[-*+]|\d+[.)])\s+\S/;
const RECOMMENDATION_RE = /^(?:i(?:'d| would)?\s+recommend|(?:my\s+)?recommendation)\b/i;
const CHOICE_CONFIRMATION_RE = /^(?:go|proceed|continue|stick)\s+with\b/i;
const QUESTION_PROMPT_RE =
	/^(?:what|which|when|where|why|how|who|whom|whose|do|does|did|can|could|would|will|should|is|are|am|may|shall)\b/i;
const USER_DIRECTED_PROMPT_RE = /\b(?:you|your|we|our)\b/i;
const ADDRESSEE_RE = /\b(?:you|your)\b/i;
// Imperatives ("tell me", "message me") and conditional permission ("If you confirm, I'll…").
const USER_RESPONSE_CUE_RE =
	/^(?:please\s+)?(?:confirm|reply|choose|pick|decide|advise|answer|approve)\b|^(?:please\s+)?(?:let\s+me\s+know|(?:tell|message|ping)\s+me)\b|^(?:if|once|when)\s+you\s+(?:confirm|approve|agree|allow|okay|ok|give)\b/i;
// Strip a connective only before an explicit address/permission cue; bare response
// words can be nouns ("Finally, answer validation is complete.").
const LEADING_CONNECTIVE_RE =
	/^(?:and|or|so|then|also|otherwise|alternatively|separately|finally)\b,?\s*(?=(?:please\b|let\s+me\s+know\b|(?:tell|message|ping)\s+me\b|(?:if|once|when)\s+you\b))/i;
// Western terminators need trailing whitespace (so `foo?: string` stays whole); CJK ones do not.
const SENTENCE_BREAK_RE = /(?<=[.!?…])\s+|(?<=[。！？])/;
/**
 * A trailing question mark is the universal signal that a line is a question, but
 * the English word/pronoun gates above exist to filter incidental "?" out of prose
 * (e.g. a TypeScript `foo?: string` tail). Non-English text has no cheap word list,
 * yet any non-ASCII character in a "?"/"？"-terminated line reliably marks it as
 * genuine prose — CJK/Japanese/Korean, Spanish `¿…?`, accented Latin — so treat it
 * as a real user-directed question.
 */
const NON_ASCII_TEXT_RE = /[^\x00-\x7F]/;
// Romance-language question openers. `NON_ASCII_TEXT_RE` already catches accented
// Portuguese/Spanish prose, but "Posso continuar?" and "Quer que eu faca o commit?"
// are ASCII. The verbs below are the closing-question forms users actually write.
const ROMANCE_QUESTION_RE =
	/^(?:posso|podemos|pode|podes|devo|devemos|deveria|quer|queres|queria|queremos|deseja|desejas|prefere|preferes|vamos|sigo|continuo|prossigo|consigo|puedo|puedes|debo|debemos|quieres|quiere|deseas|prefieres|seguimos|dois|dois-je|puis-je|faut-il|posso|devo)\b/i;

// A question wrapped whole in italics (`*…*`, `_…_`) — or the `*…*` that
// INLINE_EMPHASIS_RE leaves of `***…***` — must still match the ^-anchored
// QUESTION_PROMPT_RE. Strikethrough is deliberately absent: `~~…~~` marks the
// author as having discarded the span, so unwrapping it would promote a retracted
// question back to a live one and idle the session waiting for an answer nobody is going to give.
const WRAPPED_EMPHASIS_RE = /^(\*\*\*|\*\*|\*|___|__|_)([\s\S]+)\1$/;

interface PromptLine {
	text: string;
	hadPromptLabel: boolean;
}

/**
 * How a closing span hands control back, strongest first: `cue` instructs the user
 * ("tell me…", "If you confirm, I'll…") and no later prose can answer it; `request`
 * asks outright (labelled, user-addressed, or non-English question) but the agent may
 * still answer it itself; `question` is only question-shaped ("What's next?") and may
 * be a heading.
 */
export type ClosingAsk = "none" | "question" | "request" | "cue";

/** Options for {@link closingQuestion}. */
export interface ClosingQuestionOptions {
	/**
	 * Treat a direct question in the penultimate sentence as a closing ask even
	 * when the final sentence is prose ("Should I proceed? The build is green.").
	 * Off by default: the todo reminder treats such a final sentence as a possible
	 * self-answer, while autopilot cannot afford to leave a question unanswered.
	 */
	includePenultimateQuestion?: boolean;
}

/** A closing question with the paragraph it came from and a repeat-detection key. */
export interface ClosingQuestion {
	/** The paragraph that carries the question, code-stripped and trimmed. */
	question: string;
	/** Normalized closing sentence: equal keys mean the same question repeated. */
	key: string;
	/** How strongly the turn hands control back. */
	ask: Exclude<ClosingAsk, "none">;
}

/** Visible assistant text, with fenced blocks and inline code removed. */
export function assistantText(message: Pick<AssistantMessage, "content">): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") parts.push(block.text);
	}
	return stripCode(parts.join("\n")).trim();
}

/**
 * Remove fenced code blocks (whole content) and inline code spans. An unterminated
 * fence drops the remainder: code is never a closing question.
 */
function stripCode(text: string): string {
	const kept: string[] = [];
	let fence: string | undefined;
	for (const line of text.split("\n")) {
		const trimmed = line.trimStart();
		if (fence) {
			if (trimmed.startsWith(fence)) fence = undefined;
			continue;
		}
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			fence = trimmed.startsWith("```") ? "```" : "~~~";
			continue;
		}
		kept.push(line.replace(/`[^`\n]*`/g, " "));
	}
	return kept.join("\n");
}

function promptLine(line: string): PromptLine {
	const withoutMarkdownPrefix = line
		.trim()
		.replace(INLINE_EMPHASIS_RE, "$2")
		.replace(MARKDOWN_PROMPT_PREFIX_RE, "")
		.trim();
	const withoutPromptLabel = withoutMarkdownPrefix.replace(PROMPT_LABEL_RE, "").trim();
	const withoutEmphasis = withoutPromptLabel.replace(WRAPPED_EMPHASIS_RE, "$2").trim();
	return {
		text: withoutEmphasis,
		hadPromptLabel: withoutPromptLabel !== withoutMarkdownPrefix,
	};
}

function isQuestionPromptLine(line: string): boolean {
	const candidate = promptLine(line);
	if (!/[?？]\s*$/.test(candidate.text)) return false;
	return (
		candidate.hadPromptLabel ||
		QUESTION_PROMPT_RE.test(candidate.text) ||
		CHOICE_CONFIRMATION_RE.test(candidate.text) ||
		USER_DIRECTED_PROMPT_RE.test(candidate.text) ||
		ROMANCE_QUESTION_RE.test(candidate.text) ||
		NON_ASCII_TEXT_RE.test(candidate.text)
	);
}

function isResponseCueLine(line: string): boolean {
	const candidate = promptLine(line)
		.text.replace(/[.!?。！？]+$/, "")
		.replace(LEADING_CONNECTIVE_RE, "")
		.trim();
	return USER_RESPONSE_CUE_RE.test(candidate);
}

function askOf(span: string): ClosingAsk {
	if (isResponseCueLine(span)) return "cue";
	if (!isQuestionPromptLine(span)) return "none";
	const candidate = promptLine(span);
	return candidate.hadPromptLabel || ADDRESSEE_RE.test(candidate.text) || NON_ASCII_TEXT_RE.test(candidate.text)
		? "request"
		: "question";
}

/** The last two sentences of the prose lines closing `paragraph`; a list item ends the walk. */
function closingSentences(paragraph: string): string[] {
	const sentences: string[] = [];
	const lines = paragraph.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0 && sentences.length < 2; index--) {
		const line = lines[index].trim();
		if (OPTION_LINE_RE.test(line)) break;
		const lineSentences = line.split(SENTENCE_BREAK_RE).filter(Boolean);
		sentences.unshift(...lineSentences.slice(sentences.length - 2));
	}
	return sentences;
}

/** Classify one paragraph as a closing ask. */
export function closingAsk(paragraph: string, options?: ClosingQuestionOptions): ClosingAsk {
	const lastLine = paragraph.slice(paragraph.lastIndexOf("\n") + 1).trim();
	const sentences = closingSentences(paragraph);
	const asks = [askOf(lastLine), ...sentences.slice(-1).map(askOf)];
	// A direct question in the penultimate sentence still hands control back when the
	// final sentence is a closing note ("Should I proceed? The build is green.").
	const penultimateAsk =
		options?.includePenultimateQuestion && sentences.length >= 2 ? askOf(sentences[sentences.length - 2]!) : "none";
	// No lexicon recognizes a non-English follow-up ("…? Отдельно скажите, …"), and none
	// recognizes a non-English self-answer either; an open request is the costlier miss.
	const foreignQuestion =
		sentences.length === 2 && NON_ASCII_TEXT_RE.test(sentences[0]!) && isQuestionPromptLine(sentences[0]!);
	if (asks.includes("cue")) return "cue";
	if (foreignQuestion || asks.includes("request") || penultimateAsk === "request") return "request";
	return asks.includes("question") || penultimateAsk === "question" ? "question" : "none";
}

/**
 * The closing question of the final assistant message, or null when the turn did
 * not hand control back. Mirrors {@link isAwaitingUserAnswer}: a one-line closing
 * note after a cue paragraph keeps the cue, and an options list plus a
 * recommendation counts as a direct request.
 */
export function closingQuestion(
	message: Pick<AssistantMessage, "content">,
	options?: ClosingQuestionOptions,
): ClosingQuestion | null {
	const text = assistantText(message);
	if (!text) return null;
	const paragraphs = text.split(/\r?\n\s*\r?\n/);
	const lastParagraph = paragraphs.at(-1)?.trim() ?? "";
	const lastAsk = closingAsk(lastParagraph, options);
	if (lastAsk !== "none") return makeQuestion(lastParagraph, lastAsk);
	// A one-line closing note ("Repository unchanged, no commits.") does not withdraw an
	// instruction in the paragraph before it. A question there may be self-answered by
	// that note ("Do you need…?\n\nNo, …"), so it does not count.
	const previousParagraph = paragraphs.at(-2)?.trim();
	if (
		previousParagraph &&
		!lastParagraph.includes("\n") &&
		!OPTION_LINE_RE.test(lastParagraph) &&
		closingAsk(previousParagraph, options) === "cue"
	) {
		return makeQuestion(previousParagraph, "cue");
	}

	// Options and a recommendation do not answer the question on the user's behalf.
	// Stop at other prose so self-answered questions still allow unfinished work to resume.
	let optionCount = 0;
	let hasRecommendation = false;
	for (const line of text.split(/\r?\n/).reverse()) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (OPTION_LINE_RE.test(trimmed)) {
			optionCount++;
			continue;
		}
		const candidate = promptLine(trimmed);
		if (optionCount > 0) {
			const requested =
				optionCount >= 2 &&
				isQuestionPromptLine(trimmed) &&
				(hasRecommendation ||
					candidate.hadPromptLabel ||
					USER_DIRECTED_PROMPT_RE.test(candidate.text) ||
					CHOICE_CONFIRMATION_RE.test(candidate.text));
			return requested ? makeQuestion(trimmed, "request") : null;
		}
		if (RECOMMENDATION_RE.test(candidate.text)) {
			hasRecommendation = true;
			continue;
		}
		return null;
	}
	return null;
}

function makeQuestion(question: string, ask: Exclude<ClosingAsk, "none">): ClosingQuestion {
	const sentences = closingSentences(question);
	const keySource =
		[...sentences].reverse().find(sentence => askOf(sentence) !== "none") ?? sentences.at(-1) ?? question;
	return { question, key: normalizeQuestion(keySource), ask };
}

/**
 * Key used to recognize the same question repeated. Case, punctuation and
 * whitespace are folded so `"Shall I run the tests?"` and
 * `"shall i run the tests"` collide.
 */
export function normalizeQuestion(question: string): string {
	return question
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/** True when the assistant ended its turn expecting the user to answer. */
export function isAwaitingUserAnswer(message: Pick<AssistantMessage, "content">): boolean {
	return closingQuestion(message) !== null;
}
