import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { collectLaunchers } from "@oh-my-pi/pi-coding-agent/cli/launchers-cli";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const originalConfigDir = process.env.PI_CONFIG_DIR;
const originalConfigFiles = process.env.PI_CONFIG_FILES;

function restoreEnv(key: "PI_CONFIG_DIR" | "PI_CONFIG_FILES", value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

describe("collectLaunchers", () => {
	let tmp: TempDir;
	let home: string;
	let project: string;
	let agentDir: string;

	beforeEach(async () => {
		resetSettingsForTest();
		tmp = TempDir.createSync("@omp-launchers-");
		home = path.join(tmp.path(), "home");
		project = path.join(tmp.path(), "project");
		agentDir = path.join(tmp.path(), "agent");
		await Promise.all([fs.mkdir(home), fs.mkdir(project), fs.mkdir(agentDir)]);
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(agentDir);
		delete process.env.PI_CONFIG_DIR;
		delete process.env.PI_CONFIG_FILES;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		restoreEnv("PI_CONFIG_DIR", originalConfigDir);
		restoreEnv("PI_CONFIG_FILES", originalConfigFiles);
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await tmp.remove().catch(() => {});
	});

	describe("profiles", () => {
		it("lists only directories that `--profile` accepts, sorted by name", async () => {
			const profilesDir = path.join(home, ".omp", "profiles");
			await fs.mkdir(path.join(profilesDir, "work"), { recursive: true });
			await fs.mkdir(path.join(profilesDir, "alpha"));
			await fs.mkdir(path.join(profilesDir, "bad name"));
			await fs.mkdir(path.join(profilesDir, "default"));
			await Bun.write(path.join(profilesDir, "notes.txt"), "not a profile");

			const report = await collectLaunchers({ cwd: project });

			expect(report.profilesDir).toBe(profilesDir);
			expect(report.profiles.map(profile => profile.name)).toEqual(["alpha", "work"]);
			expect(report.profiles[1]?.path).toBe(path.join(profilesDir, "work"));
		});

		it("follows PI_CONFIG_DIR instead of a hard-coded ~/.omp", async () => {
			await fs.mkdir(path.join(home, ".omp", "profiles", "stock"), { recursive: true });
			await fs.mkdir(path.join(home, ".custom-omp", "profiles", "relocated"), { recursive: true });
			process.env.PI_CONFIG_DIR = ".custom-omp";

			const report = await collectLaunchers({ cwd: project });

			expect(report.profiles.map(profile => profile.name)).toEqual(["relocated"]);
		});

		it("reports no profiles when the profiles directory does not exist", async () => {
			const report = await collectLaunchers({ cwd: project });

			expect(report.profiles).toEqual([]);
		});
	});

	describe("overlays", () => {
		it("lists PI_CONFIG_FILES entries, flagging files that do not exist", async () => {
			const present = path.join(project, "fast.yml");
			await Bun.write(present, "{}\n");
			process.env.PI_CONFIG_FILES = [present, "gone.yaml"].join(path.delimiter);

			const report = await collectLaunchers({ cwd: project });

			expect(report.overlayDir).toBeUndefined();
			expect(report.overlays).toEqual([
				{ name: "fast", path: present, source: "env", missing: false },
				{ name: "gone", path: path.join(project, "gone.yaml"), source: "env", missing: true },
			]);
		});

		it("scans only the directory passed explicitly, for .yml/.yaml files, without duplicating env entries", async () => {
			const overlayDir = path.join(tmp.path(), "overlays");
			await fs.mkdir(path.join(overlayDir, "nested.yml"), { recursive: true });
			await Bun.write(path.join(overlayDir, "b.yaml"), "{}\n");
			await Bun.write(path.join(overlayDir, "a.yml"), "{}\n");
			await Bun.write(path.join(overlayDir, "readme.md"), "not an overlay");
			process.env.PI_CONFIG_FILES = path.join(overlayDir, "a.yml");

			const withDir = await collectLaunchers({ cwd: project, overlayDir });
			const withoutDir = await collectLaunchers({ cwd: project });

			expect(withDir.overlays.map(overlay => [overlay.name, overlay.source])).toEqual([
				["a", "env"],
				["b", "dir"],
			]);
			expect(withoutDir.overlays.map(overlay => overlay.name)).toEqual(["a"]);
		});

		it("rejects an overlay directory that does not exist instead of silently listing nothing", async () => {
			await expect(collectLaunchers({ cwd: project, overlayDir: path.join(tmp.path(), "missing") })).rejects.toThrow(
				"is not a directory",
			);
		});
	});

	describe("presets", () => {
		it("lists each preset's default model, thinking level, and defining layer; invalid ones carry the reason", async () => {
			await Bun.write(
				path.join(agentDir, "config.yml"),
				[
					"modelPresets:",
					"  fast:",
					"    modelRoles:",
					"      default: anthropic/claude-haiku-4-5",
					"    defaultThinkingLevel: low",
					"  broken:",
					"    modelRoles: nope",
					"",
				].join("\n"),
			);

			const report = await collectLaunchers({ cwd: project });

			expect(report.presetsError).toBeUndefined();
			expect(report.presets).toEqual([
				{ name: "broken", source: "global", error: "`modelRoles` is missing or not a mapping" },
				{ name: "fast", source: "global", defaultModel: "anthropic/claude-haiku-4-5", thinking: "low" },
			]);
		});

		it("attributes presets to the overlay layer for both PI_CONFIG_FILES and --config overlays", async () => {
			const overlayDir = path.join(tmp.path(), "overlays");
			await fs.mkdir(overlayDir);
			const deep = path.join(overlayDir, "deep.yml");
			const flagged = path.join(overlayDir, "flagged.yml");
			await Bun.write(
				deep,
				["modelPresets:", "  deep:", "    modelRoles:", "      default: openai/gpt-5", ""].join("\n"),
			);
			await Bun.write(
				flagged,
				["modelPresets:", "  flagged:", "    modelRoles:", "      default: openai/gpt-5-mini", ""].join("\n"),
			);
			process.env.PI_CONFIG_FILES = deep;

			const report = await collectLaunchers({ cwd: project, config: [flagged, deep] });

			expect(report.overlays.map(overlay => [overlay.name, overlay.source])).toEqual([
				["deep", "env"],
				["flagged", "flag"],
			]);
			expect(report.presets).toEqual([
				{ name: "deep", source: "overlay", defaultModel: "openai/gpt-5", thinking: undefined },
				{ name: "flagged", source: "overlay", defaultModel: "openai/gpt-5-mini", thinking: undefined },
			]);
		});

		it("keeps profiles and overlays listed when the config cannot load", async () => {
			await fs.mkdir(path.join(home, ".omp", "profiles", "work"), { recursive: true });
			process.env.PI_CONFIG_FILES = path.join(project, "absent.yml");

			const report = await collectLaunchers({ cwd: project });

			expect(report.presets).toEqual([]);
			expect(report.presetsError).toContain("absent.yml");
			expect(report.profiles.map(profile => profile.name)).toEqual(["work"]);
			expect(report.overlays.map(overlay => overlay.missing)).toEqual([true]);
		});
	});
});
