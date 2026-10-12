import { describe, expect, it } from "bun:test";
import {
	isJevLiveCandidate,
	isSafeCancelRequest,
	parseJevLiveDecision,
} from "../../examples/extensions/jev-live";

function answer(choice: string, confidence: number): unknown {
	return { answers: { action: { choice, probabilities: { [choice]: confidence } } } };
}

describe("opt-in Jev live-voice example", () => {
	it("only considers short, direct status/model/task requests", () => {
		expect(isJevLiveCandidate("what's the current model?")).toBe(true);
		expect(isJevLiveCandidate("please stop current task")).toBe(true);
		expect(isJevLiveCandidate("explain how databases work")).toBe(false);
		expect(isJevLiveCandidate("stop\nand run this")).toBe(false);
		expect(isJevLiveCandidate("stop " + "now ".repeat(100))).toBe(false);
		expect(isJevLiveCandidate("cancel; rm -rf .")).toBe(false);
	});

	it("only trusts calibrated, allowlisted choices", () => {
		expect(parseJevLiveDecision(answer("status", 0.95))).toBe("status");
		expect(parseJevLiveDecision(answer("model", 0.85))).toBe("model");
		expect(parseJevLiveDecision(answer("cancel", 0.91))).toBe("cancel");
		expect(parseJevLiveDecision(answer("cancel", 0.84))).toBeUndefined();
		expect(parseJevLiveDecision(answer("none", 0.99))).toBeUndefined();
		expect(parseJevLiveDecision(answer("run_shell", 1))).toBeUndefined();
		expect(parseJevLiveDecision({ answers: { action: { choice: "cancel" } } })).toBeUndefined();
		expect(parseJevLiveDecision({ answers: { action: { choice: "cancel", probabilities: { cancel: "1" } } } })).toBeUndefined();
		expect(parseJevLiveDecision(null)).toBeUndefined();
	});

	it("rejects indirect, negated, or extended cancellation instructions", () => {
		expect(isSafeCancelRequest("please stop current agent task")).toBe(true);
		expect(isSafeCancelRequest("abort")).toBe(true);
		expect(isSafeCancelRequest("don't stop the agent")).toBe(false);
		expect(isSafeCancelRequest("stop after saving the file")).toBe(false);
		expect(isSafeCancelRequest("stop the server")).toBe(false);
		expect(isSafeCancelRequest("stop and delete files")).toBe(false);
	});
});
