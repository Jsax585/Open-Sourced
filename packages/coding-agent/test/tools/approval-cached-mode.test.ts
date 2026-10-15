/**
 * `tools.approvalMode: always-ask-cached` — resolver semantics, the on-disk
 * grant store, and the wrapper's approve-then-remember cycle.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
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
	recordApprovalCacheTargets,
	resolveApproval,
	resolveApprovalFromContext,
} from "@oh-my-pi/pi-coding-agent/tools/approval";
import {
	ApprovalCache,
	APPROVAL_CACHE_FILENAME,
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

describe("approval cache store", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-approval-cache-");
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	it("persists granted targets and reads them back in a fresh instance", () => {
		const cache = new ApprovalCache(tempDir.path());
		cache.record("C:/work/notes.txt", "read");
		expect(cache.has("C:/work/notes.txt")).toBe(true);
		expect(cache.has("C:/work/other.txt")).toBe(false);

		const persisted = JSON.parse(fs.readFileSync(path.join(tempDir.path(), APPROVAL_CACHE_FILENAME), "utf8"));
		expect(persisted.version).toBe(1);
		expect(Object.keys(persisted.paths)).toEqual(["C:/work/notes.txt"]);
		expect(persisted.paths["C:/work/notes.txt"].tool).toBe("read");
		expect(Number.isNaN(Date.parse(persisted.paths["C:/work/notes.txt"].approvedAt))).toBe(false);

		const reopened = new ApprovalCache(tempDir.path());
		expect(reopened.has("C:/work/notes.txt")).toBe(true);
	});

	it("merges grants another writer stored since this instance loaded", () => {
		const cache = new ApprovalCache(tempDir.path());
		cache.record("first.txt");
		const other = new ApprovalCache(tempDir.path());
		other.record("second.txt");
		// First instance records again; the second writer's entry must survive.
		cache.record("third.txt");
		const persisted = JSON.parse(fs.readFileSync(path.join(tempDir.path(), APPROVAL_CACHE_FILENAME), "utf8"));
		expect(Object.keys(persisted.paths).sort()).toEqual(["first.txt", "second.txt", "third.txt"]);
	});

	it("degrades to no grants for a corrupt file and repairs it on the next record", () => {
		fs.mkdirSync(tempDir.path(), { recursive: true });
		fs.writeFileSync(path.join(tempDir.path(), APPROVAL_CACHE_FILENAME), "{not json");
		const cache = new ApprovalCache(tempDir.path());
		expect(cache.has("anything")).toBe(false);
		cache.record("fresh.txt");
		const persisted = JSON.parse(fs.readFileSync(path.join(tempDir.path(), APPROVAL_CACHE_FILENAME), "utf8"));
		expect(Object.keys(persisted.paths)).toEqual(["fresh.txt"]);
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
