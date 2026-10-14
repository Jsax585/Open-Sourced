import type { AssistantMessage, ModelUsageHealth } from "@oh-my-pi/pi-ai";
import { formatDuration } from "@oh-my-pi/pi-utils";
import * as AIError from "@oh-my-pi/pi-ai/error";

/**
 * Describe a request failure that triggered a fallback switch, including the
 * classified error kind. The kind is what makes a switch traceable: the raw
 * provider text may be absent or generic, while `AIError.stringify` yields the
 * stable vocabulary (`usage-limit`, `transient`, `timeout`, `auth-failed`, …)
 * that `retry.fallbackOn` is defined over.
 */
export function describeRequestFailure(failedMessage: AssistantMessage, failureKind: number | undefined): string {
	const kind = AIError.stringify(failureKind);
	const detail = failedMessage.errorMessage ?? "provider returned an error without details";
	return `Request failed [${kind}]: ${detail}`;
}

/** Describe the health snapshot that actually caused a preflight switch. */
export function describeUsageFallback(health: ModelUsageHealth, reservePercent: number): string {
	const condition =
		health.state === "reserve"
			? `available quota is at or below the ${reservePercent}% reserve`
			: health.accounts.length === 0
				? "no account is eligible for this model's plan requirements"
				: "all eligible accounts are quota-exhausted or temporarily blocked";
	const now = Date.now();
	let earliestReset = Infinity;
	for (const account of health.accounts) {
		const reset = account.resetsAt;
		if (reset !== undefined && Number.isFinite(reset) && reset > now && reset < earliestReset) {
			earliestReset = reset;
		}
	}
	const reset = Number.isFinite(earliestReset)
		? ` Earliest reported reset in ${formatDuration(earliestReset - now)}.`
		: "";
	return `Usage preflight: ${condition}.${reset} No request was sent to the source model for this attempt.`;
}
