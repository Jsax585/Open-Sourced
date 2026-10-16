/**
 * `omp launchers` — list the ways to start omp that exist on this machine.
 *
 * - Profiles: directories under the profiles root (`omp --profile <name>`).
 * - Overlays: `config.yml`-style files (`omp --config <file>`). omp has no overlay
 *   directory; they are the files named by `PI_CONFIG_FILES` and `--config`, plus,
 *   optionally, the `*.yml`/`*.yaml` files of a directory passed with `--overlay-dir`.
 * - Presets: `modelPresets` from the effective config (`/modelpreset switch <name>`).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	APP_NAME,
	getActiveProfile,
	getProfilesDir,
	getProjectDir,
	isEnoent,
	isEnotdir,
	normalizeProfileName,
} from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { getModelPreset, getModelPresetNames } from "../config/model-presets";
import { Settings } from "../config/settings";
import { expandTilde } from "../tools/path-utils";
import { detectInteractiveShell, type InteractiveShell, quoteShellArgument } from "../utils/shell-quote";
import { CliUsageError } from "./usage-error";

const OVERLAY_EXTENSION = /\.ya?ml$/;

export interface LauncherProfile {
	name: string;
	path: string;
	/** True when this process runs under the profile (`--profile`, `OMP_PROFILE`, `PI_PROFILE`). */
	active: boolean;
}

export interface LauncherOverlay {
	/** File name without its `.yml`/`.yaml` extension. */
	name: string;
	path: string;
	/** `env`: listed in `PI_CONFIG_FILES`; `flag`: passed via `--config`; `dir`: found in `--overlay-dir`. */
	source: "env" | "flag" | "dir";
	/** `PI_CONFIG_FILES` names a file that does not exist; omp refuses to start until it is fixed. */
	missing: boolean;
}

export interface LauncherPreset {
	name: string;
	/** Config layer that defines the preset. */
	source: "runtime" | "overlay" | "project" | "global";
	/** Model selector of the preset's `default` role. */
	defaultModel?: string;
	thinking?: string;
	/** Why the preset cannot be applied (hand-edited config). */
	error?: string;
}

export interface LaunchersReport {
	profilesDir: string;
	profiles: LauncherProfile[];
	/** Directory scanned for overlays; absent unless `--overlay-dir` was given. */
	overlayDir?: string;
	overlays: LauncherOverlay[];
	presets: LauncherPreset[];
	/** Set when the effective config could not be loaded, so presets are unknown. */
	presetsError?: string;
}

export interface LaunchersCommandArgs {
	flags: {
		json?: boolean;
		config?: string[];
		overlayDir?: string;
	};
}

function overlayName(file: string): string {
	return path.basename(file).replace(OVERLAY_EXTENSION, "");
}

async function listProfiles(profilesDir: string): Promise<LauncherProfile[]> {
	let names: string[];
	try {
		names = await fs.readdir(profilesDir);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const active = getActiveProfile();
	const profiles: LauncherProfile[] = [];
	for (const name of names) {
		// `--profile` rejects invalid names and treats "default" as the base config,
		// so a directory with such a name cannot be launched as a profile.
		let normalized: string | undefined;
		try {
			normalized = normalizeProfileName(name);
		} catch {
			continue;
		}
		if (normalized !== name) continue;
		const profilePath = path.join(profilesDir, name);
		const stat = await fs.stat(profilePath).catch(() => undefined);
		if (stat?.isDirectory()) profiles.push({ name, path: profilePath, active: name === active });
	}
	return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

async function listOverlays(
	cwd: string,
	configFiles: readonly string[],
	overlayDir: string | undefined,
): Promise<LauncherOverlay[]> {
	const overlays: LauncherOverlay[] = [];
	const seen = new Set<string>();
	// Same resolution as Settings: `PI_CONFIG_FILES` path-list, then `--config`, `~` expansion, relative to the project directory.
	const entries: [LauncherOverlay["source"], string][] = [
		...(process.env.PI_CONFIG_FILES?.split(path.delimiter).filter(Boolean) ?? []).map(
			(entry): [LauncherOverlay["source"], string] => ["env", entry],
		),
		...configFiles.map((entry): [LauncherOverlay["source"], string] => ["flag", entry]),
	];
	for (const [source, entry] of entries) {
		const file = path.resolve(cwd, expandTilde(entry));
		if (seen.has(file)) continue;
		seen.add(file);
		const stat = await fs.stat(file).catch(() => undefined);
		overlays.push({ name: overlayName(file), path: file, source, missing: !stat?.isFile() });
	}
	if (overlayDir) {
		const names = await fs.readdir(overlayDir).catch((error: unknown) => {
			throw new CliUsageError(
				isEnoent(error) || isEnotdir(error)
					? `--overlay-dir ${overlayDir} is not a directory`
					: `--overlay-dir ${overlayDir} could not be read: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		for (const name of names.filter(entry => OVERLAY_EXTENSION.test(entry)).sort((a, b) => a.localeCompare(b))) {
			const file = path.join(overlayDir, name);
			if (seen.has(file)) continue;
			const stat = await fs.stat(file).catch(() => undefined);
			if (stat?.isFile()) overlays.push({ name: overlayName(file), path: file, source: "dir", missing: false });
		}
	}
	return overlays;
}

async function listPresets(
	cwd: string,
	configFiles: string[],
): Promise<Pick<LaunchersReport, "presets" | "presetsError">> {
	let settings: Settings;
	try {
		settings = await Settings.loadReadOnly({ cwd, configFiles });
	} catch (error) {
		return { presets: [], presetsError: error instanceof Error ? error.message : String(error) };
	}
	const presets: LauncherPreset[] = [];
	for (const name of getModelPresetNames(settings)) {
		const source = settings.getOwnedModelPreset(name)?.source;
		const lookup = getModelPreset(settings, name);
		if (!source || lookup.kind === "missing") continue;
		if (lookup.kind === "invalid") {
			presets.push({ name, source, error: lookup.reason });
			continue;
		}
		presets.push({
			name,
			source,
			defaultModel: lookup.preset.modelRoles.default,
			thinking: lookup.preset.defaultThinkingLevel,
		});
	}
	return { presets };
}

export async function collectLaunchers(options: {
	cwd: string;
	config?: string[];
	overlayDir?: string;
}): Promise<LaunchersReport> {
	const { cwd } = options;
	const configFiles = options.config ?? [];
	const overlayDir = options.overlayDir ? path.resolve(cwd, expandTilde(options.overlayDir)) : undefined;
	const profilesDir = getProfilesDir();
	const [profiles, overlays] = await Promise.all([
		listProfiles(profilesDir),
		listOverlays(cwd, configFiles, overlayDir),
	]);
	return { profilesDir, profiles, overlayDir, overlays, ...(await listPresets(cwd, configFiles)) };
}

function writeLine(line = ""): void {
	process.stdout.write(`${line}\n`);
}

function writeRows(rows: readonly (readonly [string, string])[], empty: string): void {
	if (rows.length === 0) {
		writeLine(`  ${chalk.dim(empty)}`);
		return;
	}
	const width = Math.max(...rows.map(([label]) => label.length));
	for (const [label, detail] of rows) writeLine(`  ${label.padEnd(width)}  ${chalk.dim(detail)}`);
}

const OVERLAY_SOURCE_TAGS: Record<LauncherOverlay["source"], string> = {
	env: "  [PI_CONFIG_FILES]",
	flag: "  [--config]",
	dir: "",
};

/** Format a hint in one shell dialect; only filesystem paths get Windows separator normalization. */
export function formatLauncherHint(
	flag: "--profile" | "--config",
	value: string,
	shell: InteractiveShell,
	platform: NodeJS.Platform = process.platform,
): string {
	if (shell === "cmd" || shell === "unknown") {
		const reason = shell === "cmd" ? "cmd.exe command hints unavailable" : "shell not recognized";
		return `Open PowerShell or bash; run ${APP_NAME} with ${flag} set to ${JSON.stringify(value)} (${reason})`;
	}
	const argument =
		flag === "--config" && platform === "win32" && shell !== "powershell" ? value.replace(/\\/g, "/") : value;
	return `${APP_NAME} ${flag} ${quoteShellArgument(argument, shell)}`;
}

function renderText(report: LaunchersReport): void {
	const shell = detectInteractiveShell();
	writeLine(chalk.dim(`Command hints: ${shell} (inferred from environment; nested shells may differ).`));
	writeLine();
	writeLine(chalk.bold(`Profiles (${shortenPath(report.profilesDir)})`));
	writeRows(
		report.profiles.map(profile => [
			profile.name,
			`${formatLauncherHint("--profile", profile.name, shell)}${profile.active ? "  [active]" : ""}`,
		]),
		"(none)",
	);

	writeLine();
	writeLine(
		chalk.bold(
			report.overlayDir
				? `Overlays (PI_CONFIG_FILES, --config, ${shortenPath(report.overlayDir)})`
				: "Overlays (PI_CONFIG_FILES, --config)",
		),
	);
	writeRows(
		report.overlays.map(overlay => [
			overlay.name,
			`${formatLauncherHint("--config", overlay.path, shell)}${OVERLAY_SOURCE_TAGS[overlay.source]}${overlay.missing ? "  [missing]" : ""}`,
		]),
		report.overlayDir ? "(none)" : "(none; pass --overlay-dir <dir> to scan a directory of overlay files)",
	);

	writeLine();
	writeLine(chalk.bold("Presets (/modelpreset switch <name>)"));
	if (report.presetsError) {
		writeLine(`  ${chalk.yellow(`Could not load config: ${report.presetsError}`)}`);
		return;
	}
	writeRows(
		report.presets.map(preset => {
			const parts = [
				preset.error ? `invalid: ${preset.error}` : `default ${preset.defaultModel ?? "?"}`,
				preset.thinking ? `thinking ${preset.thinking}` : undefined,
				`[${preset.source}]`,
			];
			return [preset.name, parts.filter(Boolean).join("  ")];
		}),
		"(none)",
	);
}

export async function runLaunchersCommand(command: LaunchersCommandArgs): Promise<void> {
	const report = await collectLaunchers({
		cwd: getProjectDir(),
		config: command.flags.config,
		overlayDir: command.flags.overlayDir,
	});
	if (command.flags.json) {
		writeLine(JSON.stringify(report, null, 2));
		return;
	}
	renderText(report);
}
