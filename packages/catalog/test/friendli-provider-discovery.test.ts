import { describe, expect, test } from "bun:test";
import { buildModel } from "../src/build";
import { providerEntry, seedModels } from "../src/compat/providers";
import { Effort } from "../src/effort";
import { getBundledModels } from "../src/models";
import { getSupportedEfforts } from "../src/model-thinking";
import { friendliModelManagerOptions } from "../src/provider-models/openai-compat";

async function discover(data: Record<string, unknown>[]) {
	const options = friendliModelManagerOptions({
		apiKey: "test-key",
		fetch: async (input, init) => {
			expect(String(input)).toBe("https://api.friendli.ai/serverless/v1/models");
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-key");
			return Response.json({ data });
		},
	});
	const specs = await options.fetchDynamicModels?.();
	if (!specs) throw new Error("Expected Friendli discovery rows");
	return specs.map(spec => buildModel(spec));
}

describe("Friendli discovery deployment contract", () => {
	test("maps published metadata through buildModel, without leaking effort into a binary picker", async () => {
		const [plain, binary, effort, mandatory] = await discover([
			{
				id: "zai-org/GLM-5.2",
				name: "GLM-5.2",
				reasoning: true,
				reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }],
				pricing: {
					input: "0.0000014",
					output: "0.0000044",
					input_cache_read: "0.00000026",
					cache_write: "0.0000003",
				},
				functionality: { tool_call: true },
				input_modalities: ["text", "image"],
				interleaved: "reasoning_content",
				context_length: 1048576,
				max_completion_tokens: 8192,
			},
			{
				id: "zai-org/GLM-5.1",
				reasoning: true,
				reasoning_options: [{ type: "toggle" }],
				functionality: { tool_call: false },
				input_modalities: ["text"],
			},
			{ id: "meta-llama/Llama-4-9B", reasoning: false, input_modalities: ["text"] },
			{
				id: "zai-org/GLM-5.3",
				reasoning: true,
				reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
			},
		]);
		expect(effort.name).toBe("GLM-5.2");
		expect(effort.cost.input).toBeCloseTo(1.4);
		expect(effort.cost.output).toBeCloseTo(4.4);
		expect(effort.cost.cacheRead).toBeCloseTo(0.26);
		expect(effort.cost.cacheWrite).toBeCloseTo(0.3);
		expect(effort.contextWindow).toBe(1048576);
		expect(effort.maxTokens).toBe(8192);
		expect(effort.input).toEqual(["text", "image"]);
		expect(effort.supportsTools).toBe(true);
		expect(getSupportedEfforts(effort)).toEqual([Effort.High, Effort.Max]);
		expect(effort.compat.supportsReasoningEffort).toBe(true);
		expect(effort.thinking?.requiresEffort).toBe(false);
		expect(effort.compat.reasoningContentField).toBe("reasoning_content");
		expect(getSupportedEfforts(binary)).toEqual([Effort.High]);
		expect(binary.compat.supportsReasoningEffort).toBe(false);
		expect(binary.compat.omitReasoningEffort).toBe(true);
		expect(binary.supportsTools).toBe(false);
		expect(binary.input).toEqual(["text"]);
		expect(plain.thinking).toBeUndefined();
		expect(getSupportedEfforts(mandatory)).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(mandatory.thinking?.requiresEffort).toBe(true);
		expect(mandatory.compat.reasoningDisableMode).toBe("lowest-effort");
	});

	test("explicit live controls and zero pricing supersede the seed; missing metadata falls back unscaled", async () => {
		const [fallback] = await discover([{ id: "zai-org/GLM-5.2" }]);
		expect(getSupportedEfforts(fallback)).toEqual([Effort.High, Effort.Max]);
		expect(fallback.compat.supportsReasoningEffort).toBe(true);
		expect(fallback.cost).toEqual({ input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 });
		const [live] = await discover([
			{
				id: "zai-org/GLM-5.2",
				reasoning: true,
				reasoning_options: [{ type: "toggle" }],
				pricing: { input: "0", output: "0", input_cache_read: "0" },
				input_modalities: ["text"],
			},
		]);
		expect(getSupportedEfforts(live)).toEqual([Effort.High]);
		expect(live.compat.supportsReasoningEffort).toBe(false);
		expect(live.cost.input).toBe(0);
		expect(live.cost.output).toBe(0);
		expect(live.cost.cacheRead).toBe(0);
	});

	test("sparse custom Friendli deployments do not collide with DeepSeek or MiniMax lineage ladders", () => {
		for (const id of ["deepseek-ai/DeepSeek-V3.2", "MiniMaxAI/MiniMax-M2.5"]) {
			for (const thinking of [undefined, { mode: "effort" as const, efforts: [Effort.High] }]) {
				const model = buildModel({
					...seedModels<"openai-completions">("friendli")[0],
					id,
					provider: "custom-friendli",
					thinking,
				});
				expect(getSupportedEfforts(model)).toEqual(thinking?.efforts ?? []);
			}
		}
	});

	test("the generated fallback agrees with its authored seed and leaves other provider seeds present", () => {
		const entry = providerEntry("friendli");
		if (!entry) throw new Error("Missing Friendli provider");
		expect(entry.defaultModel).toBe("zai-org/GLM-5.2");
		expect(entry.envVars).toEqual(["FRIENDLI_API_KEY"]);
		const seed = buildModel(seedModels("friendli")[0]);
		const bundled = getBundledModels("friendli").find(model => model.id === seed.id);
		expect(bundled?.cost).toEqual(seed.cost);
		expect(bundled?.maxTokens).toBe(seed.maxTokens);
		expect(bundled?.thinking?.efforts).toEqual(seed.thinking?.efforts);
		for (const id of ["aiand", "gmi-cloud"] as const) {
			const other = providerEntry(id);
			if (!other) throw new Error(`Missing ${id}`);
			expect(seedModels(id).length).toBeGreaterThan(0);
		}
		expect(friendliModelManagerOptions().fetchDynamicModels).toBeUndefined();
	});
});
