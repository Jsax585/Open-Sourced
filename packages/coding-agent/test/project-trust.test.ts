/**
 * Project trust gate: an untrusted project's code-running config (MCP servers,
 * npm plugins, TS slash commands, a project-owned `extensions:` list) must not
 * load, must not shadow the user's own equivalent, and must still be listed for
 * the trust prompt. Trust persisted by `trustProject` lets it load, and copies of
 * a trusted repo (linked worktrees, task isolations) share that trust.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	inheritProjectTrust,
	isProjectCodeTrusted,
	projectTrustRoot,
	resetCapabilityForTests,
	setProjectTrustCheck,
} from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import {
	listProjectCodeSources,
	loadTrustedProjects,
	trustProject,
} from "@oh-my-pi/pi-coding-agent/config/project-trust";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearPluginRootsAndCaches } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { loadCustomCommands } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/loader";
import { getEnabledPlugins } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { discoverSessionExtensionPaths } from "@oh-my-pi/pi-coding-agent/sdk";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import "@oh-my-pi/pi-coding-agent/discovery";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const CONNECTION = { type: "http", url: "https://mcp.example/mcp" } as const;

async function writeMcpJson(filePath: string, servers: Record<string, unknown>): Promise<void> {
	await Bun.write(filePath, JSON.stringify({ mcpServers: servers }, null, 2));
}

/** A repo with one commit, so `git worktree add` has a HEAD to check out. */
async function initRepo(dir: string): Promise<void> {
	const git = (args: string[]) =>
		$`git -c user.name=t -c user.email=t@t -c commit.gpgsign=false ${args}`
			.cwd(dir)
			.env({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" })
			.quiet();
	await git(["init", "--initial-branch=main"]);
	await git(["commit", "--allow-empty", "-m", "init"]);
}

describe("project trust gate", () => {
	let tempHome = "";
	let projectDir = "";
	let userAgentDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-trust-home-"));
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-trust-project-"));
		userAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-trust-agent-"));
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(userAgentDir);
		clearFsCache();
		await writeMcpJson(path.join(projectDir, ".omp", "mcp.json"), { projcontext: CONNECTION });
		await writeMcpJson(path.join(userAgentDir, "mcp.json"), { usercontext: CONNECTION });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetCapabilityForTests();
		resetSettingsForTest();
		clearPluginRootsAndCaches();
		if (originalAgentDirEnv) {
			setAgentDir(originalAgentDirEnv);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await removeWithRetries(tempHome);
		await removeWithRetries(projectDir);
		await removeWithRetries(userAgentDir);
	});

	test("an untrusted project's MCP server is skipped but listed for the prompt", async () => {
		setProjectTrustCheck(() => false);

		const result = await loadAllMCPConfigs(projectDir, { filterExa: false });
		// The equivalent project alias would win dedupe if it were not dropped first.
		expect(Object.keys(result.configs)).toEqual(["usercontext"]);

		const sources = await listProjectCodeSources(projectDir);
		expect(sources).toContainEqual({ kind: "MCP Servers", path: path.join(projectDir, ".omp", "mcp.json") });
	});

	test("persisted trust loads the project's MCP server", async () => {
		const root = await projectTrustRoot(projectDir);
		await trustProject(root);
		const trusted = await loadTrustedProjects();
		setProjectTrustCheck(candidate => trusted.has(candidate));

		const result = await loadAllMCPConfigs(projectDir, { filterExa: false });
		expect(Object.keys(result.configs)).toEqual(["projcontext"]);
	});
	test("an untrusted project's npm plugins stay hidden until the project is trusted", async () => {
		const pluginsDir = path.join(projectDir, ".omp", "plugins");
		await Bun.write(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {} }));
		await Bun.write(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({ dependencies: { "proj-plugin": "1.0.0" } }),
		);
		await Bun.write(
			path.join(pluginsDir, "node_modules", "proj-plugin", "package.json"),
			JSON.stringify({ name: "proj-plugin", version: "1.0.0", omp: { tools: "tools" } }),
		);
		let trusted = false;
		setProjectTrustCheck(() => trusted);

		const untrusted = await getEnabledPlugins(projectDir, { home: tempHome });
		expect(untrusted.map(plugin => plugin.name)).not.toContain("proj-plugin");

		// Granting trust clears plugin caches, as `resolveProjectTrust` does; a stale entry would keep it hidden.
		trusted = true;
		clearPluginRootsAndCaches();
		const granted = await getEnabledPlugins(projectDir, { home: tempHome });
		expect(granted.map(plugin => plugin.name)).toContain("proj-plugin");
	});

	test("an untrusted project's TS slash command is never imported but is listed for the prompt", async () => {
		const marker = path.join(projectDir, "RAN");
		const commandPath = path.join(projectDir, ".omp", "commands", "evil", "index.ts");
		await Bun.write(
			commandPath,
			`await Bun.write(${JSON.stringify(marker)}, "x");\nexport default () => ({ name: "evil", description: "d", execute() {} });\n`,
		);
		setProjectTrustCheck(() => false);

		const result = await loadCustomCommands({ cwd: projectDir, agentDir: userAgentDir });
		expect(result.commands.map(loaded => loaded.command.name)).not.toContain("evil");
		expect(await Bun.file(marker).exists()).toBe(false);

		const sources = await listProjectCodeSources(projectDir);
		expect(sources).toContainEqual({ kind: "Commands", path: commandPath });
	});

	test("a project-owned extensions list loads only once the project is trusted", async () => {
		const extensionPath = path.join(projectDir, "ext.ts");
		await Bun.write(extensionPath, "export default () => {};\n");
		await Bun.write(path.join(projectDir, ".omp", "settings.json"), JSON.stringify({ extensions: ["./ext.ts"] }));
		const settings = await Settings.init({ cwd: projectDir, agentDir: userAgentDir, inMemory: true });
		let trusted = false;
		setProjectTrustCheck(() => trusted);

		expect(await discoverSessionExtensionPaths({}, projectDir, settings)).not.toContain(extensionPath);
		const sources = await listProjectCodeSources(projectDir, settings);
		expect(sources.map(source => source.path)).toContain(extensionPath);

		trusted = true;
		expect(await discoverSessionExtensionPaths({}, projectDir, settings)).toContain(extensionPath);
	});

	test("a linked worktree of a trusted repo is trusted", async () => {
		const repoDir = path.join(projectDir, "repo");
		const worktreeDir = path.join(projectDir, "wt");
		await fs.mkdir(repoDir);
		await initRepo(repoDir);
		await $`git worktree add ${worktreeDir}`
			.cwd(repoDir)
			.env({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" })
			.quiet();
		await trustProject(await projectTrustRoot(repoDir));
		const trusted = await loadTrustedProjects();
		setProjectTrustCheck(candidate => trusted.has(candidate));

		expect(await isProjectCodeTrusted(worktreeDir)).toBe(true);
	});

	test("a copy of the project inherits trust only from a trusted parent", async () => {
		const copyDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-trust-copy-"));
		try {
			const parentRoot = await projectTrustRoot(projectDir);
			let parentTrusted = false;
			setProjectTrustCheck(candidate => parentTrusted && candidate === parentRoot);
			await inheritProjectTrust(projectDir, copyDir);
			expect(await isProjectCodeTrusted(copyDir)).toBe(false);

			parentTrusted = true;
			await inheritProjectTrust(projectDir, copyDir);
			expect(await isProjectCodeTrusted(copyDir)).toBe(true);
		} finally {
			await removeWithRetries(copyDir);
		}
	});
});
