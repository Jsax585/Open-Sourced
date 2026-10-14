import { expect, test, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import {
	describeRequestFailure,
	describeUsageFallback,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-reason";

function failedMessage(errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o",
		content: [],
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as AssistantMessage;
}

test("names the classified failure kind so a switch is traceable to its error class", () => {
	const usage = describeRequestFailure(failedMessage("429 usage limit reached"), AIError.create(AIError.Flag.UsageLimit));
	expect(usage).toContain("[usage-limit]");
	expect(usage).toContain("429 usage limit reached");

	const transient = describeRequestFailure(
		failedMessage("all serving lanes are busy; retry shortly"),
		AIError.create(AIError.Flag.Transient),
	);
	expect(transient).toContain("[transient]");
	expect(transient).not.toContain("usage-limit");
});

test("keeps a placeholder when the provider sent no text, and reports unclassified failures", () => {
	const timeout = describeRequestFailure(failedMessage(undefined), AIError.create(AIError.Flag.Timeout));
	expect(timeout).toContain("[timeout]");
	expect(timeout).toContain("provider returned an error without details");
	expect(describeRequestFailure(failedMessage("odd"), undefined)).toContain("[none]");
});

test("does not describe plan-ineligible accounts as exhausted quota", () => {
	// Health drops plan-ineligible accounts before computing the depleted state.
	const reason = describeUsageFallback({ state: "depleted", accounts: [] }, 30);
	expect(reason).toMatch(/eligible.*plan/);
	expect(reason).not.toMatch(/quota-exhausted|temporarily blocked/);
});

test("reports the earliest future reset instead of an expired or invalid account reset", () => {
	const now = 1_900_000_000_000;
	const clock = vi.spyOn(Date, "now").mockReturnValue(now);
	try {
		const reason = describeUsageFallback(
			{
				state: "depleted",
				accounts: [now - 60_000, Infinity, NaN, now + 120_000, now + 60_000].map((resetsAt, credentialId) => ({
					credentialId,
					credentialType: "oauth",
					state: "depleted",
					resetsAt,
				})),
			},
			30,
		);
		expect(reason).toMatch(/reset in 1m\b/);
		expect(reason).not.toMatch(/2m|0ms|NaN|Infinity/);
	} finally {
		clock.mockRestore();
	}
});
