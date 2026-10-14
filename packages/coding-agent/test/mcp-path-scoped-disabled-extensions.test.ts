import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings } from "@oh-my-pi/pi-coding-agent/discovery";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { ROOTS_ECHO_MODE } from "./fixtures/instructions-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "instructions-mcp.ts");
const WORK_SERVER = "work-server";
const ALWAYS_SERVER = "always-on";
const WORK_TOOL = "mcp__work_server_do_thing";
const ALWAYS_TOOL = "mcp__always_on_do_thing";

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

/**
 * Polls until `done` holds or 12s elapse. MCP connects are real child-process
 * handshakes with no completion signal, so fake timers cannot drive them.
 */
async function eventually(done: () => boolean): Promise<void> {
	const deadline = Date.now() + 12_000;
	while (!done() && Date.now() < deadline) await Bun.sleep(10);
}

describe("path-scoped disabledExtensions for MCP servers", () => {
	let homeDir = "";
	let agentDir = "";
	let projectDir = "";
	let nestedDir = "";
	let otherDir = "";
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
		const server = (who: string, ...modes: string[]) => ({
			command: process.execPath,
			args: [FIXTURE_PATH, ...modes],
			env: { WHO: who },
		});
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: { [WORK_SERVER]: server("work", ROOTS_ECHO_MODE), [ALWAYS_SERVER]: server("always") },
			}),
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

	async function initSettingsAt(cwd: string): Promise<Settings> {
		const settings = await Settings.init({ cwd, agentDir });
		initializeWithSettings(settings);
		return settings;
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

	it("connects a newly allowed server with the new workspace root and drops it again inside the tree", async () => {
		const settings = await initSettingsAt(nestedDir);
		const sessionManager = SessionManager.inMemory(nestedDir);
		const authStorage = await AuthStorage.create(":memory:");
		const { session } = await createAgentSession({
			cwd: nestedDir,
			agentDir,
			modelRegistry: new ModelRegistry(authStorage),
			sessionManager,
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
		});
		const hasTool = (name: string) => session.getToolByName(name) !== undefined;
		// The same rescope `/move` and cross-project resume run, TUI and headless alike.
		const moveTo = async (cwd: string) => {
			sessionManager.setCwdWithoutRelocation(cwd);
			await settings.reloadForCwd(cwd);
		};
		try {
			await eventually(() => hasTool(ALWAYS_TOOL));
			expect([hasTool(WORK_TOOL), hasTool(ALWAYS_TOOL)]).toEqual([false, true]);

			await moveTo(otherDir);
			await eventually(() => hasTool(WORK_TOOL));
			expect([hasTool(WORK_TOOL), hasTool(ALWAYS_TOOL)]).toEqual([true, true]);
			// The server asks `roots/list` while handling the call and echoes the root it was given.
			const result = await session.getToolByName(WORK_TOOL)?.execute("roots-echo-call", {});
			expect(result?.content.find(part => part.type === "text")?.text).toBe(url.pathToFileURL(otherDir).href);

			await moveTo(nestedDir);
			await eventually(() => !hasTool(WORK_TOOL));
			expect([hasTool(WORK_TOOL), hasTool(ALWAYS_TOOL)]).toEqual([false, true]);
		} finally {
			await session.dispose();
			authStorage.close();
			closeModelCache();
		}
	}, 30_000);
});
