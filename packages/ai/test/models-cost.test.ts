import { describe, expect, it } from "bun:test";
import { calculateCost, getBundledModel } from "../src/models";
import type { Usage } from "../src/types";

describe("calculateCost", () => {
	it("keeps token-based calculation for GitHub Copilot models", () => {
		const model = {
			...getBundledModel("github-copilot", "gpt-4o"),
			cost: {
				input: 1000,
				output: 2000,
				cacheRead: 500,
				cacheWrite: 800,
			},
		};
		const usage: Usage = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 100,
			totalTokens: 1800,
			cost: {
				input: 123,
				output: 456,
				cacheRead: 789,
				cacheWrite: 321,
				total: 1689,
			},
		};

		calculateCost(model, usage);

		expect(usage.cost.input).toBeCloseTo(1, 8);
		expect(usage.cost.output).toBeCloseTo(1, 8);
		expect(usage.cost.cacheRead).toBeCloseTo(0.1, 8);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.08, 8);
		expect(usage.cost.total).toBeCloseTo(2.18, 8);
	});

	it("keeps token-based calculation for non-Copilot providers", () => {
		const model = {
			...getBundledModel("openai", "gpt-4o-mini"),
			cost: {
				input: 1000,
				output: 2000,
				cacheRead: 500,
				cacheWrite: 800,
			},
		};
		const usage: Usage = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 100,
			totalTokens: 1800,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		};

		calculateCost(model, usage);

		expect(usage.cost.input).toBeCloseTo(1, 8);
		expect(usage.cost.output).toBeCloseTo(1, 8);
		expect(usage.cost.cacheRead).toBeCloseTo(0.1, 8);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.08, 8);
		expect(usage.cost.total).toBeCloseTo(2.18, 8);
	});

	it("prices OpenAI Codex GPT models from the matching OpenAI catalog entry", () => {
		const openAIModel = getBundledModel("openai", "gpt-5.4");
		const codexModel = getBundledModel("openai-codex", "gpt-5.4");
		const usage: Usage = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 1700,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		expect(codexModel.cost).toEqual(openAIModel.cost);

		calculateCost(codexModel, usage);

		expect(usage.cost.total).toBeCloseTo(0.01005, 8);
	});

	it("prices 1h cache writes at twice the input rate when the ttl split is reported", () => {
		// Anthropic bills 1h cache writes at 2x input; model.cost.cacheWrite is the flat 5m rate.
		const model = {
			...getBundledModel("anthropic", "claude-sonnet-4-5"),
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		};
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 2000,
			totalTokens: 2000,
			cttl: { ephemeral5m: 1000, ephemeral1h: 1000 },
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		calculateCost(model, usage);

		// 1000 * 3.75/1e6 (5m) + 1000 * 6/1e6 (1h at 2x input)
		expect(usage.cost.cacheWrite).toBeCloseTo(0.00975, 10);
	});

	it("bills cache-write tokens the ttl breakdown omits at the flat rate", () => {
		// cttl and cacheWrite come from independent wire fields, so a partial
		// breakdown must not make the unattributed remainder free.
		const model = {
			...getBundledModel("anthropic", "claude-sonnet-4-5"),
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		};
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 2000,
			totalTokens: 2000,
			cttl: { ephemeral5m: 500 },
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		calculateCost(model, usage);

		// All 2000 tokens priced at the flat 5m rate: 500 attributed + 1500 residual.
		expect(usage.cost.cacheWrite).toBeCloseTo(0.0075, 10);
	});
});
