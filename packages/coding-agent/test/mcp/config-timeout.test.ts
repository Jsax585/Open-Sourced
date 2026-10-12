/**
 * `timeout` accepts a bare number (every phase) or a `{ connect, catalog, execution }`
 * object in the OMP-owned loaders. A bad value must warn with the offending key and
 * fall back, never reach a transport as NaN or a negative deadline.
 */
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema/json-schema-validator";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { getConfigRootDir, logger, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import mcpSchema from "../../src/config/mcp-schema.json" with { type: "json" };

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

let tempAgentDir = "";
let tempCwd = "";
let tempHome = "";
let originalHome: string | undefined;

beforeEach(async () => {
	originalHome = process.env.HOME;
	tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-timeout-home-"));
	tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-timeout-agent-"));
	tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-timeout-cwd-"));
	process.env.HOME = tempHome;
	vi.spyOn(os, "homedir").mockReturnValue(tempHome);
	setAgentDir(tempAgentDir);
	clearFsCache();
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (originalAgentDirEnv) {
		setAgentDir(originalAgentDirEnv);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	clearFsCache();
	await removeWithRetries(tempHome);
	await removeWithRetries(tempAgentDir);
	await removeWithRetries(tempCwd);
});

for (const [provider, file] of [
	["native", ".omp/mcp.json"],
	["standalone", ".mcp.json"],
	["plugin", "plugin/.mcp.json"],
] as const) {
	test(`${provider} loader keeps phase timeouts and a bare number, and warns about bad keys`, async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		await Bun.write(
			path.join(tempCwd, file),
			JSON.stringify({
				mcpServers: {
					bare: { command: "/bin/echo", args: ["bare"], timeout: 1500 },
					phased: {
						command: "/bin/echo",
						args: ["phased"],
						timeout: { connect: 100, catalog: 200, execution: 0, startup: 5 },
					},
					negative: { command: "/bin/echo", args: ["negative"], timeout: { catalog: -1, execution: 40 } },
					junk: { command: "/bin/echo", args: ["junk"], timeout: "soon" },
				},
			}),
		);
		const { configs } = await loadAllMCPConfigs(tempCwd, {
			extensionRoots: {
				explicit: provider === "plugin" ? [path.join(tempCwd, "plugin")] : [],
				mode: "explicit-only",
				configured: [],
				configuredLevel: "project",
			},
		});

		expect(configs.bare?.timeout).toBe(1500);
		expect(configs.phased?.timeout).toEqual({ connect: 100, catalog: 200, execution: 0 });
		expect(configs.negative?.timeout).toEqual({ execution: 40 });
		expect(configs.junk?.timeout).toBeUndefined();
		const messages = warn.mock.calls.map(call => String(call[0]));
		expect(messages.some(m => m.includes('unknown timeout key "startup"'))).toBe(true);
		expect(messages.some(m => m.includes("invalid timeout.catalog -1"))).toBe(true);
		expect(messages.some(m => m.includes('invalid timeout "soon"'))).toBe(true);
	});
}

for (const server of [
	{ type: "stdio", command: "fixture" },
	{ type: "http", url: "https://example.com/mcp" },
	{ type: "sse", url: "https://example.com/sse" },
]) {
	test(`${server.type} schema accepts the number and object timeout and rejects bad ones`, () => {
		const valid = (timeout: unknown) =>
			validateJsonSchemaValue(mcpSchema, { mcpServers: { fixture: { ...server, timeout } } }).success;
		expect(valid(1000)).toBe(true);
		expect(valid({ catalog: 10, execution: 0 })).toBe(true);
		expect(valid({ startup: 10 })).toBe(false);
		expect(valid({ catalog: -1 })).toBe(false);
		expect(valid({ catalog: 1.5 })).toBe(false);
		expect(valid(-1)).toBe(false);
		expect(valid(3_000_000_000)).toBe(false);
		expect(valid({ execution: 3_000_000_000 })).toBe(false);
	});
}
