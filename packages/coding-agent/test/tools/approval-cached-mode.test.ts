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
	approvalFolderCandidate,
	recordApprovalCacheTargets,
	resolveApproval,
	resolveApprovalFromContext,
} from "@oh-my-pi/pi-coding-agent/tools/approval";
import {
	ApprovalCache,
	APPROVAL_CACHE_FILENAME,
	approvalAncestorDirectoryKeys,
	approvalDirectoryCovers,
	approvalDirectoryKey,
	commonApprovalDirectoryKey,
	getApprovalCache,
} from "@oh-my-pi/pi-coding-agent/tools/approval-cache";
import { approvalCommandKey, approvalTargetKey } from "@oh-my-pi/pi-coding-agent/tools/approval-targets";
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

function testGrants(keys: string[] = []): ApprovalGrantStore & { keys: Set<string> } {
	const grants = new Set(keys);
	return {
		filePath: "(memory)",
		has: key => grants.has(key),
		record: (key: string) => {
			grants.add(key);
		},
		keys: grants,
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

		recordApprovalCacheTargets(read, { path: "notes.txt" }, grants);
		expect(grants.keys).toEqual(new Set(["target:notes.txt"]));
		expect(resolveApproval(read, { path: "notes.txt" }, "always-ask-cached", {}, grants).policy).toBe("allow");
		expect(resolveApproval(write, { path: "notes.txt" }, "always-ask-cached", {}, grants).policy).toBe("allow");
		// A different target is still unknown.
		expect(resolveApproval(read, { path: "other.txt" }, "always-ask-cached", {}, grants).policy).toBe("prompt");
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

	it("remembers exec calls per exact command, gated on the tool's own target", () => {
		const bash = targetTool("bash", "exec");
		const grants = testGrants(["target:npm test"]);
		expect(resolveApproval(bash, { path: "npm test" }, "always-ask-cached", {}, grants)).toMatchObject({
			policy: "allow",
			tier: "exec",
			source: "mode",
		});
		// A different command still asks.
		expect(resolveApproval(bash, { path: "npm run build" }, "always-ask-cached", {}, grants)).toMatchObject({
			policy: "prompt",
			tier: "exec",
		});
	});

	it("keeps prompting exec tools that declare no cache target", () => {
		const evalTool = { name: "eval", approval: "exec" as const } as AgentTool;
		const grants = testGrants(["target:anything"]);
		expect(resolveApproval(evalTool, { code: "1 + 1" }, "always-ask-cached", {}, grants)).toMatchObject({
			policy: "prompt",
			tier: "exec",
			reason: "command not yet approved",
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

	it("imports a legacy JSON cache once and moves it aside", () => {
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
		expect(fs.existsSync(path.join(tempDir.path(), "approval-cache.json"))).toBe(false);
		expect(fs.existsSync(path.join(tempDir.path(), "approval-cache.json.bak"))).toBe(true);
	});

	it("returns one shared store per agent directory", () => {
		expect(getApprovalCache(tempDir.path())).toBe(getApprovalCache(tempDir.path()));
		expect(getApprovalCache(path.join(tempDir.path(), "nested-other"))).not.toBe(getApprovalCache(tempDir.path()));
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

	it("keys commands by tool and exact text, ignoring only surrounding whitespace", () => {
		expect(approvalCommandKey("bash", "  npm test  ")).toBe("bash: npm test");
		expect(approvalCommandKey("bash", "   ")).toBeUndefined();
		expect(approvalCommandKey("bash", "echo 'a  b'")).not.toBe(approvalCommandKey("bash", "echo 'a b'"));

		const bash = new BashTool(createToolSession(cwd));
		expect(bash.approvalCacheTargets?.({ command: "git status" })).toEqual(["bash: git status"]);
		expect(bash.approvalCacheTargets?.({ command: "git status " })).toEqual(["bash: git status"]);
		expect(bash.approvalCacheTargets?.({ command: "git status --short" })).toEqual(["bash: git status --short"]);
		expect(bash.approvalCacheTargets?.({ command: "" })).toBeUndefined();
		expect(bash.approvalCacheTargets?.({})).toBeUndefined();
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

	it("reports a shell command's working directory as its scope", () => {
		const bash = new BashTool(createToolSession(cwd));
		expect(bash.approvalCacheScopes?.({ command: "git status" })).toEqual([approvalDirectoryKey(cwd)]);
		const elsewhere = path.resolve("/elsewhere");
		expect(bash.approvalCacheScopes?.({ command: "git status", cwd: elsewhere })).toEqual([
			approvalDirectoryKey(elsewhere),
		]);
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
		const select = vi.fn(async () => "Approve");
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		initializeRunner(runner, select);
		const settings = cachedSettings();
		const tool = targetTool("write_probe", "write");
		const wrapper = new ExtensionToolWrapper(tool, runner);

		await wrapper.execute("cached-first", { path: "notes.txt" }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(1);

		const cache = getApprovalCache(settings.getAgentDir());
		expect(cache.has("target:notes.txt")).toBe(true);

		const secondRunner = new ExtensionRunner(
			[],
			new ExtensionRuntime(),
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const secondSelect = vi.fn(async () => "Approve");
		initializeRunner(secondRunner, secondSelect);
		const secondWrapper = new ExtensionToolWrapper(tool, secondRunner);
		await secondWrapper.execute("cached-second", { path: "notes.txt" }, undefined, undefined, context(settings));
		expect(secondSelect).not.toHaveBeenCalled();
	});

	it("remembers a folder when the folder answer approves the call", async () => {
		const select = vi.fn(async () => "Approve");
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
		expect(getApprovalCache(settings.getAgentDir()).has(approvalDirectoryKey(dir))).toBe(true);

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
		const select = vi.fn(async () => "Approve");
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
		expect(cache.has(approvalDirectoryKey(dir))).toBe(true);

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

	it("remembers an approved exec command and keeps asking for other commands", async () => {
		const select = vi.fn(async () => "Approve");
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		initializeRunner(runner, select);
		const settings = cachedSettings();
		const tool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "command tool",
			parameters: {} as never,
			approval: "exec",
			approvalCacheTargets: (args: unknown) =>
				isRecord(args) && typeof args.command === "string"
					? [approvalCommandKey("bash", args.command)!]
					: undefined,
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		};
		const wrapper = new ExtensionToolWrapper(tool, runner);

		await wrapper.execute("exec-first", { command: "npm test" }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(1);
		expect(getApprovalCache(settings.getAgentDir()).has("bash: npm test")).toBe(true);

		await wrapper.execute("exec-again", { command: "npm test" }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(1);

		await wrapper.execute("exec-other", { command: "npm run build" }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(2);
	});

	it("does not remember a command whose prompt came from a tool safety override", async () => {
		const select = vi.fn(async () => "Approve");
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		initializeRunner(runner, select);
		const settings = cachedSettings();
		const tool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "guarded command tool",
			parameters: {} as never,
			approval: () => ({ tier: "exec", override: true, reason: "critical pattern detected" }),
			approvalCacheTargets: () => ["bash: rm -rf /"],
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		};
		const wrapper = new ExtensionToolWrapper(tool, runner);

		await wrapper.execute("guarded-first", { command: "rm -rf /" }, undefined, undefined, context(settings));
		await wrapper.execute("guarded-second", { command: "rm -rf /" }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(2);
		expect(getApprovalCache(settings.getAgentDir()).has("bash: rm -rf /")).toBe(false);
		const [title] = select.mock.calls[0] as unknown as [string, string[]];
		expect(title).toContain("critical pattern detected");
	});
});
