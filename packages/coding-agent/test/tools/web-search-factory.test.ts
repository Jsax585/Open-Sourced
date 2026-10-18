import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { FactoryProvider, searchFactory } from "@oh-my-pi/pi-coding-agent/web/search/providers/factory";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function withLocalAuthStorage<T>(run: (authStorage: AuthStorage) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "web-search-factory-auth-"));
	const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
	try {
		return await run(authStorage);
	} finally {
		authStorage.close();
		await removeWithRetries(dir);
	}
}

async function storeFactoryLogin(authStorage: AuthStorage, orgId: string, region?: string): Promise<void> {
	await authStorage.credentials.set("factory-droid", {
		type: "oauth",
		access: "factory-access-token",
		refresh: "factory-refresh-token",
		expires: Date.now() + 3_600_000,
		orgId,
		...(region ? { region } : {}),
	});
}

interface CapturedRequest {
	url: string;
	method: string;
	headers: Headers;
	body?: unknown;
}

function factoryFetch(
	captured: CapturedRequest[],
	responses: { settings?: unknown; search?: Response | (() => Response) },
): FetchImpl {
	return async (input, init) => {
		const url = String(input);
		captured.push({
			url,
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		});
		if (url.endsWith("/api/organization/managed-settings")) {
			return Response.json({ success: true, settings: responses.settings ?? {} });
		}
		if (url.endsWith("/api/tools/web-search")) {
			const search = responses.search;
			if (typeof search === "function") return search();
			if (search) return search;
		}
		throw new Error(`unexpected request ${url}`);
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("FactoryProvider availability", () => {
	it("is available only with a stored Factory login", async () => {
		await withLocalAuthStorage(async authStorage => {
			const provider = new FactoryProvider();
			expect(provider.isAvailable(authStorage)).toBe(false);
			await storeFactoryLogin(authStorage, "org-availability");
			expect(provider.isAvailable(authStorage)).toBe(true);
		});
	});
});

describe("searchFactory", () => {
	it("posts the query with the Factory login and normalizes You.com results", async () => {
		const captured: CapturedRequest[] = [];
		const fetchMock = factoryFetch(captured, {
			search: Response.json(
				{
					results: {
						web: [
							{
								title: "Bun",
								url: "https://bun.com/",
								description: "Fast JavaScript runtime",
								snippets: ["ignored when description exists"],
								page_age: "2026-10-01T00:00:00Z",
							},
						],
						news: [{ title: "Bun 2 ships", url: "https://example.com/news", snippets: ["release notes"] }],
					},
				},
				{ headers: { "x-request-id": "req-1" } },
			),
		});

		const result = await withLocalAuthStorage(async authStorage => {
			await storeFactoryLogin(authStorage, "org-success", "eu");
			return searchFactory({
				query: "bun runtime",
				limit: 5,
				sessionId: "session-1",
				authStorage,
				fetch: fetchMock,
			});
		});

		const search = captured.find(request => request.url.endsWith("/api/tools/web-search"));
		expect(search?.url).toBe("https://api.eu.factory.ai/api/tools/web-search");
		expect(search?.method).toBe("POST");
		expect(search?.headers.get("Authorization")).toBe("Bearer factory-access-token");
		expect(search?.headers.get("X-Factory-Org-Id")).toBe("org-success");
		expect(search?.headers.get("x-session-id")).toBe("session-1");
		expect(search?.body).toEqual({ query: "bun runtime", numResults: 5 });

		expect(result.provider).toBe("factory");
		expect(result.requestId).toBe("req-1");
		expect(result.sources.map(source => [source.title, source.url, source.snippet])).toEqual([
			["Bun", "https://bun.com/", "Fast JavaScript runtime"],
			["Bun 2 ships", "https://example.com/news", "release notes"],
		]);
		expect(result.sources[0]?.publishedDate).toBe("2026-10-01T00:00:00Z");
	});

	it("normalizes the Parallel and Exa response shapes", async () => {
		const bodies = [
			{ results: [{ url: "https://p.example", title: "P", publish_date: "2026-01-02", excerpts: ["a", "b"] }] },
			{ results: [{ url: "https://e.example", title: null, author: "Ada", highlights: ["hit"] }] },
		];
		const results = await withLocalAuthStorage(async authStorage => {
			await storeFactoryLogin(authStorage, "org-shapes");
			const out = [];
			for (const body of bodies) {
				out.push(
					await searchFactory({
						query: "q",
						authStorage,
						fetch: factoryFetch([], { search: Response.json(body) }),
					}),
				);
			}
			return out;
		});

		expect(results[0]?.sources).toMatchObject([
			{ title: "P", url: "https://p.example", snippet: "a … b", publishedDate: "2026-01-02" },
		]);
		expect(results[1]?.sources).toMatchObject([
			{ title: "https://e.example", url: "https://e.example", snippet: "hit", author: "Ada" },
		]);
	});

	it("refuses without sending the query when the organization disables web search", async () => {
		const captured: CapturedRequest[] = [];
		const fetchMock = factoryFetch(captured, { settings: { webSearchDisabled: true } });

		const error = await withLocalAuthStorage(async authStorage => {
			await storeFactoryLogin(authStorage, "org-disabled");
			return searchFactory({ query: "secret", authStorage, fetch: fetchMock }).catch((err: unknown) => err);
		});

		expect(error).toBeInstanceOf(SearchProviderError);
		expect((error as SearchProviderError).status).toBe(403);
		expect((error as SearchProviderError).message).toContain("disabled by your organization");
		expect(captured.some(request => request.url.endsWith("/api/tools/web-search"))).toBe(false);
	});

	it("reports a rejected Factory login as an authorization failure", async () => {
		const fetchMock = factoryFetch([], {
			search: () => Response.json({ detail: "Access token is invalid or expired.", status: 401 }, { status: 401 }),
		});

		const error = await withLocalAuthStorage(async authStorage => {
			await storeFactoryLogin(authStorage, "org-auth-error");
			// The retry wrapper asks for a refreshed token after a 401; a missing refresh ends the retry offline.
			const access = authStorage.oauth.access.bind(authStorage.oauth);
			vi.spyOn(authStorage.oauth, "access").mockImplementation((provider, sessionId, options) =>
				options?.forceRefresh ? Promise.resolve(undefined) : access(provider, sessionId, options),
			);
			return searchFactory({ query: "q", authStorage, fetch: fetchMock }).catch((err: unknown) => err);
		});

		expect(error).toBeInstanceOf(SearchProviderError);
		expect((error as SearchProviderError).status).toBe(401);
	});

	it("asks for a Factory login when none is stored", async () => {
		await withLocalAuthStorage(async authStorage => {
			await expect(searchFactory({ query: "q", authStorage, fetch: factoryFetch([], {}) })).rejects.toThrow(
				/login factory-droid/,
			);
		});
	});
});
