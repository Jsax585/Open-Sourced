import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vcsDiscover, vcsGitClone, vcsGitDiscover, vcsGitRepoInfo } from "../native/index.js";
import * as vcs from "../native/vcs.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	// Neutralize any ambient diff driver / textconv (e.g. a user's `diff.external`
	// like difftastic) so raw unified-diff assertions stay stable regardless of the
	// host's global git config. `--no-ext-diff` is the reliable switch here; setting
	// `diff.external=` to empty makes git execute "" as the driver and fail.
	if (args[0] === "diff") args = ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)];
	const process = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) throw new Error(stderr);
	return stdout.trimEnd();
}

async function repository() {
	const root = await mkdtemp(join(tmpdir(), "pi-natives-vcs-"));
	roots.push(root);
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Native Test");
	await git(root, "config", "user.email", "native@example.test");
	// Assertions compare exact LF bytes; Git for Windows' system
	// `core.autocrlf=true` would check files out as CRLF.
	await git(root, "config", "core.autocrlf", "false");
	await writeFile(join(root, "tracked.txt"), "one\ntwo\n");
	await git(root, "add", "tracked.txt");
	await git(root, "commit", "-m", "initial");
	return root;
}

describe("in-process VCS bindings", () => {
	test("detects staged, unstaged, and untracked working-tree changes", async () => {
		const root = await repository();
		const repo = vcsGitDiscover(root)!;

		expect(await repo.isDirty()).toBe(false);

		await writeFile(join(root, "tracked.txt"), "one\nchanged\n");
		expect(await repo.isDirty()).toBe(true);

		await git(root, "restore", "tracked.txt");
		expect(await repo.isDirty()).toBe(false);

		await writeFile(join(root, "untracked.txt"), "new\n");
		expect(await repo.isDirty()).toBe(true);

		await git(root, "add", "untracked.txt");
		expect(await repo.isDirty()).toBe(true);
	});

	test("discovers, diffs, applies, stages, and commits", async () => {
		const root = await repository();
		const nested = join(root, "nested");
		await mkdir(nested);
		await writeFile(join(nested, "untracked.txt"), "new\n");
		await writeFile(join(root, "tracked.txt"), "one\nchanged\n");

		const repo = vcsGitDiscover(nested);
		expect(repo).not.toBeNull();
		const info = vcsGitRepoInfo(nested);
		expect(info?.repoRoot).toBe(root);
		expect(repo!.info().repoRoot).toBe(root);
		expect(repo!.headSync()).toMatchObject({ kind: "ref", branch: "main" });
		expect(await repo!.statusSummary()).toEqual({ staged: 0, unstaged: 1, untracked: 1 });

		const nativePatch = await repo!.diffText({});
		const cliPatch = await git(root, "diff");
		expect(nativePatch.trimEnd()).toBe(cliPatch);
		expect(nativePatch).toContain("diff --git a/tracked.txt b/tracked.txt");
		expect(nativePatch).toContain("@@");

		await git(root, "restore", "tracked.txt");
		expect(await repo!.canApplyPatch(nativePatch, {})).toBe(true);
		await repo!.applyPatch(nativePatch, {});
		expect(await Bun.file(join(root, "tracked.txt")).text()).toBe("one\nchanged\n");

		await repo!.stageFiles(["tracked.txt"]);
		const sha = await repo!.commitCreate("native commit", {});
		expect(sha).toBe(await git(root, "rev-parse", "HEAD"));
	});

	test("throws rich VcsError objects", async () => {
		const root = await repository();
		const repo = vcsGitDiscover(root)!;
		const sha = await git(root, "rev-parse", "HEAD");
		try {
			await repo.cherryPick(sha);
			throw new Error("expected cherry-pick to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect(error).toMatchObject({ name: "VcsError", code: "EmptyCherryPick" });
			expect((error as Error).message).toContain(sha);
		}
	});
	test("applies cached patches to an alternate index", async () => {
		const root = await repository();
		const repo = vcsGitDiscover(root)!;
		await writeFile(join(root, "tracked.txt"), "one\nsynthetic\n");
		const patch = await repo.diffText({});
		const indexPath = join(root, "synthetic.index");
		await repo.readTree("HEAD", indexPath);
		await repo.applyPatch(patch, { cached: true, indexPath });

		const headTree = await git(root, "rev-parse", "HEAD^{tree}");
		expect(await git(root, "write-tree")).toBe(headTree);
		expect(await repo.writeTree(indexPath)).not.toBe(headTree);
		expect(await git(root, "diff", "--cached")).toBe("");
	});

	test("aborts clone promptly", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-natives-vcs-clone-"));
		roots.push(root);
		const target = join(root, "clone");
		const controller = new AbortController();
		controller.abort();
		const started = performance.now();
		try {
			await vcsGitClone("https://10.255.255.1/never.git", target, { timeoutMs: 60_000 }, controller.signal);
			throw new Error("expected clone to reject");
		} catch (error) {
			expect(error).toMatchObject({ name: "VcsError" });
			const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
			expect(["Canceled", "Cli", "CliTimeout"]).toContain(String(code));
			expect(performance.now() - started).toBeLessThan(2_000);
		}
	});

	test("cancels a task-backed repository operation without replacing an aborted signal handler", async () => {
		const root = await repository();
		const repo = vcsGitDiscover(root)!;
		const controller = new AbortController();
		const onAbort = () => {};
		controller.signal.onabort = onAbort;
		controller.abort();

		await expect(repo.head(controller.signal)).rejects.toMatchObject({ name: "VcsError", code: "Canceled" });
		expect(controller.signal.onabort).toBe(onAbort);
	});

	test("keeps the VcsError shape when an AbortSignal fires before task settlement", async () => {
		const root = await repository();
		const repo = vcsGitDiscover(root)!;
		const controller = new AbortController();
		const pending = repo.head(controller.signal);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: "VcsError", code: "Canceled" });
	});
});

describe("VcsRepo", () => {
	test("dispatches portable Git operations", async () => {
		const root = await repository();
		await writeFile(join(root, "tracked.txt"), "one\nunstaged\n");
		await writeFile(join(root, "staged.txt"), "staged\n");
		await git(root, "add", "staged.txt");

		const repo = vcsDiscover(root);
		expect(repo?.kind()).toBe("git");
		expect(repo?.root()).toBe(root);
		expect(repo?.supports("stagedDiff")).toBe(true);
		expect(repo?.asGit()).not.toBeNull();
		expect(repo?.asJj()).toBeNull();
		expect((await repo?.uncommittedDiff([]))?.trimEnd()).toBe(await git(root, "diff", "HEAD"));

		const required = vcs.require(root, "stagedDiff");
		expect(required.kind()).toBe("git");
		expect(required.supports("revDiff")).toBe(true);
	});

	test("discovers Jujutsu and rejects unsupported features", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-natives-vcs-jj-"));
		roots.push(root);
		await mkdir(join(root, ".jj", "repo"), { recursive: true });

		const repo = vcsDiscover(root);
		expect(repo?.kind()).toBe("jj");
		expect(repo?.supports("stagedDiff")).toBe(false);
		expect(repo?.asGit()).toBeNull();
		expect(repo?.asJj()).not.toBeNull();

		try {
			vcs.require(root, "stagedDiff");
			throw new Error("expected capability assertion to reject");
		} catch (error) {
			expect(error).toMatchObject({ name: "VcsError", code: "Unsupported" });
		}

		try {
			repo?.supports("unknown");
			throw new Error("expected unknown feature to reject");
		} catch (error) {
			expect(error).toMatchObject({ name: "VcsError", code: "Backend" });
			expect(error).toBeInstanceOf(Error);
			if (!(error instanceof Error)) throw error;
			expect(error.message).toContain("valid: stagedDiff, revDiff");
		}
	});
});

describe("runPostCheckoutHook records", () => {
	test.skipIf(process.platform === "win32")(
		"a finished run leaves the record of a run still going in the same git dir",
		async () => {
			const root = await repository();
			const fifos = await mkdtemp(join(tmpdir(), "pi-natives-hook-"));
			roots.push(fifos);
			const hooks = join(root, "hooks");
			await mkdir(hooks);
			const hook = join(hooks, "post-checkout");
			await writeFile(hook, '#!/bin/sh\necho started > "$OMP_STARTED"\ncat "$OMP_RELEASE" > /dev/null\n', {
				mode: 0o755,
			});
			// Added before `core.hooksPath` is set: `git worktree add` itself runs post-checkout.
			const worktree = join(root, "linked");
			await git(root, "worktree", "add", "-b", "linked", worktree);
			await git(root, "config", "core.hooksPath", hooks);
			const head = await git(worktree, "rev-parse", "HEAD");
			const setupGitDir = join(root, ".git", "worktrees", "linked");

			const start = async (name: string) => {
				const started = join(fifos, `${name}-started`);
				const release = join(fifos, `${name}-release`);
				for (const fifo of [started, release]) {
					const made = Bun.spawn(["mkfifo", fifo]);
					if ((await made.exited) !== 0) throw new Error(`mkfifo ${fifo} failed`);
				}
				const env = {
					PATH: process.env.PATH ?? "",
					HOME: process.env.HOME ?? "",
					OMP_STARTED: started,
					OMP_RELEASE: release,
				};
				const run = vcs.runPostCheckoutHook(worktree, head, { setupGitDir, env, detached: true });
				return { started, release, run };
			};

			const a = await start("a");
			const b = await start("b");
			// Opening a FIFO for reading blocks until the hook opens it for writing.
			await Promise.all([readFile(a.started), readFile(b.started)]);
			// A blocking write: Bun.write opens FIFOs non-blocking.
			await writeFile(a.release, "go");
			await a.run;
			expect(await vcs.worktreeSetupHookRunning(setupGitDir)).toBe(true);
			await writeFile(b.release, "go");
			await b.run;
			// Cleanup after git exits is not awaited and exposes no signal, so a bounded real-time poll is the only way to observe it.
			for (let i = 0; i < 200 && (await vcs.worktreeSetupHookRunning(setupGitDir)); i++) await Bun.sleep(25);
			expect(await vcs.worktreeSetupHookRunning(setupGitDir)).toBe(false);
		},
	);
});

describe("vcs.js on an addon older than its identity bindings", () => {
	test("imports, so omp still starts, and names a setup owner without a start time", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-natives-stale-addon-"));
		roots.push(root);
		const native = join(dirname(import.meta.dir), "native");
		// A copy of vcs.js whose loader returns the real bindings minus one the module must not need at load.
		await writeFile(join(root, "vcs.js"), await Bun.file(join(native, "vcs.js")).text());
		await writeFile(
			join(root, "loader-state.js"),
			`import { loadNative as real } from ${JSON.stringify(join(native, "loader-state.js"))};\nexport function loadNative() { return { ...real(), vcsProcessStartTime: undefined }; }\n`,
		);
		await writeFile(
			join(root, "main.js"),
			'import { worktreeSetupOwner } from "./vcs.js";\nconsole.log(worktreeSetupOwner());\n',
		);
		const run = Bun.spawnSync([process.execPath, join(root, "main.js")], { stderr: "pipe", stdout: "pipe" });

		expect(run.stderr.toString()).toBe("");
		expect(run.exitCode).toBe(0);
		expect(run.stdout.toString().trim()).toMatch(/^[^-]+-\d+$/);
	});
});
