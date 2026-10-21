import { beforeAll, describe, expect, it } from "bun:test";
import { createAutopilotMessageCard, type AutopilotCardDetails } from "../src/chat/autopilot-message";
import { initTheme, theme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

const details: AutopilotCardDetails = {
	kind: "question",
	decision: "Yes, run the e2e suite",
	strategy: "goal-aware",
	model: "anthropic/claude-sonnet-4-5",
	latencyMs: 1234,
	inputTokens: 800,
	outputTokens: 40,
};

function render(card: { render(width: number): readonly string[] }, width = 120): string {
	return Bun.stripANSI(card.render(width).join("\n"));
}

describe("autopilot decision card", () => {
	it("renders a compact summary while collapsed", () => {
		const card = createAutopilotMessageCard(details, () => false, theme);
		const text = render(card);
		expect(text).toContain("Autopilot");
		expect(text).toContain("answered");
		expect(text).toContain("Yes, run the e2e suite");
		expect(text).not.toContain("Decision:");
	});

	it("expands to the strategy, model and responder usage", () => {
		const card = createAutopilotMessageCard(details, () => true, theme);
		const text = render(card);
		expect(text).toContain("Decision: Yes, run the e2e suite");
		expect(text).toContain("Kind: question");
		expect(text).toContain("strategy: goal-aware");
		expect(text).toContain("Model: anthropic/claude-sonnet-4-5");
		expect(text).toContain("Responder: 1234 ms");
		expect(text).toContain("800 in / 40 out tokens");
	});

	it("labels a reiteration of the objective", () => {
		const card = createAutopilotMessageCard(
			{ kind: "reiterate", decision: "ship it", strategy: "goal-aware" },
			() => false,
			theme,
		);
		expect(render(card)).toContain("reiterated the objective");
	});

	it("shows the stop reason for a stopped decision", () => {
		const card = createAutopilotMessageCard(
			{ ...details, decision: "", stopped: "no-progress", latencyMs: undefined },
			() => true,
			theme,
		);
		expect(render(card)).toContain("Stopped: no-progress");
	});

	it("follows a transcript-wide expansion toggle", () => {
		let expanded = false;
		const card = createAutopilotMessageCard(details, () => expanded, theme);
		expect(render(card)).not.toContain("Decision:");
		expanded = true;
		expect(render(card)).toContain("Decision:");
	});
});
