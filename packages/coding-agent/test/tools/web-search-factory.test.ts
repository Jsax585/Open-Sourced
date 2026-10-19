import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { formatSearchProviderFailure } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import {
	clearFactoryOrgPolicyCache,
	FactoryProvider,
	parseFactorySearchResults,
	searchFactory,
} from "@oh-my-pi/pi-coding-agent/web/search/providers/factory";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "../helpers/rejection";

async function withLocalAuthStorage<T>(run: (authStorage: AuthStorage, dbPath: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "web-search-factory-auth-"));
	const dbPath = path.join(dir, "auth.db");
	const authStorage = await AuthStorage.create(dbPath);
	try {
		return await run(authStorage, dbPath);
	} finally {
		authStorage.close();
		await removeWithRetries(dir);
	}
}

async function storeFactoryLogin(authStorage: AuthStorage, region?: string): Promise<void> {
	await authStorage.credentials.set("factory-droid", {
		type: "oauth",
		access: "factory-access-token",
		refresh: "factory-refresh-token",
		expires: Date.now() + 3_600_000,
		orgId: "org-1",
		...(region ? { region } : {}),
	});
}

interface CapturedRequest {
	url: string;
	method: string;
	headers: Headers;
	body?: unknown;
}

const EMPTY_RESULTS = { results: [] };

function factoryFetch(
	captured: CapturedRequest[],
	responses: {
		settings?: () => Response;
		search?: (request: CapturedRequest) => Response;
	},
): FetchImpl {
	return async (input, init) => {
		const request: CapturedRequest = {
			url: String(input),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		};
		captured.push(request);
		if (request.url.endsWith("/api/organization/managed-settings")) {
			return responses.settings?.() ?? Response.json({ success: true, settings: {} });
		}
		if (request.url.endsWith("/api/tools/web-search")) {
			return responses.search?.(request) ?? Response.json(EMPTY_RESULTS);
		}
		throw new Error(`unexpected request ${request.url}`);
	};
}

const disabledSettings = () => Response.json({ success: true, settings: { webSearchDisabled: true } });
const isSearch = (request: CapturedRequest) => request.url.endsWith("/api/tools/web-search");
const isSettings = (request: CapturedRequest) => request.url.endsWith("/api/organization/managed-settings");

beforeEach(() => {
	clearFactoryOrgPolicyCache();
});

afterEach(() => {
	setSystemTime();
	vi.restoreAllMocks();
});

describe("FactoryProvider availability", () => {
	it("is available only with a stored Factory login", async () => {
		await withLocalAuthStorage(async authStorage => {
			const provider = new FactoryProvider();
			expect(provider.isAvailable(authStorage)).toBe(false);
			await storeFactoryLogin(authStorage);
			expect(provider.isAvailable(authStorage)).toBe(true);
		});
	});
});

describe("searchFactory request", () => {
	it("posts the query with the Factory login, session and session model, and normalizes You.com results", async () => {
		const captured: CapturedRequest[] = [];
		const fetchMock = factoryFetch(captured, {
			search: () =>
				Response.json(
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
		const sessionModel = { provider: "factory-droid", id: "session-model-id" } as Model<Api>;

		const result = await withLocalAuthStorage(async authStorage => {
			await storeFactoryLogin(authStorage, "eu");
			return searchFactory({
				query: "bun runtime",
				limit: 5,
				sessionId: "session-1",
				sessionModel,
				authStorage,
				fetch: fetchMock,
			});
		});

		const settings = captured.find(isSettings);
		expect(settings?.url).toBe("https://api.eu.factory.ai/api/organization/managed-settings");
		expect(settings?.headers.get("X-Factory-Org-Id")).toBe("org-1");
		const search = captured.find(isSearch);
		expect(search?.url).toBe("https://api.eu.factory.ai/api/tools/web-search");
		expect(search?.method).toBe("POST");
		expect(search?.headers.get("Authorization")).toBe("Bearer factory-access-token");
		expect(search?.headers.get("X-Factory-Org-Id")).toBe("org-1");
		expect(search?.headers.get("x-session-id")).toBe("session-1");
		expect(search?.headers.get("x-client-model")).toBe("session-model-id");
		expect(search?.body).toEqual({ query: "bun runtime", numResults: 5 });

		expect(result.provider).toBe("factory");
		expect(result.requestId).toBe("req-1");
		expect(result.sources.map(source => [source.title, source.url, source.snippet])).toEqual([
			["Bun", "https://bun.com/", "Fast JavaScript runtime"],
			["Bun 2 ships", "https://example.com/news", "release notes"],
		]);
		expect(result.sources[0]?.publishedDate).toBe("2026-10-01T00:00:00Z");
	});

	it("omits x-client-model outside a Factory session model and defaults then clamps the result count", async () => {
		const captured: CapturedRequest[] = [];
		await withLocalAuthStorage(async authStorage => {
			await storeFactoryLogin(authStorage);
			await searchFactory({ query: "q", authStorage, fetch: factoryFetch(captured, {}) });
			await searchFactory({
				query: "q",
				limit: 99,
				sessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" } as Model<Api>,
				authStorage,
				fetch: factoryFetch(captured, {}),
			});
		});

		const searches = captured.filter(isSearch);
		expect(searches[0]?.url).toBe("https://api.factory.ai/api/tools/web-search");
		expect(searches.map(request => request.headers.has("x-client-model"))).toEqual([false, false]);
		expect(searches.map(request => request.body)).toMatchObject([{ numResults: 10 }, { numResults: 20 }]);
	});
});

describe("parseFactorySearchResults", () => {
	it("normalizes the Parallel and Exa response shapes", () => {
		expect(
			parseFactorySearchResults({
				results: [{ url: "https://p.example", title: "P", publish_date: "2026-01-02", excerpts: ["a", "b"] }],
			}),
		).toMatchObject([{ title: "P", url: "https://p.example", snippet: "a … b", publishedDate: "2026-01-02" }]);
		expect(
			parseFactorySearchResults({
				results: [{ url: "https://e.example", title: null, author: "Ada", highlights: ["hit"] }],
			}),
		).toMatchObject([{ title: "https://e.example", url: "https://e.example", snippet: "hit", author: "Ada" }]);
	});

	it("returns no sources for a malformed body", () => {
		expect(parseFactorySearchResults({ results: "nope" })).toEqual([]);
		expect(parseFactorySearchResults(null)).toEqual([]);
		expect(parseFactorySearchResults({ results: [{ title: "no url" }] })).toEqual([]);
	});
});

describe("searchFactory organization policy", () => {
	it("refuses without sending the query, rotating or blocking the login, and names the org setting", async () => {
		const captured: CapturedRequest[] = [];
		const { error, rotations, blocks } = await withLocalAuthStorage(async (authStorage, dbPath) => {
			await storeFactoryLogin(authStorage);
			const rotate = vi.spyOn(authStorage.limits, "rotate");
			const error = await rejectionOf(
				searchFactory({
					query: "secret",
					authStorage,
					fetch: factoryFetch(captured, { settings: disabledSettings }),
				}),
			);
			const db = new Database(dbPath, { readonly: true });
			const blocks = db.query("SELECT * FROM auth_credential_blocks").all();
			db.close();
			return { error, rotations: rotate.mock.calls.length, blocks };
		});

		expect(error).toBeInstanceOf(SearchProviderError);
		expect((error as SearchProviderError).status).toBeUndefined();
		expect(formatSearchProviderFailure(error, { id: "factory", label: "Factory" })).toContain(
			"disabled by your organization's settings",
		);
		expect(captured.some(isSearch)).toBe(false);
		expect(rotations).toBe(0);
		expect(blocks).toEqual([]);
	});

	it("reuses the policy answer for five minutes, then reads it again", async () => {
		const captured: CapturedRequest[] = [];
		const fetchMock = factoryFetch(captured, {});
		const start = Date.now();
		await withLocalAuthStorage(async authStorage => {
			await storeFactoryLogin(authStorage);
			await searchFactory({ query: "one", authStorage, fetch: fetchMock });
			await searchFactory({ query: "two", authStorage, fetch: fetchMock });
			setSystemTime(new Date(start + 5 * 60_000 + 1_000));
			await searchFactory({ query: "three", authStorage, fetch: fetchMock });
		});

		expect(captured.filter(isSettings)).toHaveLength(2);
		expect(captured.filter(isSearch)).toHaveLength(3);
	});

	it("allows the search when the policy cannot be read, and reuses that answer for a minute", async () => {
		const captured: CapturedRequest[] = [];
		const fetchMock = factoryFetch(captured, { settings: () => new Response("upstream down", { status: 500 }) });
		await withLocalAuthStorage(async authStorage => {
			await storeFactoryLogin(authStorage);
			await searchFactory({ query: "one", authStorage, fetch: fetchMock });
			await searchFactory({ query: "two", authStorage, fetch: fetchMock });
		});

		expect(captured.filter(isSettings)).toHaveLength(1);
		expect(captured.filter(isSearch)).toHaveLength(2);
	});

	it("allows the search when the policy request fails to connect", async () => {
		const captured: CapturedRequest[] = [];
		const fetchMock = factoryFetch(captured, {
			settings: () => {
				throw new TypeError("socket reset");
			},
		});
		await withLocalAuthStorage(async authStorage => {
			await storeFactoryLogin(authStorage);
			await searchFactory({ query: "q", authStorage, fetch: fetchMock });
		});

		expect(captured.filter(isSearch)).toHaveLength(1);
	});

	it("treats a server 403 as the org refusal when a fresh policy read says disabled", async () => {
		let settingsReads = 0;
		const fetchMock = factoryFetch([], {
			settings: () => {
				settingsReads += 1;
				return settingsReads === 1
					? Response.json({ success: true, settings: {} })
					: Response.json({ success: true, settings: { webSearchDisabled: true } });
			},
			search: () => Response.json({ detail: "Web search is disabled" }, { status: 403 }),
		});

		const { error, rotations } = await withLocalAuthStorage(async authStorage => {
			await storeFactoryLogin(authStorage);
			const rotate = vi.spyOn(authStorage.limits, "rotate");
			const error = await rejectionOf(searchFactory({ query: "q", authStorage, fetch: fetchMock }));
			return { error, rotations: rotate.mock.calls.length };
		});

		expect(error).toBeInstanceOf(SearchProviderError);
		expect((error as SearchProviderError).status).toBeUndefined();
		expect(String(error)).toContain("disabled by your organization's settings");
		expect(rotations).toBe(0);
	});
});

describe("searchFactory errors", () => {
	it("refuses an oversized success body instead of buffering it", async () => {
		const huge = JSON.stringify({ results: [{ url: "https://e.example", text: "x".repeat(3 * 1024 * 1024) }] });
		const fetchMock = factoryFetch([], { search: () => new Response(huge, { status: 200 }) });

		const error = await withLocalAuthStorage(async authStorage => {
			await storeFactoryLogin(authStorage);
			return rejectionOf(searchFactory({ query: "q", authStorage, fetch: fetchMock }));
		});

		expect(error).toBeInstanceOf(SearchProviderError);
		expect(String(error)).toContain("exceeded");
	});

	it("truncates a large error body instead of embedding it whole", async () => {
		const fetchMock = factoryFetch([], { search: () => new Response("x".repeat(200_000), { status: 502 }) });

		const error = await withLocalAuthStorage(async authStorage => {
			await storeFactoryLogin(authStorage);
			return rejectionOf(searchFactory({ query: "q", authStorage, fetch: fetchMock }));
		});

		expect(error).toBeInstanceOf(SearchProviderError);
		expect(String(error).length).toBeLessThan(10_000);
	});
});

describe("searchFactory authentication", () => {
	it("retries with a refreshed token after a 401", async () => {
		const captured: CapturedRequest[] = [];
		const fetchMock = factoryFetch(captured, {
			search: request =>
				request.headers.get("Authorization") === "Bearer refreshed-token"
					? Response.json({ results: [{ url: "https://ok.example", title: "OK", highlights: ["fine"] }] })
					: Response.json({ detail: "Access token is invalid or expired.", status: 401 }, { status: 401 }),
		});

		const result = await withLocalAuthStorage(async authStorage => {
			await storeFactoryLogin(authStorage);
			const access = authStorage.oauth.access.bind(authStorage.oauth);
			vi.spyOn(authStorage.oauth, "access").mockImplementation(async (provider, sessionId, options) => {
				const current = await access(provider, sessionId, { ...options, forceRefresh: false });
				return options?.forceRefresh && current ? { ...current, accessToken: "refreshed-token" } : current;
			});
			return searchFactory({ query: "q", authStorage, fetch: fetchMock });
		});

		expect(result.sources.map(source => source.url)).toEqual(["https://ok.example"]);
		expect(captured.filter(isSearch).map(request => request.headers.get("Authorization"))).toEqual([
			"Bearer factory-access-token",
			"Bearer refreshed-token",
		]);
	});

	it("reports a rejected login as an authorization failure when refresh yields nothing", async () => {
		const fetchMock = factoryFetch([], {
			search: () => Response.json({ detail: "Access token is invalid or expired.", status: 401 }, { status: 401 }),
		});

		const error = await withLocalAuthStorage(async authStorage => {
			await storeFactoryLogin(authStorage);
			const access = authStorage.oauth.access.bind(authStorage.oauth);
			vi.spyOn(authStorage.oauth, "access").mockImplementation((provider, sessionId, options) =>
				options?.forceRefresh ? Promise.resolve(undefined) : access(provider, sessionId, options),
			);
			return rejectionOf(searchFactory({ query: "q", authStorage, fetch: fetchMock }));
		});

		expect(error).toBeInstanceOf(SearchProviderError);
		expect((error as SearchProviderError).status).toBe(401);
	});

	it("asks for a Factory login when none is stored", async () => {
		const error = await withLocalAuthStorage(authStorage =>
			rejectionOf(searchFactory({ query: "q", authStorage, fetch: factoryFetch([], {}) })),
		);
		expect(String(error)).toMatch(/login factory-droid/);
	});
});
