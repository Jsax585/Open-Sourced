import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getModelPricingStatus } from "@oh-my-pi/pi-catalog/models";
import { bizrouterModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

const BASE_URL = "https://api.bizrouter.ai/v1";
const MESSAGES_BASE_URL = "https://api.bizrouter.ai";

const CHAT_PARAMETERS = ["max_tokens", "reasoning_effort", "tools", "tool_choice"];

/** One `models[]` row as `GET /v1/models` returns it (only the fields discovery reads). */
function row(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		name: id,
		api_type: "chat_completions",
		context_length: 131072,
		max_output_tokens: 16384,
		input_price_per_1m_usd: 1,
		output_price_per_1m_usd: 2,
		input_modalities: ["text"],
		output_modalities: ["text"],
		supported_parameters: CHAT_PARAMETERS,
		...fields,
	};
}

/**
 * BizRouter's `/v1/models` payload: an OpenAI `data` list (ids and limits only)
 * beside the `models` list that carries transport, prices, and capabilities.
 */
function rosterFetch(
	models: Record<string, unknown>[],
	calls?: Array<{ url: string; authorization: string | null }>,
): FetchImpl {
	return async (input: string | URL | Request, init?: RequestInit) => {
		calls?.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
		const data = models.map(model => ({ id: model.id, object: "model", owned_by: "bizrouter" }));
		return new Response(JSON.stringify({ object: "list", data, models, exchange_rate: 1431 }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
}

async function discover(models: Record<string, unknown>[]) {
	return (
		(await bizrouterModelManagerOptions({ apiKey: "test-key", fetch: rosterFetch(models) }).fetchDynamicModels?.()) ??
		[]
	);
}

function buildBizRouter<TApi extends Api = "openai-completions">(
	id: string,
	api: TApi = "openai-completions" as TApi,
): Model<TApi> {
	return buildModel<TApi>({
		id,
		name: id,
		api,
		provider: "bizrouter",
		baseUrl: api === "anthropic-messages" ? MESSAGES_BASE_URL : BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 131072,
	});
}

describe("BizRouter discovery", () => {
	test("reads the priced models list and maps transport, prices, limits, and capabilities", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const options = bizrouterModelManagerOptions({
			apiKey: "sk-br-v1-test",
			fetch: rosterFetch(
				[
					row("bizrouter/deepseek-v4.1-flash", {
						context_length: 1048576,
						max_output_tokens: 393216,
						input_price_per_1m_usd: 0.9,
						output_price_per_1m_usd: 3.6,
						cache_read_price_per_1m_usd: 0.018,
						input_modalities: ["text", "image"],
					}),
					row("anthropic/claude-sonnet-5.5", {
						input_price_per_1m_usd: 2,
						output_price_per_1m_usd: 10,
						cache_read_price_per_1m_usd: 0.1,
						cache_write_price_per_1m_usd: 2.5,
						input_modalities: ["text", "image", "file"],
					}),
					row("openai/gpt-6-astra", { api_type: "responses" }),
					row("perplexity/sonar", { supported_parameters: ["max_tokens", "temperature"] }),
				],
				calls,
			),
		});
		const models = (await options.fetchDynamicModels?.()) ?? [];

		expect(calls).toEqual([{ url: `${BASE_URL}/models`, authorization: "Bearer sk-br-v1-test" }]);
		const byId = new Map(models.map(model => [model.id, model]));
		expect(byId.get("bizrouter/deepseek-v4.1-flash")).toMatchObject({
			api: "openai-completions",
			baseUrl: BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1048576,
			maxTokens: 393216,
			cost: { input: 0.9, output: 3.6, cacheRead: 0.018, cacheWrite: 0 },
		});
		expect(byId.get("anthropic/claude-sonnet-5.5")).toMatchObject({
			api: "anthropic-messages",
			baseUrl: MESSAGES_BASE_URL,
			cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		});
		expect(byId.get("openai/gpt-6-astra")).toMatchObject({ api: "openai-responses", baseUrl: BASE_URL });
		expect(byId.get("perplexity/sonar")).toMatchObject({ reasoning: false, supportsTools: false });
		expect(byId.get("bizrouter/deepseek-v4.1-flash")?.supportsTools).toBeUndefined();
	});

	test("drops rows a chat agent cannot drive", async () => {
		const models = await discover([
			row("bizrouter/glm-5.3"),
			row("openai/gpt-audio", { output_modalities: ["text", "audio"] }),
			row("google/gemini-3.1-flash-image", { output_modalities: ["text", "image"] }),
			row("google/veo-3.1", { output_modalities: ["video"] }),
			row("openai/text-embedding-3-small", { api_type: "embeddings", output_modalities: ["embedding"] }),
			row("bizrouter/qwen3-reranker-4b", { api_type: "rerank", output_modalities: ["ranking"] }),
			row("openai/gpt-realtime-2", { api_type: "realtime", output_modalities: ["text", "audio"] }),
			row("openai/gpt-transcribe", { api_type: "audio_transcription" }),
		]);
		expect(models.map(model => model.id)).toEqual(["bizrouter/glm-5.3"]);
	});

	test("absent cache legs are free; an unreadable card is unpriced; an all-zero card is free", async () => {
		const models = await discover([
			row("priced"),
			row("free", { input_price_per_1m_usd: 0, output_price_per_1m_usd: 0 }),
			row("bad-required", { output_price_per_1m_usd: "abc" }),
			row("negative", { input_price_per_1m_usd: -1 }),
			row("bad-cache", { cache_read_price_per_1m_usd: "abc" }),
			row("missing", { input_price_per_1m_usd: undefined }),
		]);
		const status = Object.fromEntries(models.map(model => [model.id, getModelPricingStatus(model)]));
		expect(status).toEqual({
			"bad-cache": "unknown",
			"bad-required": "unknown",
			free: "free",
			missing: "unknown",
			negative: "unknown",
			priced: "fixed",
		});
		expect(models.find(model => model.id === "priced")?.cost).toEqual({
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	test("the seed shows without a key and the live roster replaces it", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-bizrouter-"));
		try {
			// No staticModels: resolution falls back to the committed bundle, so
			// this fails if the generated catalog lacks the seed row.
			const withoutKey = await resolveProviderModels(
				{ ...bizrouterModelManagerOptions({}), cacheDbPath: path.join(tempDir, "keyless.db") },
				"online-if-uncached",
			);
			const seed = withoutKey.models.find(model => model.id === "bizrouter/deepseek-v4.1-flash");
			expect(seed && getModelPricingStatus(seed)).toBe("fixed");

			const withLive = await resolveProviderModels(
				{
					...bizrouterModelManagerOptions({
						apiKey: "test-key",
						fetch: rosterFetch([row("z-ai/glm-5.3")]),
					}),
					cacheDbPath: path.join(tempDir, "live.db"),
				},
				"online",
			);
			expect(withLive.models.map(model => model.id)).toEqual(["z-ai/glm-5.3"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("BizRouter capability rules", () => {
	test("Claude on /v1/messages keeps the Claude API effort ladders", () => {
		expect(buildBizRouter("anthropic/claude-opus-4.6", "anthropic-messages").thinking?.efforts).toEqual([
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.Max,
		]);
		expect(buildBizRouter("anthropic/claude-sonnet-4.6", "anthropic-messages").thinking?.efforts).toEqual([
			Effort.Low,
			Effort.Medium,
			Effort.High,
		]);
		const sonnet = buildBizRouter("anthropic/claude-sonnet-5.5", "anthropic-messages");
		expect(sonnet.thinking?.mode).toBe("anthropic-adaptive");
		expect(sonnet.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
		const haiku = buildBizRouter("anthropic/claude-haiku-5.5", "anthropic-messages");
		expect(haiku.thinking?.mode).toBe("anthropic-adaptive");
		expect(haiku.compat?.disabledThinking).toBe("disabled");
	});

	test("chat-completions ladders drop the levels the gateway rejects", () => {
		const efforts = (id: string) => buildBizRouter(id).thinking?.efforts;
		for (const id of ["openai/gpt-5.6-sol", "openai/gpt-6-luna", "openai/gpt-6.1-sol"]) {
			expect(efforts(id)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
		}
		expect(buildBizRouter("openai/gpt-6-astra", "openai-responses").thinking?.efforts).toEqual([
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
		]);
		expect(efforts("openai/gpt-5.1")).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		expect(efforts("openai/o3")).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
		for (const id of ["google/gemini-3.8-flash", "google/gemini-4-argon"]) {
			expect(efforts(id)).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		}
		expect(efforts("perplexity/sonar-reasoning-pro")).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
		]);
		expect(buildBizRouter("bizrouter/deepseek-v4.1-flash").compat?.thinkingFormat).toBe("openai");
	});
});
