import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings } from "@oh-my-pi/pi-coding-agent/discovery";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { cfgDisabledExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { reconcileMcpDisabledExtensions } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/mcp-runtime";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "instructions-mcp.ts");
const WORK_SERVER = "work-server";
const ALWAYS_SERVER = "always-on";

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

function serverNames(tools: readonly CustomTool[]): string[] {
	const names = new Set<string>();
	for (const tool of tools) {
		if (tool.mcpServerName) names.add(tool.mcpServerName);
	}
	return [...names].sort();
}

describe("path-scoped disabledExtensions for MCP servers", () => {
	let homeDir = "";
	let agentDir = "";
	let projectDir = "";
	let nestedDir = "";
	let otherDir = "";
	let settings: Settings;
	let originalHome: string | undefined;
	let originalUserProfile: string | undefined;
	let originalAgentDirEnv: string | undefined;
	let originalClaudeConfigDir: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		originalHome = process.env.HOME;
		originalUserProfile = process.env.USERPROFILE;
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		delete Bun.env.CLAUDE_CONFIG_DIR;

		homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-scoped-"));
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);
		agentDir = path.join(homeDir, ".omp", "agent");
		setAgentDir(agentDir);
		projectDir = path.join(homeDir, "work");
		nestedDir = path.join(projectDir, "packages", "app");
		otherDir = path.join(homeDir, "personal");
		await fs.mkdir(nestedDir, { recursive: true });
		await fs.mkdir(otherDir, { recursive: true });
		// Distinct env keeps the two entries from deduplicating as one connection.
		const server = (who: string) => ({ command: process.execPath, args: [FIXTURE_PATH], env: { WHO: who } });
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { [WORK_SERVER]: server("work"), [ALWAYS_SERVER]: server("always") } }),
		);
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				disabledExtensions: [{ paths: [projectDir], extensions: [`mcp:${WORK_SERVER}`] }],
			}),
		);
	});

	afterEach(async () => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		restoreEnvValue("HOME", originalHome);
		restoreEnvValue("USERPROFILE", originalUserProfile);
		restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDirEnv);
		restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
		__resetDirsFromEnvForTests();
		await removeWithRetries(homeDir);
	});

	async function initSettingsAt(cwd: string): Promise<void> {
		settings = await Settings.init({ cwd, agentDir });
		initializeWithSettings(settings);
	}

	it("excludes the scoped server inside the tree, including a child dir, and keeps it elsewhere", async () => {
		for (const cwd of [projectDir, nestedDir]) {
			await initSettingsAt(cwd);
			const { configs } = await loadAllMCPConfigs(cwd);
			expect(Object.keys(configs).sort()).toEqual([ALWAYS_SERVER]);
			resetSettingsForTest();
		}

		await initSettingsAt(otherDir);
		const { configs } = await loadAllMCPConfigs(otherDir);
		expect(Object.keys(configs).sort()).toEqual([ALWAYS_SERVER, WORK_SERVER]);
	});

	it("disconnects a newly blocked server on a cwd change into the tree and reconnects it on the way out", async () => {
		await initSettingsAt(otherDir);
		const manager = new MCPManager(otherDir);
		const refreshed: CustomTool[][] = [];
		const session = {
			refreshMCPTools: (tools: CustomTool[]) => {
				refreshed.push(tools);
			},
		};
		try {
			const initial = await loadAllMCPConfigs(otherDir);
			await manager.connectServers(initial.configs, initial.sources);
			expect(manager.getConnectionStatus(WORK_SERVER)).toBe("connected");
			expect(serverNames(manager.getTools())).toEqual([ALWAYS_SERVER, WORK_SERVER]);

			const moveTo = async (cwd: string) => {
				const before = cfgDisabledExtensions.get(settings);
				await settings.reloadForCwd(cwd);
				await reconcileMcpDisabledExtensions({
					before,
					after: cfgDisabledExtensions.get(settings),
					cwd,
					manager,
					session,
				});
			};

			await moveTo(nestedDir);
			expect(manager.getConnectionStatus(WORK_SERVER)).toBe("disconnected");
			expect(manager.getConnectionStatus(ALWAYS_SERVER)).toBe("connected");
			expect(serverNames(refreshed.at(-1) ?? [])).toEqual([ALWAYS_SERVER]);

			await moveTo(otherDir);
			expect(manager.getConnectionStatus(WORK_SERVER)).toBe("connected");
			expect(serverNames(refreshed.at(-1) ?? [])).toEqual([ALWAYS_SERVER, WORK_SERVER]);
		} finally {
			await manager.disconnectAll();
		}
	});
});
