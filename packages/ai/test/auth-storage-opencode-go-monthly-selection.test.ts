import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";
import { opencodeGoUsageProvider } from "../src/usage/opencode-go";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type WindowSpec = { percent: number; resetsInDays: number; status?: "ok" | "rate-limited" };
type ReportSpec = { rolling: WindowSpec; weekly: WindowSpec; monthly: WindowSpec };

function encodeWindow(spec: WindowSpec): Record<string, unknown> {
	return {
		status: spec.status ?? "ok",
		percent: spec.percent,
		resetsAt: new Date(Date.now() + spec.resetsInDays * DAY_MS).toISOString(),
	};
}

/**
 * Ordering is decided by the monthly window's own reset clock, so every spec
 * gives the weekly window a distinct reset too: that way the pre-existing
 * weekly-drain slot would rank these accounts in an order the monthly slot has
 * to override, and the assertions cannot pass for the wrong reason.
 */
function goPayload(spec: ReportSpec): Record<string, unknown> {
	return {
		usage: {
			rolling: encodeWindow(spec.rolling),
			weekly: encodeWindow(spec.weekly),
			monthly: encodeWindow(spec.monthly),
		},
	};
}

describe("AuthStorage OpenCode Go monthly ordering", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	const reportByKey = new Map<string, UsageReport>();

	// Reports are decoded by the real provider so the monthly window reaches
	// ranking exactly as it does in production.
	async function reportFor(spec: ReportSpec, options: { dropMonthlyWindow?: boolean } = {}): Promise<UsageReport> {
		const key = "sk-decode-probe";
		const report = await opencodeGoUsageProvider.fetchUsage(
			{ provider: "opencode-go", credential: { type: "api_key", apiKey: key } },
			{
				fetch: (async () =>
					new Response(JSON.stringify(goPayload(spec)), {
						status: 200,
						headers: { "content-type": "application/json" },
					})) as unknown as typeof fetch,
			},
		);
		if (!report) throw new Error("expected a decoded OpenCode Go usage report");
		if (!options.dropMonthlyWindow) return report;
		// Models a cached/last-good report from before the endpoint reported a
		// monthly window: undecidable, so it must not outrank a live account.
		return { ...report, limits: report.limits.filter(limit => limit.id !== "monthly") };
	}

	async function useAccounts(accounts: Array<{ key: string; report: UsageReport }>): Promise<void> {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.credentials.set(
			"opencode-go",
			accounts.map(account => ({ type: "api_key" as const, key: account.key, source: "login" as const })),
		);
		reportByKey.clear();
		for (const account of accounts) {
			reportByKey.set(account.key, account.report);
		}
	}

	const usageProvider: UsageProvider = {
		id: "opencode-go",
		async fetchUsage(params) {
			const apiKey = params.credential.apiKey;
			if (!apiKey) return null;
			return reportByKey.get(apiKey) ?? null;
		},
		supports: params => params.provider === "opencode-go" && params.credential.type === "api_key",
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-opencode-monthly-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "opencode-go" ? usageProvider : undefined),
		});
		reportByKey.clear();
	});

	afterEach(async () => {
		authStorage?.close();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir.length > 0) {
			await removeWithRetries(tempDir);
		}
		tempDir = "";
	});

	test("leads with the account whose monthly quota expires first, even with a busier week", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await useAccounts([
			{
				key: "sk-go-monthly-soon",
				report: await reportFor({
					rolling: { percent: 10, resetsInDays: 0.2 },
					// Busiest week and the least drain urgency: the pre-existing
					// weekly slots would hand this account's traffic to its sibling.
					weekly: { percent: 60, resetsInDays: 6 },
					monthly: { percent: 30, resetsInDays: 3 },
				}),
			},
			{
				key: "sk-go-monthly-late",
				report: await reportFor({
					rolling: { percent: 10, resetsInDays: 0.2 },
					weekly: { percent: 5, resetsInDays: 1 },
					monthly: { percent: 30, resetsInDays: 20 },
				}),
			},
		]);

		expect(await authStorage.keys.get("opencode-go", "session-monthly-order")).toBe("sk-go-monthly-soon");
	});

	test("ranks a monthly-spent account last but never benches it", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await useAccounts([
			{
				key: "sk-go-monthly-spent",
				report: await reportFor({
					rolling: { percent: 10, resetsInDays: 0.2 },
					// Coolest week in the pool: without the monthly class this account wins.
					weekly: { percent: 0, resetsInDays: 2 },
					monthly: { percent: 100, resetsInDays: 5, status: "rate-limited" },
				}),
			},
			{
				key: "sk-go-monthly-live",
				report: await reportFor({
					rolling: { percent: 10, resetsInDays: 0.2 },
					weekly: { percent: 55, resetsInDays: 5 },
					monthly: { percent: 40, resetsInDays: 10 },
				}),
			},
		]);

		expect(await authStorage.keys.get("opencode-go", "session-spent-last")).toBe("sk-go-monthly-live");

		// Monthly stays out of the exhaustion scope: the spent account keeps
		// serving instead of being blocked until its subscription anniversary.
		const listBlocks = store.listCredentialBlocks?.bind(store);
		if (!listBlocks) throw new Error("test setup failed: store cannot list credential blocks");
		const ids = store.listAuthCredentials("opencode-go").map(entry => entry.id);
		expect(listBlocks(ids)).toHaveLength(0);

		await authStorage.credentials.set("opencode-go", [
			{ type: "api_key", key: "sk-go-monthly-spent", source: "login" },
		]);
		expect(await authStorage.keys.get("opencode-go", "session-spent-only")).toBe("sk-go-monthly-spent");
	});

	test("ranks a report with no monthly window between live and spent accounts", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const unknownReport = await reportFor(
			{
				rolling: { percent: 10, resetsInDays: 0.2 },
				weekly: { percent: 30, resetsInDays: 3 },
				monthly: { percent: 20, resetsInDays: 10 },
			},
			{ dropMonthlyWindow: true },
		);
		const liveReport = await reportFor({
			rolling: { percent: 10, resetsInDays: 0.2 },
			weekly: { percent: 50, resetsInDays: 3 },
			monthly: { percent: 20, resetsInDays: 10 },
		});
		const spentReport = await reportFor({
			rolling: { percent: 10, resetsInDays: 0.2 },
			weekly: { percent: 0, resetsInDays: 3 },
			monthly: { percent: 100, resetsInDays: 10, status: "rate-limited" },
		});

		await useAccounts([
			{ key: "sk-go-monthly-unknown", report: unknownReport },
			{ key: "sk-go-monthly-spent-2", report: spentReport },
		]);
		expect(await authStorage.keys.get("opencode-go", "session-unknown-vs-spent")).toBe("sk-go-monthly-unknown");

		await useAccounts([
			{ key: "sk-go-monthly-unknown-2", report: unknownReport },
			{ key: "sk-go-monthly-live-2", report: liveReport },
		]);
		expect(await authStorage.keys.get("opencode-go", "session-live-vs-unknown")).toBe("sk-go-monthly-live-2");
	});

	test("demotes the earliest monthly reset when its weekly window is nearly exhausted", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await useAccounts([
			{
				key: "sk-go-hot-week",
				report: await reportFor({
					rolling: { percent: 10, resetsInDays: 0.2 },
					weekly: { percent: 90, resetsInDays: 1 },
					monthly: { percent: 20, resetsInDays: 2 },
				}),
			},
			{
				key: "sk-go-cool-week",
				report: await reportFor({
					rolling: { percent: 10, resetsInDays: 0.2 },
					weekly: { percent: 20, resetsInDays: 4 },
					monthly: { percent: 20, resetsInDays: 15 },
				}),
			},
		]);

		expect(await authStorage.keys.get("opencode-go", "session-week-hot-guard")).toBe("sk-go-cool-week");
	});
});
