/**
 * `tools.approvalMode: always-ask-cached` — resolver semantics, the on-disk
 * grant store, and the wrapper's approve-then-remember cycle.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, ToolTier } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type ApprovalGrantStore,
	APPROVAL_ALWAYS_FILE_LABEL,
	APPROVAL_APPROVE_FILE_LABEL,
	APPROVAL_APPROVE_LABEL,
	approvalFolderCandidate,
	recordApprovalCacheTargets,
	resolveApproval,
	resolveApprovalFromContext,
} from "@oh-my-pi/pi-coding-agent/tools/approval";
import {
	ApprovalCache,
	ApprovalGrants,
	APPROVAL_CACHE_FILENAME,
	approvalAncestorDirectoryKeys,
	approvalDirectoryCovers,
	approvalDirectoryKey,
	commonApprovalDirectoryKey,
	clearApprovalGrants,
	getApprovalCache,
	getApprovalGrants,
	SessionApprovals,
	__resetSessionApprovalsForTests,
} from "@oh-my-pi/pi-coding-agent/tools/approval-cache";
import { approvalTargetKey } from "@oh-my-pi/pi-coding-agent/tools/approval-targets";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { getAgentDir, isRecord, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";

/** Minimal tool session for directly exercising a tool's approval-cache keys. */
function createToolSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

/** Check-only store for resolution tests: knows exactly the given keys. */
function testGrants(keys: string[] = []): ApprovalGrantStore {
	const grants = new Set(keys);
	return { has: key => grants.has(key) };
}

/** A real two-tier store over a temp agent directory, for recording tests. */
function recordingGrants(agentDir: string): ApprovalGrants {
	return new ApprovalGrants(new SessionApprovals(), new ApprovalCache(agentDir));
}

/** Tool that declares `approvalTargetKey` targets from `args.path`, like read/write/edit. */
function pathTool(name: string, tier: ToolTier, cwd: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: {} as never,
		approval: tier,
		approvalCacheTargets: (args: unknown) =>
			isRecord(args) && typeof args.path === "string" ? [approvalTargetKey(cwd, args.path)!] : undefined,
		execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
	};
}

/** Tool that declares cache targets from `args.path`, mirroring read/write/edit. */
function targetTool(name: string, tier: ToolTier): AgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: {} as never,
		approval: tier,
		approvalCacheTargets: (args: unknown) => {
			if (!isRecord(args) || typeof args.path !== "string") return undefined;
			return [`target:${args.path}`];
		},
		execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
	};
}

describe("always-ask-cached resolution", () => {
	it("prompts once per target, then resolves cached read/write targets silently", () => {
		const read = targetTool("read", "read");
		const write = targetTool("write", "write");
		const grants = testGrants();

		const firstRead = resolveApproval(read, { path: "notes.txt" }, "always-ask-cached", {}, grants);
		expect(firstRead).toMatchObject({ policy: "prompt", tier: "read", source: "mode" });
		expect(firstRead.reason).toBeTruthy();

		expect(resolveApproval(write, { path: "notes.txt" }, "always-ask-cached", {}, grants).policy).toBe("prompt");

		// Recording lands in the session tier by default; both tools then hit the same key.
		const dir = TempDir.createSync("@pi-approval-record-");
		try {
			const store = recordingGrants(dir.path());
			recordApprovalCacheTargets(read, { path: "notes.txt" }, store);
			expect(store.session.has("target:notes.txt")).toBe(true);
			expect(store.global.size).toBe(0);
			expect(resolveApproval(read, { path: "notes.txt" }, "always-ask-cached", {}, store).policy).toBe("allow");
			expect(resolveApproval(write, { path: "notes.txt" }, "always-ask-cached", {}, store).policy).toBe("allow");
			// A different target is still unknown.
			expect(resolveApproval(read, { path: "other.txt" }, "always-ask-cached", {}, store).policy).toBe("prompt");
		} finally {
			dir.removeSync();
		}
	});

	it("auto-approves read-tier tools without targets and keeps prompting write-tier ones", () => {
		const plainRead = { name: "glob", approval: "read" as const } as AgentTool;
		const plainWrite = { name: "mcp__filesystem_write", approval: "write" as const } as AgentTool;
		const grants = testGrants();
		expect(resolveApproval(plainRead, {}, "always-ask-cached", {}, grants)).toMatchObject({
			policy: "allow",
			source: "mode",
		});
		expect(resolveApproval(plainWrite, {}, "always-ask-cached", {}, grants)).toMatchObject({
			policy: "prompt",
			source: "mode",
		});
	});

	it("uses folder scopes, never command text, to cover exec calls", () => {
		const cwd = path.resolve("/work/project");
		const bash: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "command tool",
			parameters: {} as never,
			approval: "exec",
			approvalCacheScopes: () => [approvalDirectoryKey(path.join(cwd, "TestDir"))],
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		};
		const uncovered = testGrants();
		expect(resolveApproval(bash, { command: "npm test" }, "always-ask-cached", {}, uncovered)).toMatchObject({
			policy: "prompt",
			tier: "exec",
			reason: "folder not yet approved",
		});
		// A granted folder (or any ancestor of it) covers the call, whatever the command.
		const covered = testGrants([approvalDirectoryKey(path.join(cwd, "TestDir"))]);
		expect(resolveApproval(bash, { command: "npm test" }, "always-ask-cached", {}, covered).policy).toBe("allow");
		expect(resolveApproval(bash, { command: "rm -rf build" }, "always-ask-cached", {}, covered).policy).toBe("allow");
		const ancestor = testGrants([approvalDirectoryKey(cwd)]);
		expect(
			resolveApproval(
				bash,
				{ command: "npm test", cwd: path.join(cwd, "TestDir", "sub") },
				"always-ask-cached",
				{},
				ancestor,
			).policy,
		).toBe("allow");
	});

	it("keeps prompting exec tools that declare no scope or target", () => {
		const evalTool = { name: "eval", approval: "exec" as const } as AgentTool;
		const grants = testGrants(["target:anything"]);
		expect(resolveApproval(evalTool, { code: "1 + 1" }, "always-ask-cached", {}, grants)).toMatchObject({
			policy: "prompt",
			tier: "exec",
			reason: "target not yet approved",
		});
	});

	it("covers read/write targets below a granted folder at any depth", () => {
		const cwd = path.resolve("/work/project");
		const key = (target: string) => approvalTargetKey(cwd, target)!;
		const granted = testGrants([approvalDirectoryKey(path.join(cwd, "TestDir"))]);
		const read = targetTool("read", "read");
		const write = targetTool("write", "write");
		// The tool reports keys, so feed it pre-derived ones through a wrapper.
		const keyed: AgentTool = { ...read, approvalCacheTargets: () => [key("TestDir/TestFile.exe")] };
		expect(resolveApproval(keyed, {}, "always-ask-cached", {}, granted).policy).toBe("allow");
		const nested: AgentTool = { ...read, approvalCacheTargets: () => [key("TestDir/sub/deep/file.ts")] };
		expect(resolveApproval(nested, {}, "always-ask-cached", {}, granted).policy).toBe("allow");
		// Outside the granted folder it still asks, and the whole-folder key never matches.
		const outside: AgentTool = { ...read, approvalCacheTargets: () => [key("OtherDir/file.ts")] };
		expect(resolveApproval(outside, {}, "always-ask-cached", {}, granted).policy).toBe("prompt");
		expect(resolveApproval(write, { path: "TestDir/x.txt" }, "always-ask-cached", {}, granted).policy).toBe("prompt");
	});

	it("covers an exec call whose working directory is inside a granted folder", () => {
		const cwd = path.resolve("/work/project");
		const granted = testGrants([approvalDirectoryKey(path.join(cwd, "TestDir"))]);
		const scoped: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "scoped command tool",
			parameters: {} as never,
			approval: "exec",
			approvalCacheTargets: () => ["bash: anything goes"],
			approvalCacheScopes: () => [approvalDirectoryKey(path.join(cwd, "TestDir", "sub"))],
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		};
		expect(resolveApproval(scoped, {}, "always-ask-cached", {}, granted).policy).toBe("allow");
		const elsewhere: AgentTool = {
			...scoped,
			approvalCacheScopes: () => [approvalDirectoryKey(path.join(cwd, "Other"))],
		};
		expect(resolveApproval(elsewhere, {}, "always-ask-cached", {}, granted).policy).toBe("prompt");
	});

	it("offers the shared folder as the approval candidate", () => {
		const cwd = path.resolve("/work/project");
		const single: AgentTool = {
			name: "write",
			label: "Write",
			description: "single",
			parameters: {} as never,
			approval: "write",
			approvalCacheTargets: () => [approvalTargetKey(cwd, "TestDir/TestFile.exe")!],
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		};
		expect(approvalFolderCandidate(single, {})).toEqual({
			key: approvalDirectoryKey(path.join(cwd, "TestDir")),
			label: approvalDirectoryKey(path.join(cwd, "TestDir")).replace(/[\\/]+$/, ""),
		});
		const command: AgentTool = {
			...single,
			approvalCacheScopes: () => [approvalDirectoryKey(path.join(cwd, "TestDir"))],
		};
		expect(approvalFolderCandidate(command, {})).toBeDefined();
		const urls: AgentTool = {
			...single,
			approvalCacheTargets: () => ["xd://todo"],
			approvalCacheScopes: () => undefined,
		};
		expect(approvalFolderCandidate(urls, {})).toBeUndefined();
	});

	it("requires every target of a multi-target call to be approved", () => {
		const edit: AgentTool = {
			name: "edit",
			label: "Edit",
			description: "multi-target test tool",
			parameters: {} as never,
			approval: "write",
			approvalCacheTargets: () => ["target:a.ts", "target:b.ts"],
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		};
		expect(resolveApproval(edit, {}, "always-ask-cached", {}, testGrants(["target:a.ts"])).policy).toBe("prompt");
		expect(
			resolveApproval(edit, {}, "always-ask-cached", {}, testGrants(["target:a.ts", "target:b.ts"])).policy,
		).toBe("allow");
	});

	it("keeps tool and user policies authoritative over the cache", () => {
		const write = targetTool("write", "write");
		const approved = testGrants(["target:notes.txt"]);
		// A user `prompt` policy outranks the cached allow.
		expect(
			resolveApproval(write, { path: "notes.txt" }, "always-ask-cached", { write: "prompt" }, approved),
		).toMatchObject({ policy: "prompt", source: "user" });
		// A user `allow` policy outranks the missing cache entry.
		expect(
			resolveApproval(write, { path: "fresh.txt" }, "always-ask-cached", { write: "allow" }, approved),
		).toMatchObject({ policy: "allow", source: "user" });
		// A tool-owned prompt (safety override) stays per-call.
		const overridden: AgentTool = {
			name: "write",
			label: "Write",
			description: "override test tool",
			parameters: {} as never,
			approval: () => ({ tier: "write", override: true, reason: "guarded" }),
			approvalCacheTargets: () => ["target:notes.txt"],
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		};
		expect(resolveApproval(overridden, { path: "notes.txt" }, "always-ask-cached", {}, approved)).toMatchObject({
			policy: "prompt",
			source: "tool",
			reason: "guarded",
		});
	});

	it("is accepted by the settings schema and reaches resolveApprovalFromContext", () => {
		const settings = Settings.isolated({ "tools.approvalMode": "always-ask-cached" });
		expect(resolveApprovalFromContext({ settings }).approvalMode).toBe("always-ask-cached");
	});
});

/** Reads the raw grant rows of a test database, ordered by key. */
function readGrants(dir: string): Array<{ key: string; tool: string; approvedAt: string; scope: string | null }> {
	const db = new Database(path.join(dir, APPROVAL_CACHE_FILENAME), { readonly: true });
	try {
		return db
			.query<{ key: string; tool: string; approved_at: string; scope: string | null }, []>(
				"SELECT key, tool, approved_at, scope FROM grants ORDER BY key",
			)
			.all()
			.map(row => ({ key: row.key, tool: row.tool, approvedAt: row.approved_at, scope: row.scope }));
	} finally {
		db.close();
	}
}

describe("approval cache store", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-approval-cache-");
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	it("leaves no file behind until a grant is recorded", () => {
		const cache = new ApprovalCache(tempDir.path());
		expect(cache.has("C:/work/notes.txt")).toBe(false);
		expect(cache.size).toBe(0);
		expect(fs.existsSync(path.join(tempDir.path(), APPROVAL_CACHE_FILENAME))).toBe(false);
	});

	it("persists granted targets as database rows and reads them back in a fresh instance", () => {
		const cache = new ApprovalCache(tempDir.path());
		cache.record("C:/work/notes.txt", "read");
		expect(cache.has("C:/work/notes.txt")).toBe(true);
		expect(cache.has("C:/work/other.txt")).toBe(false);
		expect(cache.size).toBe(1);

		const [row] = readGrants(tempDir.path());
		expect(row).toMatchObject({ key: "C:/work/notes.txt", tool: "read", scope: null });
		expect(Number.isNaN(Date.parse(row!.approvedAt))).toBe(false);

		expect(new ApprovalCache(tempDir.path()).has("C:/work/notes.txt")).toBe(true);
	});

	it("keeps grants from another writer and never rewrites an existing key", () => {
		const cache = new ApprovalCache(tempDir.path());
		cache.record("first.txt", "read");
		new ApprovalCache(tempDir.path()).record("second.txt", "write");
		cache.record("first.txt", "edit");
		expect(readGrants(tempDir.path()).map(row => row.key)).toEqual(["first.txt", "second.txt"]);
		expect(readGrants(tempDir.path())[0]!.tool).toBe("read");
	});

	it("drops grants when the database is deleted, so revocation does not need a restart", () => {
		const cache = new ApprovalCache(tempDir.path());
		cache.record("first.txt");
		fs.rmSync(path.join(tempDir.path(), APPROVAL_CACHE_FILENAME));
		expect(cache.has("first.txt")).toBe(false);
		cache.record("second.txt");
		expect(readGrants(tempDir.path()).map(row => row.key)).toEqual(["second.txt"]);
	});

	it("persists a directory grant with its scope marker", () => {
		const cache = new ApprovalCache(tempDir.path());
		cache.record("c:\\testdir\\", "read", "directory");
		expect(cache.has("c:\\testdir\\")).toBe(true);
		expect(readGrants(tempDir.path())).toEqual([
			{ key: "c:\\testdir\\", tool: "read", approvedAt: expect.any(String), scope: "directory" },
		]);
	});

	it("quarantines an unusable database and starts a fresh one", () => {
		fs.mkdirSync(tempDir.path(), { recursive: true });
		fs.writeFileSync(path.join(tempDir.path(), APPROVAL_CACHE_FILENAME), "{not a database");
		const cache = new ApprovalCache(tempDir.path());
		expect(cache.has("anything")).toBe(false);
		cache.record("fresh.txt");
		expect(readGrants(tempDir.path()).map(row => row.key)).toEqual(["fresh.txt"]);
		expect(fs.existsSync(`${path.join(tempDir.path(), APPROVAL_CACHE_FILENAME)}.corrupt`)).toBe(true);
	});

	it("imports a legacy JSON cache once and leaves only the database behind", () => {
		fs.mkdirSync(tempDir.path(), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir.path(), "approval-cache.json"),
			JSON.stringify({
				version: 1,
				paths: {
					"c:\\testdir\\notes.txt": { tool: "read", approvedAt: "2026-10-15T00:00:00.000Z" },
					"c:\\testdir\\": { tool: "read", approvedAt: "2026-10-15T00:00:00.000Z", scope: "directory" },
				},
			}),
		);
		const cache = new ApprovalCache(tempDir.path());
		expect(cache.has("c:\\testdir\\notes.txt")).toBe(true);
		expect(readGrants(tempDir.path())).toEqual([
			{ key: "c:\\testdir\\", tool: "read", approvedAt: "2026-10-15T00:00:00.000Z", scope: "directory" },
			{ key: "c:\\testdir\\notes.txt", tool: "read", approvedAt: "2026-10-15T00:00:00.000Z", scope: null },
		]);
		// The legacy file is gone: the database is the only cache on disk.
		expect(fs.existsSync(path.join(tempDir.path(), "approval-cache.json"))).toBe(false);
		expect(fs.existsSync(path.join(tempDir.path(), "approval-cache.json.bak"))).toBe(false);
		expect(fs.existsSync(path.join(tempDir.path(), APPROVAL_CACHE_FILENAME))).toBe(true);
	});

	it("keeps an unreadable legacy JSON as a .bak instead of dropping it", () => {
		fs.mkdirSync(tempDir.path(), { recursive: true });
		fs.writeFileSync(path.join(tempDir.path(), "approval-cache.json"), "{not json");
		const cache = new ApprovalCache(tempDir.path());
		expect(cache.has("anything")).toBe(false);
		expect(fs.existsSync(path.join(tempDir.path(), "approval-cache.json"))).toBe(false);
		expect(fs.existsSync(path.join(tempDir.path(), "approval-cache.json.bak"))).toBe(true);
	});

	it("keeps session grants in memory only, so a fresh instance starts clean", () => {
		const session = new SessionApprovals();
		session.record("C:/work/notes.txt", "read");
		expect(session.has("C:/work/notes.txt")).toBe(true);
		expect(session.size).toBe(1);
		// Nothing reached the global database, so a new instance (or a restarted one) sees no file.
		expect(fs.existsSync(path.join(tempDir.path(), APPROVAL_CACHE_FILENAME))).toBe(false);
		expect(new ApprovalCache(tempDir.path()).has("C:/work/notes.txt")).toBe(false);
		session.clear();
		expect(session.has("C:/work/notes.txt")).toBe(false);
	});

	it("allows a key from either tier through the composite store", () => {
		const session = new SessionApprovals();
		const global = new ApprovalCache(tempDir.path());
		const grants = new ApprovalGrants(session, global);
		grants.record("session-key", "read");
		grants.record("global-key", "read", undefined, "global");
		expect(session.has("session-key")).toBe(true);
		expect(global.has("session-key")).toBe(false);
		expect(grants.has("session-key")).toBe(true);
		expect(grants.has("global-key")).toBe(true);
		expect(readGrants(tempDir.path())).toEqual([expect.objectContaining({ key: "global-key", scope: null })]);
	});

	it("returns one shared store per agent directory", () => {
		expect(getApprovalCache(tempDir.path())).toBe(getApprovalCache(tempDir.path()));
		expect(getApprovalCache(path.join(tempDir.path(), "nested-other"))).not.toBe(getApprovalCache(tempDir.path()));
		expect(getApprovalGrants(tempDir.path())).toBe(getApprovalGrants(tempDir.path()));
		expect(getApprovalGrants(tempDir.path()).global).toBe(getApprovalCache(tempDir.path()));
		expect(getApprovalGrants(path.join(tempDir.path(), "nested-other"))).not.toBe(getApprovalGrants(tempDir.path()));
	});

	it("forgets every row when cleared, and clearing an absent cache is a no-op", () => {
		const cache = new ApprovalCache(tempDir.path());
		cache.record("C:/work/notes.txt", "read");
		cache.record("c:\\testdir\\", "read", "directory");
		expect(cache.size).toBe(2);

		cache.clear();

		expect(cache.size).toBe(0);
		expect(readGrants(tempDir.path())).toEqual([]);
		// A fresh instance (and a later check through the same store) sees nothing either.
		expect(new ApprovalCache(tempDir.path()).has("C:/work/notes.txt")).toBe(false);
		expect(cache.has("c:\\testdir\\")).toBe(false);
		cache.clear();
		expect(cache.size).toBe(0);
		// The file stays: grants recorded after a clear persist as usual.
		cache.record("after-clear.txt", "read");
		expect(readGrants(tempDir.path()).map(row => row.key)).toEqual(["after-clear.txt"]);
	});

	it("clears both tiers through clearApprovalGrants, the settings action", () => {
		const grants = getApprovalGrants(tempDir.path());
		grants.record("session-key", "read");
		grants.record("global-key", "read", undefined, "global");
		expect(grants.has("session-key")).toBe(true);
		expect(grants.has("global-key")).toBe(true);
		expect(readGrants(tempDir.path())).toEqual([expect.objectContaining({ key: "global-key" })]);

		clearApprovalGrants(tempDir.path());

		expect(grants.has("session-key")).toBe(false);
		expect(grants.has("global-key")).toBe(false);
		expect(getApprovalCache(tempDir.path()).size).toBe(0);
		expect(readGrants(tempDir.path())).toEqual([]);
		__resetSessionApprovalsForTests();
	});
});

describe("approval target keys", () => {
	const cwd = path.resolve("/work/project");

	it("resolves local targets to one absolute key across spellings", () => {
		expect(approvalTargetKey(cwd, "./sub/../notes.txt")).toBe(approvalTargetKey(cwd, "notes.txt"));
		expect(approvalTargetKey(cwd, "notes.txt")).toBe(
			process.platform === "win32" ? approvalTargetKey(cwd, "NOTES.TXT") : approvalTargetKey(cwd, "notes.txt"),
		);
		expect(approvalTargetKey(cwd, "   ")).toBeUndefined();
		expect(approvalTargetKey(cwd, "")).toBeUndefined();
	});

	it("keeps URL targets in their normalized form", () => {
		expect(approvalTargetKey(cwd, "xd://todo")).toBe("xd://todo");
		expect(approvalTargetKey(cwd, "local:/notes.md")).toBe("local://notes.md");
		expect(approvalTargetKey(cwd, "https://example.com/a.txt")).toBe("https://example.com/a.txt");
	});

	it("reports no cache key for public web URLs, so the cached mode never asks", () => {
		const read = new ReadTool(createToolSession(cwd));
		// Web URLs (and `www.` hosts) are public: nothing to approve, nothing to remember.
		expect(read.approvalCacheTargets?.({ path: "https://example.com/a.txt" })).toBeUndefined();
		expect(read.approvalCacheTargets?.({ path: "https://example.com/a.txt:10-20" })).toBeUndefined();
		expect(read.approvalCacheTargets?.({ path: "www.example.com/docs" })).toBeUndefined();
		// Local files keep their key, and the resolver still prompts once for them.
		expect(read.approvalCacheTargets?.({ path: "notes.txt" })).toEqual([approvalTargetKey(cwd, "notes.txt")!]);

		const grants = testGrants();
		expect(
			resolveApproval(read, { path: "https://example.com/a.txt" }, "always-ask-cached", {}, grants),
		).toMatchObject({ policy: "allow", tier: "read", source: "mode" });
		expect(resolveApproval(read, { path: "notes.txt" }, "always-ask-cached", {}, grants)).toMatchObject({
			policy: "prompt",
			tier: "read",
			source: "mode",
		});
	});

	it("shares one key between read selectors and write hashline headers", () => {
		const session = createToolSession(cwd);
		const read = new ReadTool(session);
		const write = new WriteTool(session);
		const readKey = read.approvalCacheTargets?.({ path: "notes.txt:120-140" });
		expect(readKey).toEqual(read.approvalCacheTargets?.({ path: "notes.txt:raw" }));
		expect(write.approvalCacheTargets?.({ path: "[notes.txt#ABCD]" })).toEqual(readKey);
		expect(write.approvalCacheTargets?.({ path: "" })).toBeUndefined();
		expect(read.approvalCacheTargets?.({})).toBeUndefined();
	});

	it("reports a shell command's working directory as its scope and no targets", () => {
		const bash = new BashTool(createToolSession(cwd));
		expect(bash.approvalCacheScopes?.({ command: "git status" })).toEqual([approvalDirectoryKey(cwd)]);
		const elsewhere = path.resolve("/elsewhere");
		expect(bash.approvalCacheScopes?.({ command: "git status", cwd: elsewhere })).toEqual([
			approvalDirectoryKey(elsewhere),
		]);
		// Command text is never a cache target: only files and folders are remembered.
		expect("approvalCacheTargets" in bash).toBe(false);
	});

	it("derives directory keys, ancestors, and shared folders", () => {
		const notes = approvalTargetKey(cwd, "sub/notes.txt")!;
		const directory = approvalDirectoryKey(path.join(cwd, "sub"));
		expect(approvalDirectoryCovers(directory, notes)).toBe(true);
		expect(approvalDirectoryCovers(approvalDirectoryKey(cwd), notes)).toBe(true);
		expect(approvalDirectoryCovers(approvalDirectoryKey(path.resolve("/elsewhere")), notes)).toBe(false);
		expect(approvalAncestorDirectoryKeys(notes)[0]).toBe(directory);
		expect(approvalAncestorDirectoryKeys("bash: npm test")).toEqual([]);
		expect(approvalAncestorDirectoryKeys("xd://todo")).toEqual([]);

		expect(commonApprovalDirectoryKey([path.join(cwd, "a"), path.join(cwd, "b")])).toBe(approvalDirectoryKey(cwd));
		expect(commonApprovalDirectoryKey([path.join(cwd, "a")])).toBe(approvalDirectoryKey(path.join(cwd, "a")));
		expect(commonApprovalDirectoryKey([])).toBeUndefined();
	});
});

describe("always-ask-cached wrapper cycle", () => {
	let tempDir: TempDir;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;
	let originalAgentDir: string;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-approval-cached-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	beforeEach(() => {
		originalAgentDir = getAgentDir();
		setAgentDir(tempDir.path());
		// Grants are per agent directory (and the session tier is process-wide); start each case clean.
		fs.rmSync(path.join(tempDir.path(), APPROVAL_CACHE_FILENAME), { force: true });
		__resetSessionApprovalsForTests();
		sessionManager = SessionManager.inMemory(path.join(tempDir.path(), "cwd"));
	});

	afterEach(() => {
		setAgentDir(originalAgentDir);
	});

	const initializeRunner = (
		runner: ExtensionRunner,
		select: (title: string, options: string[]) => Promise<string | undefined>,
	) => {
		runner.initialize(
			{
				sendMessage: () => {},
				sendUserMessage: () => {},
				appendEntry: () => {},
				setLabel: () => {},
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools: async () => {},
				getCommands: () => [],
				setModel: async () => false,
				getThinkingLevel: () => undefined,
				setThinkingLevel: () => {},
				getSessionName: () => undefined,
				setSessionName: async () => {},
			},
			{
				getModel: () => undefined,
				isIdle: () => true,
				abort: () => {},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: async () => {},
				getSystemPrompt: () => [],
			},
			undefined,
			{
				select,
				confirm: async () => false,
				input: async () => undefined,
				notify: () => {},
				onTerminalInput: () => () => {},
				setStatus: () => {},
				setWorkingMessage: () => {},
				setWidget: () => {},
				setFooter: () => {},
				setHeader: () => {},
				setTitle: () => {},
				custom: async <T>() => undefined as T,
				pasteToEditor: () => {},
				setEditorText: () => {},
				getEditorText: () => "",
				editor: async () => undefined,
				addAutocompleteProvider: () => {},
				setEditorComponent: () => {},
				getEditorComponent: () => undefined,
				get theme() {
					return {} as never;
				},
				getAllThemes: async () => [],
				getTheme: async () => undefined,
				setTheme: async () => ({ success: false, error: "not implemented" }),
				getToolsExpanded: () => false,
				setToolsExpanded: () => {},
			} satisfies ExtensionUIContext,
		);
	};

	function context(settings: Settings): AgentToolContext {
		return {
			sessionManager,
			modelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
			settings,
		} as AgentToolContext;
	}

	function cachedSettings(): Settings {
		return Settings.isolated({ "tools.approvalMode": "always-ask-cached" });
	}

	it("prompts on the first write, records the target, and runs later writes without asking", async () => {
		const select = vi.fn(async _title => APPROVAL_APPROVE_FILE_LABEL);
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		initializeRunner(runner, select);
		const settings = cachedSettings();
		const tool = targetTool("write_probe", "write");
		const wrapper = new ExtensionToolWrapper(tool, runner);

		await wrapper.execute("cached-first", { path: "notes.txt" }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(1);

		const grants = getApprovalGrants(settings.getAgentDir());
		expect(grants.session.has("target:notes.txt")).toBe(true);
		// A plain approval stays in this instance's memory: nothing reached the global database.
		expect(grants.global.size).toBe(0);

		const secondRunner = new ExtensionRunner(
			[],
			new ExtensionRuntime(),
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const secondSelect = vi.fn(async _title => APPROVAL_APPROVE_FILE_LABEL);
		initializeRunner(secondRunner, secondSelect);
		const secondWrapper = new ExtensionToolWrapper(tool, secondRunner);
		await secondWrapper.execute("cached-second", { path: "notes.txt" }, undefined, undefined, context(settings));
		expect(secondSelect).not.toHaveBeenCalled();
	});

	it("remembers a folder when the folder answer approves the call", async () => {
		const select = vi.fn(async _title => APPROVAL_APPROVE_FILE_LABEL);
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		// The dialog host answers with the folder scope.
		const approve = vi.fn(async () => ({ approved: true, scope: "folder" }) as const);
		runner.initialize(
			{
				sendMessage: () => {},
				sendUserMessage: () => {},
				appendEntry: () => {},
				setLabel: () => {},
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools: async () => {},
				getCommands: () => [],
				setModel: async () => false,
				getThinkingLevel: () => undefined,
				setThinkingLevel: () => {},
				getSessionName: () => undefined,
				setSessionName: async () => {},
			},
			{
				getModel: () => undefined,
				isIdle: () => true,
				abort: () => {},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: async () => {},
				getSystemPrompt: () => [],
			},
			undefined,
			{
				select,
				approve,
				confirm: async () => false,
				input: async () => undefined,
				notify: () => {},
				onTerminalInput: () => () => {},
				setStatus: () => {},
				setWorkingMessage: () => {},
				setWidget: () => {},
				setFooter: () => {},
				setHeader: () => {},
				setTitle: () => {},
				custom: async <T>() => undefined as T,
				pasteToEditor: () => {},
				setEditorText: () => {},
				getEditorText: () => "",
				editor: async () => undefined,
				addAutocompleteProvider: () => {},
				setEditorComponent: () => {},
				getEditorComponent: () => undefined,
				get theme() {
					return {} as never;
				},
				getAllThemes: async () => [],
				getTheme: async () => undefined,
				setTheme: async () => ({ success: false, error: "not implemented" }),
				getToolsExpanded: () => false,
				setToolsExpanded: () => {},
			} satisfies ExtensionUIContext,
		);
		const settings = cachedSettings();
		const dir = path.join(tempDir.path(), "TestDir");
		const write = (toolName: string): AgentTool => ({
			name: toolName,
			label: toolName,
			description: "file tool",
			parameters: {} as never,
			approval: "write",
			approvalCacheTargets: (args: unknown) =>
				isRecord(args) && typeof args.path === "string"
					? [approvalTargetKey(tempDir.path(), args.path)!]
					: undefined,
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		});
		const first = new ExtensionToolWrapper(write("write"), runner);
		await first.execute(
			"folder-first",
			{ path: path.join(dir, "TestFile.exe") },
			undefined,
			undefined,
			context(settings),
		);
		expect(approve).toHaveBeenCalledTimes(1);
		const [prompt] = approve.mock.calls[0] as unknown as [{ folderLabel?: string }];
		expect(prompt.folderLabel).toBe(approvalDirectoryKey(dir).replace(/[\\/]+$/, ""));
		expect(getApprovalGrants(settings.getAgentDir()).session.has(approvalDirectoryKey(dir))).toBe(true);
		expect(getApprovalCache(settings.getAgentDir()).size).toBe(0);

		// A different file in the folder, and a nested one, run without asking.
		const second = new ExtensionToolWrapper(write("write"), runner);
		await second.execute(
			"folder-second",
			{ path: path.join(dir, "Other.txt") },
			undefined,
			undefined,
			context(settings),
		);
		await second.execute(
			"folder-third",
			{ path: path.join(dir, "sub", "deep.txt") },
			undefined,
			undefined,
			context(settings),
		);
		expect(approve).toHaveBeenCalledTimes(1);
		expect(select).not.toHaveBeenCalled();
	});

	it("records the whole folder on plain approval when the scope prefers folders", async () => {
		const select = vi.fn(async _title => APPROVAL_APPROVE_FILE_LABEL);
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		initializeRunner(runner, select);
		const settings = Settings.isolated({
			"tools.approvalMode": "always-ask-cached",
			"tools.approvalScope": "folder",
		});
		const dir = path.join(tempDir.path(), "ScopedDir");
		const tool: AgentTool = {
			name: "write_scope",
			label: "Write",
			description: "file tool",
			parameters: {} as never,
			approval: "write",
			approvalCacheTargets: (args: unknown) =>
				isRecord(args) && typeof args.path === "string"
					? [approvalTargetKey(tempDir.path(), args.path)!]
					: undefined,
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		};
		const wrapper = new ExtensionToolWrapper(tool, runner);

		await wrapper.execute(
			"scope-first",
			{ path: path.join(dir, "One.txt") },
			undefined,
			undefined,
			context(settings),
		);
		expect(select).toHaveBeenCalledTimes(1);
		const cache = getApprovalCache(settings.getAgentDir());
		expect(getApprovalGrants(settings.getAgentDir()).session.has(approvalDirectoryKey(dir))).toBe(true);
		expect(cache.size).toBe(0);

		// A sibling file is covered by the recorded folder, without a prompt.
		await wrapper.execute(
			"scope-second",
			{ path: path.join(dir, "Two.txt") },
			undefined,
			undefined,
			context(settings),
		);
		expect(select).toHaveBeenCalledTimes(1);
		// Outside the folder it still asks.
		await wrapper.execute(
			"scope-outside",
			{ path: path.join(tempDir.path(), "Elsewhere.txt") },
			undefined,
			undefined,
			context(settings),
		);
		expect(select).toHaveBeenCalledTimes(2);
	});

	it("forgets session grants when a fresh instance starts, but keeps 'Always …' ones", async () => {
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		// Answer by option label: the session-scoped file answer for the first call, the
		// cross-instance one for the second.
		const picks = [APPROVAL_APPROVE_FILE_LABEL, APPROVAL_ALWAYS_FILE_LABEL];
		const select = vi.fn(async (_title: string, options: string[]) => {
			const pick = picks.shift() ?? APPROVAL_APPROVE_FILE_LABEL;
			expect(options).toContain(pick);
			return pick;
		});
		initializeRunner(runner, select);
		const settings = cachedSettings();
		const wrapper = new ExtensionToolWrapper(pathTool("write", "write", tempDir.path()), runner);
		const dir = path.join(tempDir.path(), "TierDir");

		await wrapper.execute(
			"tier-session",
			{ path: path.join(dir, "Session.txt") },
			undefined,
			undefined,
			context(settings),
		);
		const grants = getApprovalGrants(settings.getAgentDir());
		expect(grants.session.has(approvalTargetKey(tempDir.path(), path.join(dir, "Session.txt"))!)).toBe(true);

		await wrapper.execute(
			"tier-global",
			{ path: path.join(dir, "Global.txt") },
			undefined,
			undefined,
			context(settings),
		);
		expect(readGrants(tempDir.path())).toEqual([
			expect.objectContaining({ key: approvalTargetKey(tempDir.path(), path.join(dir, "Global.txt")), scope: null }),
		]);

		// A new instance: session grants are gone, the global one still covers its file.
		__resetSessionApprovalsForTests();
		expect(grants.session.size).toBe(0);
		expect(grants.has(approvalTargetKey(tempDir.path(), path.join(dir, "Global.txt"))!)).toBe(true);
		await wrapper.execute(
			"tier-global-again",
			{ path: path.join(dir, "Global.txt") },
			undefined,
			undefined,
			context(settings),
		);
		expect(select).toHaveBeenCalledTimes(2);
		await wrapper.execute(
			"tier-session-again",
			{ path: path.join(dir, "Session.txt") },
			undefined,
			undefined,
			context(settings),
		);
		expect(select).toHaveBeenCalledTimes(3);
	});

	it("records a directory for every session when the cross-instance directory answer is picked", async () => {
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		const select = vi.fn(async (_title: string, options: string[]) => options[2]);
		initializeRunner(runner, select);
		const settings = cachedSettings();
		const dir = path.join(tempDir.path(), "AlwaysDir");
		const wrapper = new ExtensionToolWrapper(pathTool("write", "write", tempDir.path()), runner);

		await wrapper.execute("always-dir", { path: path.join(dir, "One.txt") }, undefined, undefined, context(settings));
		expect(select.mock.calls[0]![1][2]).toBe(
			`Always Approve Directory: ${approvalDirectoryKey(dir).replace(/[\\/]+$/, "")}`,
		);
		expect(readGrants(tempDir.path())).toEqual([
			expect.objectContaining({ key: approvalDirectoryKey(dir), scope: "directory" }),
		]);
		__resetSessionApprovalsForTests();
		await wrapper.execute(
			"always-dir-sibling",
			{ path: path.join(dir, "Two.txt") },
			undefined,
			undefined,
			context(settings),
		);
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("leaves no grant behind when the user denies, so the next call asks again", async () => {
		const select = vi.fn(async () => "Deny");
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		initializeRunner(runner, select);
		const settings = cachedSettings();
		const wrapper = new ExtensionToolWrapper(targetTool("write_probe", "write"), runner);

		await expect(
			wrapper.execute("cached-denied", { path: "blocked.txt" }, undefined, undefined, context(settings)),
		).rejects.toThrow("denied by user");
		expect(getApprovalCache(settings.getAgentDir()).has("target:blocked.txt")).toBe(false);

		await expect(
			wrapper.execute("cached-denied-again", { path: "blocked.txt" }, undefined, undefined, context(settings)),
		).rejects.toThrow("denied by user");
		expect(select).toHaveBeenCalledTimes(2);
	});

	it("never remembers a command by its text; only the folder answer covers exec calls", async () => {
		const select = vi.fn(async _title => APPROVAL_APPROVE_LABEL);
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		initializeRunner(runner, select);
		const settings = cachedSettings();
		const dir = path.join(tempDir.path(), "ExecDir");
		const tool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "command tool",
			parameters: {} as never,
			approval: "exec",
			approvalCacheScopes: () => [approvalDirectoryKey(dir)],
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		};
		const wrapper = new ExtensionToolWrapper(tool, runner);

		// A plain approval of a command records nothing: the same command asks again.
		await wrapper.execute("exec-first", { command: "npm test" }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(1);
		expect(getApprovalCache(settings.getAgentDir()).size).toBe(0);
		await wrapper.execute("exec-again", { command: "npm test" }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(2);
	});

	it("lets the folder answer cover exec calls, whatever command runs there", async () => {
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		// Select hosts (RPC/ACP) answer with the option label; the first option is the folder answer.
		const select = vi.fn(async (_title: string, options: string[]) => options[0]);
		initializeRunner(runner, select);
		const settings = cachedSettings();
		const dir = path.join(tempDir.path(), "ExecDir");
		const tool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "command tool",
			parameters: {} as never,
			approval: "exec",
			approvalCacheScopes: () => [approvalDirectoryKey(dir)],
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		};
		const wrapper = new ExtensionToolWrapper(tool, runner);

		await wrapper.execute("exec-folder-answer", { command: "npm test" }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(1);
		expect(select.mock.calls[0]![1][0]).toBe(
			`Approve Directory: ${approvalDirectoryKey(dir).replace(/[\\/]+$/, "")}`,
		);
		expect(getApprovalGrants(settings.getAgentDir()).session.has(approvalDirectoryKey(dir))).toBe(true);
		expect(getApprovalCache(settings.getAgentDir()).size).toBe(0);

		await wrapper.execute("exec-sibling", { command: "npm run build" }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("does not remember a guarded command even when its folder is granted", async () => {
		const select = vi.fn(async _title => APPROVAL_APPROVE_LABEL);
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		initializeRunner(runner, select);
		const settings = cachedSettings();
		const dir = path.join(tempDir.path(), "GuardedDir");
		const tool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "guarded command tool",
			parameters: {} as never,
			approval: () => ({ tier: "exec", override: true, reason: "critical pattern detected" }),
			approvalCacheScopes: () => [approvalDirectoryKey(dir)],
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		};
		const wrapper = new ExtensionToolWrapper(tool, runner);

		await wrapper.execute("guarded-first", { command: "rm -rf /" }, undefined, undefined, context(settings));
		await wrapper.execute("guarded-second", { command: "rm -rf /" }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(2);
		expect(getApprovalCache(settings.getAgentDir()).size).toBe(0);
		const [title] = select.mock.calls[0] as unknown as [string, string[]];
		expect(title).toContain("critical pattern detected");
	});
});
