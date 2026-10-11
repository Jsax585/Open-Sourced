import { describe, expect, it } from "bun:test";
import { buildDiscoveredModel, buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, ModelCost, ModelJudgment, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { RUNNER_APIS, runnerApiKind } from "@oh-my-pi/pi-catalog/types";
import { buildGeneratedModel } from "../scripts/generate-models";

const OPENAI_CHAT_COST: ModelCost = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };
const DECISIONS_JUDGMENT: ModelJudgment = {
	api: "openai-decisions",
	cost: {
		input: 0.1,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		longContext: {
			inputThreshold: 272_000,
			input: 0.2,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
	},
};

function modelSpec<TApi extends Api>(
	id: string,
	api: TApi,
	provider: ModelSpec<TApi>["provider"],
	baseUrl: string,
	overrides: Partial<ModelSpec<TApi>> = {},
): ModelSpec<TApi> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		...overrides,
	};
}

describe("OpenAI Decisions catalog capability", () => {
	it("registers Decisions as a judge runner without replacing GPT-6 Luna's Responses model route or price", () => {
		expect(RUNNER_APIS).toContain("openai-decisions");
		expect(runnerApiKind("openai-decisions")).toBe("judge");

		const source = modelSpec("gpt-6-luna", "openai-responses", "openai", "https://api.openai.com/v1", {
			reasoning: true,
			input: ["text", "image"],
			cost: OPENAI_CHAT_COST,
			contextWindow: 1_050_000,
			maxTokens: 128_000,
		});
		const generated = buildGeneratedModel(source);

		expect(generated).toMatchObject({
			id: "gpt-6-luna",
			provider: "openai",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			cost: OPENAI_CHAT_COST,
			judgment: DECISIONS_JUDGMENT,
		});
		expect(generated.kind).toBeUndefined();
	});

	it("materializes eligibility on discovered direct OpenAI Luna rows", () => {
		const discovered = buildDiscoveredModel(
			modelSpec("gpt-6-luna", "openai-responses", "openai", "https://api.openai.com/v1", {
				reasoning: true,
				input: ["text", "image"],
				cost: OPENAI_CHAT_COST,
			}),
			"openai",
		);

		expect(discovered.judgment).toEqual(DECISIONS_JUDGMENT);
		expect(discovered.api).toBe("openai-responses");
		expect(discovered.cost).toEqual(OPENAI_CHAT_COST);
	});

	it("keeps eligibility off Codex, Bedrock Runtime, Mantle, and other OpenAI models", () => {
		expect(
			buildModel(
				modelSpec("gpt-6-luna", "openai-codex-responses", "openai-codex", "https://chatgpt.com/backend-api"),
			).judgment,
		).toBeUndefined();
		expect(
			buildModel(
				modelSpec(
					"global.openai.gpt-6-luna",
					"bedrock-converse-stream",
					"amazon-bedrock",
					"https://bedrock-runtime.us-east-1.amazonaws.com",
				),
			).judgment,
		).toBeUndefined();
		expect(
			buildModel(
				modelSpec(
					"openai.gpt-6-luna",
					"openai-responses",
					"bedrock-mantle",
					"https://bedrock-mantle.us-east-1.api.aws/openai/v1",
				),
			).judgment,
		).toBeUndefined();
		expect(
			buildModel(modelSpec("gpt-6-sol", "openai-responses", "openai", "https://api.openai.com/v1")).judgment,
		).toBeUndefined();
		const staleGeneratedCodex = buildGeneratedModel(
			modelSpec("gpt-6-luna", "openai-codex-responses", "openai-codex", "https://chatgpt.com/backend-api", {
				judgment: DECISIONS_JUDGMENT,
			}),
		);
		expect(staleGeneratedCodex.judgment).toBeUndefined();
	});

	it("corrects account-discovered Bedrock Mantle Luna metadata without enabling Decisions", () => {
		const mantle = buildDiscoveredModel(
			modelSpec(
				"openai.gpt-6-luna",
				"openai-responses",
				"bedrock-mantle",
				"https://bedrock-mantle.us-east-1.api.aws/openai/v1",
			),
			"bedrock-mantle",
		);

		expect(mantle).toMatchObject({
			provider: "bedrock-mantle",
			api: "openai-responses",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_050_000,
			maxTokens: 128_000,
			cost: {
				input: 0.11,
				output: 0.55,
				cacheRead: 0.011,
				cacheWrite: 0.1375,
				longContext: {
					inputThreshold: 272_000,
					input: 0.22,
					output: 0.825,
					cacheRead: 0.022,
					cacheWrite: 0.275,
				},
			},
		});
		expect(mantle.judgment).toBeUndefined();
	});
});
