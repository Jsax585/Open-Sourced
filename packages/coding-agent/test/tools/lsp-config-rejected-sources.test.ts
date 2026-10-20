import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { preloadPluginRoots } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import { configCache, formatRejectedConfigSources, loadConfig } from "@oh-my-pi/pi-coding-agent/lsp/config";
import { readConfigFileResult } from "@oh-my-pi/pi-coding-agent/utils/config-file-sources";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "../helpers/settings-test-state";

const lspTestSettings = await Settings.init({ inMemory: true });

function makeLspSession(cwd: string): ToolSession {
	return { cwd, settings: lspTestSettings } as ToolSession;
}

function textResult(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

/**
 * `loadConfig` walks user config dirs under os.homedir(). Isolate HOME so a
 * developer lsp.json cannot mask the fixture (#15528 coverage).
 */
let lspHomeOverride: string | undefined;
let lspOriginalHome: string | undefined;

beforeEach(() => {
	lspOriginalHome = process.env.HOME;
	lspHomeOverride = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lsp-rejected-home-"));
	process.env.HOME = lspHomeOverride;
	vi.spyOn(os, "homedir").mockReturnValue(lspHomeOverride);
});

afterEach(() => {
	if (lspOriginalHome === undefined) delete process.env.HOME;
	else process.env.HOME = lspOriginalHome;
	if (lspHomeOverride) fs.rmSync(lspHomeOverride, { recursive: true, force: true });
	lspHomeOverride = undefined;
	vi.restoreAllMocks();
});

describe("LSP rejected config sources (#15528)", () => {
	it("readConfigFileResult distinguishes absent, invalid, and unreadable paths", () => {
		const tempDir = TempDir.createSync("@omp-cfg-read-result-");
		try {
			const parseJson = (content: string) => JSON.parse(content) as unknown;

			const missing = path.join(tempDir.path(), "missing.json");
			expect(readConfigFileResult(missing, parseJson)).toEqual({ kind: "absent" });

			const invalid = path.join(tempDir.path(), "bad.json");
			fs.writeFileSync(invalid, '{"servers":');
			const invalidResult = readConfigFileResult(invalid, content => {
				parseJson(content);
				return { ok: true };
			});
			expect(invalidResult.kind).toBe("rejected");
			if (invalidResult.kind === "rejected") {
				expect(invalidResult.rejection.path).toBe(invalid);
				expect(invalidResult.rejection.reason).toBe("invalid");
				expect(invalidResult.rejection.message).toMatch(/JSON Parse error|Unexpected EOF/i);
			}

			const notObject = path.join(tempDir.path(), "array.json");
			fs.writeFileSync(notObject, "[]");
			const nullAdapt = readConfigFileResult(notObject, () => null);
			expect(nullAdapt).toEqual({
				kind: "rejected",
				rejection: {
					path: notObject,
					reason: "invalid",
					message: "config did not contain a usable object",
				},
			});
		} finally {
			tempDir.removeSync();
		}
	});

	it("readConfigFileResult treats ENOTDIR parents as absent", () => {
		const tempDir = TempDir.createSync("@omp-cfg-enotdir-");
		try {
			const fileAsDir = path.join(tempDir.path(), "omp-as-file");
			fs.writeFileSync(fileAsDir, "not-a-directory");
			const nested = path.join(fileAsDir, "lsp.json");
			expect(readConfigFileResult(nested, content => JSON.parse(content) as unknown)).toEqual({
				kind: "absent",
			});
		} finally {
			tempDir.removeSync();
		}
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"readConfigFileResult reports unreadable files",
		() => {
			const tempDir = TempDir.createSync("@omp-cfg-unreadable-");
			try {
				const locked = path.join(tempDir.path(), "locked.json");
				fs.writeFileSync(locked, '{"servers":{}}');
				fs.chmodSync(locked, 0);
				try {
					const result = readConfigFileResult(locked, content => JSON.parse(content) as unknown);
					expect(result.kind).toBe("rejected");
					if (result.kind === "rejected") {
						expect(result.rejection.reason).toBe("unreadable");
						expect(result.rejection.path).toBe(locked);
					}
				} finally {
					fs.chmodSync(locked, 0o644);
				}
			} finally {
				tempDir.removeSync();
			}
		},
	);

	it("loadConfig records malformed .omp/lsp.json and leaves absent paths silent", () => {
		const tempDir = TempDir.createSync("@omp-lsp-malformed-load-");
		try {
			const cwd = tempDir.path();
			fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".omp", "lsp.json"), '{"servers":');

			configCache.delete(cwd);
			const config = loadConfig(cwd);

			expect(config.rejectedSources?.length).toBe(1);
			expect(config.rejectedSources?.[0]?.reason).toBe("invalid");
			expect(config.rejectedSources?.[0]?.path).toBe(path.join(cwd, ".omp", "lsp.json"));
			expect(formatRejectedConfigSources(cwd, config.rejectedSources)[0]).toContain(path.join(".omp", "lsp.json"));
		} finally {
			configCache.delete(tempDir.path());
			tempDir.removeSync();
		}
	});

	it("loadConfig accepts a valid override without rejectedSources", () => {
		const tempDir = TempDir.createSync("@omp-lsp-valid-load-");
		try {
			const cwd = tempDir.path();
			fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
			fs.writeFileSync(
				path.join(cwd, ".omp", "lsp.json"),
				JSON.stringify({
					servers: {
						"fake-custom": {
							command: process.execPath,
							fileTypes: [".xyz"],
							rootMarkers: ["."],
						},
					},
				}),
			);

			configCache.delete(cwd);
			const config = loadConfig(cwd);
			expect(config.rejectedSources).toBeUndefined();
			expect(config.servers["fake-custom"]).toBeDefined();
		} finally {
			configCache.delete(tempDir.path());
			tempDir.removeSync();
		}
	});

	it("formatRejectedConfigSources shortens home paths and sanitizes messages", () => {
		const home = lspHomeOverride ?? os.homedir();
		const absolute = path.join(home, ".omp", "agent", "lsp.json");
		const lines = formatRejectedConfigSources("/tmp/project", [
			{
				path: absolute,
				reason: "invalid",
				message: "JSON\tParse\nerror: Unexpected EOF",
			},
		]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("Rejected config:");
		expect(lines[0]).toContain("(invalid):");
		expect(lines[0]).not.toContain(home);
		expect(lines[0]).toContain("~");
		expect(lines[0]).not.toContain("\t");
		expect(lines[0]).not.toContain("\n");
		expect(lines[0]).toMatch(/JSON\s+Parse\s+error: Unexpected EOF/);
	});

	it("status names the rejected source path and parse diagnostic", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-malformed-status-");
		try {
			const cwd = tempDir.path();
			fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".omp", "lsp.json"), '{"servers":');
			configCache.delete(cwd);

			const tool = new LspTool(makeLspSession(cwd));
			const output = textResult(await tool.execute("status-rejected", { action: "status" }));

			expect(output).toContain(`Rejected config: ${path.join(".omp", "lsp.json")} (invalid):`);
			expect(output).toMatch(/JSON Parse error|Unexpected EOF/i);
		} finally {
			configCache.delete(tempDir.path());
			tempDir.removeSync();
		}
	});

	it("reload * reports the rejected source when config cannot be applied", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-malformed-reload-");
		try {
			const cwd = tempDir.path();
			fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".omp", "lsp.json"), "not: [yaml");
			configCache.delete(cwd);

			const tool = new LspTool(makeLspSession(cwd));
			const output = textResult(await tool.execute("reload-rejected", { action: "reload", file: "*" }));

			expect(output).toContain("No language server found for this action");
			expect(output).toContain(`Rejected config: ${path.join(".omp", "lsp.json")} (invalid):`);
		} finally {
			configCache.delete(tempDir.path());
			tempDir.removeSync();
		}
	});

	it("loadConfig reports a malformed marketplace lspServers file", async () => {
		const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		delete Bun.env.CLAUDE_CONFIG_DIR;
		const tempDir = TempDir.createSync("@omp-lsp-marketplace-rejected-");
		const home = path.join(tempDir.path(), "home");
		const cwd = path.join(tempDir.path(), "repo");
		const pluginRoot = path.join(
			home,
			".claude",
			"plugins",
			"cache",
			"claude-plugins-official",
			"broken-lsp",
			"1.0.0",
		);
		const marketplaceRoot = path.dirname(path.dirname(pluginRoot));
		const registryPath = path.join(home, ".claude", "plugins", "installed_plugins.json");
		const nestedConfig = path.join(pluginRoot, "lsp.json");

		await fs.promises.mkdir(pluginRoot, { recursive: true });
		await fs.promises.mkdir(cwd, { recursive: true });
		await fs.promises.mkdir(path.dirname(registryPath), { recursive: true });
		await Bun.write(nestedConfig, '{"servers":');
		await Bun.write(
			registryPath,
			`${JSON.stringify(
				{
					version: 2,
					plugins: {
						"broken-lsp@claude-plugins-official": [
							{
								scope: "user",
								installPath: pluginRoot,
								version: "1.0.0",
								installedAt: "2026-05-25T00:00:00.000Z",
								lastUpdated: "2026-05-25T00:00:00.000Z",
							},
						],
					},
				},
				null,
				2,
			)}\n`,
		);
		await Bun.write(
			path.join(marketplaceRoot, "marketplace.json"),
			`${JSON.stringify(
				{
					name: "claude-plugins-official",
					owner: { name: "anthropic" },
					plugins: [
						{
							name: "broken-lsp",
							version: "1.0.0",
							source: "./broken-lsp/1.0.0",
							lspServers: "./lsp.json",
						},
					],
				},
				null,
				2,
			)}\n`,
		);

		try {
			await preloadPluginRoots(home, cwd);
			configCache.delete(cwd);
			const config = loadConfig(cwd);
			expect(config.rejectedSources?.some(entry => entry.path === nestedConfig && entry.reason === "invalid")).toBe(
				true,
			);
		} finally {
			try {
				await preloadPluginRoots(path.join(tempDir.path(), "empty-home"), cwd);
			} finally {
				configCache.delete(cwd);
				restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
				tempDir.removeSync();
			}
		}
	});
});
