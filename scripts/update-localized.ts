#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LOCALIZED_UPDATE_CONFLICT_EXIT_CODE } from "../packages/coding-agent/src/cli/localized-update-protocol";
import { compareVersions } from "../packages/utils/src/version";

const UPSTREAM = "https://github.com/can1357/oh-my-pi.git";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface LocalizedInstall {
	schemaVersion: 1;
	repoRoot: string;
	bunPath: string;
	executablePath: string;
	localeDir: string;
	upstreamBase: string;
	version: string;
}

export function parseMetadata(value: unknown): LocalizedInstall {
	if (typeof value !== "object" || value === null) throw new Error("Invalid localized metadata object");
	const data = value as Record<string, unknown>;
	if (data.schemaVersion !== 1) throw new Error("Unsupported localized metadata schema");
	for (const field of ["repoRoot", "bunPath", "executablePath", "localeDir"] as const) {
		if (typeof data[field] !== "string" || !path.isAbsolute(data[field])) {
			throw new Error(`Localized metadata requires absolute ${field}`);
		}
	}
	if (typeof data.upstreamBase !== "string" || !/^[a-f0-9]{40,64}$/i.test(data.upstreamBase)) {
		throw new Error("Localized metadata requires an upstream commit ID");
	}
	if (typeof data.version !== "string" || !VERSION_PATTERN.test(data.version)) {
		throw new Error("Invalid localized installed version");
	}
	return data as unknown as LocalizedInstall;
}

export function parseOptions(args: string[]) {
	let metadataPath: string | undefined;
	let version: string | undefined;
	let check = false;
	let force = false;
	let offline = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--check" || arg === "-c") check = true;
		else if (arg === "--force" || arg === "-f") force = true;
		else if (arg === "--offline") offline = true;
		else if (arg === "--stable") continue;
		else if (arg === "--canary") throw new Error("Localized updates support stable releases only");
		else if (arg === "--metadata") metadataPath = args[++i];
		else if (arg === "--version") {
			version = args[++i]?.replace(/^v/, "");
			if (!version) throw new Error("--version requires a stable release version");
		} else throw new Error(`Unsupported localized update option: ${arg}`);
	}
	if (!metadataPath || !path.isAbsolute(metadataPath)) throw new Error("--metadata requires an absolute file path");
	if (version !== undefined && (!VERSION_PATTERN.test(version) || version.includes("-"))) {
		throw new Error("--version requires a stable release version, for example 18.13.0");
	}
	if (offline && !version) throw new Error("--offline requires --version");
	return { metadataPath, version, check, force, offline };
}

async function command(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	capture = false,
): Promise<string> {
	// Nested update worktrees exceed Git for Windows' legacy path limit.
	const argv = args[0] === "git" ? ["git", "-c", "core.longpaths=true", ...args.slice(1)] : args;
	const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: capture ? "pipe" : "inherit", stderr: "inherit" });
	const output = capture ? new Response(child.stdout as ReadableStream).text() : Promise.resolve("");
	const [code, text] = await Promise.all([child.exited, output]);
	if (code !== 0) throw new Error(`Command failed (${code}): ${args.join(" ")}`);
	return text;
}

export class LocalizedMergeConflictError extends Error {
	constructor(cause: unknown) {
		super("Korean source changes conflict with the upstream release", { cause });
		this.name = "LocalizedMergeConflictError";
	}
}

export async function applyLocalizedPatch(candidate: string, patchFile: string): Promise<void> {
	try {
		await command(["git", "apply", "--3way", "--index", patchFile], candidate);
	} catch (error) {
		const unmerged = await command(["git", "ls-files", "--unmerged", "-z"], candidate, process.env, true);
		if (unmerged.length > 0) throw new LocalizedMergeConflictError(error);
		throw error;
	}
}

async function fetchBytes(url: string, timeout: number): Promise<Uint8Array> {
	const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
	if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
	return new Uint8Array(await response.arrayBuffer());
}

async function latestVersion(): Promise<string> {
	const response = await fetch("https://api.github.com/repos/can1357/oh-my-pi/releases/latest", {
		headers: { accept: "application/vnd.github+json", "user-agent": "omp-localized-source-updater" },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`Release check failed: HTTP ${response.status}`);
	const release = (await response.json()) as { tag_name?: unknown };
	const version = typeof release.tag_name === "string" ? release.tag_name.replace(/^v/, "") : "";
	if (!VERSION_PATTERN.test(version) || version.includes("-")) throw new Error("Latest release has no stable version tag");
	return version;
}

async function installNative(candidate: string, metadata: LocalizedInstall, offline: boolean): Promise<void> {
	const manifest = (await Bun.file(path.join(candidate, "packages/natives/package.json")).json()) as { version: string };
	const tag = `${process.platform}-${process.arch}`;
	const names = process.arch === "x64"
		? [`pi_natives.${tag}-baseline.node`, `pi_natives.${tag}-modern.node`, `pi_natives.${tag}.node`]
		: [`pi_natives.${tag}.node`];
	const destination = path.join(candidate, "packages/natives/native");
	if (offline) {
		const source = (await Bun.file(path.join(metadata.repoRoot, "packages/natives/package.json")).json()) as { version: string };
		if (source.version !== manifest.version) throw new Error("Offline native reuse requires exactly matching native versions");
		let copied = 0;
		for (const name of names) {
			const file = path.join(metadata.repoRoot, "packages/natives/native", name);
			if (await Bun.file(file).exists()) {
				await fs.copyFile(file, path.join(destination, name));
				copied++;
			}
		}
		if (copied === 0) throw new Error("No exact-version local native addon available");
		return;
	}
	const packageName = `@oh-my-pi/pi-natives-${tag}`;
	const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(manifest.version)}`;
	const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error(`Native manifest unavailable: HTTP ${response.status}`);
	const published = (await response.json()) as { name: string; version: string; dist: { tarball: string; integrity?: string; shasum?: string } };
	if (published.name !== packageName || published.version !== manifest.version) throw new Error("Native package version mismatch");
	const tarballUrl = new URL(published.dist.tarball);
	if (tarballUrl.protocol !== "https:" || tarballUrl.hostname !== "registry.npmjs.org") throw new Error("Unexpected native tarball origin");
	const tarball = await fetchBytes(tarballUrl.href, 15 * 60_000);
	if (published.dist.integrity) {
		const expected = published.dist.integrity.split(/\s+/).find(value => value.startsWith("sha512-"));
		if (!expected || `sha512-${createHash("sha512").update(tarball).digest("base64")}` !== expected) {
			throw new Error("Native tarball integrity mismatch");
		}
	} else if (!published.dist.shasum || createHash("sha1").update(tarball).digest("hex") !== published.dist.shasum) {
		throw new Error("Native tarball checksum mismatch");
	}
	// Read only known regular-file members: never extract archive paths or symlinks to disk.
	const files = await new Bun.Archive(tarball).files();
	const packageManifest = files.get("package/package.json");
	if (!packageManifest) throw new Error("Native tarball has no manifest");
	const packed = JSON.parse(await packageManifest.text()) as { name: string; version: string };
	if (packed.name !== packageName || packed.version !== manifest.version) throw new Error("Packed native manifest mismatch");
	let copied = 0;
	for (const name of names) {
		const file = files.get(`package/${name}`);
		if (file) {
			await Bun.write(path.join(destination, name), file);
			copied++;
		}
	}
	if (copied === 0) throw new Error("Native tarball has no supported addon");
}

export function verifyLanguageProbe(english: string, korean: string): void {
	if (!english.includes("USAGE") || english.includes("LOCALIZED_UPDATE_PROBE") || !korean.includes("LOCALIZED_UPDATE_PROBE")) {
		throw new Error("Candidate language selection did not honor the external language pack");
	}
}

async function verifyBinary(binary: string, version: string, metadata: LocalizedInstall, transaction: string): Promise<void> {
	const probeDir = path.join(transaction, "probe-locales");
	await fs.mkdir(probeDir, { recursive: true });
	await fs.writeFile(path.join(probeDir, "ko.json"), JSON.stringify({ USAGE: "LOCALIZED_UPDATE_PROBE" }));
	for (const locale of ["en", "ko"]) {
		const env = {
			...process.env,
			OMP_LANG: locale,
			OMP_LOCALE_DIR: metadata.localeDir,
			PI_CODING_AGENT_DIR: path.join(transaction, `smoke-${locale}`),
			PI_PROFILE: undefined,
		};
		const reported = (await command([binary, "--version"], transaction, env, true)).trim();
		if (reported !== `omp/${version}`) throw new Error(`Candidate version mismatch: ${reported}`);
		const text = await command([binary, "--help"], transaction, env, true);
		if (text.trim().length < 100) throw new Error(`Candidate ${locale} help is incomplete`);
		// Installed packs may legitimately be empty or partial, yielding identical English fallback help.
		const smoke = await command([binary, "--smoke-test"], transaction, env, true);
		if (!smoke.includes("smoke-test: ok")) throw new Error(`Candidate ${locale} smoke test did not complete`);
	}
	const probeEnv = {
		...process.env,
		OMP_LOCALE_DIR: probeDir,
		PI_CODING_AGENT_DIR: path.join(transaction, "probe-agent"),
		PI_PROFILE: undefined,
	};
	const english = await command([binary, "--help"], transaction, { ...probeEnv, OMP_LANG: "en" }, true);
	const korean = await command([binary, "--help"], transaction, { ...probeEnv, OMP_LANG: "ko" }, true);
	verifyLanguageProbe(english, korean);
}

export async function replaceLocalizedExecutable(options: {
	executablePath: string;
	stagedPath: string;
	backupPath: string;
	metadataPath: string;
	stagedMetadataPath: string;
	verifyInstalled(): Promise<void>;
}): Promise<void> {
	let backedUp = false;
	let replaced = false;
	try {
		// Windows permits renaming the running image, but its backup must remain until the parent exits.
		await fs.rename(options.executablePath, options.backupPath);
		backedUp = true;
		await fs.rename(options.stagedPath, options.executablePath);
		replaced = true;
		await options.verifyInstalled();
		// The metadata is staged before touching the old executable and committed last.
		await fs.rename(options.stagedMetadataPath, options.metadataPath);
	} catch (error) {
		if (replaced) await fs.unlink(options.executablePath);
		if (backedUp) await fs.rename(options.backupPath, options.executablePath);
		throw error;
	} finally {
		await fs.rm(options.stagedPath, { force: true });
		await fs.rm(options.stagedMetadataPath, { force: true });
	}
}

export async function updateLocalized(args: string[]): Promise<void> {
	const options = parseOptions(args);
	const originalMetadata = await fs.readFile(options.metadataPath, "utf8");
	const metadata = parseMetadata(JSON.parse(originalMetadata));
	if (path.resolve(path.dirname(options.metadataPath)) !== path.resolve(path.dirname(metadata.executablePath))) {
		throw new Error("Metadata must be beside the installed executable");
	}
	const version = options.version ?? (await latestVersion());
	console.log(`Localized installed version: ${metadata.version}; upstream stable: ${version}`);
	if (options.check) return;
	if (!options.force && compareVersions(version, metadata.version) <= 0) {
		console.log("Localized installation is already up to date. Use --force to rebuild.");
		return;
	}
	if (process.platform !== "win32" || process.arch !== "x64") {
		throw new Error("This localized source installer currently supports Windows x64 only");
	}
	const lockPath = `${options.metadataPath}.update-lock`;
	const lock = await fs.open(lockPath, "wx");
	try {
		await lock.writeFile(String(process.pid));
		const root = path.join(path.dirname(options.metadataPath), "updates");
		await fs.mkdir(root, { recursive: true });
		const transaction = await fs.mkdtemp(path.join(root, `${version}-`));
		const candidate = path.join(transaction, "source");
		const patchFile = path.join(transaction, "fork.patch");
		console.log(`Preparing isolated source candidate: ${candidate}`);
		const indexEnv = { ...process.env, GIT_INDEX_FILE: path.join(transaction, "fork.index") };
		await command(["git", "read-tree", metadata.upstreamBase], metadata.repoRoot, indexEnv);
		await command(["git", "add", "-A", "--", "."], metadata.repoRoot, indexEnv);
		const patch = await command(["git", "diff", "--cached", "--binary", "--full-index", "--no-ext-diff", metadata.upstreamBase, "--"], metadata.repoRoot, indexEnv, true);
		if (!patch.trim()) throw new Error("No fork changes found; refusing an unlocalized upstream replacement");
		await Bun.write(patchFile, patch);
		if (!options.offline) {
			await command(["git", "fetch", "--no-tags", UPSTREAM, `refs/tags/v${version}`], metadata.repoRoot);
		}
		const ref = options.offline ? `refs/tags/v${version}^{commit}` : "FETCH_HEAD^{commit}";
		const upstreamBase = (await command(["git", "rev-parse", "--verify", ref], metadata.repoRoot, process.env, true)).trim();
		if (!/^[a-f0-9]{40,64}$/i.test(upstreamBase)) throw new Error("Invalid fetched commit");
		await command(["git", "worktree", "add", "--detach", candidate, upstreamBase], metadata.repoRoot);
		await applyLocalizedPatch(candidate, patchFile);
		const manifest = (await Bun.file(path.join(candidate, "packages/coding-agent/package.json")).json()) as { version: string };
		if (manifest.version !== version) throw new Error("Candidate package version does not match upstream release");
		// Preserve the clean upstream checkout as HEAD; future patches are derived from working files, not commits.
		const env = { ...process.env, PATH: `${path.dirname(metadata.bunPath)}${path.delimiter}${process.env.PATH ?? ""}` };
		await command([metadata.bunPath, "install", "--frozen-lockfile", "--ignore-scripts", ...(options.offline ? ["--offline"] : [])], candidate, env);
		await installNative(candidate, metadata, options.offline);
		await command([metadata.bunPath, "scripts/build-localized.ts"], candidate, env);
		const binary = path.join(candidate, "packages/coding-agent/binaries/omp-windows-x64.exe");
		await verifyBinary(binary, version, metadata, transaction);
		const suffix = randomUUID();
		const staged = `${metadata.executablePath}.${suffix}.new`;
		const backup = `${metadata.executablePath}.${suffix}.bak`;
		const stagedMetadata = `${options.metadataPath}.${suffix}.new`;
		const next = { ...metadata, repoRoot: candidate, upstreamBase, version };
		await fs.copyFile(binary, staged);
		await fs.writeFile(stagedMetadata, `${JSON.stringify(next, null, 2)}\n`);
		await fs.writeFile(path.join(transaction, "previous-omp-localized.json"), originalMetadata);
		await replaceLocalizedExecutable({
			executablePath: metadata.executablePath,
			stagedPath: staged,
			backupPath: backup,
			metadataPath: options.metadataPath,
			stagedMetadataPath: stagedMetadata,
			verifyInstalled: () => verifyBinary(metadata.executablePath, version, metadata, transaction),
		});
		console.log(`Localized update installed: ${version}\nPrevious executable: ${backup}\nPrevious sources preserved: ${metadata.repoRoot}\nActive sources: ${candidate}`);
	} finally {
		await lock.close();
		await fs.unlink(lockPath);
	}
}

if (import.meta.main) {
	try {
		await updateLocalized(process.argv.slice(2));
	} catch (error) {
		if (error instanceof LocalizedMergeConflictError) {
			console.error(`${error.message}. Official fallback requested; the omp update CLI must install and launch the official version.`);
			process.exitCode = LOCALIZED_UPDATE_CONFLICT_EXIT_CODE;
		} else {
			console.error(`Localized update failed: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
		}
	}
}
