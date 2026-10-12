import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage, AsideMessage } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	CONTEXT_FILE_UPDATE_MESSAGE_TYPE,
	ContextFileTracker,
	NESTED_CONTEXT_MESSAGE_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/context-file-tracker";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
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

function resolveAsides(asides: AsideMessage[]): CustomMessage[] {
	const out: CustomMessage[] = [];
	for (const aside of asides) {
		const message = typeof aside === "function" ? aside() : aside;
		if (message?.role === "custom") out.push(message);
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

	function setup(initial: Record<string, string>, overrides: Record<string, unknown> = {}) {
		tmp = TempDir.createSync("@omp-ambient-ctx-");
		const root = fs.realpathSync(tmp.path());
		const files: Array<{ path: string; content: string }> = [];
		for (const [rel, content] of Object.entries(initial)) {
			const abs = path.join(root, rel);
			fs.writeFileSync(abs, content);
			files.push({ path: abs, content });
		}
		const r = rig(root, overrides);
		r.tracker.setAmbientFiles(files);
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

	it("says nothing while loaded files are unchanged, even when only the mtime moves", async () => {
		const { r, files } = setup({ "AGENTS.md": "same" });
		expect(await update(r)).toBeUndefined();
		rewrite(files[0]!.path, "same");
		expect(await update(r)).toBeUndefined();
	});

	it("sends the new content once after an edit and nothing further", async () => {
		const { r, files } = setup({ "AGENTS.md": "old rules" });
		rewrite(files[0]!.path, "new rules");
		const message = await update(r);
		expect(message?.customType).toBe(CONTEXT_FILE_UPDATE_MESSAGE_TYPE);
		expect(text(message!)).toContain("new rules");
		expect(text(message!)).toContain(files[0]!.path);
		expect(await update(r)).toBeUndefined();
	});

	it("sends the update again once compaction dropped the earlier one", async () => {
		const { r, files } = setup({ "AGENTS.md": "old rules" });
		rewrite(files[0]!.path, "new rules");
		await update(r);
		r.messages.splice(0, r.messages.length, toolResult);
		expect(text((await update(r))!)).toContain("new rules");
	});

	it("tells the model when an edit puts the original content back", async () => {
		const { r, files } = setup({ "AGENTS.md": "old rules" });
		rewrite(files[0]!.path, "new rules");
		await update(r);
		rewrite(files[0]!.path, "old rules");
		expect(text((await update(r))!)).toContain("old rules");
	});

	it("reports a deleted file, and that no instructions remain when it was the only one", async () => {
		const { r, files } = setup({ "AGENTS.md": "rules" });
		fs.rmSync(files[0]!.path);
		const message = await update(r);
		expect(text(message!)).toContain("was removed");
		expect(text(message!)).toContain("No context files remain");
		expect(await update(r)).toBeUndefined();
	});

	it("keeps the rest in force when only one of several files is deleted", async () => {
		const { r, files } = setup({ "AGENTS.md": "rules", "CLAUDE.md": "claude rules" });
		fs.rmSync(files[0]!.path);
		const message = await update(r);
		expect(text(message!)).toContain("was removed");
		expect(text(message!)).not.toContain("No context files remain");
	});

	it("restores a deleted file that comes back", async () => {
		const { r, files } = setup({ "AGENTS.md": "rules" });
		fs.rmSync(files[0]!.path);
		await update(r);
		fs.writeFileSync(files[0]!.path, "rules again");
		expect(text((await update(r))!)).toContain("rules again");
	});

	it("treats a transient stat failure as no news rather than a deletion", async () => {
		if (process.getuid?.() === 0) return; // root ignores directory permissions
		const { r, root, files } = setup({ "AGENTS.md": "rules" });
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
		const { r, files } = setup({ "AGENTS.md": "rules" });
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
		const { r, files } = setup({ "AGENTS.md": "old rules" });
		rewrite(files[0]!.path, "new rules");
		const delivered = await update(r);
		// Delivered before the rebuild; /reload-plugins style rebuild then bakes the new content into the prompt.
		delivered!.timestamp -= 1_000;
		r.tracker.setAmbientFiles([{ path: files[0]!.path, content: "new rules" }]);
		expect(await update(r)).toBeUndefined();
	});

	it("does not watch files with no backing file on disk", async () => {
		const { r } = setup({});
		r.tracker.setAmbientFiles([{ path: path.join(r.root, "virtual/AGENTS.md"), content: "sdk-supplied" }]);
		expect(await update(r)).toBeUndefined();
	});

	it("is off when contextFiles.liveUpdates is false", async () => {
		const { r, files } = setup({ "AGENTS.md": "old" }, { "contextFiles.liveUpdates": false });
		rewrite(files[0]!.path, "new");
		expect(await update(r)).toBeUndefined();
	});

	it("also delivers the update at a mid-work step boundary", async () => {
		const { r, files } = setup({ "AGENTS.md": "old" });
		rewrite(files[0]!.path, "new");
		const injected = resolveAsides(await r.tracker.takeAsides());
		expect(injected.map(message => message.customType)).toEqual([CONTEXT_FILE_UPDATE_MESSAGE_TYPE]);
	});
});
