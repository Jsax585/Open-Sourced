import { AUTOPILOT_ANSWER_MESSAGE_TYPE } from "@oh-my-pi/pi-tui/chat/autopilot-message";
import type { SessionEntry } from "../session/session-entries";

/** Custom entry that carries the per-session autopilot toggle across resume. */
export const AUTOPILOT_STATE_CUSTOM_TYPE = "autopilot-state";
/** Custom message that carries a responder decision into the transcript. */
export const AUTOPILOT_ANSWER_CUSTOM_TYPE = AUTOPILOT_ANSWER_MESSAGE_TYPE;
/** Custom entry journaling one responder decision (observability). */
export const AUTOPILOT_DECISION_CUSTOM_TYPE = "autopilot-decision";

/**
 * How autopilot treats a settled main-agent turn:
 * - `answer` answers closing questions only;
 * - `continue` also resolves question-free endings into the next action;
 * - `goal-aware` adds the goal/todos context and stops on a no-progress digest.
 */
export type AutopilotStrategy = "answer" | "continue" | "goal-aware";

/** Why a cycle or the whole run stopped. */
export type AutopilotStopReason =
	| "done"
	| "limit"
	| "repeat"
	| "no-progress"
	| "responder-failed"
	| "no-decision"
	| "model-unavailable";

/** Structured record of one autopilot decision, persisted and shown in the card. */
export interface AutopilotDecisionDetails {
	kind: "question" | "ending" | "reiterate";
	decision: string;
	strategy: AutopilotStrategy;
	model?: string;
	latencyMs?: number;
	inputTokens?: number;
	outputTokens?: number;
	stopped?: AutopilotStopReason;
}

/** A decision plus its timestamp for the session journal. */
export interface AutopilotDecisionRecord extends AutopilotDecisionDetails {
	at: number;
}

/** Latest journaled toggle/directive. */
export interface PersistedAutopilotState {
	enabled?: boolean;
	prompt?: string;
	/** Per-session cycle cap; undefined falls back to `autopilot.maxCycles`. */
	maxCycles?: number;
}

/**
 * Latest persisted autopilot toggle on the branch, or undefined when the session
 * never toggled it. Mirrors how goal/vibe state is restored from the journal, but
 * uses a `custom` entry because `mode_change` is a single slot shared by modes and
 * autopilot must coexist with goal/vibe.
 */
export function autopilotStateFromEntries(entries: readonly SessionEntry[]): PersistedAutopilotState | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "custom" || entry.customType !== AUTOPILOT_STATE_CUSTOM_TYPE) continue;
		const data = entry.data;
		if (typeof data !== "object" || data === null) return undefined;
		const state: PersistedAutopilotState = {};
		if ("enabled" in data && typeof data.enabled === "boolean") state.enabled = data.enabled;
		if ("prompt" in data && typeof data.prompt === "string") {
			const prompt = data.prompt.trim();
			if (prompt.length > 0) state.prompt = prompt;
		}
		if ("maxCycles" in data && typeof data.maxCycles === "number" && Number.isFinite(data.maxCycles)) {
			state.maxCycles = Math.max(0, Math.floor(data.maxCycles));
		}
		return state;
	}
	return undefined;
}
