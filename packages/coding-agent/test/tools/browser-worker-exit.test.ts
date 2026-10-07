import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { listTabs, releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	settings: Settings.isolated({
		"browser.enabled": true,
		"browser.headless": true,
		"browser.cmux": false,
		"browser.tern": false,
		"tools.maxTimeout": 0,
	}),
};
const prelude = createBrowserPrelude(session);
const context = { session, toolCallId: "browser-worker-exit-test" };
const name = "worker-exit";

async function run(code: string): Promise<unknown> {
	const result = (await prelude.invoke({ action: "run", name, code, timeout: 20 }, context)) as {
		details?: Record<string, unknown>;
	};
	return result.details?.value;
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser tab worker exit", () => {
	it("kills the tab when its worker dies after init instead of failing later sends", async () => {
		await prelude.invoke(
			{ action: "open", name, url: `data:text/html,${encodeURIComponent("<p>alive</p>")}` },
			context,
		);
		expect(await run("return 1;")).toBe(1);

		// An uncaught exception terminates the Bun worker. The in-flight run must
		// reject as soon as the worker exits, not hang to its timeout.
		const crash = run(`setTimeout(() => { throw new Error("tab-worker-crash"); }, 0); await new Promise(() => {});`);
		await expect(crash).rejects.toThrow(/Browser tab worker exited unexpectedly.*tab-worker-crash/);

		expect(listTabs().some(tab => tab.name === name)).toBe(false);
		const next = run("return 2;");
		await expect(next).rejects.toThrow(`Tab "${name}" was killed`);
		await expect(next).rejects.toThrow("Reopen it.");

		// Reopening recovers.
		await prelude.invoke({ action: "open", name, url: "data:text/html,<p>again</p>" }, context);
		expect(await run("return 3;")).toBe(3);
	}, 30_000);
});
