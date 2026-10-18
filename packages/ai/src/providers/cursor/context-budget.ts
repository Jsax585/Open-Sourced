import { prompt } from "@oh-my-pi/pi-utils";
import contextBudgetNotice from "./context-budget-notice.md" with { type: "text" };

/**
 * Asks a Cursor turn to wrap up once its conversation crosses the host's
 * compaction threshold.
 *
 * Cursor runs the whole tool loop server-side inside one request, so the host
 * only gets a compaction boundary when the turn ends: until then every internal
 * step replays an ever-growing conversation. One notice, attached to the first
 * tool result past the threshold, ends the turn so the host can compact and
 * continue — the boundary mid-turn compaction gets for free on providers whose
 * tool loop runs on the client.
 */
export class CursorContextBudget {
	#turnStartTokens: number | undefined;
	#spent = false;

	constructor(readonly thresholdTokens: number) {}

	/**
	 * The notice to attach to the next tool result, at most once per turn.
	 * `contextTokens` is Cursor's live conversation size from its latest checkpoint.
	 */
	takeNotice(contextTokens: number | undefined): string | undefined {
		if (this.#spent || !contextTokens) return undefined;
		this.#turnStartTokens ??= contextTokens;
		if (this.#turnStartTokens >= this.thresholdTokens) {
			// The host could not bring this turn under its threshold before it
			// started; stopping it would stall the work without freeing anything.
			this.#spent = true;
			return undefined;
		}
		if (contextTokens < this.thresholdTokens) return undefined;
		this.#spent = true;
		return prompt.render(contextBudgetNotice, { contextTokens, thresholdTokens: this.thresholdTokens });
	}
}
