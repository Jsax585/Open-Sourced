import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, type FetchImpl } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgProvidersFetch } from "@oh-my-pi/pi-coding-agent/session/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type FetchProvider, renderHtmlToText } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { DeepSeekApiError, fetchWithDeepSeek } from "@oh-my-pi/pi-coding-agent/web/deepseek";
import { mockFetch } from "../helpers/fetch-mock";
import * as toolsManager from "@oh-my-pi/pi-coding-agent/utils/tools-manager";
import * as utils from "@oh-my-pi/pi-utils";

const API_URL = "https://api.deepseek.com/v1/tools/fetch";
const ARTICLE_URL = "https://example.com/article";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MARKDOWN =
	`# DeepSeek article\n\n${"This extracted article contains meaningful prose for the reader quality gate. ".repeat(5)}`.trim();
const HTML = `<html><body><article><h1>Local fallback article</h1><p>${"The locally rendered article has enough meaningful prose to pass the common reader quality gate. ".repeat(5)}</p></article></body></html>`;

const credentialVariables = [
	"DEEPSEEK_API_KEY",
	"PARALLEL_API_KEY",
	"FIRECRAWL_API_KEY",
	"FIRECRAWL_BASE_URL",
	"FIRECRAWL_API_URL",
] as const;
const originalCredentials: Record<string, string | undefined> = {};
beforeEach(() => {
	for (const name of credentialVariables) {
		originalCredentials[name] = process.env[name];
		delete process.env[name];
	}
	process.env.DEEPSEEK_API_KEY = "env-deepseek-key";
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const name of credentialVariables) {
		if (originalCredentials[name] === undefined) delete process.env[name];
		else process.env[name] = originalCredentials[name];
	}
});

const authStores: AuthStorage[] = [];
async function createAuthStorage(): Promise<AuthStorage> {
	const authStorage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	authStores.push(authStorage);
	return authStorage;
}

afterEach(() => {
	for (const authStorage of authStores.splice(0)) authStorage.close();
});

function waitForAbort(signal: AbortSignal | null | undefined): Promise<Response> {
	if (!signal) throw new Error("Expected a bounded request signal");
	const pending = Promise.withResolvers<Response>();
	if (signal.aborted) pending.reject(signal.reason);
	else signal.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
	return pending.promise;
}

function makeSession(
	fetchImpl: FetchImpl,
	authStorage?: AuthStorage,
	preference: FetchProvider | "auto" = "deepseek",
): ToolSession {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "fetch.enabled": true }),
		fetch: fetchImpl,
		authStorage,
		getSessionId: () => "deepseek-read-test",
	};
	cfgProvidersFetch.set(session.settings, preference);
	return session;
}

describe("DeepSeek fetch client", () => {
	it("posts the URL with bearer credentials and normalizes Markdown without flattening it", async () => {
		let calls = 0;
		const fetchImpl = mockFetch((input, init) => {
			calls++;
			expect(String(input)).toBe(API_URL);
			expect(init?.method).toBe("POST");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer env-deepseek-key");
			expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
			expect(JSON.parse(String(init?.body))).toEqual({ url: ARTICLE_URL });
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			return Response.json({ title: "Article", content: `\r\n${MARKDOWN.replace(/\n/g, "\r\n")}\r\n` });
		});
		expect(await fetchWithDeepSeek(ARTICLE_URL, { fetch: fetchImpl })).toBe(MARKDOWN);
		expect(calls).toBe(1);
	});

	it("rejects missing credentials without sending a request", async () => {
		delete process.env.DEEPSEEK_API_KEY;
		let calls = 0;
		const fetchImpl = mockFetch(() => {
			calls++;
			return Response.json({ content: MARKDOWN });
		});
		await expect(fetchWithDeepSeek(ARTICLE_URL, { fetch: fetchImpl })).rejects.toThrow(
			"DeepSeek credentials not found",
		);
		expect(calls).toBe(0);
	});

	it.each([
		{ status: 401, oversized: false },
		{ status: 403, oversized: false },
		{ status: 401, oversized: true },
	])("rotates stored credentials after HTTP $status (oversized: $oversized)", async ({ status, oversized }) => {
		const authStorage = await createAuthStorage();
		await authStorage.credentials.set("deepseek", [
			{ type: "api_key", key: "first-key", source: "login" },
			{ type: "api_key", key: "second-key", source: "login" },
		]);
		const attemptedKeys: string[] = [];
		const result = await fetchWithDeepSeek(ARTICLE_URL, {
			apiKey: authStorage.keys.resolver("deepseek", { sessionId: "deepseek-rotation" }),
			fetch: mockFetch((_input, init) => {
				const key = new Headers(init?.headers).get("authorization")!;
				attemptedKeys.push(key);
				if (attemptedKeys.length === 1) {
					const body = JSON.stringify({ error: { message: "Invalid credentials" } });
					return new Response(oversized ? body.padEnd(MAX_RESPONSE_BYTES + 1) : body, { status });
				}
				return Response.json({ content: MARKDOWN });
			}),
		});
		expect(result).toBe(MARKDOWN);
		expect(attemptedKeys.toSorted()).toEqual(["Bearer first-key", "Bearer second-key"]);
	});

	it.each([200, 402])("accepts HTTP %i JSON exactly at the 2 MiB boundary", async status => {
		const body = JSON.stringify({ content: MARKDOWN, error: { message: "Request rejected" } }).padEnd(
			MAX_RESPONSE_BYTES,
		);
		const pending = fetchWithDeepSeek(ARTICLE_URL, { fetch: mockFetch(() => new Response(body, { status })) });
		if (status === 200) await expect(pending).resolves.toBe(MARKDOWN);
		else {
			await expect(pending).rejects.toMatchObject({
				statusCode: status,
				message: "DeepSeek API error (402): Request rejected",
			});
		}
	});

	it.each([200, 402])("stops an oversized HTTP %i body without parsing its JSON prefix", async status => {
		let pulls = 0;
		let cancelled = false;
		const prefix = JSON.stringify({ content: MARKDOWN, error: { message: "Do not parse a truncated response" } });
		const response = new Response(
			new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						pulls++;
						if (pulls === 1) controller.enqueue(Buffer.from(prefix.padEnd(MAX_RESPONSE_BYTES)));
						else if (pulls === 2) controller.enqueue(new Uint8Array([32]));
						else throw new Error("Read beyond body limit");
					},
					cancel() {
						cancelled = true;
					},
				},
				{ highWaterMark: 0 },
			),
			{ status },
		);
		const pending = fetchWithDeepSeek(ARTICLE_URL, { fetch: mockFetch(() => response) });
		if (status === 200) await expect(pending).resolves.toBeNull();
		else {
			await expect(pending).rejects.toMatchObject({
				statusCode: status,
				message: `DeepSeek API error (${status}): response body too large`,
			});
		}
		expect(pulls).toBe(2);
		expect(cancelled).toBe(true);
	});

	it("returns no Markdown and falls back promptly when cancelling an oversized body stalls", async () => {
		let cancellations = 0;
		const fetchImpl = mockFetch(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1));
						},
						cancel() {
							cancellations++;
							return Promise.withResolvers<void>().promise;
						},
					}),
				),
		);
		const result = await renderHtmlToText(
			ARTICLE_URL,
			HTML,
			30,
			Settings.isolated({ "providers.fetch": "deepseek" }),
			undefined,
			null,
			fetchImpl,
		);
		expect(result.method).toBe("native");
		expect(result.content).toContain("Local fallback article");
		expect(cancellations).toBe(1);
	}, 1_000);

	it("propagates cancellation while reading a response body", async () => {
		const controller = new AbortController();
		const reading = Promise.withResolvers<void>();
		const response = new Response(
			new ReadableStream<Uint8Array>(
				{
					pull() {
						reading.resolve();
						return Promise.withResolvers<void>().promise;
					},
				},
				{ highWaterMark: 0 },
			),
		);
		const pending = fetchWithDeepSeek(ARTICLE_URL, {
			signal: controller.signal,
			fetch: mockFetch(() => response),
		});
		await reading.promise;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	it("caps the first retryable response before reading retry hints or making another request", async () => {
		let calls = 0;
		let pulls = 0;
		let cancelled = false;
		const prefix = JSON.stringify({ error: { message: "retry-after-ms=0" } });
		const response = new Response(
			new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						pulls++;
						if (pulls === 1) controller.enqueue(Buffer.from(prefix.padEnd(MAX_RESPONSE_BYTES)));
						else if (pulls === 2) controller.enqueue(new Uint8Array([32]));
						else return Promise.withResolvers<void>().promise;
					},
					cancel() {
						cancelled = true;
						return Promise.withResolvers<void>().promise;
					},
				},
				{ highWaterMark: 0 },
			),
			{ status: 429 },
		);
		await expect(
			fetchWithDeepSeek(ARTICLE_URL, {
				fetch: mockFetch(() => {
					calls++;
					return calls === 1 ? response : Response.json({ content: MARKDOWN });
				}),
			}),
		).rejects.toMatchObject({
			name: "DeepSeekApiError",
			statusCode: 429,
			message: "DeepSeek API error (429): response body too large",
		});
		expect(calls).toBe(1);
		expect(pulls).toBeGreaterThanOrEqual(2);
		expect(pulls).toBeLessThanOrEqual(3);
		expect(cancelled).toBe(true);
	}, 1_000);

	it.each(["header", "body"])("recovers from a temporary failure using a within-limit %s retry hint", async hint => {
		let calls = 0;
		const result = await renderHtmlToText(
			ARTICLE_URL,
			HTML,
			0.25,
			Settings.isolated({ "providers.fetch": "deepseek" }),
			undefined,
			null,
			mockFetch(() => {
				calls++;
				if (calls > 1) return Response.json({ content: MARKDOWN });
				return Response.json(
					{ error: { message: hint === "body" ? "retry-after-ms=0" : "Unavailable" } },
					{ status: 503, headers: hint === "header" ? { "Retry-After": "0" } : undefined },
				);
			}),
		);
		expect(result.method).toBe("deepseek");
		expect(result.content).toBe(MARKDOWN);
		expect(calls).toBe(2);
	});

	it.each([
		{ status: 408, retryAfter: "0", calls: 2 },
		{ status: 429, retryAfter: "3", calls: 1 },
		{ status: 402, retryAfter: "0", calls: 1 },
	])(
		"falls back after HTTP $status without exceeding its retry policy",
		async ({ status, retryAfter, calls: expectedCalls }) => {
			let calls = 0;
			const result = await renderHtmlToText(
				ARTICLE_URL,
				HTML,
				1,
				Settings.isolated({ "providers.fetch": "deepseek" }),
				undefined,
				null,
				mockFetch(() => {
					calls++;
					return Response.json(
						{ error: { message: "Request rejected" } },
						{ status, headers: { "Retry-After": retryAfter } },
					);
				}),
			);
			expect(result.method).toBe("native");
			expect(result.content).toContain("Local fallback article");
			expect(calls).toBe(expectedCalls);
		},
	);

	it("honors user cancellation during retry backoff without another request or fallback", async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		let calls = 0;
		const request = renderHtmlToText(
			ARTICLE_URL,
			HTML,
			1,
			Settings.isolated({ "providers.fetch": "deepseek" }),
			controller.signal,
			null,
			mockFetch(() => {
				calls++;
				started.resolve();
				return Response.json({ error: { message: "Slow down" } }, { status: 429, headers: { "Retry-After": "1" } });
			}),
		);
		await started.promise;
		controller.abort();
		await expect(request).rejects.toMatchObject({ name: "AbortError" });
		expect(calls).toBe(1);
	});

	it("reports structured HTTP API errors", async () => {
		const status = 402;
		const fetchImpl = mockFetch(() =>
			Response.json(
				{ error: { message: "Request rejected", type: "api_error", code: "failure", param: null } },
				{ status },
			),
		);
		await expect(fetchWithDeepSeek(ARTICLE_URL, { fetch: fetchImpl })).rejects.toMatchObject({
			name: "DeepSeekApiError",
			statusCode: status,
			message: `DeepSeek API error (${status}): Request rejected`,
		});
	});

	it("preserves non-JSON HTTP error details", async () => {
		await expect(
			fetchWithDeepSeek(ARTICLE_URL, {
				fetch: mockFetch(() => new Response("Gateway unavailable", { status: 502 })),
			}),
		).rejects.toEqual(new DeepSeekApiError("DeepSeek API error (502): Gateway unavailable", 502));
	});

	it.each([null, { content: 7 }, { content: " \r\n " }])(
		"returns no Markdown for unusable payload %j",
		async payload => {
			expect(await fetchWithDeepSeek(ARTICLE_URL, { fetch: mockFetch(() => Response.json(payload)) })).toBeNull();
		},
	);

	it("enforces its standalone timeout", async () => {
		await expect(
			fetchWithDeepSeek(ARTICLE_URL, {
				timeoutMs: 10,
				fetch: mockFetch((_input, init) => waitForAbort(init?.signal)),
			}),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("does not send a request after user cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		await expect(
			fetchWithDeepSeek(ARTICLE_URL, {
				signal: controller.signal,
				fetch: mockFetch(() => {
					calls++;
					return Response.json({ content: MARKDOWN });
				}),
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(calls).toBe(0);
	});
});

describe("DeepSeek reader fallback chain", () => {
	it.each(["transport", "invalid JSON"])("falls back after %s failure", async failure => {
		const fetchImpl = mockFetch(() => {
			if (failure === "transport") throw new Error("Connection failed");
			return new Response("not JSON");
		});
		const result = await renderHtmlToText(
			ARTICLE_URL,
			HTML,
			1,
			Settings.isolated({ "providers.fetch": "deepseek" }),
			undefined,
			null,
			fetchImpl,
		);
		expect(result.method).toBe("native");
	});

	it.each([200, 402])("falls back to native after an oversized HTTP %i response", async status => {
		const result = await renderHtmlToText(
			ARTICLE_URL,
			HTML,
			1,
			Settings.isolated({ "providers.fetch": "deepseek" }),
			undefined,
			null,
			mockFetch(
				() => new Response(JSON.stringify({ content: MARKDOWN }).padEnd(MAX_RESPONSE_BYTES + 1), { status }),
			),
		);
		expect(result.method).toBe("native");
		expect(result.content).toContain("Local fallback article");
	});

	it("excludes DeepSeek from auto even with environment and configured credentials", async () => {
		vi.spyOn(toolsManager, "ensureTool").mockResolvedValue(undefined);
		vi.spyOn(utils, "$which").mockReturnValue(null);
		process.env.FIRECRAWL_API_KEY = "firecrawl-test-key";
		const authStorage = await createAuthStorage();
		authStorage.keys.setConfig("deepseek", "configured-deepseek-key");
		const requests: string[] = [];
		const result = await renderHtmlToText(
			ARTICLE_URL,
			"<html><body>short</body></html>",
			1,
			Settings.isolated({ "providers.fetch": "auto" }),
			undefined,
			null,
			mockFetch(input => {
				requests.push(String(input));
				if (String(input) === API_URL) return Response.json({ content: MARKDOWN });
				return String(input) === `https://r.jina.ai/${ARTICLE_URL}`
					? new Response(`Markdown Content:\n${MARKDOWN}`)
					: Response.json({ error: "Rejected" }, { status: 403 });
			}),
			authStorage.keys.resolver("deepseek"),
		);
		expect(result.method).toBe("jina");
		expect(result.content).toBe(MARKDOWN);
		expect(requests).toEqual(["https://api.firecrawl.dev/v2/scrape", `https://r.jina.ai/${ARTICLE_URL}`]);
	});

	it("skips explicitly selected DeepSeek without official credentials", async () => {
		delete process.env.DEEPSEEK_API_KEY;
		const authStorage = await createAuthStorage();
		await authStorage.credentials.set("openrouter", { type: "api_key", key: "gateway-only-key" });
		let calls = 0;
		const result = await renderHtmlToText(
			ARTICLE_URL,
			HTML,
			1,
			Settings.isolated({ "providers.fetch": "deepseek" }),
			undefined,
			null,
			mockFetch(() => {
				calls++;
				return Response.json({ content: MARKDOWN });
			}),
			authStorage.keys.resolver("deepseek"),
		);
		expect(result.method).toBe("native");
		expect(calls).toBe(0);
	});

	it("falls back to local rendering when the remote budget expires", async () => {
		const result = await renderHtmlToText(
			ARTICLE_URL,
			HTML,
			0.02,
			Settings.isolated({ "providers.fetch": "deepseek" }),
			undefined,
			null,
			mockFetch((_input, init) => waitForAbort(init?.signal)),
		);
		expect(result.method).toBe("native");
		expect(result.ok).toBe(true);
	});

	it("propagates user cancellation instead of falling back", async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const pending = renderHtmlToText(
			ARTICLE_URL,
			HTML,
			30,
			Settings.isolated({ "providers.fetch": "deepseek" }),
			controller.signal,
			null,
			mockFetch((_input, init) => {
				started.resolve();
				return waitForAbort(init?.signal);
			}),
		);
		await started.promise;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});
});

describe("DeepSeek through read URL", () => {
	it.each(["config", "runtime", "login"] as const)(
		"uses %s credentials before environment keys through ReadTool",
		async source => {
			const authStorage = await createAuthStorage();
			if (source === "config") authStorage.keys.setConfig("deepseek", "configured-deepseek-key");
			else if (source === "runtime") authStorage.keys.setRuntime("deepseek", "configured-deepseek-key");
			else {
				await authStorage.credentials.set("deepseek", {
					type: "api_key",
					key: "configured-deepseek-key",
					source: "login",
				});
			}
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: request =>
					new URL(request.url).pathname === "/article"
						? new Response(HTML, { headers: { "Content-Type": "text/html" } })
						: new Response("Not found", { status: 404 }),
			});
			try {
				const url = new URL("/article", server.url).href;
				let calls = 0;
				const session = makeSession(
					mockFetch((input, init) => {
						calls++;
						expect(String(input)).toBe(API_URL);
						expect(JSON.parse(String(init?.body))).toEqual({ url });
						expect(new Headers(init?.headers).get("authorization")).toBe("Bearer configured-deepseek-key");
						return Response.json({
							title: "Article",
							content: `${MARKDOWN}\n\n![diagram](data:image/png;base64,AAAA)`,
						});
					}),
					authStorage,
				);
				const result = await new ReadTool(session).execute("deepseek-read", { path: url });
				expect(result.details?.method).toBe("deepseek");
				const text = result.content.find(block => block.type === "text")?.text;
				expect(text).toContain("DeepSeek article");
				expect(text).toContain("![diagram]");
				expect(text).not.toContain("base64");
				expect(calls).toBe(1);
			} finally {
				await server.stop(true);
			}
		},
	);
});
