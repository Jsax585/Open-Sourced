#!/usr/bin/env bun

import { t } from "@oh-my-pi/pi-utils/i18n";
import { parseArgs } from "node:util";
import { formatDuration, formatNumber, formatPercent, normalizePremiumRequests } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { formatErrorRate } from "./client/data/formatters";
import { getDashboardStats, getTotalMessageCount, syncAllSessions } from "./aggregator";
import { closeDb } from "./db";
import { refreshRollups } from "./rollup";
import { formatStatsDashboardUrl, startServer } from "./server";

export {
	getDashboardStats,
	getToolDashboardStats,
	getTotalMessageCount,
	type SyncOptions,
	type SyncProgress,
	smokeTestSyncWorker,
	syncAllSessions,
} from "./aggregator";
export { closeDb } from "./db";
export { refreshRollups } from "./rollup";
export type { StatsJudge, StatsJudgeProvider } from "./frustration";
export { getGainDashboardStats } from "./gain-aggregator";
export { formatStatsDashboardUrl, type StartServerOptions, startServer } from "./server";
export type { GainDashboardStats, GainSource, GainSourceTotals, GainTimeSeriesPoint } from "./shared-types";
export type {
	AggregatedStats,
	DashboardStats,
	FolderStats,
	MessageStats,
	ModelPerformancePoint,
	ModelStats,
	ModelTimeSeriesPoint,
	TimeSeriesPoint,
	ToolDashboardStats,
	ToolModelStats,
	ToolTimeSeriesPoint,
	ToolUsageStats,
} from "./types";

/** Format an API-equivalent estimate in dollars, or N/A for unpriced usage. */
function formatCost(n: number, unpricedRequests = 0): string {
	if (n === 0 && unpricedRequests > 0) return t("N/A");
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

/**
 * Print the dashboard summary to the console. Shared by `omp stats --summary`
 * and the standalone `omp-stats --sync`.
 */
export async function printStatsSummary(): Promise<void> {
	const stats = await getDashboardStats();
	const { overall, byModel, byFolder } = stats;

	console.log(chalk.bold(t("\n=== AI Usage Statistics ===\n")));

	console.log(chalk.bold(t("Overall:")));
	console.log(t("  Requests: {0} ({1} errors)", `${formatNumber(overall.totalRequests)}`, `${formatNumber(overall.failedRequests)}`));
	console.log(t("  Error Rate: {0}", `${formatErrorRate(overall.errorRate)}`));
	console.log(t("  Total Tokens: {0}", `${formatNumber(overall.totalInputTokens + overall.totalOutputTokens)}`));
	console.log(t("  Input Tokens: {0}", `${formatNumber(overall.totalInputTokens)}`));
	console.log(t("  Output Tokens: {0}", `${formatNumber(overall.totalOutputTokens)}`));
	console.log(t("  Cache Rate: {0}", `${formatPercent(overall.cacheRate)}`));
	console.log(t("  Cache Savings: {0}", `${formatPercent(overall.cacheSavings)}`));
	console.log(t("  API-equivalent estimate: {0}", `${formatCost(overall.totalCost, overall.unpricedRequests)}`));
	console.log(t("  Premium Requests: {0}", `${formatNumber(normalizePremiumRequests(overall.totalPremiumRequests ?? 0))}`));
	console.log(t("  Avg Duration: {0}", `${overall.avgDuration !== null ? formatDuration(overall.avgDuration) : "-"}`));
	console.log(t("  Avg TTFT: {0}", `${overall.avgTtft !== null ? formatDuration(overall.avgTtft) : "-"}`));
	if (overall.avgTokensPerSecond !== null) {
		console.log(t("  Avg Tokens/s: {0}", `${overall.avgTokensPerSecond.toFixed(1)}`));
	}

	if (byModel.length > 0) {
		console.log(chalk.bold(t("\nBy Model (API-equivalent estimates):")));
		for (const m of byModel.slice(0, 10)) {
			console.log(
				t("  {0}: {1} reqs, {2}, {3} cache rate, {4} cache savings", `${m.model}`, `${formatNumber(m.totalRequests)}`, `${formatCost(m.totalCost, m.unpricedRequests)}`, `${formatPercent(m.cacheRate)}`, `${formatPercent(m.cacheSavings)}`),
			);
		}
	}

	if (byFolder.length > 0) {
		console.log(chalk.bold(t("\nBy Folder (API-equivalent estimates):")));
		for (const f of byFolder.slice(0, 10)) {
			console.log(
				t("  {0}: {1} reqs, {2}", `${f.folder}`, `${formatNumber(f.totalRequests)}`, `${formatCost(f.totalCost, f.unpricedRequests)}`),
			);
		}
	}

	console.log("");
}

/** Parsed arguments for the standalone `omp-stats` entry point. */
export interface StandaloneStatsArgs {
	port: number;
	host: string;
	json: boolean;
	sync: boolean;
	help: boolean;
}

/** Parse the standalone `omp-stats` arguments used by the production entry point. */
export function parseStandaloneStatsArgs(args: string[]): StandaloneStatsArgs {
	const { values } = (() => {
		try {
			return parseArgs({
				args,
				options: {
					port: { type: "string", short: "p", default: "3847" },
					host: { type: "string", default: "127.0.0.1" },
					json: { type: "boolean", short: "j", default: false },
					sync: { type: "boolean", short: "s", default: false },
					help: { type: "boolean", short: "h", default: false },
				},
				allowPositionals: true,
			});
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : undefined;
			const reason =
				code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
					? t("Unknown option")
					: code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
						? t("Missing or invalid option value")
						: t("Invalid command-line arguments");
			throw new Error(`${reason}: ${args.map(arg => JSON.stringify(arg)).join(" ")}`);
		}
	})();
	return {
		port: parseInt(values.port || "3847", 10),
		host: values.host || "127.0.0.1",
		json: values.json ?? false,
		sync: values.sync ?? false,
		help: values.help ?? false,
	};
}

/**
 * Main CLI entry point.
 */
async function main(): Promise<void> {
	const values = parseStandaloneStatsArgs(process.argv.slice(2));

	if (values.help) {
		console.log(t("\nomp-stats - AI Usage Statistics Dashboard\n\nUsage:\n  omp-stats [options]\n\nOptions:\n  -p, --port <port>  Port for the dashboard server (default: 3847)\n  --host <host>       Host to bind (default: 127.0.0.1)\n  -j, --json         Output stats as JSON and exit\n  -s, --sync         Sync session files and show summary\n  -h, --help         Show this help message\n\nExamples:\n  omp-stats              # Start dashboard server\n  omp-stats --json       # Print stats as JSON\n  omp-stats --host 0.0.0.0 # Explicitly expose on all IPv4 interfaces\n  omp-stats --sync       # Sync and show summary\n"));
		return;
	}

	try {
		if (!values.json && !values.sync) {
			// The dashboard ingests sessions in the background and streams progress to the page.
			const { port: actualPort } = await startServer(values.port, values.host);
			console.log(t("Dashboard available at: {0}", `${formatStatsDashboardUrl(values.host, actualPort)}`));
			console.log(t("Press Ctrl+C to stop\n"));
			process.on("SIGINT", () => {
				console.log(t("\nShutting down..."));
				closeDb();
				process.exit(0);
			});
			return;
		}

		// One-shot reports need fully ingested, fully rolled-up data before printing.
		const tty = process.stderr.isTTY === true;
		process.stderr.write(t("Syncing session files...\n"));
		let lastWidth = 0;
		let lastRender = 0;
		const { processed, files } = await syncAllSessions({
			onProgress: event => {
				if (!tty) return;
				const now = Date.now();
				if (event.current < event.total && now - lastRender < 33) return;
				lastRender = now;
				const marker = "/sessions/";
				const idx = event.sessionFile.indexOf(marker);
				const short = idx >= 0 ? event.sessionFile.slice(idx + marker.length) : event.sessionFile;
				const pct = ((event.current / event.total) * 100).toFixed(0).padStart(3, " ");
				const line = `[${event.current}/${event.total}] ${pct}%  ${short}`;
				const columns = process.stderr.columns ?? 120;
				const clipped = line.length > columns - 1 ? `${line.slice(0, columns - 2)}\u2026` : line;
				process.stderr.write(`\r${clipped.padEnd(lastWidth)}`);
				lastWidth = clipped.length;
			},
		});
		if (tty && lastWidth > 0) process.stderr.write(`\r${" ".repeat(lastWidth)}\r`);
		await refreshRollups();
		const total = await getTotalMessageCount();
		process.stderr.write(t("Synced {1} new entries from {0} files ({2} total)\n\n\u0004packages/stats/src/index.ts:main", `${files}`, `${processed}`, `${total}`));

		if (values.json) {
			console.log(JSON.stringify(await getDashboardStats(), null, 2));
		} else {
			await printStatsSummary();
		}
	} catch (error) {
		console.error(t("Error:"), error);
		closeDb();
		process.exit(1);
	}
}

// Run if executed directly
if (import.meta.main) {
	main();
}
