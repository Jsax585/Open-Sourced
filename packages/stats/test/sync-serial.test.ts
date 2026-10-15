import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { getOverallStats } from "@oh-my-pi/omp-stats/rollup";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-sync-serial-");

afterEach(() => {
	vi.restoreAllMocks();
});

function sessionLine(id: string, includeCost = true): string {
	const timestamp = new Date().toISOString();
	return `${JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				...(includeCost ? { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } : {}),
			},
			stopReason: "stop",
			timestamp: Date.now(),
			duration: 10,
			ttft: 5,
		},
	})}\n`;
}

async function writeSessionFile(options?: { includeCost?: boolean }): Promise<void> {
	const sessionDir = path.join(getSessionsDir(), "--tmp--sync-serial");
	await fs.mkdir(sessionDir, { recursive: true });
	await Bun.write(path.join(sessionDir, "session.jsonl"), sessionLine("assistant-1", options?.includeCost ?? true));
}

describe("stats sync serial mode", () => {
	it("honors workers: 1 without spawning a worker", async () => {
		await writeSessionFile();
		const workerSpy = vi.spyOn(globalThis, "Worker");

		const synced = await syncAllSessions({ workers: 1 });
		const overall = getOverallStats();

		expect(synced.files).toBe(1);
		expect(overall.totalRequests).toBe(1);
		expect(workerSpy).not.toHaveBeenCalled();
	});

	it("skips gc compress scratch copies but keeps transcripts in other dot directories", async () => {
		await writeSessionFile();
		const folder = path.join(getSessionsDir(), "--tmp--sync-serial");
		const scratch = path.join(folder, ".omp-gc-compress-a1b2c3");
		const hidden = path.join(folder, "session", ".runs");
		await fs.mkdir(scratch);
		await fs.mkdir(hidden, { recursive: true });
		await fs.copyFile(path.join(folder, "session.jsonl"), path.join(scratch, "session.jsonl"));
		await fs.copyFile(path.join(folder, "session.jsonl"), path.join(hidden, "child.jsonl"));

		const synced = await syncAllSessions({ workers: 1 });

		expect(synced.files).toBe(2);
	});

	it("syncs legacy session usage without a cost breakdown", async () => {
		await writeSessionFile({ includeCost: false });

		const synced = await syncAllSessions({ workers: 1 });
		const overall = getOverallStats();

		expect(synced).toEqual({ processed: 1, files: 1 });
		expect(overall.totalRequests).toBe(1);
		expect(overall.totalCost).toBeGreaterThan(0);
	});

	it("uses the serial parser by default on macOS", async () => {
		await writeSessionFile();
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		const workerSpy = vi.spyOn(globalThis, "Worker");

		const synced = await syncAllSessions();
		const overall = getOverallStats();

		expect(synced.files).toBe(1);
		expect(overall.totalRequests).toBe(1);
		expect(workerSpy).not.toHaveBeenCalled();
	});

	it("spawns no worker when every transcript is unchanged", async () => {
		await writeSessionFile();
		await syncAllSessions({ workers: 1 });
		const workerSpy = vi.spyOn(globalThis, "Worker");

		const synced = await syncAllSessions({ workers: 2 });

		expect(synced).toEqual({ processed: 0, files: 0 });
		expect(workerSpy).not.toHaveBeenCalled();
	});

	it("parses a few already-tracked transcripts inline by default", async () => {
		await writeSessionFile();
		await syncAllSessions({ workers: 1 });
		const sessionFile = path.join(getSessionsDir(), "--tmp--sync-serial", "session.jsonl");
		await fs.appendFile(sessionFile, "\n");
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		const workerSpy = vi.spyOn(globalThis, "Worker");

		await syncAllSessions({ files: [sessionFile] });

		expect(workerSpy).not.toHaveBeenCalled();
	});

	it("spawns a worker pool when callers explicitly request workers: 2 with a single file", async () => {
		await writeSessionFile();
		const workerProbe = new Error("worker probe");
		const workerSpy = vi.spyOn(globalThis, "Worker").mockImplementation(() => {
			throw workerProbe;
		});

		await expect(syncAllSessions({ workers: 2 })).rejects.toBe(workerProbe);
		expect(workerSpy).toHaveBeenCalled();
	});

	it("processes every file when workers cross the 128-file metadata batch boundary", async () => {
		// 200 files span the 128-file metadata window: the worker that opens the
		// second batch must not re-index the first batch's in-flight results.
		const sessionDir = path.join(getSessionsDir(), "--tmp--sync-serial-boundary");
		await fs.mkdir(sessionDir, { recursive: true });
		const filePaths = Array.from({ length: 200 }, (_, index) => path.join(sessionDir, `session-${index}.jsonl`));
		await Promise.all(filePaths.map((file, index) => Bun.write(file, sessionLine(`assistant-${index}`))));

		const synced = await syncAllSessions({ files: filePaths, workers: 4 });

		expect(synced).toEqual({ processed: 200, files: 200 });
	});

	it("never indexes an in-flight batch after a later worker advances past it", async () => {
		// Pre-populate file_offsets for the first 128 files so those workers return
		// null immediately (already-tracked). With 200 files and 4 workers, fast
		// workers drain batch 1 and advance the shared metadata slots to batch 2
		// while slower workers are still inside batch 1. A worker that reads the
		// advanced slots mid-flight computes a negative metadataIndex and crashes
		// on the parent implementation (undefined array element destructure).
		const sessionDir = path.join(getSessionsDir(), "--tmp--sync-serial-stale");
		await fs.mkdir(sessionDir, { recursive: true });
		const filePaths = Array.from({ length: 200 }, (_, index) => path.join(sessionDir, `session-${index}.jsonl`));
		await Promise.all(filePaths.map((file, index) => Bun.write(file, sessionLine(`assistant-${index}`))));

		// Pre-populate offsets for files 0–127 (batch 1) so they appear unchanged.
		await syncAllSessions({ files: filePaths.slice(0, 128), workers: 1 });

		// Sync all 200 with 4 workers: batch-1 workers return null instantly and
		// race ahead; batch-2 workers trigger the second metadata batch while
		// batch-1 promises may still be resolving.
		const synced = await syncAllSessions({ files: filePaths, workers: 4 });

		expect(synced).toEqual({ processed: 72, files: 72 });
	});
});
