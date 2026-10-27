import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LOCALIZED_UPDATE_CONFLICT_EXIT_CODE } from "../packages/coding-agent/src/cli/localized-update-protocol";
import {
	applyLocalizedPatch,
	LocalizedMergeConflictError,
	parseMetadata,
	parseOptions,
	replaceLocalizedExecutable,
	updateLocalized,
	verifyLanguageProbe,
} from "./update-localized";

const metadataPath = path.resolve("test-install", "omp-localized.json");
const metadata = {
	schemaVersion: 1,
	repoRoot: path.resolve("test-source"),
	bunPath: path.resolve("test-tools", "bun.exe"),
	executablePath: path.resolve("test-install", "omp.exe"),
	localeDir: path.resolve("test-install", "locales"),
	upstreamBase: "a".repeat(40),
	version: "18.13.0",
};

describe("localized source update contract", () => {
	it("accepts exact stable and local cached rebuild requests", () => {
		expect(parseOptions(["--metadata", metadataPath, "--version", "v18.13.0", "--offline", "--force"])).toEqual({
			metadataPath,
			version: "18.13.0",
			check: false,
			force: true,
			offline: true,
		});
		expect(parseOptions(["--metadata", metadataPath, "--check", "--stable"]).check).toBe(true);
	});

	it("rejects unsupported channels before reading metadata or changing files", async () => {
		await expect(updateLocalized(["--metadata", metadataPath, "--canary"])).rejects.toThrow("stable releases only");
	});

	it("rejects injected refs, unknown flags and unpinned offline requests", () => {
		for (const args of [
			["--version", "18.13.0; echo injected"],
			["--version", "../main"],
			["--version", "18.13.0-canary.1"],
			["--offline"],
			["--remote", "untrusted"],
			["--parent-pid", "123"],
		]) {
			expect(() => parseOptions(["--metadata", metadataPath, ...args])).toThrow();
		}
	});

	it("requires absolute installation paths and an exact upstream base", () => {
		expect(parseMetadata(metadata)).toEqual(metadata);
		for (const changed of [
			{ schemaVersion: 2 },
			{ repoRoot: "relative" },
			{ bunPath: "bun" },
			{ executablePath: "omp.exe" },
			{ localeDir: "locales" },
			{ upstreamBase: "HEAD" },
			{ version: "latest" },
		]) {
			expect(() => parseMetadata({ ...metadata, ...changed })).toThrow();
		}
	});
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn(
		["git", "-c", "core.longpaths=true", "-c", "core.autocrlf=false", "-c", "user.name=Localized Test", "-c", "user.email=localized@example.invalid", ...args],
		{ cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
	return stdout;
}

async function withPatchFixture(
	conflict: boolean,
	run: (fixture: { directory: string; repo: string; patchFile: string; base: string }) => Promise<void>,
): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-localized-patch-"));
	const repo = path.join(directory, "repo");
	const patchFile = path.join(directory, "fork.patch");
	try {
		await fs.mkdir(repo);
		await git(repo, "init");
		await git(repo, "config", "core.autocrlf", "false");
		await fs.writeFile(path.join(repo, "greeting.txt"), "English greeting\n");
		await git(repo, "add", ".");
		await git(repo, "commit", "-m", "base");
		const base = (await git(repo, "rev-parse", "HEAD")).trim();
		await fs.writeFile(path.join(repo, "greeting.txt"), "Korean greeting\n");
		await fs.writeFile(patchFile, await git(repo, "diff", "--binary", "--full-index"));
		await fs.writeFile(path.join(repo, "greeting.txt"), conflict ? "New upstream greeting\n" : "English greeting\n");
		await git(repo, "add", ".");
		await git(repo, "commit", "--allow-empty", "-m", "upstream release");
		await git(repo, "tag", "v18.13.1");
		await run({ directory, repo, patchFile, base });
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

describe("localized patch conflict protocol", () => {
	it("identifies an actual three-way collision from unmerged index entries", async () => {
		await withPatchFixture(true, async ({ repo, patchFile }) => {
			await expect(applyLocalizedPatch(repo, patchFile)).rejects.toBeInstanceOf(LocalizedMergeConflictError);
			expect((await git(repo, "ls-files", "--unmerged", "-z")).length).toBeGreaterThan(0);
		});
	});

	it("preserves successful Korean patch application", async () => {
		await withPatchFixture(false, async ({ repo, patchFile }) => {
			await applyLocalizedPatch(repo, patchFile);
			expect(await fs.readFile(path.join(repo, "greeting.txt"), "utf8")).toBe("Korean greeting\n");
			expect(await git(repo, "ls-files", "--unmerged", "-z")).toBe("");
		});
	});

	it("does not classify an unreadable or malformed patch as a merge conflict", async () => {
		await withPatchFixture(false, async ({ repo, patchFile }) => {
			for (const file of [path.join(path.dirname(patchFile), "missing.patch"), patchFile]) {
				await fs.writeFile(patchFile, "not a Git patch\n");
				try {
					await applyLocalizedPatch(repo, file);
					throw new Error("Expected patch application failure");
				} catch (error) {
					expect(error).toBeInstanceOf(Error);
					expect(error).not.toBeInstanceOf(LocalizedMergeConflictError);
					expect((error as Error).message).toContain("Command failed");
				}
				expect(await git(repo, "ls-files", "--unmerged", "-z")).toBe("");
			}
		});
	});

	for (const failure of ["conflict", "bad-ref", "missing-manifest"] as const) {
		it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
			`direct source updater reports ${failure === "conflict" ? "official fallback exit 42" : "ordinary exit 1"} for ${failure}`,
			async () => {
				await withPatchFixture(failure === "conflict", async ({ directory, repo, base }) => {
					await fs.writeFile(path.join(repo, "greeting.txt"), "Korean greeting\n");
					if (failure === "bad-ref") await git(repo, "tag", "-d", "v18.13.1");
					const executablePath = path.join(directory, "omp.exe");
					const metadataPath = path.join(directory, "omp-localized.json");
					const originalMetadata = JSON.stringify({
						...metadata,
						repoRoot: repo,
						bunPath: process.execPath,
						executablePath,
						localeDir: path.join(directory, "locales"),
						upstreamBase: base,
					});
					await fs.writeFile(executablePath, "current Korean executable");
					await fs.writeFile(metadataPath, originalMetadata);
					const child = Bun.spawn(
						[process.execPath, path.join(import.meta.dir, "update-localized.ts"), "--metadata", metadataPath, "--version", "18.13.1", "--offline"],
						{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
					);
					const [code, , stderr] = await Promise.all([
						child.exited,
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
					]);
					expect(code).toBe(failure === "conflict" ? LOCALIZED_UPDATE_CONFLICT_EXIT_CODE : 1);
					if (failure === "conflict") expect(stderr).toContain("Official fallback requested");
					else {
						expect(stderr).toContain("Localized update failed:");
						expect(stderr).not.toContain("Official fallback requested");
					}
					expect(await fs.readFile(executablePath, "utf8")).toBe("current Korean executable");
					expect(await fs.readFile(metadataPath, "utf8")).toBe(originalMetadata);
					expect(await Bun.file(`${metadataPath}.update-lock`).exists()).toBe(false);
				});
			},
			30_000,
		);
	}
});

describe("localized candidate validation", () => {
	it("checks language selection independently of empty installed packs", () => {
		expect(() => verifyLanguageProbe("USAGE", "LOCALIZED_UPDATE_PROBE")).not.toThrow();
		expect(() => verifyLanguageProbe("USAGE", "USAGE")).toThrow();
		expect(() => verifyLanguageProbe("LOCALIZED_UPDATE_PROBE", "LOCALIZED_UPDATE_PROBE")).toThrow();
	});

	for (const failure of ["none", "verification", "metadata"]) {
		it(`preserves the installation transaction when failure is ${failure}`, async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-localized-transaction-"));
			const executablePath = path.join(directory, "omp.exe");
			const stagedPath = path.join(directory, "omp.new");
			const backupPath = path.join(directory, "omp.bak");
			const metadataPath = path.join(directory, "omp-localized.json");
			const stagedMetadataPath = path.join(directory, "metadata.new");
			try {
				await fs.writeFile(executablePath, "old executable");
				await fs.writeFile(stagedPath, "new executable");
				await fs.writeFile(metadataPath, "old metadata");
				await fs.writeFile(stagedMetadataPath, "new metadata");
				const replacement = replaceLocalizedExecutable({
					executablePath,
					stagedPath,
					backupPath,
					metadataPath,
					stagedMetadataPath,
					async verifyInstalled() {
						expect(await fs.readFile(executablePath, "utf8")).toBe("new executable");
						if (failure === "verification") throw new Error("candidate failed validation");
						if (failure === "metadata") await fs.unlink(stagedMetadataPath);
					},
				});
				if (failure === "none") {
					await replacement;
					expect(await fs.readFile(executablePath, "utf8")).toBe("new executable");
					expect(await fs.readFile(metadataPath, "utf8")).toBe("new metadata");
					expect(await fs.readFile(backupPath, "utf8")).toBe("old executable");
				} else {
					await expect(replacement).rejects.toThrow();
					expect(await fs.readFile(executablePath, "utf8")).toBe("old executable");
					expect(await fs.readFile(metadataPath, "utf8")).toBe("old metadata");
				}
				expect(await Bun.file(stagedPath).exists()).toBe(false);
				expect(await Bun.file(stagedMetadataPath).exists()).toBe(false);
			} finally {
				await fs.rm(directory, { recursive: true, force: true });
			}
		});
	}

	for (const failVerification of [false, true]) {
		it.skipIf(process.platform !== "win32")(
			`${failVerification ? "rolls back" : "installs"} while the previous Windows executable is still running`,
			async () => {
				const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-localized-live-"));
				const executablePath = path.join(directory, "omp.exe");
				const stagedPath = path.join(directory, "omp.new");
				const backupPath = path.join(directory, "omp.bak");
				const metadataPath = path.join(directory, "omp-localized.json");
				const stagedMetadataPath = path.join(directory, "metadata.new");
				let live: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
				try {
					await fs.copyFile(process.execPath, executablePath);
					await fs.copyFile(process.execPath, stagedPath);
					await fs.writeFile(metadataPath, "old metadata");
					await fs.writeFile(stagedMetadataPath, "new metadata");
					live = Bun.spawn([executablePath, "-e", 'await Bun.write(Bun.stdout, "1"); await Bun.stdin.text()'], {
						stdin: "pipe",
						stdout: "pipe",
						stderr: "pipe",
					});
					const reader = live.stdout.getReader();
					const ready = await reader.read();
					reader.releaseLock();
					expect(new TextDecoder().decode(ready.value)).toBe("1");
					const replacement = replaceLocalizedExecutable({
						executablePath,
						stagedPath,
						backupPath,
						metadataPath,
						stagedMetadataPath,
						async verifyInstalled() {
							const installed = Bun.spawn([executablePath, "--version"], { stdout: "ignore", stderr: "ignore" });
							expect(await installed.exited).toBe(0);
							if (failVerification) throw new Error("candidate failed validation");
						},
					});
					if (failVerification) await expect(replacement).rejects.toThrow("candidate failed validation");
					else await replacement;
					expect(live.exitCode).toBeNull();
					expect(await Bun.file(executablePath).exists()).toBe(true);
					expect(await Bun.file(backupPath).exists()).toBe(!failVerification);
					expect(await fs.readFile(metadataPath, "utf8")).toBe(failVerification ? "old metadata" : "new metadata");
				} finally {
					if (live) {
						live.stdin.end();
						await live.exited;
					}
					await fs.rm(directory, { recursive: true, force: true });
				}
			},
			30_000,
		);
	}
});
