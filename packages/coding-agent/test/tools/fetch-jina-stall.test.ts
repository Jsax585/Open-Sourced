import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { renderHtmlToText } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import * as toolsManager from "@oh-my-pi/pi-coding-agent/utils/tools-manager";
import * as utils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "../helpers/fetch-mock";

/**
 * Regression test for #1449: a stalled Jina reader request must not prevent
 * native rendering of already-loaded HTML after the shared reader-mode deadline.
 */
describe("renderHtmlToText: jina stall does not starve local fallbacks (#1449)", () => {
	it("falls back to native renderer when jina hangs until aborted", async () => {
		// Force jina first so the stall path is actually exercised before the
		// native fallback runs.
		const settings = Settings.isolated({ "providers.fetch": "jina" });
		// Substantive HTML so the native converter produces >100 chars and
		// `isLowQualityOutput` does not reject it.
		const paragraphs = Array.from(
			{ length: 6 },
			(_, i) =>
				`<p>Paragraph number ${i + 1} carries some real content for the article body so the native renderer has enough text to satisfy the length threshold.</p>`,
		).join("");
		const html = `<!doctype html><html><head><title>Example</title></head><body><article><h1>Example article</h1>${paragraphs}</article></body></html>`;

		let requestSignal: AbortSignal | null | undefined;
		const fetchMock = asGlobalFetch((input, init) => {
			const url = String(input);
			if (url.startsWith("https://r.jina.ai/")) {
				requestSignal = init?.signal;
				return new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) return;
					if (signal.aborted) {
						reject(new DOMException("aborted", "AbortError"));
						return;
					}
					signal.addEventListener("abort", () => {
						reject(new DOMException("aborted", "AbortError"));
					});
				});
			}
			return new Response("", { status: 404 });
		});

		// A short real budget is intentional: the combined AbortSignal clock is
		// the behavior under test, and fake timers do not drive it reliably.
		const result = await renderHtmlToText(
			"https://example.com/article",
			html,
			0.05,
			settings,
			undefined,
			null,
			fetchMock,
		);

		expect(result.ok).toBe(true);
		expect(requestSignal?.aborted).toBe(true);
		expect(result.method).toBe("native");
	});

	it("shares the render deadline across sequential remote fallbacks and skips later requests", async () => {
		const originalFirecrawlKey = process.env.FIRECRAWL_API_KEY;
		const originalParallelKey = process.env.PARALLEL_API_KEY;
		process.env.FIRECRAWL_API_KEY = "firecrawl-test-key";
		process.env.PARALLEL_API_KEY = "parallel-test-key";
		const deadline = new AbortController();
		// Control only the whole-render clock; per-provider signal composition stays real.
		const clock = vi.spyOn(utils.ptree, "combineSignals").mockReturnValueOnce(deadline.signal);
		const ensureTool = vi.spyOn(toolsManager, "ensureTool").mockResolvedValue(undefined);
		const which = vi.spyOn(utils, "$which").mockReturnValue(null);
		const requests: string[] = [];
		const signals: Array<AbortSignal | null | undefined> = [];
		const paragraph =
			"Please enable JavaScript to view this article. This locally available text is substantial but fails the reader quality gate. ";
		const html = `<html><body><article><h1>Fallback article</h1><p>${paragraph.repeat(4)}</p></article></body></html>`;
		try {
			const result = await renderHtmlToText(
				"https://example.com/article",
				html,
				30,
				Settings.isolated({ "providers.fetch": "firecrawl" }),
				undefined,
				null,
				asGlobalFetch((input, init) => {
					requests.push(String(input));
					signals.push(init?.signal);
					if (requests.length === 1) {
						return Response.json({ success: true, data: { markdown: "Too short" } });
					}
					// The second provider starts before the deadline, then exhausts the
					// remaining shared budget. Neither it nor Jina gets a fresh budget.
					deadline.abort(new DOMException("Render deadline expired", "TimeoutError"));
					return Promise.reject(deadline.signal.reason);
				}),
			);

			expect(requests).toEqual(["https://api.firecrawl.dev/v2/scrape", "https://api.parallel.ai/v1beta/extract"]);
			expect(signals).toHaveLength(2);
			expect(signals.every(signal => signal?.aborted)).toBe(true);
			expect(result.ok).toBe(true);
			expect(result.method).toBe("native");
			expect(result.content).toContain("Fallback article");
		} finally {
			clock.mockRestore();
			ensureTool.mockRestore();
			which.mockRestore();
			if (originalFirecrawlKey === undefined) delete process.env.FIRECRAWL_API_KEY;
			else process.env.FIRECRAWL_API_KEY = originalFirecrawlKey;
			if (originalParallelKey === undefined) delete process.env.PARALLEL_API_KEY;
			else process.env.PARALLEL_API_KEY = originalParallelKey;
		}
	});

	it("re-throws when the user signal is aborted, not when Jina sub-budget expires", async () => {
		const settings = Settings.isolated({ "providers.fetch": "jina" });
		const html = "<html><body><p>short</p></body></html>";

		const fetchMock2 = asGlobalFetch((_input, init) => {
			return new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) return;
				if (signal.aborted) {
					reject(new DOMException("aborted", "AbortError"));
					return;
				}
				signal.addEventListener("abort", () => {
					reject(new DOMException("aborted", "AbortError"));
				});
			});
		});

		const controller = new AbortController();
		const pending = renderHtmlToText(
			"https://example.com/article",
			html,
			30,
			settings,
			controller.signal,
			null,
			fetchMock2,
		).catch(err => err);

		controller.abort();
		const outcome = await pending;
		expect(outcome).toBeInstanceOf(Error);
		expect(
			(outcome as Error).name === "AbortError" || (outcome as Error).message.toLowerCase().includes("abort"),
		).toBe(true);
	});
});

describe("renderHtmlToText: Jina response validation", () => {
	it("sends JINA_API_KEY as optional bearer authentication", async () => {
		const originalApiKey = process.env.JINA_API_KEY;
		process.env.JINA_API_KEY = "env-jina-key";
		try {
			const settings = Settings.isolated({ "providers.fetch": "jina" });
			let requestHeaders: Headers | undefined;
			const markdown = `# Authenticated article\n\n${"Substantive reader content. ".repeat(8)}`.trim();
			const fetchMock = asGlobalFetch((_input, init) => {
				requestHeaders = new Headers(init?.headers);
				return new Response(`Markdown Content:\n${markdown}`);
			});

			const result = await renderHtmlToText(
				"https://example.com/article",
				"<html><body>short</body></html>",
				1,
				settings,
				undefined,
				null,
				fetchMock,
			);

			expect(result.method).toBe("jina");
			expect(requestHeaders?.get("authorization")).toBe("Bearer env-jina-key");
		} finally {
			if (originalApiKey === undefined) delete process.env.JINA_API_KEY;
			else process.env.JINA_API_KEY = originalApiKey;
		}
	});

	it("uses a stored Jina credential when the environment key is absent", async () => {
		const originalApiKey = process.env.JINA_API_KEY;
		delete process.env.JINA_API_KEY;
		const tempDir = TempDir.createSync("@omp-jina-reader-auth-");
		try {
			const storage = await AgentStorage.open(path.join(tempDir.path(), "agent.db"));
			await storage.replaceAuthCredentials("jina", [{ type: "api_key", key: "stored-jina-key" }]);
			const settings = Settings.isolated({ "providers.fetch": "jina" });
			let requestHeaders: Headers | undefined;
			const markdown = `# Authenticated article\n\n${"Substantive reader content. ".repeat(8)}`.trim();
			const fetchMock = asGlobalFetch((_input, init) => {
				requestHeaders = new Headers(init?.headers);
				return new Response(`Markdown Content:\n${markdown}`);
			});

			const result = await renderHtmlToText(
				"https://example.com/article",
				"<html><body>short</body></html>",
				1,
				settings,
				undefined,
				storage,
				fetchMock,
			);

			expect(result.method).toBe("jina");
			expect(requestHeaders?.get("authorization")).toBe("Bearer stored-jina-key");
		} finally {
			AgentStorage.close();
			await tempDir.remove().catch(() => {});
			if (originalApiKey === undefined) delete process.env.JINA_API_KEY;
			else process.env.JINA_API_KEY = originalApiKey;
		}
	});

	it("requests fresh markdown and strips the Jina metadata preamble", async () => {
		const settings = Settings.isolated({ "providers.fetch": "jina" });
		const markdown = `# Extracted article\n\n${"Substantive reader content. ".repeat(8)}`.trim();
		let requestHeaders: Headers | undefined;
		const fetchMock = asGlobalFetch((_input, init) => {
			requestHeaders = new Headers(init?.headers);
			return new Response(`Title: Example\nURL Source: https://example.com/article\nMarkdown Content:\n${markdown}`);
		});

		const result = await renderHtmlToText(
			"https://example.com/article",
			"<html><body>short</body></html>",
			1,
			settings,
			undefined,
			null,
			fetchMock,
		);

		expect(result).toEqual({ content: markdown, ok: true, method: "jina" });
		expect(requestHeaders?.get("accept")).toBe("text/markdown");
		expect(requestHeaders?.get("x-no-cache")).toBe("true");
		expect(requestHeaders?.get("authorization")).toBeNull();
	});

	for (const { label, readerBody, headers } of [
		{ label: "missing marker", readerBody: "Plausible but unstructured output. ".repeat(8) },
		{ label: "short body", readerBody: "Markdown Content:\nToo short" },
		{ label: "loading shell", readerBody: `Markdown Content:\nLoading...${" ".repeat(120)}` },
		{ label: "JavaScript gate", readerBody: `Markdown Content:\nPlease enable JavaScript${" ".repeat(120)}` },
		{
			label: "declared oversized body",
			readerBody: `Markdown Content:\n${"Substantive content. ".repeat(8)}`,
			headers: { "Content-Length": String(2 * 1024 * 1024 + 1) },
		},
	]) {
		it(`falls back when Jina returns a ${label}`, async () => {
			const settings = Settings.isolated({ "providers.fetch": "jina" });
			const paragraph =
				"This locally rendered article contains enough meaningful prose to satisfy the shared reader quality gate. ";
			const html = `<html><body><article><h1>Fallback article</h1><p>${paragraph.repeat(4)}</p></article></body></html>`;
			const fetchMock = asGlobalFetch(() => new Response(readerBody, { headers }));

			const result = await renderHtmlToText(
				"https://example.com/article",
				html,
				1,
				settings,
				undefined,
				null,
				fetchMock,
			);

			expect(result.ok).toBe(true);
			expect(result.method).toBe("native");
			expect(result.content).toContain("Fallback article");
		});
	}
});
