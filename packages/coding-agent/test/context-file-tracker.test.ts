import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type AgentMessage,
	ASIDE_MESSAGE_COMMIT,
	type AsideMessage,
	type CommittableAsideMessage,
} from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	CONTEXT_FILE_UPDATE_MESSAGE_TYPE,
	ContextFileTracker,
	NESTED_CONTEXT_MESSAGE_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/context-file-tracker";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { expandAtImports } from "@oh-my-pi/pi-coding-agent/discovery/at-imports";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";

const READ_RESULT = (target: string) => ({ details: { resolvedPath: target } });

const toolResult = { role: "toolResult" } as unknown as AgentMessage;

interface Rig {
	tracker: ContextFileTracker;
	/** The conversation the tracker sees; tests mutate it to model compaction and reverts. */
	messages: AgentMessage[];
	root: string;
	settings: Settings;
}

function rig(root: string, overrides: Record<string, unknown> = {}): Rig {
	const messages: AgentMessage[] = [toolResult];
	const settings = Settings.isolated(overrides);
	const tracker = new ContextFileTracker({
		settings,
		cwd: () => root,
		additionalDirectories: () => [],
		messages: () => messages,
	});
	return { tracker, messages, root, settings };
}

/** Evaluates asides the way the agent loop does, running each message's commit hook once it is "inserted". */
function resolveAsides(asides: AsideMessage[]): CustomMessage[] {
	const out: CustomMessage[] = [];
	for (const aside of asides) {
		const message = typeof aside === "function" ? aside() : aside;
		if (message?.role !== "custom") continue;
		out.push(message);
		(message as CommittableAsideMessage)[ASIDE_MESSAGE_COMMIT]?.();
	}
	return out;
}

/** Runs one read through the tracker and returns what the loop would inject, committing it to the conversation. */
async function read(r: Rig, target: string): Promise<CustomMessage[]> {
	r.tracker.noteReadResult(READ_RESULT(target));
	const injected = resolveAsides(await r.tracker.takeAsides());
	r.messages.push(...injected);
	return injected;
}

function text(message: CustomMessage): string {
	return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

function paths(messages: CustomMessage[]): string[] {
	return messages.map(message => (isRecord(message.details) ? String(message.details.path) : ""));
}

describe("nested context discovery", () => {
	let tmp: TempDir | undefined;
	afterEach(() => {
		tmp?.removeSync();
		tmp = undefined;
	});

	function project(files: Record<string, string>): string {
		tmp = TempDir.createSync("@omp-nested-ctx-");
		const root = fs.realpathSync(tmp.path());
		for (const [rel, content] of Object.entries(files)) {
			const abs = path.join(root, rel);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, content);
		}
		return root;
	}

	it("injects the AGENTS.md files between a read target and the root, nearest first, excluding the root's own", async () => {
		const root = project({
			"AGENTS.md": "ROOT",
			"a/AGENTS.md": "A rules",
			"a/b/AGENTS.md": "B rules",
			"a/b/file.ts": "x",
		});
		const r = rig(root);
		const injected = await read(r, path.join(root, "a/b/file.ts"));
		expect(paths(injected)).toEqual([path.join(root, "a/b/AGENTS.md"), path.join(root, "a/AGENTS.md")]);
		expect(injected.every(message => message.customType === NESTED_CONTEXT_MESSAGE_TYPE)).toBe(true);
		expect(text(injected[0]!)).toContain("B rules");
		expect(text(injected[0]!)).toContain(path.join(root, "a/b/AGENTS.md"));
		expect(text(injected[1]!)).toContain("A rules");
	});

	it("does not inject again while the entry is in context, and does again once it is gone", async () => {
		const root = project({ "a/AGENTS.md": "A rules", "a/one.ts": "1", "a/two.ts": "2" });
		const r = rig(root);
		expect(await read(r, path.join(root, "a/one.ts"))).toHaveLength(1);
		expect(await read(r, path.join(root, "a/two.ts"))).toHaveLength(0);
		expect(await read(r, path.join(root, "a"))).toHaveLength(0);

		r.messages.splice(0, r.messages.length, toolResult); // compaction or revert dropped the entry
		expect(await read(r, path.join(root, "a/two.ts"))).toHaveLength(1);
	});

	it("loads a directory read's own AGENTS.md, and skips the file being read itself", async () => {
		const root = project({ "a/AGENTS.md": "A rules", "a/b/AGENTS.md": "B rules" });
		const r = rig(root);
		expect(paths(await read(r, path.join(root, "a/b")))).toEqual([
			path.join(root, "a/b/AGENTS.md"),
			path.join(root, "a/AGENTS.md"),
		]);
		const r2 = rig(root);
		expect(paths(await read(r2, path.join(root, "a/b/AGENTS.md")))).toEqual([path.join(root, "a/AGENTS.md")]);
	});

	it("still injects when a hook appended a developer message after the read result", async () => {
		const root = project({ "a/AGENTS.md": "A rules", "a/f.ts": "x" });
		const r = rig(root);
		r.messages.push({ role: "developer" } as unknown as AgentMessage);
		expect(paths(await read(r, path.join(root, "a/f.ts")))).toEqual([path.join(root, "a/AGENTS.md")]);
	});

	it("keeps a nested file queued when the loop ends before inserting it", async () => {
		const root = project({ "a/AGENTS.md": "A rules", "a/f.ts": "x" });
		const r = rig(root);
		r.tracker.noteReadResult(READ_RESULT(path.join(root, "a/f.ts")));
		const drained = await r.tracker.takeAsides(); // evaluated but never committed: the loop stopped first
		for (const aside of drained) if (typeof aside === "function") aside();
		expect(paths(resolveAsides(await r.tracker.takeAsides()))).toEqual([path.join(root, "a/AGENTS.md")]);
	});

	it("injects nothing once the prompt is declared to carry no project context", async () => {
		const root = project({ "a/AGENTS.md": "A rules", "a/f.ts": "x" });
		const r = rig(root);
		await r.tracker.setAmbientFiles([], { nestedDiscovery: false });
		expect(await read(r, path.join(root, "a/f.ts"))).toHaveLength(0);
	});

	it("ignores a target that is a link to a file outside the workspace", async () => {
		const root = project({ "sub/AGENTS.md": "SUB rules" });
		const outside = TempDir.createSync("@omp-nested-outside-");
		try {
			const real = path.join(fs.realpathSync(outside.path()), "real.ts");
			fs.writeFileSync(real, "x");
			fs.symlinkSync(real, path.join(root, "sub/link.ts"));
			const r = rig(root);
			expect(await read(r, path.join(root, "sub/link.ts"))).toHaveLength(0);
		} finally {
			outside.removeSync();
		}
	});

	it("falls back to CLAUDE.md per directory and prefers AGENTS.md when both exist", async () => {
		const root = project({
			"a/CLAUDE.md": "claude rules",
			"a/b/AGENTS.md": "agents rules",
			"a/b/CLAUDE.md": "claude shadowed",
			"a/b/f.ts": "x",
		});
		const r = rig(root);
		const injected = await read(r, path.join(root, "a/b/f.ts"));
		expect(paths(injected)).toEqual([path.join(root, "a/b/AGENTS.md"), path.join(root, "a/CLAUDE.md")]);
		expect(text(injected[0]!)).not.toContain("claude shadowed");
	});

	it("ignores targets outside the workspace, empty files, dot directories, and node_modules", async () => {
		const root = project({
			"empty/AGENTS.md": "  \n",
			"empty/f.ts": "x",
			".hidden/AGENTS.md": "hidden",
			".hidden/f.ts": "x",
			"node_modules/pkg/AGENTS.md": "third party",
			"node_modules/pkg/f.ts": "x",
		});
		const outside = project({ "AGENTS.md": "elsewhere", "f.ts": "x" });
		const r = rig(root);
		for (const target of ["empty/f.ts", ".hidden/f.ts", "node_modules/pkg/f.ts"]) {
			expect(await read(r, path.join(root, target))).toEqual([]);
		}
		expect(await read(r, path.join(outside, "f.ts"))).toEqual([]);
	});

	it("excludes a dot directory anywhere on the path, not only the target's own directory", async () => {
		const root = project({ ".hidden/child/AGENTS.md": "hidden child", ".hidden/child/f.ts": "x" });
		expect(await read(rig(root), path.join(root, ".hidden/child/f.ts"))).toEqual([]);
	});

	it("loads instructions from a directory whose name merely begins with two dots", async () => {
		const root = project({ "..draft/AGENTS.md": "draft rules", "..draft/f.ts": "x" });
		expect(paths(await read(rig(root), path.join(root, "..draft/f.ts")))).toEqual([
			path.join(root, "..draft/AGENTS.md"),
		]);
	});

	it("does not follow a symlinked directory into node_modules or out of the workspace", async () => {
		const root = project({ "node_modules/pkg/AGENTS.md": "third party", "node_modules/pkg/f.ts": "x" });
		const outside = project({ "AGENTS.md": "elsewhere", "f.ts": "x" });
		fs.symlinkSync(path.join(root, "node_modules/pkg"), path.join(root, "alias"));
		fs.symlinkSync(outside, path.join(root, "away"));
		const r = rig(root);
		expect(await read(r, path.join(root, "alias/f.ts"))).toEqual([]);
		expect(await read(r, path.join(root, "away/f.ts"))).toEqual([]);
	});

	it("does not read an AGENTS.md symlinked from outside the workspace", async () => {
		const root = project({ "a/f.ts": "x" });
		const outside = project({ "AGENTS.md": "elsewhere" });
		fs.symlinkSync(path.join(outside, "AGENTS.md"), path.join(root, "a/AGENTS.md"));
		expect(await read(rig(root), path.join(root, "a/f.ts"))).toEqual([]);
	});

	it("still loads a symlinked directory that resolves to an ordinary place inside the workspace", async () => {
		const root = project({ "real/AGENTS.md": "real rules", "real/f.ts": "x" });
		fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));
		expect(await read(rig(root), path.join(root, "link/f.ts"))).toHaveLength(1);
	});

	it("honors disabledExtensions for project AGENTS.md", async () => {
		const root = project({ "a/AGENTS.md": "A rules", "a/f.ts": "x" });
		const r = rig(root, { disabledExtensions: ["context-file:project:AGENTS.md"] });
		expect(await read(r, path.join(root, "a/f.ts"))).toEqual([]);
	});

	it("is off when contextFiles.nestedDiscovery is false", async () => {
		const root = project({ "a/AGENTS.md": "A rules", "a/f.ts": "x" });
		const r = rig(root, { "contextFiles.nestedDiscovery": false });
		expect(await read(r, path.join(root, "a/f.ts"))).toEqual([]);
	});

	it("keeps one read's batch within a single read-sized budget and loads the rest on a later read", async () => {
		const big = "x".repeat(40_000);
		const root = project({ "a/AGENTS.md": big, "a/b/AGENTS.md": big, "a/b/f.ts": "x" });
		const r = rig(root);

		expect(paths(await read(r, path.join(root, "a/b/f.ts")))).toEqual([path.join(root, "a/b/AGENTS.md")]);
		r.messages.push(toolResult); // the next step's read result
		expect(paths(await read(r, path.join(root, "a/b/f.ts")))).toEqual([path.join(root, "a/AGENTS.md")]);
	});

	it("bounds injected content to the read size limit", async () => {
		const root = project({ "a/AGENTS.md": `${"rule line\n".repeat(20_000)}TAIL_MARKER`, "a/f.ts": "x" });
		const r = rig(root);
		const [message] = await read(r, path.join(root, "a/f.ts"));
		expect(text(message!)).not.toContain("TAIL_MARKER");
		expect(text(message!)).toContain("Truncated");
		expect(Buffer.byteLength(text(message!))).toBeLessThan(60 * 1024);
	});

	it("holds nested files back at the stop boundary instead of starting a turn for them", async () => {
		const root = project({ "a/AGENTS.md": "A rules", "a/f.ts": "x" });
		const r = rig(root);
		r.messages.splice(0, r.messages.length, { role: "assistant" } as unknown as AgentMessage);
		r.tracker.noteReadResult(READ_RESULT(path.join(root, "a/f.ts")));
		expect(await r.tracker.takeAsides()).toEqual([]);
		r.messages.push(toolResult);
		expect(await r.tracker.takeAsides()).toEqual([]);
	});
});

describe("live updates of loaded context files", () => {
	let tmp: TempDir | undefined;
	afterEach(() => {
		tmp?.removeSync();
		tmp = undefined;
	});

	async function setup(initial: Record<string, string>, overrides: Record<string, unknown> = {}) {
		tmp = TempDir.createSync("@omp-ambient-ctx-");
		const root = fs.realpathSync(tmp.path());
		const files: Array<{ path: string; content: string }> = [];
		for (const [rel, content] of Object.entries(initial)) {
			const abs = path.join(root, rel);
			fs.writeFileSync(abs, content);
			files.push({ path: abs, content });
		}
		const r = rig(root, overrides);
		await r.tracker.setAmbientFiles(files);
		return { r, root, files };
	}

	/** Every rewrite gets a distinct mtime, so same-size rewrites in one tick stay distinguishable. */
	let rewrites = 0;
	function rewrite(file: string, content: string): void {
		fs.writeFileSync(file, content);
		const later = new Date(Date.now() + 5_000 + ++rewrites * 1_000);
		fs.utimesSync(file, later, later);
	}

	async function update(r: Rig) {
		const message = await r.tracker.takePromptUpdate();
		if (message) r.messages.push(message);
		return message;
	}

	it("announces the deletion of a discovered file that vanished before registration finished", async () => {
		tmp = TempDir.createSync("@omp-ambient-ctx-");
		const root = fs.realpathSync(tmp.path());
		const gone = path.join(root, "AGENTS.md");
		const r = rig(root);
		await r.tracker.setAmbientFiles([{ path: gone, content: "rules the prompt was built with" }], {
			diskBacked: true,
		});
		const message = await update(r);
		expect(text(message!)).toContain(gone);
		expect(message?.details).toEqual({ files: [{ path: gone, hash: null }] });
	});

	it("tracks a vanished discovered file but not an SDK-supplied path with no file in the same list", async () => {
		tmp = TempDir.createSync("@omp-ambient-ctx-");
		const root = fs.realpathSync(tmp.path());
		const virtual = path.join(root, "virtual/AGENTS.md");
		const gone = path.join(root, "extra/AGENTS.md");
		const r = rig(root);
		await r.tracker.setAmbientFiles(
			[
				{ path: virtual, content: "sdk" },
				{ path: gone, content: "discovered" },
			],
			{ diskBacked: true, virtualPaths: new Set([virtual]) },
		);
		const message = await update(r);
		expect(message?.details).toEqual({ files: [{ path: gone, hash: null }] });
	});

	it("defers removal notices that do not fit one update's budget", async () => {
		tmp = TempDir.createSync("@omp-ambient-ctx-");
		const root = fs.realpathSync(tmp.path());
		const files = Array.from({ length: 600 }, (_, index) => ({
			path: path.join(root, `${"d".repeat(150)}${index}`, "AGENTS.md"),
			content: "rules",
		}));
		const r = rig(root);
		await r.tracker.setAmbientFiles(files, { diskBacked: true });
		const message = await update(r);
		const listed = message?.details?.files.length ?? 0;
		expect(listed).toBeGreaterThan(0);
		expect(listed).toBeLessThan(files.length);
	});

	it("says nothing while loaded files are unchanged, even when only the mtime moves", async () => {
		const { r, files } = await setup({ "AGENTS.md": "same" });
		expect(await update(r)).toBeUndefined();
		rewrite(files[0]!.path, "same");
		expect(await update(r)).toBeUndefined();
	});

	it("announces a same-size edit that preserves the file's mtime", async () => {
		const { r, files } = await setup({ "AGENTS.md": "rules A" });
		expect(await update(r)).toBeUndefined(); // records the file's signature
		const before = fs.statSync(files[0]!.path);
		fs.writeFileSync(files[0]!.path, "rules B");
		fs.utimesSync(files[0]!.path, before.atime, before.mtime);
		expect(text((await update(r))!)).toContain("rules B");
	});

	it("sends the new content once after an edit and nothing further", async () => {
		const { r, files } = await setup({ "AGENTS.md": "old rules" });
		rewrite(files[0]!.path, "new rules");
		const message = await update(r);
		expect(message?.customType).toBe(CONTEXT_FILE_UPDATE_MESSAGE_TYPE);
		expect(text(message!)).toContain("new rules");
		expect(text(message!)).toContain(files[0]!.path);
		expect(await update(r)).toBeUndefined();
	});

	it("sends the update again once compaction dropped the earlier one", async () => {
		const { r, files } = await setup({ "AGENTS.md": "old rules" });
		rewrite(files[0]!.path, "new rules");
		await update(r);
		r.messages.splice(0, r.messages.length, toolResult);
		expect(text((await update(r))!)).toContain("new rules");
	});

	it("tells the model when an edit puts the original content back", async () => {
		const { r, files } = await setup({ "AGENTS.md": "old rules" });
		rewrite(files[0]!.path, "new rules");
		await update(r);
		rewrite(files[0]!.path, "old rules");
		expect(text((await update(r))!)).toContain("old rules");
	});

	it("reports a deleted file, and that no instructions remain when it was the only one", async () => {
		const { r, files } = await setup({ "AGENTS.md": "rules" });
		fs.rmSync(files[0]!.path);
		const message = await update(r);
		expect(text(message!)).toContain("was removed");
		expect(text(message!)).toContain("No context files remain");
		expect(await update(r)).toBeUndefined();
	});

	it("keeps the rest in force when only one of several files is deleted", async () => {
		const { r, files } = await setup({ "AGENTS.md": "rules", "CLAUDE.md": "claude rules" });
		fs.rmSync(files[0]!.path);
		const message = await update(r);
		expect(text(message!)).toContain("was removed");
		expect(text(message!)).not.toContain("No context files remain");
	});

	it("restores a deleted file that comes back", async () => {
		const { r, files } = await setup({ "AGENTS.md": "rules" });
		fs.rmSync(files[0]!.path);
		await update(r);
		fs.writeFileSync(files[0]!.path, "rules again");
		expect(text((await update(r))!)).toContain("rules again");
	});

	it("treats a transient stat failure as no news rather than a deletion", async () => {
		if (process.getuid?.() === 0) return; // root ignores directory permissions
		const { r, root, files } = await setup({ "AGENTS.md": "rules" });
		fs.chmodSync(root, 0o000);
		try {
			expect(await update(r)).toBeUndefined();
		} finally {
			fs.chmodSync(root, 0o700);
		}
		rewrite(files[0]!.path, "edited after the blip");
		expect(text((await update(r))!)).toContain("edited after the blip");
	});

	it("retries an unreadable edit on the next check instead of giving up on it", async () => {
		if (process.getuid?.() === 0) return;
		const { r, files } = await setup({ "AGENTS.md": "rules" });
		rewrite(files[0]!.path, "edited");
		fs.chmodSync(files[0]!.path, 0o000);
		try {
			expect(await update(r)).toBeUndefined();
		} finally {
			fs.chmodSync(files[0]!.path, 0o600);
		}
		expect(text((await update(r))!)).toContain("edited");
	});

	it("ignores update messages from before the prompt was last rebuilt", async () => {
		const { r, files } = await setup({ "AGENTS.md": "old rules" });
		rewrite(files[0]!.path, "new rules");
		const delivered = await update(r);
		// Delivered before the rebuild; /reload-plugins style rebuild then bakes the new content into the prompt.
		delivered!.timestamp -= 1_000;
		await r.tracker.setAmbientFiles([{ path: files[0]!.path, content: "new rules" }]);
		expect(await update(r)).toBeUndefined();
	});

	it("does not watch files with no backing file on disk", async () => {
		const { r } = await setup({});
		await r.tracker.setAmbientFiles([{ path: path.join(r.root, "virtual/AGENTS.md"), content: "sdk-supplied" }]);
		expect(await update(r)).toBeUndefined();
	});

	it("does not claim no context remains while SDK-supplied files are still in force", async () => {
		const { r, files } = await setup({ "AGENTS.md": "disk rules" });
		await r.tracker.setAmbientFiles([
			files[0]!,
			{ path: path.join(r.root, "virtual/AGENTS.md"), content: "sdk-supplied" },
		]);
		fs.rmSync(files[0]!.path);
		const message = await update(r);
		expect(text(message!)).toContain("was removed");
		expect(text(message!)).not.toContain("No context files remain");
	});

	it("does not claim no context remains while nested instructions are still in the conversation", async () => {
		const { r, files } = await setup({ "AGENTS.md": "root rules" });
		fs.mkdirSync(path.join(r.root, "sub"));
		fs.writeFileSync(path.join(r.root, "sub/AGENTS.md"), "nested rules");
		fs.writeFileSync(path.join(r.root, "sub/f.ts"), "x");
		await read(r, path.join(r.root, "sub/f.ts"));
		fs.rmSync(files[0]!.path);
		const message = await update(r);
		expect(text(message!)).toContain("was removed");
		expect(text(message!)).not.toContain("No context files remain");
	});

	it("shares one read-sized budget between files changed together and delivers the rest next", async () => {
		const big = "y".repeat(40_000);
		const { r, files } = await setup({ "AGENTS.md": "a", "CLAUDE.md": "b" });
		rewrite(files[0]!.path, `a${big}`);
		rewrite(files[1]!.path, `b${big}`);
		const first = await update(r);
		expect(first && (first.details as { files: unknown[] }).files).toHaveLength(1);
		const second = await update(r);
		expect(second && (second.details as { files: unknown[] }).files).toHaveLength(1);
		expect(await update(r)).toBeUndefined();
	});

	it("announces an edit made between prompt discovery and registration", async () => {
		const { r, root } = await setup({});
		const file = path.join(root, "AGENTS.md");
		fs.writeFileSync(file, "edited after discovery");
		await r.tracker.setAmbientFiles([{ path: file, content: "content the prompt was built with" }]);
		const message = await update(r);
		expect(text(message!)).toContain("edited after discovery");
	});

	it("loads a nested file through the current content of its @-imports, not the startup cache", async () => {
		const { r, root } = await setup({});
		fs.mkdirSync(path.join(root, "a"));
		fs.writeFileSync(path.join(root, "shared.md"), "shared v1");
		fs.writeFileSync(path.join(root, "a/AGENTS.md"), "see @../shared.md");
		fs.writeFileSync(path.join(root, "a/f.ts"), "x");
		await expandAtImports("see @shared.md", path.join(root, "AGENTS.md")); // startup fills the cache
		fs.writeFileSync(path.join(root, "shared.md"), "shared v2");
		expect(text((await read(r, path.join(root, "a/f.ts")))[0]!)).toContain("shared v2");
	});

	it("notices a changed @-import when its importer is touched, despite the startup read cache", async () => {
		const { r, root } = await setup({});
		const rules = path.join(root, "rules.md");
		const agents = path.join(root, "AGENTS.md");
		fs.writeFileSync(rules, "imported v1");
		fs.writeFileSync(agents, "see @rules.md");
		const loaded = await expandAtImports("see @rules.md", agents); // fills the discovery cache like startup does
		await r.tracker.setAmbientFiles([{ path: agents, content: loaded }]);
		fs.writeFileSync(rules, "imported v2");
		rewrite(agents, "see @rules.md");
		const message = await update(r);
		expect(text(message!)).toContain("imported v2");
	});

	it("is off when contextFiles.liveUpdates is false", async () => {
		const { r, files } = await setup({ "AGENTS.md": "old" }, { "contextFiles.liveUpdates": false });
		rewrite(files[0]!.path, "new");
		expect(await update(r)).toBeUndefined();
	});

	it("also delivers the update at a mid-work step boundary", async () => {
		const { r, files } = await setup({ "AGENTS.md": "old" });
		rewrite(files[0]!.path, "new");
		const injected = resolveAsides(await r.tracker.takeAsides());
		expect(injected.map(message => message.customType)).toEqual([CONTEXT_FILE_UPDATE_MESSAGE_TYPE]);
	});
});
