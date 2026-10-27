#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { parseMetadata, type LocalizedInstall } from "./update-localized";

const repoRoot = path.resolve(import.meta.dir, "..");

async function run(args: string[], capture = false, env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const child = Bun.spawn(args, { cwd: repoRoot, env, stdin: "ignore", stdout: capture ? "pipe" : "inherit", stderr: "inherit" });
	const output = capture ? new Response(child.stdout as ReadableStream).text() : Promise.resolve("");
	const [code, text] = await Promise.all([child.exited, output]);
	if (code !== 0) throw new Error(`Command failed (${code}): ${args.join(" ")}`);
	return text;
}

async function main(): Promise<void> {
	if (process.platform !== "win32" || process.arch !== "x64") {
		throw new Error("This isolated installer currently supports Windows x64.");
	}
	let directory = path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Local"), "omp-korean");
	let changePath = true;
	for (let index = 2; index < process.argv.length; index++) {
		if (process.argv[index] === "--directory") {
			const value = process.argv[++index];
			if (!value || !path.isAbsolute(value)) throw new Error("--directory requires an absolute directory");
			directory = value;
		} else if (process.argv[index] === "--no-path") changePath = false;
		else throw new Error(`Unknown installer option: ${process.argv[index]}`);
	}
	const official = path.join(process.env.LOCALAPPDATA ?? "", "omp");
	if (path.resolve(directory).toLowerCase() === path.resolve(official).toLowerCase()) {
		throw new Error("Choose a separate installation directory, not the official omp directory.");
	}
	const manifest = await Bun.file(path.join(repoRoot, "packages/coding-agent/package.json")).json() as { version: string };
	const upstreamBase = (await run(["git", "rev-parse", "HEAD"], true)).trim();
	await run([process.execPath, path.join(repoRoot, "scripts/build-localized.ts")]);
	const binary = path.join(repoRoot, "packages/coding-agent/binaries/omp-windows-x64.exe");
	const version = (await run([binary, "--version"], true)).trim();
	if (version !== `omp/${manifest.version}`) throw new Error(`Unexpected built version: ${version}`);
	await run([binary, "--smoke-test"]);
	await fs.mkdir(directory, { recursive: true });
	const localeDir = path.join(directory, "locales");
	await fs.mkdir(localeDir, { recursive: true });
	for (const language of ["en", "ko"]) {
		// Language packs belong to the user after installation; never overwrite edits.
		try {
			await fs.copyFile(path.join(repoRoot, "packages/utils/src/locales", `${language}.json`), path.join(localeDir, `${language}.json`), fs.constants.COPYFILE_EXCL);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	const executablePath = path.join(directory, "omp.exe");
	const metadataPath = path.join(directory, "omp-localized.json");
	const metadata: LocalizedInstall = parseMetadata({ schemaVersion: 1, repoRoot, bunPath: process.execPath, executablePath, localeDir, upstreamBase, version: manifest.version });
	const id = randomUUID();
	const pending = path.join(directory, `omp.${id}.pending.exe`);
	const backup = path.join(directory, `omp.${id}.previous.exe`);
	await fs.copyFile(binary, pending, fs.constants.COPYFILE_EXCL);
	const installedHelp = await run([pending, "--help"], true, { ...process.env, OMP_LANG: "ko", OMP_LOCALE_DIR: localeDir });
	if (!installedHelp.includes("--model")) throw new Error("Installed language pack did not produce usable help");
	let backedUp = false;
	let promoted = false;
	try {
		try { await fs.rename(executablePath, backup); backedUp = true; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		await fs.rename(pending, executablePath);
		promoted = true;
		const temporaryMetadata = `${metadataPath}.${id}.tmp`;
		await Bun.write(temporaryMetadata, `${JSON.stringify(metadata, null, 2)}\n`);
		await fs.rename(temporaryMetadata, metadataPath);
	} catch (error) {
		if (promoted) await fs.rm(executablePath, { force: true });
		if (backedUp) await fs.rename(backup, executablePath);
		throw error;
	}
	if (changePath) {
		const script = '$dir=$env:OMP_LOCALIZED_INSTALL_DIR; $old=[Environment]::GetEnvironmentVariable("Path","User"); $parts=@($old -split ";" | Where-Object { $_ -and $_.TrimEnd("\\") -ine $dir.TrimEnd("\\") }); [Environment]::SetEnvironmentVariable("Path", (@($dir)+$parts -join ";"), "User")';
		await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], false, { ...process.env, OMP_LOCALIZED_INSTALL_DIR: directory });
	}
	console.log(`Installed language-pack omp ${manifest.version}: ${executablePath}`);
	console.log(`Editable language pack: ${path.join(localeDir, "ko.json")}`);
	console.log(changePath ? "Restart your terminal to use the isolated omp from PATH." : "PATH unchanged.");
}

if (import.meta.main) await main();
