import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { PerplexityProvider, searchPerplexity } from "@oh-my-pi/pi-coding-agent/web/search/providers/perplexity";

const SEARCH_URL = "https://api.perplexity.ai/search";

interface CapturedRequest {
	url: string;
	method: string | undefined;
	authorization: string | undefined;
	body: Record<string, unknown>;
}

/** Env-backed keys report an `env` credential origin, mirroring a real PERPLEXITY_API_KEY. */
function authStorageWith(keys: Partial<Record<"perplexity" | "openrouter", string>>): AuthStorage {
	const lookup = (provider: string): string | undefined => keys[provider as keyof typeof keys];
	return {
		keys: {
			async get(provider: string) {
				return lookup(provider);
			},
			source(provider: string) {
				return lookup(provider) ? { kind: "env", concrete: true } : undefined;
			},
		},
	} as unknown as AuthStorage;
}

const apiKeyStorage = authStorageWith({ perplexity: "pplx-test-key" });

function resultsPayload(results: Record<string, unknown>[]): Record<string, unknown> {
	return { results, id: "req-1", server_time: null };
}

/** Record every outbound request so tests can assert the exact Search API payload. */
function mockSearchApi(requests: CapturedRequest[], payload: unknown = resultsPayload([]), status = 200): FetchImpl {
	return async (input, init) => {
		requests.push({
			url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
			method: init?.method,
			authorization: new Headers(init?.headers as Record<string, string>).get("authorization") ?? undefined,
			body: JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>,
		});
		return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
	};
}

describe("Perplexity Search API request shape", () => {
	it("posts one query to /search with bearer auth, Fast Search and a fixed medium extraction budget", async () => {
		const requests: CapturedRequest[] = [];
		await searchPerplexity({
			query: "quic vs tcp",
			authStorage: apiKeyStorage,
			fetch: mockSearchApi(requests),
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(SEARCH_URL);
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.authorization).toBe("Bearer pplx-test-key");
		expect(requests[0]?.body).toEqual({
			query: "quic vs tcp",
			max_results: 10,
			search_type: "fast",
			search_context_size: "medium",
		});
	});

	it("honors a caller-supplied result count and clamps it to the 20-result web cap", async () => {
		const requests: CapturedRequest[] = [];
		const fetchMock = mockSearchApi(requests);

		await searchPerplexity({ query: "quic vs tcp", authStorage: apiKeyStorage, num_results: 5, fetch: fetchMock });
		await searchPerplexity({ query: "quic vs tcp", authStorage: apiKeyStorage, num_results: 50, fetch: fetchMock });

		expect(requests[0]?.body.max_results).toBe(5);
		expect(requests[1]?.body.max_results).toBe(20);
	});

	it("maps site:/-site:/after:/before:/lang: directives onto native filters and strips them from the query", async () => {
		const requests: CapturedRequest[] = [];
		await searchPerplexity({
			query: "rust site:docs.rs -site:reddit.com after:2024-06-01 before:2025-01-15 lang:it",
			authStorage: apiKeyStorage,
			fetch: mockSearchApi(requests),
		});

		const body = requests[0]?.body ?? {};
		expect(body.query).toBe("rust");
		expect(body.search_domain_filter).toEqual(["docs.rs", "-reddit.com"]);
		expect(body.search_after_date_filter).toBe("6/1/2024");
		expect(body.search_before_date_filter).toBe("1/15/2025");
		expect(body.search_language_filter).toEqual(["it"]);
	});

	it("maps recency onto search_recency_filter, which absolute bounds take precedence over", async () => {
		const requests: CapturedRequest[] = [];
		const fetchMock = mockSearchApi(requests);

		await searchPerplexity({ query: "quic", authStorage: apiKeyStorage, recency: "week", fetch: fetchMock });
		await searchPerplexity({
			query: "quic after:2024-06-01",
			authStorage: apiKeyStorage,
			recency: "week",
			fetch: fetchMock,
		});

		expect(requests[0]?.body.search_recency_filter).toBe("week");
		expect(requests[1]?.body.search_recency_filter).toBeUndefined();
		expect(requests[1]?.body.search_after_date_filter).toBe("6/1/2024");
	});
});

describe("Perplexity Search API results", () => {
	it("maps ranked results into sources, dropping entries without a URL and deduping", async () => {
		const requests: CapturedRequest[] = [];
		const response = await searchPerplexity({
			query: "quic vs tcp",
			authStorage: apiKeyStorage,
			fetch: mockSearchApi(
				requests,
				resultsPayload([
					{
						title: "QUIC vs TCP",
						url: "https://example.com/quic",
						snippet: "line one\nline two",
						date: "2024-11-15",
					},
					{ title: "duplicate", url: "https://example.com/quic", snippet: "dup" },
					{ title: "no url", snippet: "orphan" },
				]),
			),
		});

		expect(response.provider).toBe("perplexity");
		expect(response.authMode).toBe("api_key");
		expect(response.requestId).toBe("req-1");
		expect(response.sources).toHaveLength(1);
		expect(response.sources[0]).toMatchObject({
			title: "QUIC vs TCP",
			url: "https://example.com/quic",
			snippet: "line one line two",
			publishedDate: "2024-11-15",
		});
		expect(response.sources[0]?.ageSeconds).toBeGreaterThan(0);
	});

	it("rejects with the classified upstream error instead of the raw body", async () => {
		const requests: CapturedRequest[] = [];
		await expect(
			searchPerplexity({
				query: "quic vs tcp",
				authStorage: apiKeyStorage,
				fetch: mockSearchApi(requests, { detail: "credits exhausted" }, 402),
			}),
		).rejects.toThrow(/perplexity: credits exhausted/);
	});

	it("surfaces unclassified HTTP failures with status and body", async () => {
		const requests: CapturedRequest[] = [];
		await expect(
			searchPerplexity({
				query: "quic vs tcp",
				authStorage: apiKeyStorage,
				fetch: mockSearchApi(requests, "boom", 500),
			}),
		).rejects.toThrow(/Perplexity Search API error \(500\): "boom"/);
	});

	it("rejects a payload without a results array", async () => {
		const requests: CapturedRequest[] = [];
		await expect(
			searchPerplexity({
				query: "quic vs tcp",
				authStorage: apiKeyStorage,
				fetch: mockSearchApi(requests, { id: "x" }),
			}),
		).rejects.toThrow(/unexpected response shape/);
	});
});

describe("Perplexity credentials", () => {
	const savedKey = process.env.PERPLEXITY_API_KEY;

	beforeEach(() => {
		delete process.env.PERPLEXITY_API_KEY;
	});

	afterEach(() => {
		if (savedKey === undefined) delete process.env.PERPLEXITY_API_KEY;
		else process.env.PERPLEXITY_API_KEY = savedKey;
	});

	it("never substitutes an OpenRouter key for the Search API", async () => {
		const requests: CapturedRequest[] = [];
		await expect(
			searchPerplexity({
				query: "quic vs tcp",
				authStorage: authStorageWith({ openrouter: "openrouter-test-key" }),
				fetch: mockSearchApi(requests),
			}),
		).rejects.toThrow(/Search API key not found/);
		expect(requests).toHaveLength(0);
	});

	it("admits itself to the chain only when the API key is configured", () => {
		const provider = new PerplexityProvider();
		const emptyStorage = authStorageWith({});

		expect(provider.isAvailable(emptyStorage)).toBe(false);
		expect(provider.isExplicitlyAvailable(emptyStorage)).toBe(false);

		process.env.PERPLEXITY_API_KEY = "pplx-test-key";
		expect(provider.isAvailable(emptyStorage)).toBe(true);
		expect(provider.isAvailable(apiKeyStorage)).toBe(true);
	});

	it("uses PERPLEXITY_API_KEY instead of a stored OAuth session that would shadow it", async () => {
		process.env.PERPLEXITY_API_KEY = "pplx-env-key";
		const oauthStorage = {
			keys: {
				async get() {
					return "oauth-session-jwt";
				},
				source() {
					return { kind: "oauth", concrete: true };
				},
			},
		} as unknown as AuthStorage;

		const requests: CapturedRequest[] = [];
		await searchPerplexity({ query: "quic vs tcp", authStorage: oauthStorage, fetch: mockSearchApi(requests) });

		expect(requests[0]?.authorization).toBe("Bearer pplx-env-key");
	});

	it("refuses a stored OAuth session when no API key is configured", async () => {
		const oauthStorage = {
			keys: {
				async get() {
					return "oauth-session-jwt";
				},
				source() {
					return { kind: "oauth", concrete: true };
				},
			},
		} as unknown as AuthStorage;

		const requests: CapturedRequest[] = [];
		await expect(
			searchPerplexity({ query: "quic vs tcp", authStorage: oauthStorage, fetch: mockSearchApi(requests) }),
		).rejects.toThrow(/Search API key not found/);
		expect(requests).toHaveLength(0);
	});
});
