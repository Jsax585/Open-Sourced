import { describe, expect, it } from "bun:test";
import { calculateCost, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Usage } from "@oh-my-pi/pi-catalog/types";

function usage(fields: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">): Usage {
	return {
		...fields,
		totalTokens: fields.input + fields.output + fields.cacheRead + fields.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("long-context pricing tier", () => {
	// GPT-5.6 Sol carries a long-context tier: the tier rate applies to the
	// ENTIRE request once total prompt input (input + cacheRead + cacheWrite)
	// crosses the threshold, matching OpenAI's billing. Rates are derived from
	// the bundled model so upstream price changes cannot mask a tier-selection
	// regression; the contract under test is which rate set applies on each
	// side of the boundary.
	const sol = getBundledModel("openai", "gpt-5.6-sol");
	const standard = sol.cost;
	const tier = sol.cost.longContext;
	if (!tier) throw new Error("gpt-5.6-sol lost its long-context tier");

	it("bills at standard rates at or below the input threshold", () => {
		const input = tier.inputThreshold - 200_000;
		const atThreshold = usage({ input, output: 10_000, cacheRead: 200_000, cacheWrite: 0 });
		calculateCost(sol, atThreshold);
		expect(atThreshold.cost.input).toBeCloseTo((standard.input / 1e6) * input, 10);
		expect(atThreshold.cost.output).toBeCloseTo((standard.output / 1e6) * 10_000, 10);
		expect(atThreshold.cost.cacheRead).toBeCloseTo((standard.cacheRead / 1e6) * 200_000, 10);
	});

	it("bills the whole request at tier rates once prompt input crosses the threshold", () => {
		const input = tier.inputThreshold - 200_000 + 1;
		const overThreshold = usage({ input, output: 10_000, cacheRead: 200_000, cacheWrite: 0 });
		calculateCost(sol, overThreshold);
		expect(overThreshold.cost.input).toBeCloseTo((tier.input / 1e6) * input, 10);
		expect(overThreshold.cost.output).toBeCloseTo((tier.output / 1e6) * 10_000, 10);
		expect(overThreshold.cost.cacheRead).toBeCloseTo((tier.cacheRead / 1e6) * 200_000, 10);
		expect(overThreshold.cost.total).toBeCloseTo(
			overThreshold.cost.input + overThreshold.cost.output + overThreshold.cost.cacheRead,
			10,
		);
	});

	it("keeps Codex Sol tier rates and its exclusive threshold aligned with standard pricing", () => {
		const codexSol = getBundledModel("openai-codex", "gpt-5.6-sol");
		const standard = codexSol.cost;
		const tier = standard.longContext;
		if (!tier) throw new Error("openai-codex gpt-5.6-sol lost its long-context tier");

		expect(tier.inputThreshold).toBe(272_000);
		expect(tier.input).toBe(standard.input * 2);
		expect(tier.output).toBe(standard.output * 1.5);
		expect(tier.cacheRead).toBe(standard.cacheRead * 2);
		expect(tier.cacheWrite).toBe(standard.cacheWrite * 2);

		const atThreshold = usage({
			input: tier.inputThreshold,
			output: 1_000_000,
			cacheRead: 0,
			cacheWrite: 0,
		});
		calculateCost(codexSol, atThreshold);
		expect(atThreshold.cost.output).toBeCloseTo(standard.output, 10);

		const overThreshold = usage({
			input: tier.inputThreshold + 1,
			output: 1_000_000,
			cacheRead: 0,
			cacheWrite: 0,
		});
		calculateCost(codexSol, overThreshold);
		expect(overThreshold.cost.output).toBeCloseTo(tier.output, 10);
	});
});
