import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import {
	type RepeatedToolCallDetection,
	ToolCallLoopGuard,
	type ToolCallLoopGuardOptions,
	type ToolCallLoopTurn,
} from "@oh-my-pi/pi-ai/utils/tool-call-loop-guard";
import { prompt } from "@oh-my-pi/pi-utils";
import { toolCallArgumentsSignature, toolCallSignature } from "./tool-call-signature";
import cumulativeRedirectTemplate from "../prompts/advisor/tool-call-loop-redirect-cumulative.md" with { type: "text" };
import { renderToolCallLoopRedirect } from "../session/tool-call-loop-redirect";

/** Cumulative bound on one identical call, as a multiple of the consecutive threshold. */
const CUMULATIVE_REPEAT_MULTIPLE = 5;
/** Ceiling on tracked signatures so a long review cannot grow the tally without bound. */
const MAX_TRACKED_SIGNATURES = 4096;
// Same limits as the shared `renderToolCallLoopRedirect` corrective, so both detections read alike.
const RESULT_SUMMARY_LIMIT = 200;
const ARGUMENT_SUMMARY_LIMIT = 400;

/** A detection from the lifetime tally rather than a back-to-back run. */
export interface CumulativeToolCallDetection extends RepeatedToolCallDetection {
	readonly cumulative: true;
}

function summarizeText(text: string, limit: number): string {
	const summary = text.replace(/\s+/g, " ").trim();
	return summary.length > limit ? `${summary.slice(0, limit)}…` : summary;
}

function summarizeToolResult(toolResults: readonly ToolResultMessage[], toolCallId: string): string {
	const result = toolResults.find(candidate => candidate.toolCallId === toolCallId);
	if (!result) return "";
	const text = result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
	return summarizeText(text, RESULT_SUMMARY_LIMIT);
}

/**
 * The shared consecutive guard plus a lifetime tally per call signature. A call
 * the model alternates with others never forms a run, so the consecutive bound
 * never sees it; this trips at a looser bound instead. Only a short-lived guard
 * (one advisor review) should count this way — a session-long guard would trip
 * on legitimate re-reads of a file the agent keeps editing.
 */
export class CumulativeToolCallLoopGuard extends ToolCallLoopGuard {
	readonly #bound: number;
	readonly #exemptTools: ReadonlySet<string>;
	readonly #repeats = new Map<string, number>();

	constructor(options: ToolCallLoopGuardOptions) {
		super(options);
		this.#bound = Math.max(1, Math.trunc(options.threshold)) * CUMULATIVE_REPEAT_MULTIPLE;
		this.#exemptTools = new Set(options.exemptTools);
	}

	override recordTurn(turn: ToolCallLoopTurn): RepeatedToolCallDetection | CumulativeToolCallDetection | null {
		return super.recordTurn(turn) ?? this.#tally(turn);
	}

	#tally(turn: ToolCallLoopTurn): CumulativeToolCallDetection | null {
		for (const part of turn.message.content) {
			if (part.type !== "toolCall" || this.#exemptTools.has(part.name)) continue;
			const signature = toolCallSignature(part.name, part.arguments);
			const total = (this.#repeats.get(signature) ?? 0) + 1;
			if (total >= this.#bound) {
				// Drop the tally so the next corrective costs another full bound
				// instead of firing on every subsequent call.
				this.#repeats.delete(signature);
				return {
					kind: "repeated_tool_call",
					cumulative: true,
					toolName: part.name,
					count: total,
					resultSummary: summarizeToolResult(turn.toolResults, part.id),
					argumentsSummary: summarizeText(toolCallArgumentsSignature(part.arguments), ARGUMENT_SUMMARY_LIMIT),
				};
			}
			if (!this.#repeats.has(signature) && this.#repeats.size >= MAX_TRACKED_SIGNATURES) this.#repeats.clear();
			this.#repeats.set(signature, total);
		}
		return null;
	}
}

/** Consecutive detections keep the shared corrective; cumulative ones drop "consecutive". */
export function renderAdvisorToolCallLoopRedirect(
	detection: RepeatedToolCallDetection | CumulativeToolCallDetection,
): string {
	if (!("cumulative" in detection)) return renderToolCallLoopRedirect(detection);
	return prompt.render(cumulativeRedirectTemplate, {
		tool_name: detection.toolName,
		count: detection.count,
		arguments_summary: detection.argumentsSummary,
		result_summary: detection.resultSummary || "(no text result)",
	});
}
