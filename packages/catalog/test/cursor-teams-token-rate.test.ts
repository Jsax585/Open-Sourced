import { describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai/types";
import { calculateCost, getBundledModel } from "@oh-my-pi/pi-catalog/models";

const sampleUsage = (input: number, cacheRead = 0): Usage => ({
	input,
	output: 0,
	cacheRead,
	cacheWrite: 0,
	totalTokens: input + cacheRead,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

describe("Cursor Teams token rate", () => {
	it("adds the configured per-million surcharge on third-party Cursor models", () => {
		const model = {
			...getBundledModel("cursor", "gemini-3.8-flash"),
			teamsTokenRatePerMillion: 0.25,
		};
		const usage = sampleUsage(1_000_000, 1_000_000);
		calculateCost(model, usage);
		// List $0.75/M input and $0.075/M cache read, each plus the $0.25/M token rate.
		expect(usage.cost.input).toBeCloseTo(1.0, 8);
		expect(usage.cost.cacheRead).toBeCloseTo(0.325, 8);
	});

	it("does not surcharge Cursor first-party Grok or Composer models", () => {
		const grok = {
			...getBundledModel("cursor", "grok-4.7"),
			teamsTokenRatePerMillion: 0.25,
		};
		const composer = {
			...getBundledModel("cursor", "composer-2.5"),
			teamsTokenRatePerMillion: 0.25,
		};
		const grokUsage = sampleUsage(10_000);
		const composerUsage = sampleUsage(10_000);
		calculateCost(grok, grokUsage);
		calculateCost(composer, composerUsage);
		expect(grokUsage.cost.input).toBeCloseTo(0.02, 8);
		expect(composerUsage.cost.input).toBeCloseTo(0.005, 8);
	});
});
