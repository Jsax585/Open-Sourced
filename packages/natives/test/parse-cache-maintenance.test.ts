import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const probePath = path.join(import.meta.dir, "fixtures/parse-cache-maintenance-probe.ts");

interface MaintenanceResult {
	evicted: number;
	nextCheckMs: number;
}

interface WorkerResult {
	results: MaintenanceResult[];
	summary: string;
}

interface LogEntry {
	level: string;
	message: string;
	error?: { message?: string } | string;
}

async function withProbe(scenario: string, verify: (root: string, token: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-parse-maintenance-"));
	const token = `parse-cache-fault-${crypto.randomUUID()}`;
	try {
		const child = Bun.spawn([process.execPath, probePath, scenario, root, token], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: {
				...process.env,
				PI_CONFIG_DIR: path.relative(os.homedir(), path.join(root, "config")),
				PI_CODING_AGENT_DIR: path.join(root, "agent"),
				PI_TEST_SESSION_OWNERS_DIR: path.join(root, "owners"),
				PI_NATIVES_DIR: path.join(root, "natives"),
				XDG_CONFIG_HOME: path.join(root, "xdg-config"),
				XDG_DATA_HOME: path.join(root, "data"),
				XDG_STATE_HOME: path.join(root, "state"),
				XDG_CACHE_HOME: path.join(root, "cache"),
				OMP_PROFILE: "",
				PI_PROFILE: "",
				OMP_LOG_LEVEL: "",
				PI_DEBUG_STARTUP: "",
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
			},
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		expect(stdout).toBe("");
		expect(stderr).toBe("");
		await verify(root, token);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

function profileCalls(summary: string, region: string): number {
	const row = summary.split("\n").find(line => line.startsWith(`| ${region} |`));
	if (!row) throw new Error(`Missing ${region} profile row:\n${summary}`);
	return Number(row.split("|")[4]?.trim());
}

describe("native parse cache maintenance", () => {
	it("keeps one sweep deadline across main, terminated, and replacement workers", async () => {
		await withProbe("workers", async root => {
			const result: WorkerResult = await Bun.file(path.join(root, "result.json")).json();
			expect(result.results).toHaveLength(4);
			const first = result.results[0];
			if (first === undefined) throw new Error("Missing the first worker's reclamation result");
			for (const sample of result.results) {
				expect(sample.evicted).toBe(0);
				expect(sample.nextCheckMs).toBeGreaterThan(0);
				expect(sample.nextCheckMs).toBeLessThanOrEqual(30_000);
			}
			for (const sample of result.results.slice(1)) {
				expect(sample.nextCheckMs).toBeLessThan(first.nextCheckMs);
			}
			expect(profileCalls(result.summary, "reclaim_idle_parse_cache")).toBe(4);
			expect(profileCalls(result.summary, "parse_cache.sweep")).toBe(1);
		});
	}, 15_000);

	it("exits naturally before its first maintenance timer fires", async () => {
		await withProbe("exit", async root => {
			expect(await Bun.file(path.join(root, "loaded")).text()).toBe("loaded");
		});
	}, 15_000);

	it("honors retry delays and logs an injected loader rejection without terminal output", async () => {
		await withProbe("fault-injection", async (root, token) => {
			const result: { delays: number[]; attempts: number } = await Bun.file(path.join(root, "result.json")).json();
			expect(result.attempts).toBe(3);
			expect(result.delays).toEqual([30_000, 1_234, 30_000, 30_000]);
			const logsDir = path.join(root, "logs");
			const logFiles = (await fs.readdir(logsDir)).filter(name => name.endsWith(".log"));
			const entries: LogEntry[] = [];
			for (const filename of logFiles) {
				const text = await Bun.file(path.join(logsDir, filename)).text();
				for (const line of text.split("\n").filter(Boolean)) entries.push(JSON.parse(line));
			}
			const failures = entries.filter(entry => entry.message === "Native parse cache maintenance failed");
			expect(failures).toHaveLength(1);
			expect(failures[0]?.level).toBe("warn");
			expect(JSON.stringify(failures[0]?.error)).toContain(token);
		});
	}, 15_000);
});
