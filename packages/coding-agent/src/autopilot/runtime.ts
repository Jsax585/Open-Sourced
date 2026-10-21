import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { goalContinuationActivity } from "../goals/state";
import { assistantText, closingQuestion, normalizeQuestion } from "../session/closing-question";
import type {
	AutopilotDecisionDetails,
	AutopilotDecisionRecord,
	AutopilotStopReason,
	AutopilotStrategy,
} from "./state";

/** How long a responder turn may take before autopilot fails closed. */
export const AUTOPILOT_RESPONDER_TIMEOUT_MS = 60_000;
/** Cap on the decision embedded in the hidden continuation. */
export const AUTOPILOT_ANSWER_MAX_CHARS = 500;
/** No-progress cycles restate the objective up to this many times before stopping. */
export const AUTOPILOT_MAX_NO_PROGRESS_REITERATIONS = 3;

/** Task context the responder receives alongside the settled turn. */
export interface AutopilotResponderContext {
	/** The current user request, compacted. */
	task: string;
	/** Optional user directive; binding for every responder decision. */
	directive?: string;
	/** Available subagents (`name (description)`), when the task tool is enabled. */
	agents?: string;
	/** Active goal objective, when goal mode has one. */
	goalObjective?: string;
	/** Goal status (`active`, `paused`, ...). */
	goalStatus?: string;
	/** Compact open-todo summary. */
	todos?: string;
	/** Last tool the agent touched in the settled turn. */
	lastAction?: string;
}

/** One responder reply plus the metadata needed for the transcript card/journal. */
export interface AutopilotResponderReply {
	text: string;
	model?: string;
	inputTokens?: number;
	outputTokens?: number;
}

/** Session capabilities the autopilot runtime borrows from its owning session. */
export interface AutopilotRuntimeHost {
	/** Current per-session toggle. */
	isEnabled(): boolean;
	/** `main` only: the responder must never answer a subagent's own question. */
	agentKind(): "main" | "sub";
	/** Configured strategy (`answer`, `continue`, `goal-aware`). */
	strategy(): AutopilotStrategy;
	/** The session's effective model is present and has configured auth. */
	modelReady(): boolean;
	/** Hard per-user-turn cycle cap (config). */
	maxCycles(): number;
	/** Structured task/goal/todo context for the responder prompt. */
	responderContext(): AutopilotResponderContext;
	/** One no-tools turn on the session's effective model. */
	runResponder(promptText: string, signal: AbortSignal): Promise<AutopilotResponderReply>;
	/** Queue the hidden answer as the next main-agent turn, with card details. */
	queueContinuation(content: string, details: AutopilotDecisionDetails): void;
	/** Persist one decision/stop for observability. */
	recordDecision(record: AutopilotDecisionRecord): void;
	/** Compact transcript notice (never a user message). */
	emitNotice(level: "info" | "warning" | "error", message: string): void;
}

/** In-memory state surfaced by `/autopilot status`. */
export interface AutopilotSnapshot {
	strategy: AutopilotStrategy;
	cycles: number;
	maxCycles: number;
	last?: AutopilotDecisionDetails;
}

/**
 * End-of-turn controller for `/autopilot`. It sees only the settled messages of
 * the main agent and asks a no-tools responder for one decision:
 *
 * - `answer` answers closing questions only;
 * - `continue` also resolves question-free endings into the next action;
 * - `goal-aware` adds goal/todo context and stops when a cycle makes no tool
 *   progress (the goal-continuation digest is unchanged).
 *
 * The responder may answer `done` to end the run. It never answers a human,
 * never touches tool approval, and never starts a second continuation for the
 * same settle: the caller treats a `true` result as the turn's `willContinue`.
 */
export class AutopilotRuntime {
	readonly #host: AutopilotRuntimeHost;
	#cycles = 0;
	#lastKey: string | undefined;
	#responding = false;
	#stopNoticeShown = false;
	#lastActivityDigest: string | undefined;
	#noProgressReiterations = 0;
	#lastDetails: AutopilotDecisionDetails | undefined;

	constructor(host: AutopilotRuntimeHost) {
		this.#host = host;
	}

	/** A new user prompt re-arms the cycle budget, the repeat guard and the progress digest. */
	resetCycleBudget(): void {
		this.#cycles = 0;
		this.#lastKey = undefined;
		this.#stopNoticeShown = false;
		this.#lastActivityDigest = undefined;
		this.#noProgressReiterations = 0;
	}

	/** Current strategy/cycles plus the latest decision (observability). */
	snapshot(): AutopilotSnapshot {
		return {
			strategy: this.#host.strategy(),
			cycles: this.#cycles,
			maxCycles: this.#maxCycles(),
			last: this.#lastDetails,
		};
	}

	/** Configured cap; `0` (or any non-positive value) means unlimited. */
	#maxCycles(): number {
		const configured = this.#host.maxCycles();
		return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : 0;
	}

	/**
	 * Inspect the settled main-agent turn. Returns true when a continuation was
	 * queued, so the caller must settle the turn as non-terminal.
	 */
	async onTurnEnd(messages: readonly AgentMessage[]): Promise<boolean> {
		if (!this.#host.isEnabled()) return false;
		if (this.#host.agentKind() !== "main") return false;
		if (this.#responding) return false;

		const strategy = this.#host.strategy();
		const lastAssistant = findLastAssistant(messages);
		if (!lastAssistant) return false;
		const question = closingQuestion(lastAssistant, { includePenultimateQuestion: true });
		const finalText = assistantText(lastAssistant);
		if (!question && finalText.length === 0) return false;
		// `answer` keeps the original contract: question-free endings do not start
		// a responder turn at all.
		if (!question && strategy === "answer") return false;
		const kind: AutopilotDecisionDetails["kind"] = question ? "question" : "ending";
		const key = question?.key ?? normalizeQuestion(finalText).slice(0, 2000);
		if (key.length === 0) return false;

		// 0 = unlimited: keep cycling while the responder keeps proposing actions.
		const maxCycles = this.#maxCycles();
		if (maxCycles > 0 && this.#cycles >= maxCycles) {
			this.#stop("warning", `Autopilot stopped: cycle limit (${maxCycles}) reached for this prompt.`, "limit", kind);
			return false;
		}
		if (strategy === "goal-aware") {
			// Two cycles whose tool-call/result digest is identical made no progress.
			// Restate the objective instead of stopping, bounded by a reiteration cap.
			const digest = goalContinuationActivity(messages);
			if (this.#lastActivityDigest !== undefined && digest === this.#lastActivityDigest) {
				if (this.#noProgressReiterations >= AUTOPILOT_MAX_NO_PROGRESS_REITERATIONS) {
					this.#stop(
						"warning",
						`Autopilot stopped: no tool activity after ${AUTOPILOT_MAX_NO_PROGRESS_REITERATIONS} objective reiterations.`,
						"no-progress",
						kind,
					);
					return false;
				}
				this.#noProgressReiterations++;
				const context = this.#host.responderContext();
				const objective = (context.goalObjective ?? context.task).replace(/\s+/g, " ").trim();
				const details: AutopilotDecisionDetails = {
					kind: "reiterate",
					decision:
						objective.length > 200 ? `${objective.slice(0, 200)}…` : objective || "Continue toward the objective",
					strategy,
				};
				this.#cycles++;
				this.#lastDetails = details;
				this.#host.queueContinuation(buildAutopilotReiteration(context), details);
				this.#host.recordDecision({ ...details, at: Date.now() });
				this.#host.emitNotice(
					"info",
					`Autopilot: reiterating the objective (${this.#noProgressReiterations}/${AUTOPILOT_MAX_NO_PROGRESS_REITERATIONS}).`,
				);
				return true;
			}
			this.#lastActivityDigest = digest;
			this.#noProgressReiterations = 0;
		}

		if (this.#lastKey === key) {
			this.#stop(
				"warning",
				question
					? "Autopilot stopped: the agent repeated the same question."
					: "Autopilot stopped: the agent repeated the same ending.",
				"repeat",
				kind,
			);
			return false;
		}
		if (!this.#host.modelReady()) {
			this.#stop(
				"error",
				"Autopilot skipped: the current model is unavailable for the responder.",
				"model-unavailable",
				kind,
			);
			return false;
		}

		const context: AutopilotResponderContext = {
			...this.#host.responderContext(),
			lastAction: lastToolActivity(messages),
		};

		this.#responding = true;
		const startedAt = Date.now();
		try {
			const promptText = question
				? buildAutopilotResponderPrompt(question.question, context)
				: buildAutopilotStatementPrompt(finalText, context);
			const reply = await this.#host.runResponder(promptText, AbortSignal.timeout(AUTOPILOT_RESPONDER_TIMEOUT_MS));
			const latencyMs = Date.now() - startedAt;
			const decision = normalizeAutopilotAnswer(reply.text);
			if (!decision) {
				this.#stop("warning", "Autopilot stopped: the responder returned no decision.", "no-decision", kind);
				return false;
			}
			// Without a question the responder may conclude the task instead of
			// proposing another action; never continue a completed run.
			if (!question && isAutopilotDoneDecision(decision)) {
				const details: AutopilotDecisionDetails = {
					kind,
					decision,
					strategy,
					model: reply.model,
					latencyMs,
					inputTokens: reply.inputTokens,
					outputTokens: reply.outputTokens,
					stopped: "done",
				};
				this.#lastDetails = details;
				this.#host.recordDecision({ ...details, at: Date.now() });
				this.#host.emitNotice("info", "Autopilot: the objective is complete; no continuation.");
				return false;
			}
			this.#cycles++;
			this.#lastKey = key;
			const details: AutopilotDecisionDetails = {
				kind,
				decision,
				strategy,
				model: reply.model,
				latencyMs,
				inputTokens: reply.inputTokens,
				outputTokens: reply.outputTokens,
			};
			this.#lastDetails = details;
			const sentence = /[.!?…]$/.test(decision) ? decision : `${decision}.`;
			this.#host.queueContinuation(`Autopilot: ${sentence} Continue without asking.`, details);
			this.#host.recordDecision({ ...details, at: Date.now() });
			this.#host.emitNotice("info", `Autopilot: ${decision}`);
			return true;
		} catch (error) {
			logger.warn("autopilot responder failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			this.#stop("warning", "Autopilot stopped: the responder failed.", "responder-failed", kind);
			return false;
		} finally {
			this.#responding = false;
		}
	}

	#stop(
		level: "info" | "warning" | "error",
		message: string,
		stopped: AutopilotStopReason,
		kind: AutopilotDecisionDetails["kind"],
	): void {
		const details: AutopilotDecisionDetails = {
			kind,
			decision: "",
			strategy: this.#host.strategy(),
			stopped,
		};
		this.#lastDetails = details;
		this.#host.recordDecision({ ...details, at: Date.now() });
		if (this.#stopNoticeShown) return;
		this.#stopNoticeShown = true;
		this.#host.emitNotice(level, message);
	}
}

function findLastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "assistant") return message;
	}
	return undefined;
}

/** Last tool touched by the settled turn, for the responder prompt. */
function lastToolActivity(messages: readonly AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "toolResult") return message.toolName;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === "toolCall") return block.name;
			}
		}
	}
	return undefined;
}

/** Render the structured context for a responder prompt. */
export function renderAutopilotContext(context: AutopilotResponderContext): string {
	const lines: string[] = [];
	if (context.task) lines.push(`Task: ${context.task}`);
	if (context.directive) lines.push(`User directive (binding): ${context.directive}`);
	if (context.agents) lines.push(`Available subagents: ${context.agents}`);
	if (context.goalObjective) lines.push(`Goal (${context.goalStatus ?? "active"}): ${context.goalObjective}`);
	if (context.todos) lines.push(`Open todos: ${context.todos}`);
	if (context.lastAction) lines.push(`Last action: ${context.lastAction}`);
	return lines.join("\n");
}

/** The responder contract for a closing question: one actionable decision. */
export function buildAutopilotResponderPrompt(question: string, context: AutopilotResponderContext): string {
	const renderedContext = renderAutopilotContext(context);
	return [
		"You are the autopilot. The main agent asked:",
		question,
		"",
		renderedContext ? `Context:\n${renderedContext}` : "",
		"",
		context.directive ? "The user directive above is binding: follow it even when the guidance below differs." : "",
		"Answer with one actionable decision in a single sentence, without asking any questions.",
		"The decision may instruct the agent to understand more of the code first (read the relevant modules or delegate a read-only scout to map them) or to delegate a self-contained slice to a subagent.",
		context.agents
			? "Prefer understanding over guessing, and delegation for independent or specialist slices; name the subagent from Available subagents."
			: "No subagents are available in this session; prefer direct investigation or action.",
		"Prefer the conservative option that keeps the current task moving.",
		'If the question requires a destructive or out-of-scope action, answer "no" and say why.',
	]
		.filter(part => part.length > 0)
		.join("\n");
}

/**
 * The responder contract when the agent stopped with a statement instead of a
 * question: decide the next concrete action from the same rules/context, or
 * answer `done` when nothing further is warranted.
 */
export function buildAutopilotStatementPrompt(finalText: string, context: AutopilotResponderContext): string {
	const renderedContext = renderAutopilotContext(context);
	return [
		"You are the autopilot. The main agent stopped without asking a question. Its final message:",
		finalText,
		"",
		renderedContext ? `Context:\n${renderedContext}` : "",
		"",
		context.directive ? "The user directive above is binding: follow it even when the guidance below differs." : "",
		"Decide the next concrete action that keeps the objective moving, in a single sentence, without asking any questions.",
		"Consider whether the next step needs understanding more code (read the relevant modules, or delegate a read-only scout to map entry points and call sites) or a subagent for a self-contained or specialist slice.",
		context.agents
			? "Prefer understanding over guessing, and delegation for independent or specialist slices; name the subagent from Available subagents."
			: "No subagents are available in this session; prefer direct investigation or action.",
		'If the task is complete or no further action is warranted, answer exactly "done".',
		"Prefer the conservative option that keeps the current task moving.",
		'If the next action would be destructive or out of scope, answer "done" and say why.',
	]
		.filter(part => part.length > 0)
		.join("\n");
}

/** Continuation that restates the objective after a cycle without tool activity. */
export function buildAutopilotReiteration(context: AutopilotResponderContext): string {
	const objective = context.goalObjective ?? context.task;
	return [
		"Autopilot: no tool activity since the previous cycle. Reiterating the objective.",
		objective ? `Objective: ${objective}` : "",
		context.directive ? `Directive (binding): ${context.directive}` : "",
		context.todos ? `Open todos: ${context.todos}` : "",
		'Do not ask a question or restate the plan. Take a concrete tool action toward the objective now; if it is blocked or out of scope, answer exactly "done" and say why.',
	]
		.filter(part => part.length > 0)
		.join("\n");
}

/** Replies that terminate the run instead of proposing another action. */
export function isAutopilotDoneDecision(decision: string): boolean {
	const normalized = decision
		.replace(/[.!…\s]+$/g, "")
		.trim()
		.toLowerCase();
	return (
		normalized === "done" ||
		normalized === "complete" ||
		normalized === "completed" ||
		normalized === "finished" ||
		normalized === "concluido" ||
		normalized === "concluído"
	);
}

/**
 * Normalize a responder reply into a one-line decision, or null when it is not a
 * decision. A reply that is itself a question is rejected (the responder must not
 * hand the question back), as is an empty or over-long answer.
 */
export function normalizeAutopilotAnswer(reply: string): string | null {
	const collapsed = reply.replace(/\s+/g, " ").trim();
	if (!collapsed) return null;
	const unquoted = collapsed
		.replace(/^["'“”‘’]+/, "")
		.replace(/["'“”‘’]+$/, "")
		.replace(/^autopilot\s*:\s*/i, "")
		.trim();
	if (!unquoted) return null;
	if (/[?？]\s*$/.test(unquoted)) return null;
	const capped =
		unquoted.length > AUTOPILOT_ANSWER_MAX_CHARS
			? `${unquoted.slice(0, AUTOPILOT_ANSWER_MAX_CHARS - 1).trimEnd()}…`
			: unquoted;
	return capped.length > 0 ? capped : null;
}
