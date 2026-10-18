import { afterAll, describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getSearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import {
	buildRequestBody,
	DeepSeekProvider,
	searchDeepSeek,
} from "@oh-my-pi/pi-coding-agent/web/search/providers/deepseek";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

const authStorage = createInMemoryAuthStorage();
authStorage.keys.setRuntime("deepseek", "test-deepseek-key");
const modelRegistry = new ModelRegistry(authStorage);

function requireDeepSeekModel(): Model<Api> {
	const model = modelRegistry.find("web", "deepseek");
	if (!model) throw new Error("Expected bundled web/deepseek model");
	return model;
}

const deepseekModel = requireDeepSeekModel();

afterAll(() => {
	authStorage.close();
});

function makeParams(extras: Partial<SearchParams> = {}): SearchParams {
	return {
		query: "DeepSeek V4 release",
		authStorage,
		systemPrompt: "DeepSeek search test prompt",
		model: deepseekModel,
		modelRegistry,
		...extras,
	};
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("DeepSeek catalog wiring", () => {
	it("resolves web/deepseek as a selectable search engine backed by its provider", async () => {
		expect(deepseekModel).toMatchObject({ provider: "web", id: "deepseek", kind: "search" });

		const provider = await getSearchProvider("deepseek");
		expect(provider).toBeInstanceOf(DeepSeekProvider);
		expect(provider.isAvailable(authStorage, deepseekModel)).toBe(true);
	});
});

describe("DeepSeek request body", () => {
	it("defaults count to 10 and clamps it to the documented 1..50 range", () => {
		expect(buildRequestBody({ query: "q" }).count).toBe(10);
		expect(buildRequestBody({ query: "q", num_results: 7 }).count).toBe(7);
		expect(buildRequestBody({ query: "q", num_results: 500 }).count).toBe(50);
		expect(buildRequestBody({ query: "q", num_results: 0 }).count).toBe(10);
	});

	it("forwards search operators intact and never rewrites recency into the query", async () => {
		let captured: { url: string; init: RequestInit } | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			captured = {
				url: typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url,
				init: init ?? {},
			};
			return jsonResponse({ results: [] });
		};

		await searchDeepSeek(
			makeParams({
				query: 'DeepSeek "exact phrase" site:github.com -site:reddit.com lang:en after:2025',
				recency: "week",
				limit: 3,
				fetch: fetchMock,
			}),
		);

		expect(captured?.url).toBe("https://api.deepseek.com/v1/tools/search");
		expect(captured?.init.method).toBe("POST");
		expect(new Headers(captured?.init.headers).get("Authorization")).toBe("Bearer test-deepseek-key");
		expect(JSON.parse(captured?.init.body as string)).toEqual({
			query: 'DeepSeek "exact phrase" site:github.com -site:reddit.com lang:en after:2025',
			count: 3,
		});
	});
});

describe("DeepSeek response mapping", () => {
	it("prefers the model-facing summary and skips results without a usable URL", async () => {
		const fetchMock: FetchImpl = async () =>
			jsonResponse({
				results: [
					{
						title: "DeepSeek V4 released",
						url: "https://example.com/deepseek-v4",
						snippet: "short UI snippet",
						summary: "long model-facing summary",
						date: "2026-06-01T00:00:00+00:00",
					},
					{
						title: "Snippet only",
						url: "https://example.com/snippet",
						snippet: "fallback snippet",
						summary: "",
						date: null,
					},
					{ title: "Bad protocol", url: "ftp://example.com/file" },
					{ title: "Missing URL" },
					null,
				],
			});

		const response = await searchDeepSeek(makeParams({ fetch: fetchMock, limit: 10 }));

		expect(response.provider).toBe("deepseek");
		expect(response.authMode).toBe("api_key");
		expect(response.sources).toHaveLength(2);
		expect(response.sources[0]).toMatchObject({
			title: "DeepSeek V4 released",
			url: "https://example.com/deepseek-v4",
			snippet: "long model-facing summary",
			publishedDate: "2026-06-01T00:00:00+00:00",
		});
		expect(response.sources[0]?.ageSeconds).toBeGreaterThan(0);
		expect(response.sources[1]).toMatchObject({
			title: "Snippet only",
			snippet: "fallback snippet",
			publishedDate: undefined,
			ageSeconds: undefined,
		});
	});

	it("caps sources at the requested count", async () => {
		const fetchMock: FetchImpl = async () =>
			jsonResponse({
				results: Array.from({ length: 5 }, (_, index) => ({
					title: `Result ${index}`,
					url: `https://example.com/${index}`,
					summary: `summary ${index}`,
				})),
			});

		const response = await searchDeepSeek(makeParams({ fetch: fetchMock, limit: 2 }));

		expect(response.sources.map(source => source.title)).toEqual(["Result 0", "Result 1"]);
	});
});

describe("DeepSeek errors", () => {
	it("surfaces the upstream OpenAI-compatible error message", async () => {
		const fetchMock: FetchImpl = async () =>
			jsonResponse(
				{
					error: {
						message: "'count' must be between 1 and 50",
						type: "invalid_request_error",
						param: null,
						code: "invalid_request_error",
					},
				},
				400,
			);

		await expect(searchDeepSeek(makeParams({ fetch: fetchMock }))).rejects.toThrow(
			"DeepSeek API error (400): 'count' must be between 1 and 50",
		);
	});

	it("rejects queries over the documented 128-character limit before calling upstream", async () => {
		let called = false;
		const fetchMock: FetchImpl = async () => {
			called = true;
			return jsonResponse({ results: [] });
		};

		await expect(searchDeepSeek(makeParams({ query: "x".repeat(129), fetch: fetchMock }))).rejects.toThrow(
			"DeepSeek search queries cannot exceed 128 characters",
		);
		expect(called).toBe(false);
	});
});
