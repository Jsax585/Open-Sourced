import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { fetchReadUrl } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as scrapers from "@oh-my-pi/pi-coding-agent/web/scrapers/types";

const filler = "Real page body content the guessed suffix must not replace. ".repeat(30);
const realHtml = (title: string) =>
	`<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${filler}</p></main></body></html>`;

function session(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "fetch.enabled": true }),
	} as unknown as ToolSession;
}

function stubPages(pages: Record<string, { content: string; contentType: string }>) {
	return vi.spyOn(scrapers, "loadPage").mockImplementation(async (requestedUrl: string) => {
		const hit = pages[requestedUrl] ?? pages[new URL(requestedUrl).pathname];
		if (!hit) throw new Error(`unexpected fetch: ${requestedUrl}`);
		return { ok: true, status: 200, finalUrl: requestedUrl, content: hit.content, contentType: hit.contentType };
	});
}

afterEach(() => vi.restoreAllMocks());

describe("read md-suffix guesses (regression: #16834 replaced valid HTML with stale/soft-404 bodies)", () => {
	it("renders the real page instead of a stale versioned .md candidate", async () => {
		stubPages({
			"/nvcomp/release_notes.html": { content: realHtml("nvcomp 6.0.0 release notes"), contentType: "text/html" },
			"/nvcomp/release_notes.html.md": {
				content: `# nvcomp 5.1.0\n\nStale versioned material. ${"stale ".repeat(80)}`,
				contentType: "text/markdown",
			},
		});
		const result = await fetchReadUrl(session(), { path: "http://127.0.0.1:9/nvcomp/release_notes.html" });
		expect(result.details.method).toBe("native");
		expect(result.details.finalUrl).toBe("http://127.0.0.1:9/nvcomp/release_notes.html");
		expect(result.content).toContain("6.0.0");
		expect(result.content).not.toContain("5.1.0");
	});

	it("renders the real page instead of a soft-404 .md candidate", async () => {
		stubPages({
			"/self-hosted/releases/": { content: realHtml("Releases & Upgrading"), contentType: "text/html" },
			"/self-hosted/releases/index.html.md": {
				content: `# Releases & Upgrading\n\nThe page you requested does not exist. ${"x ".repeat(900)}`,
				contentType: "text/markdown",
			},
		});
		const result = await fetchReadUrl(session(), { path: "http://127.0.0.1:9/self-hosted/releases/" });
		expect(result.details.method).toBe("native");
		expect(result.content).toContain("Releases & Upgrading");
		expect(result.content).not.toContain("does not exist");
	});

	it("reports the candidate URL when a matching .md suffix is used", async () => {
		stubPages({
			"/docs/guide.html": { content: realHtml("Guide to widgets"), contentType: "text/html" },
			"/docs/guide.html.md": {
				content: `# Guide to widgets\n\nFresh markdown for the same page. ${"same ".repeat(80)}`,
				contentType: "text/markdown",
			},
		});
		const result = await fetchReadUrl(session(), { path: "http://127.0.0.1:9/docs/guide.html" });
		expect(result.details.method).toBe("md-suffix");
		expect(result.details.finalUrl).toBe("http://127.0.0.1:9/docs/guide.html.md");
		expect(result.details.notes.join("; ")).toContain("http://127.0.0.1:9/docs/guide.html.md");
		expect(result.content).toContain("Fresh markdown");
	});
});
