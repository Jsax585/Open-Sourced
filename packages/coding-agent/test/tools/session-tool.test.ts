import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type SessionControl, SessionTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

interface Fixture {
	root: string;
	repo: string;
	worktreeBase: string;
	moves: string[];
	titles: string[];
	control: SessionControl;
	tool: SessionTool;
	/** Rebuild the tool as if the session now works in `cwd`. */
	toolIn(cwd: string, extra?: Partial<ToolSession>): SessionTool;
}

let fixture: Fixture;
let savedWorktreeDir: string | undefined;

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	return stdout.trim();
}

async function createFixture(): Promise<Fixture> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-tool-")));
	const repo = path.join(root, "repo");
	// The base is reached through a symlink, as /tmp is on macOS: git registers the unresolved path.
	const realBase = path.join(root, "wt-real");
	await fs.mkdir(realBase);
	await fs.symlink(realBase, path.join(root, "wt"));
	const worktreeBase = realBase;
	await fs.mkdir(repo, { recursive: true });
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@example.com");
	await git(repo, "config", "user.name", "t");
	await Bun.write(path.join(repo, "tracked.txt"), "committed\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "init");
	process.env.OMP_WORKTREE_DIR = path.join(root, "wt");

	const moves: string[] = [];
	const titles: string[] = [];
	let pending: string | undefined;
	const control: SessionControl = {
		rename: async title => {
			titles.push(title);
			return title.trim().length > 0;
		},
		canMove: () => true,
		requestMove: directory => {
			moves.push(directory);
			pending = directory;
		},
		pendingMove: () => pending,
	};
	const toolIn = (cwd: string, extra: Partial<ToolSession> = {}) =>
		new SessionTool({
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			sessionControl: control,
			...extra,
		});
	return { root, repo, worktreeBase, moves, titles, control, tool: toolIn(repo), toolIn };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => block.text ?? "").join("\n");
}

beforeEach(async () => {
	savedWorktreeDir = process.env.OMP_WORKTREE_DIR;
	fixture = await createFixture();
});

afterEach(async () => {
	if (savedWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
	else process.env.OMP_WORKTREE_DIR = savedWorktreeDir;
	await fs.rm(fixture.root, { recursive: true, force: true });
});

describe("session tool: approval tiers", () => {
	it("classes list as read, rename as write, and every other op as exec", () => {
		const tier = (op: unknown) => (fixture.tool.approval as (args: unknown) => unknown)({ op });
		expect(tier("worktree_list")).toBe("read");
		expect(tier("rename")).toBe("write");
		for (const op of ["move", "worktree_create", "worktree_remove"]) expect(tier(op)).toBe("exec");
		// An unreadable op must not fall into a read tier.
		expect(tier(undefined)).toBe("exec");
	});

	it("is only created for sessions that carry session control", () => {
		const bare: ToolSession = {
			cwd: fixture.repo,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		expect(SessionTool.createIf(bare)).toBeNull();
		expect(SessionTool.createIf({ ...bare, sessionControl: fixture.control })).toBeInstanceOf(SessionTool);
	});
});

describe("session tool: rename and move", () => {
	it("renames with the trimmed title and fails when the session refuses it", async () => {
		await fixture.tool.execute("1", { op: "rename", title: "  login work  " });
		expect(fixture.titles).toEqual(["login work"]);
		await expect(fixture.tool.execute("2", { op: "rename", title: "   " })).rejects.toThrow("requires `title`");
		await expect(
			fixture
				.toolIn(fixture.repo, {
					sessionControl: { ...fixture.control, rename: async () => false },
				})
				.execute("3", { op: "rename", title: "x" }),
		).rejects.toThrow("not changed");
	});

	it("queues a move to the real path of a relative directory and says when it takes effect", async () => {
		await fs.mkdir(path.join(fixture.repo, "pkg"));
		await fs.symlink(path.join(fixture.repo, "pkg"), path.join(fixture.root, "link"));
		const result = await fixture.tool.execute("1", { op: "move", path: "pkg" });
		expect(fixture.moves).toEqual([path.join(fixture.repo, "pkg")]);
		expect(textOf(result)).toContain("after this step finishes");

		await fixture.tool.execute("2", { op: "move", path: path.join(fixture.root, "link") });
		expect(fixture.moves.at(-1)).toBe(path.join(fixture.repo, "pkg"));
	});

	it("refuses missing paths, files, the current directory (even via symlink), and queues nothing", async () => {
		await fs.symlink(fixture.repo, path.join(fixture.root, "self"));
		await expect(fixture.tool.execute("1", { op: "move", path: "nope" })).rejects.toThrow("does not exist");
		await expect(fixture.tool.execute("2", { op: "move", path: "tracked.txt" })).rejects.toThrow("Not a directory");
		await expect(fixture.tool.execute("3", { op: "move", path: "." })).rejects.toThrow("already runs");
		await expect(fixture.tool.execute("4", { op: "move", path: path.join(fixture.root, "self") })).rejects.toThrow(
			"already runs",
		);
		expect(fixture.moves).toEqual([]);
	});

	it("surfaces a host that cannot relocate instead of reporting a queued move", async () => {
		await fs.mkdir(path.join(fixture.repo, "pkg"));
		const tool = fixture.toolIn(fixture.repo, {
			sessionControl: {
				...fixture.control,
				requestMove: () => {
					throw new Error("This host cannot move the session workspace.");
				},
			},
		});
		await expect(tool.execute("1", { op: "move", path: "pkg" })).rejects.toThrow("cannot move");
	});

	it("refuses move and worktree_create with move before creating anything when the host cannot relocate", async () => {
		await fs.mkdir(path.join(fixture.repo, "pkg"));
		const tool = fixture.toolIn(fixture.repo, { sessionControl: { ...fixture.control, canMove: () => false } });
		await expect(tool.execute("1", { op: "move", path: "pkg" })).rejects.toThrow("cannot move");
		await expect(tool.execute("2", { op: "worktree_create", branch: "stuck", move: true })).rejects.toThrow(
			"cannot move",
		);
		expect(await git(fixture.repo, "branch", "--list", "stuck")).toBe("");
		expect(fixture.moves).toEqual([]);
	});
});

describe("session tool: worktrees", () => {
	it("creates a clean worktree on a new branch under the worktree base, leaving the source untouched", async () => {
		await Bun.write(path.join(fixture.repo, "tracked.txt"), "edited\n");
		await Bun.write(path.join(fixture.repo, "untracked.txt"), "new\n");

		const result = await fixture.tool.execute("1", { op: "worktree_create", branch: "login" });

		const details = result.details!;
		expect(details.branch).toBe("login");
		expect(details.moveQueued).toBe(false);
		expect(details.path!.startsWith(fixture.worktreeBase)).toBe(true);
		expect(await Bun.file(path.join(details.path!, "tracked.txt")).text()).toBe("committed\n");
		expect(await Bun.file(path.join(details.path!, "untracked.txt")).exists()).toBe(false);
		expect(await git(details.path!, "symbolic-ref", "HEAD")).toBe("refs/heads/login");
		expect(await Bun.file(path.join(fixture.repo, "tracked.txt")).text()).toBe("edited\n");
		expect(fixture.moves).toEqual([]);
	});

	it("carries uncommitted changes only when asked and queues the move with move: true", async () => {
		await Bun.write(path.join(fixture.repo, "tracked.txt"), "edited\n");
		await Bun.write(path.join(fixture.repo, "untracked.txt"), "new\n");

		const result = await fixture.tool.execute("1", {
			op: "worktree_create",
			branch: "carry",
			carryChanges: true,
			move: true,
		});

		const created = result.details!.path!;
		expect(await Bun.file(path.join(created, "tracked.txt")).text()).toBe("edited\n");
		expect(await Bun.file(path.join(created, "untracked.txt")).text()).toBe("new\n");
		expect(fixture.moves).toEqual([created]);
		expect(textOf(result)).toContain("after this step finishes");
	});

	it("refuses an existing branch and an invalid branch name, and outside a git repository", async () => {
		await expect(fixture.tool.execute("1", { op: "worktree_create", branch: "main" })).rejects.toThrow(
			"already exists",
		);
		await expect(fixture.tool.execute("2", { op: "worktree_create", branch: "bad name" })).rejects.toThrow(
			"Invalid branch name",
		);
		await expect(fixture.tool.execute("3", { op: "worktree_create" })).rejects.toThrow("requires `branch`");
		const plain = path.join(fixture.root, "plain");
		await fs.mkdir(plain);
		await expect(fixture.toolIn(plain).execute("4", { op: "worktree_create", branch: "x" })).rejects.toThrow(
			"Not inside a git repository",
		);
		await expect(fixture.toolIn(plain).execute("5", { op: "worktree_list" })).rejects.toThrow(
			"Not inside a git repository",
		);
	});

	it("lists every worktree with branch, dirty state, and which one the session works in", async () => {
		const created = (await fixture.tool.execute("1", { op: "worktree_create", branch: "login" })).details!.path!;
		await Bun.write(path.join(created, "scratch.txt"), "x\n");

		const fromMain = textOf(await fixture.tool.execute("2", { op: "worktree_list" }));
		const mainLine = fromMain.split("\n").find(line => line.startsWith(fixture.repo))!;
		const loginLine = fromMain.split("\n").find(line => line.startsWith(created))!;
		expect(mainLine).toContain("[main]");
		expect(mainLine).toContain("(this session)");
		expect(loginLine).toContain("[login, uncommitted changes]");
		expect(loginLine).not.toContain("(this session)");

		// Listed from inside a linked worktree, the marker follows the session.
		const fromLogin = textOf(await fixture.toolIn(created).execute("3", { op: "worktree_list" }));
		expect(fromLogin.split("\n").find(line => line.startsWith(created))).toContain("(this session)");
		expect(fromLogin.split("\n").find(line => line.startsWith(fixture.repo))).not.toContain("(this session)");
	});

	it("removes a clean worktree, keeps its branch, and removes a dirty one only with force", async () => {
		const clean = (await fixture.tool.execute("1", { op: "worktree_create", branch: "clean" })).details!.path!;
		const result = await fixture.tool.execute("2", { op: "worktree_remove", path: clean });
		expect(textOf(result)).toContain("branch was kept");
		expect(await Bun.file(path.join(clean, "tracked.txt")).exists()).toBe(false);
		expect(await git(fixture.repo, "branch", "--list", "clean")).toContain("clean");
		// Deregistered from git, not just deleted from disk.
		expect(await git(fixture.repo, "worktree", "list", "--porcelain")).not.toContain("refs/heads/clean");

		const dirty = (await fixture.tool.execute("3", { op: "worktree_create", branch: "dirty" })).details!.path!;
		await Bun.write(path.join(dirty, "tracked.txt"), "unsaved\n");
		await expect(fixture.tool.execute("4", { op: "worktree_remove", path: dirty })).rejects.toThrow(
			"uncommitted changes",
		);
		expect(await Bun.file(path.join(dirty, "tracked.txt")).text()).toBe("unsaved\n");
		await fixture.tool.execute("5", { op: "worktree_remove", path: dirty, force: true });
		expect(await Bun.file(path.join(dirty, "tracked.txt")).exists()).toBe(false);
	});

	it("deregisters a worktree that was created through another spelling of the repository path", async () => {
		// The session moves between /tmp/x and /private/tmp/x style spellings of one checkout.
		const alias = path.join(fixture.root, "repo-alias");
		await fs.symlink(fixture.repo, alias);
		const created = (await fixture.toolIn(alias).execute("1", { op: "worktree_create", branch: "alias" })).details!
			.path!;

		await fixture.tool.execute("2", { op: "worktree_remove", path: created });

		expect(await fs.stat(created).catch(() => undefined)).toBeUndefined();
		expect(await git(fixture.repo, "worktree", "list", "--porcelain")).not.toContain("refs/heads/alias");
		expect(await git(fixture.repo, "branch", "--list", "alias")).toContain("alias");
	});

	it("keeps an unrelated locked worktree whose checkout is temporarily absent", async () => {
		const alias = path.join(fixture.root, "repo-alias");
		await fs.symlink(fixture.repo, alias);
		const portable = (await fixture.tool.execute("1", { op: "worktree_create", branch: "portable" })).details!.path!;
		await git(fixture.repo, "worktree", "lock", portable);
		await fs.rename(portable, `${portable}-offline`);
		const created = (await fixture.toolIn(alias).execute("2", { op: "worktree_create", branch: "other" })).details!
			.path!;

		await fixture.tool.execute("3", { op: "worktree_remove", path: created });

		const listing = await git(fixture.repo, "worktree", "list", "--porcelain");
		expect(listing).toContain("branch refs/heads/portable\nlocked");
		expect(listing).not.toContain("refs/heads/other");
	});

	it("refuses to remove a locked worktree unless forced", async () => {
		const created = (await fixture.tool.execute("1", { op: "worktree_create", branch: "locked" })).details!.path!;
		await git(fixture.repo, "worktree", "lock", created);
		await expect(fixture.tool.execute("2", { op: "worktree_remove", path: created })).rejects.toThrow("locked");
		expect(await Bun.file(path.join(created, "tracked.txt")).exists()).toBe(true);

		await fixture.tool.execute("3", { op: "worktree_remove", path: created, force: true });
		expect(await fs.stat(created).catch(() => undefined)).toBeUndefined();
	});

	it("lets only the listing overlap with other session calls", () => {
		const concurrency = fixture.tool.concurrency as (args: { op: string }) => string;
		expect(concurrency({ op: "worktree_list" })).toBe("shared");
		for (const op of ["rename", "move", "worktree_create", "worktree_remove"]) {
			expect(concurrency({ op })).toBe("exclusive");
		}
	});

	it("treats an untracked file as uncommitted work", async () => {
		const created = (await fixture.tool.execute("1", { op: "worktree_create", branch: "wip" })).details!.path!;
		await Bun.write(path.join(created, "notes.txt"), "keep me\n");
		await expect(fixture.tool.execute("2", { op: "worktree_remove", path: created })).rejects.toThrow(
			"uncommitted changes",
		);
	});

	it("refuses to remove the session's own directory, a parent of it, the pending move target, or the primary checkout", async () => {
		const created = (await fixture.tool.execute("1", { op: "worktree_create", branch: "busy" })).details!.path!;
		const nested = path.join(created, "src");
		await fs.mkdir(nested);

		// Session works in the worktree, in a subdirectory of it, or in an added workspace directory.
		await expect(
			fixture.toolIn(created).execute("2", { op: "worktree_remove", path: created, force: true }),
		).rejects.toThrow("this session works in");
		await expect(
			fixture.toolIn(nested).execute("3", { op: "worktree_remove", path: created, force: true }),
		).rejects.toThrow("this session works in");
		await expect(
			fixture
				.toolIn(fixture.repo, { additionalDirectories: [nested] })
				.execute("4", { op: "worktree_remove", path: created, force: true }),
		).rejects.toThrow("this session works in");

		// A directory merely named like a parent reference is still inside the worktree.
		const dotted = path.join(created, "..notes");
		await fs.mkdir(dotted);
		await expect(
			fixture.toolIn(dotted).execute("2b", { op: "worktree_remove", path: created, force: true }),
		).rejects.toThrow("this session works in");

		// A move already queued into it counts as in use.
		fixture.control.requestMove(created);
		await expect(fixture.tool.execute("5", { op: "worktree_remove", path: created, force: true })).rejects.toThrow(
			"this session works in",
		);
		await expect(
			fixture.toolIn(created).execute("6", { op: "worktree_remove", path: fixture.repo, force: true }),
		).rejects.toThrow("primary checkout");
		expect(await Bun.file(path.join(created, "tracked.txt")).exists()).toBe(true);
	});

	it("refuses paths that are not registered worktrees of this repository", async () => {
		const stray = path.join(fixture.root, "stray");
		await fs.mkdir(stray);
		await expect(fixture.tool.execute("1", { op: "worktree_remove", path: stray, force: true })).rejects.toThrow(
			"not a registered worktree",
		);
		await expect(fixture.tool.execute("2", { op: "worktree_remove", path: "pkg-missing" })).rejects.toThrow(
			"not a registered worktree",
		);
		expect(await fs.stat(stray)).toBeDefined();
	});
});
