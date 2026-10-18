import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { FetchImpl, Model, StoredAuthCredential } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
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
const MARKDOWN =
	`# DeepSeek article\n\n${"This extracted article contains meaningful prose for the reader quality gate. ".repeat(5)}`.trim();
const HTML = `<html><body><article><h1>Local fallback article</h1><p>${"The locally rendered article has enough meaningful prose to pass the common reader quality gate. ".repeat(5)}</p></article></body></html>`;
const deepSeekModel = getBundledModel("deepseek", "deepseek-v4-pro")!;

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

const storedCredentials: StoredAuthCredential[] = [
	{ id: 1, provider: "deepseek", credential: { type: "api_key", key: "stored-deepseek-key" }, disabledCause: null },
];
const storage = {
	listAuthCredentials(provider?: string) {
		return provider === "deepseek" ? storedCredentials : [];
	},
} as unknown as AgentStorage;

function waitForAbort(signal: AbortSignal | null | undefined): Promise<Response> {
	if (!signal) throw new Error("Expected a bounded request signal");
	const pending = Promise.withResolvers<Response>();
	if (signal.aborted) pending.reject(signal.reason);
	else signal.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
	return pending.promise;
}

function makeSession(
	fetchImpl: FetchImpl,
	stored?: AgentStorage,
	preference: FetchProvider | "auto" = "deepseek",
	getActiveModel?: () => Model | undefined,
): ToolSession {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "fetch.enabled": true }, { storage: stored }),
		fetch: fetchImpl,
		getActiveModel,
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
		expect(await fetchWithDeepSeek(ARTICLE_URL, { fetch: fetchImpl }, storage)).toBe(MARKDOWN);
		expect(calls).toBe(1);
	});

	it("rejects missing credentials without sending a request", async () => {
		delete process.env.DEEPSEEK_API_KEY;
		let calls = 0;
		const fetchImpl = mockFetch(() => {
			calls++;
			return Response.json({ content: MARKDOWN });
		});
		await expect(fetchWithDeepSeek(ARTICLE_URL, { fetch: fetchImpl }, null)).rejects.toBeInstanceOf(DeepSeekApiError);
		expect(calls).toBe(0);
	});

	it("recovers from a temporary server failure before falling back to another reader", async () => {
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
				return calls === 1
					? Response.json({ error: { message: "Unavailable" } }, { status: 503, headers: { "Retry-After": "0" } })
					: Response.json({ content: MARKDOWN });
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
		await expect(fetchWithDeepSeek(ARTICLE_URL, { fetch: fetchImpl }, null)).rejects.toMatchObject({
			name: "DeepSeekApiError",
			statusCode: status,
			message: `DeepSeek API error (${status}): Request rejected`,
		});
	});

	it("preserves non-JSON HTTP error details", async () => {
		await expect(
			fetchWithDeepSeek(
				ARTICLE_URL,
				{ fetch: mockFetch(() => new Response("Gateway unavailable", { status: 502 })) },
				null,
			),
		).rejects.toEqual(new DeepSeekApiError("DeepSeek API error (502): Gateway unavailable", 502));
	});

	it.each([null, { content: 7 }, { content: " \r\n " }])(
		"returns no Markdown for unusable payload %j",
		async payload => {
			expect(
				await fetchWithDeepSeek(ARTICLE_URL, { fetch: mockFetch(() => Response.json(payload)) }, null),
			).toBeNull();
		},
	);

	it("enforces its standalone timeout", async () => {
		await expect(
			fetchWithDeepSeek(
				ARTICLE_URL,
				{ timeoutMs: 10, fetch: mockFetch((_input, init) => waitForAbort(init?.signal)) },
				null,
			),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("does not send a request after user cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		await expect(
			fetchWithDeepSeek(
				ARTICLE_URL,
				{
					signal: controller.signal,
					fetch: mockFetch(() => {
						calls++;
						return Response.json({ content: MARKDOWN });
					}),
				},
				null,
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(calls).toBe(0);
	});
});

describe("DeepSeek reader fallback chain", () => {
	it.each([
		{ name: "HTTP failure", body: { error: { message: "Quota exhausted" } }, status: 402 },
		{ name: "empty content", body: { content: "" }, status: 200 },
		{ name: "short content", body: { content: "Too short" }, status: 200 },
		{
			name: "JavaScript gate",
			body: { content: `Please enable JavaScript. ${"A gated page is not the requested article. ".repeat(5)}` },
			status: 200,
		},
		{
			name: "navigation",
			body: { content: Array.from({ length: 20 }, (_, i) => `Navigation link ${i}`).join("\n") },
			status: 200,
		},
	])("falls back to native on $name", async ({ body, status }) => {
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
				return Response.json(body, { status });
			}),
		);
		expect(result.method).toBe("native");
		expect(result.content).toContain("Local fallback article");
		expect(calls).toBe(1);
	});

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

	it("tries DeepSeek after Firecrawl fails and before Jina in auto mode", async () => {
		vi.spyOn(toolsManager, "ensureTool").mockResolvedValue(undefined);
		vi.spyOn(utils, "$which").mockReturnValue(null);
		process.env.FIRECRAWL_API_KEY = "firecrawl-test-key";
		const requests: string[] = [];
		const result = await renderHtmlToText(
			ARTICLE_URL,
			"<html><body>short</body></html>",
			1,
			Settings.isolated(),
			undefined,
			null,
			mockFetch(input => {
				requests.push(String(input));
				return String(input) === API_URL
					? Response.json({ content: MARKDOWN })
					: Response.json({ error: "Rejected" }, { status: 403 });
			}),
		);
		expect(result.method).toBe("deepseek");
		expect(result.content).toBe(MARKDOWN);
		expect(requests).toEqual(["https://api.firecrawl.dev/v2/scrape", API_URL]);
	});

	it("skips DeepSeek without credentials and continues to Jina in auto mode", async () => {
		vi.spyOn(toolsManager, "ensureTool").mockResolvedValue(undefined);
		vi.spyOn(utils, "$which").mockReturnValue(null);
		delete process.env.DEEPSEEK_API_KEY;
		const requests: string[] = [];
		const result = await renderHtmlToText(
			ARTICLE_URL,
			"<html><body>short</body></html>",
			1,
			Settings.isolated(),
			undefined,
			null,
			mockFetch(input => {
				requests.push(String(input));
				return new Response(`Markdown Content:\n${MARKDOWN}`);
			}),
		);
		expect(result.method).toBe("jina");
		expect(result.content).toBe(MARKDOWN);
		expect(requests).toEqual([`https://r.jina.ai/${ARTICLE_URL}`]);
	});

	it.each(["native", "jina"] as const)("honors explicit %s without trying DeepSeek", async preference => {
		const requests: string[] = [];
		const result = await renderHtmlToText(
			ARTICLE_URL,
			HTML,
			1,
			Settings.isolated({ "providers.fetch": preference }),
			undefined,
			null,
			mockFetch(input => {
				requests.push(String(input));
				return new Response(`Markdown Content:\n${MARKDOWN}`);
			}),
		);
		expect(result.method).toBe(preference);
		expect(requests).toEqual(preference === "jina" ? [`https://r.jina.ai/${ARTICLE_URL}`] : []);
	});

	it("skips explicitly selected DeepSeek without official credentials", async () => {
		delete process.env.DEEPSEEK_API_KEY;
		const gatewayStorage = {
			listAuthCredentials(provider?: string) {
				return provider === "openrouter"
					? [{ id: 2, provider, credential: { type: "api_key", key: "gateway-only-key" }, disabledCause: null }]
					: [];
			},
		} as unknown as AgentStorage;
		let calls = 0;
		const result = await renderHtmlToText(
			ARTICLE_URL,
			HTML,
			1,
			Settings.isolated({ "providers.fetch": "deepseek" }),
			undefined,
			gatewayStorage,
			mockFetch(() => {
				calls++;
				return Response.json({ content: MARKDOWN });
			}),
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
	it("keeps successful local rendering first in auto mode but honors explicit DeepSeek", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request =>
				new URL(request.url).pathname === "/article"
					? new Response(HTML, { headers: { "Content-Type": "text/html" } })
					: new Response("Not found", { status: 404 }),
		});
		try {
			let calls = 0;
			const session = makeSession(
				mockFetch(() => {
					calls++;
					return Response.json({ content: MARKDOWN });
				}),
				undefined,
				"auto",
				() => deepSeekModel,
			);
			const read = new ReadTool(session);
			const url = new URL("/article", server.url).href;
			expect((await read.execute("automatic", { path: url })).details?.method).toBe("native");
			expect(calls).toBe(0);
			cfgProvidersFetch.set(session.settings, "deepseek");
			expect((await read.execute("explicit-deepseek", { path: url })).details?.method).toBe("deepseek");
			expect(calls).toBe(1);
			cfgProvidersFetch.set(session.settings, "auto");
			expect((await read.execute("automatic-again", { path: url })).details?.method).toBe("native");
			expect(calls).toBe(1);
		} finally {
			await server.stop(true);
		}
	});

	it("uses stored credentials, reports deepseek, and applies shared image cleanup", async () => {
		delete process.env.DEEPSEEK_API_KEY;
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
					expect(new Headers(init?.headers).get("authorization")).toBe("Bearer stored-deepseek-key");
					return Response.json({
						title: "Article",
						content: `${MARKDOWN}\n\n![diagram](data:image/png;base64,AAAA)`,
					});
				}),
				storage,
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
	});

	it.each(["raw", "binary", "markdown"])("preserves %s handling despite explicit DeepSeek selection", async mode => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				mode === "raw"
					? new Response(HTML, { headers: { "Content-Type": "text/html" } })
					: mode === "markdown"
						? new Response(MARKDOWN, { headers: { "Content-Type": "text/markdown" } })
						: new Response(new Uint8Array([0, 1, 2, 3, 4]), {
								headers: { "Content-Type": "application/octet-stream" },
							}),
		});
		try {
			let calls = 0;
			const session = makeSession(
				mockFetch(() => {
					calls++;
					return Response.json({ content: MARKDOWN });
				}),
			);
			const url = new URL("/article", server.url).href;
			const result = await new ReadTool(session).execute("deepseek-bypass", {
				path: mode === "raw" ? `${url}:raw` : url,
			});
			expect(result.details?.method).toBe(mode === "markdown" ? "text" : mode);
			const text = result.content.find(block => block.type === "text")?.text;
			expect(text).toContain(mode === "raw" ? HTML : mode === "markdown" ? MARKDOWN : "Binary content");
			expect(calls).toBe(0);
		} finally {
			await server.stop(true);
		}
	});
});
