import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import { parseStandaloneStatsArgs } from "../src/index";
import { formatStatsDashboardUrl } from "../src/server";
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const STATS_CLI = path.join(REPO_ROOT, "packages/stats/src/index.ts");

function isolatedEnv(root: string): Record<string, string> {
	const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<
		string,
		string
	>;
	for (const key of [
		"HOME",
		"PI_CONFIG_DIR",
		"PI_CODING_AGENT_DIR",
		"PI_PROFILE",
		"OMP_ROOT",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"XDG_CACHE_HOME",
	]) {
		delete env[key];
	}
	env.HOME = root;
	env.PI_CONFIG_DIR = "config";
	env.PI_CODING_AGENT_DIR = path.join(root, "config", "agent");
	return env;
}

async function reservePort(): Promise<{ server: net.Server; port: number }> {
	const server = net.createServer();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", resolve);
	await promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("failed to reserve a TCP port");
	return { server, port: address.port };
}

it("runs follow mode as a headless importer", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stats-cli-"));
	const sessionDir = path.join(root, "config", "agent", "sessions", "--tmp--headless");
	const statsDbPath = path.join(root, "config", "stats.db");
	await fs.mkdir(sessionDir, { recursive: true });
	const timestamp = new Date().toISOString();
	const user = {
		type: "message",
		id: "user-1",
		parentId: null,
		timestamp,
		message: { role: "user", content: "HEADLESS SMOKE" },
	};
	const assistant = {
		type: "message",
		id: "assistant-1",
		parentId: "user-1",
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
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			duration: 10,
			ttft: 5,
		},
	};
	await Bun.write(path.join(sessionDir, "session.jsonl"), `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`);
	const { server, port } = await reservePort();
	let child: Bun.Subprocess | undefined;
	let exitCode: number | undefined;
	try {
		// This child owns the real watcher and SQLite clock; fake timers cannot drive this integration test.
		child = Bun.spawn([process.execPath, STATS_CLI, "--follow", "--port", String(port)], {
			cwd: REPO_ROOT,
			env: isolatedEnv(root),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			timeout: 15_000,
		});
		const exited = child.exited.then(code => {
			exitCode = code;
			return code;
		});
		if (!child.stdout) throw new Error("headless stats CLI did not expose stdout");
		const outputReader = child.stdout.getReader();
		const outputDecoder = new TextDecoder();
		let output = "";
		const syncComplete = Promise.withResolvers<void>();
		void (async () => {
			try {
				while (true) {
					const { done, value } = await outputReader.read();
					if (done) {
						syncComplete.reject(new Error(`headless stats CLI exited before syncing: ${output}`));
						return;
					}
					output += outputDecoder.decode(value, { stream: true });
					if (output.includes("Initial live stats sync complete.")) {
						syncComplete.resolve();
						return;
					}
				}
			} catch (error) {
				syncComplete.reject(error);
			}
		})();
		await syncComplete.promise;
		const database = new Database(statsDbPath, { readonly: true });
		const messages = database.query("SELECT COUNT(*) AS count FROM messages").get() as { count?: number } | null;
		const offsets = database.query("SELECT COUNT(*) AS count FROM file_offsets").get() as { count?: number } | null;
		database.close();
		expect(messages?.count).toBe(1);
		expect(offsets?.count).toBe(1);
		expect(server.listening).toBe(true);
		child.kill("SIGTERM");
		expect(await exited).toBe(0);
	} finally {
		if (child && exitCode === undefined) child.kill("SIGTERM");
		if (child) await child.exited;
		if (server.listening) {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
		}
		await fs.rm(root, { recursive: true, force: true });
	}
});

describe("standalone stats CLI", () => {
	it("keeps the production parser loopback-only by default", () => {
		expect(parseStandaloneStatsArgs([])).toEqual({
			port: 3847,
			host: "127.0.0.1",
			json: false,
			sync: false,
			follow: false,
			help: false,
		});
	});

	it("forwards explicit bind hosts and formats IPv6 dashboard URLs", () => {
		expect(parseStandaloneStatsArgs(["--host", "::", "--port", "3850"])).toMatchObject({
			port: 3850,
			host: "::",
		});
		expect(formatStatsDashboardUrl("::", 3850)).toBe("http://[::]:3850");
		expect(formatStatsDashboardUrl("2001:db8::1", 3850)).toBe("http://[2001:db8::1]:3850");
	});
	it("parses follow mode without changing the dashboard bind defaults", () => {
		expect(parseStandaloneStatsArgs(["--follow"])).toMatchObject({
			port: 3847,
			host: "127.0.0.1",
			follow: true,
			json: false,
			sync: false,
		});
	});
});
