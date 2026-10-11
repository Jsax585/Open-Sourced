import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type Api,
	type Context,
	clearCustomApis,
	type Model,
	type ModelSpec,
	registerCustomApi,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { reset as resetCapabilityCache } from "@oh-my-pi/pi-coding-agent/capability";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { NESTED_CONTEXT_FILE_MAX_CHARS } from "@oh-my-pi/pi-coding-agent/session/nested-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { inheritedContextFiles } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ContextFileEntry, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

interface ScriptedCall {
	name: "read" | "write";
	arguments: Record<string, unknown>;
}

interface RunResult {
	/** Provider contexts, one per model request. */
	contexts: Context[];
	/** Developer messages persisted in the session after the run. */
	developerTexts: string[];
	notices: string[];
	/** What the session would hand a subagent after the run. */
	carried: ContextFileEntry[];
}

const BLOCK_PATHS_RE = /<nested-context path="([^"]+)">/g;

function blockPaths(texts: readonly string[]): string[] {
	return texts.flatMap(text => [...text.matchAll(BLOCK_PATHS_RE)].map(match => match[1]));
}

function developerTexts(messages: readonly AgentMessage[]): string[] {
	const texts: string[] = [];
	for (const message of messages) {
		if (message.role !== "developer" || !Array.isArray(message.content)) continue;
		for (const part of message.content) if (part.type === "text") texts.push(part.text);
	}
	return texts;
}

function writeTree(root: string, files: Record<string, string>): void {
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(root, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
}

let apiCounter = 0;

/**
 * Runs one user prompt against a scripted model: request N issues `turns[N]`
 * as parallel tool calls in one assistant message; the request after the last
 * turn ends the run.
 */
async function run(
	tempDir: TempDir,
	cwd: string,
	turns: ScriptedCall[][],
	settings: Record<string, unknown>,
	contextFiles: ContextFileEntry[] = [],
): Promise<RunResult> {
	const api = `test-nested-context-${++apiCounter}`;
	const contexts: Context[] = [];
	registerCustomApi(api, (_model, context) => {
		contexts.push(context);
		const stream = new AssistantMessageEventStream();
		const turn = turns[contexts.length - 1];
		queueMicrotask(() => {
			if (!turn) {
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				return;
			}
			const message = createAssistantMessage("");
			const calls = turn.map((call, index) => ({
				type: "toolCall" as const,
				id: `call-${contexts.length}-${index}`,
				name: call.name,
				arguments: call.arguments,
			}));
			message.content = calls;
			message.stopReason = "toolUse";
			calls.forEach((toolCall, contentIndex) => {
				stream.push({ type: "toolcall_start", contentIndex, partial: message });
				stream.push({ type: "toolcall_end", contentIndex, toolCall: toolCall as never, partial: message });
			});
			stream.push({ type: "done", reason: "toolUse", message });
		});
		return stream;
	});
	const model = buildModel({
		id: "nested-context-model",
		name: "Nested Context Model",
		api,
		provider: "ollama",
		baseUrl: "http://127.0.0.1:11434",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
	const authStorage = await AuthStorage.create(tempDir.join(`auth-${apiCounter}.db`));
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const { session } = await createAgentSession({
		cwd,
		agentDir: tempDir.join("agent"),
		sessionManager: SessionManager.inMemory(cwd),
		authStorage,
		modelRegistry,
		settings: Settings.isolated({ "compaction.enabled": false, "tools.xdev": false, ...settings }),
		model,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles,
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: ["read", "write"],
	});
	const notices: string[] = [];
	session.subscribe(event => {
		if (event.type === "notice" && event.source === "context-files") notices.push(event.message);
	});
	try {
		await session.sendUserMessage("go");
		return {
			contexts,
			developerTexts: developerTexts(session.agent.state.messages),
			notices,
			carried: session.getNestedContextFiles(),
		};
	} finally {
		await session.dispose();
		authStorage.close();
	}
}

const ON = { "contextFiles.onTouch": true };

describe("contextFiles.onTouch", () => {
	let tempDir: TempDir;
	let repo: string;

	const setup = (files: Record<string, string>): void => {
		tempDir = TempDir.createSync("@pi-nested-context-");
		// macOS tmp dirs are symlinks; tools report real paths.
		repo = fs.realpathSync(tempDir.path());
		writeTree(repo, { "AGENTS.md": "ROOT-CANARY", ...files });
		resetCapabilityCache();
	};

	afterEach(() => {
		clearCustomApis();
		tempDir?.removeSync();
	});

	it("injects nothing when the setting is off", async () => {
		// Guards the default: existing users must see no new developer messages.
		setup({ "pkg/AGENTS.md": "PKG-CANARY", "pkg/a.ts": "a" });
		const result = await run(tempDir, repo, [[{ name: "read", arguments: { path: "pkg/a.ts" } }]], {});
		expect(result.developerTexts).toEqual([]);
		expect(result.notices).toEqual([]);
	});

	it("delivers a touched directory's context file on the next request, once per window", async () => {
		// Guards the core contract: first touch loads the nested file as a developer message
		// the model sees; later touches of the same directory do not repeat it; the cwd's own
		// file (already in the system prompt) is never injected.
		setup({ "pkg/AGENTS.md": "PKG-CANARY", "pkg/a.ts": "a", "pkg/b.ts": "b" });
		const result = await run(
			tempDir,
			repo,
			[[{ name: "read", arguments: { path: "pkg/a.ts" } }], [{ name: "read", arguments: { path: "pkg/b.ts" } }]],
			ON,
		);

		const secondRequest = developerTexts(result.contexts[1]?.messages as AgentMessage[]);
		expect(blockPaths(secondRequest)).toEqual(["pkg/AGENTS.md"]);
		expect(secondRequest.join("\n")).toContain("PKG-CANARY");
		expect(secondRequest.join("\n")).not.toContain("ROOT-CANARY");
		expect(blockPaths(result.developerTexts)).toEqual(["pkg/AGENTS.md"]);
		expect(result.notices).toEqual(["Loaded pkg/AGENTS.md"]);
	});

	it("loads each file once when parallel calls in one batch touch the same directory", async () => {
		// Guards the in-batch race: context arrives after the whole batch settles, so the
		// window scan alone would let both calls inject the same file.
		setup({ "pkg/AGENTS.md": "PKG-CANARY", "pkg/a.ts": "a", "pkg/b.ts": "b" });
		const result = await run(
			tempDir,
			repo,
			[
				[
					{ name: "read", arguments: { path: "pkg/a.ts" } },
					{ name: "read", arguments: { path: "pkg/b.ts" } },
				],
			],
			ON,
		);
		expect(blockPaths(result.developerTexts)).toEqual(["pkg/AGENTS.md"]);
	});

	it("loads every level between cwd and the touched file, shallowest first", async () => {
		// Guards precedence: deeper rules override higher ones, so they must come last.
		setup({
			"pkg/AGENTS.md": "PKG-CANARY",
			"pkg/sub/CLAUDE.md": "SUB-CANARY",
			"pkg/sub/deep/x.ts": "x",
		});
		const result = await run(tempDir, repo, [[{ name: "read", arguments: { path: "pkg/sub/deep/x.ts" } }]], ON);
		expect(blockPaths(result.developerTexts)).toEqual(["pkg/AGENTS.md", "pkg/sub/CLAUDE.md"]);
	});

	it("triggers on a write that creates a new subdirectory", async () => {
		// Guards writes: the touched directory does not exist until the tool runs.
		setup({ "pkg/AGENTS.md": "PKG-CANARY" });
		const result = await run(
			tempDir,
			repo,
			[[{ name: "write", arguments: { path: "pkg/fresh/new.ts", content: "export {};\n" } }]],
			ON,
		);
		expect(blockPaths(result.developerTexts)).toEqual(["pkg/AGENTS.md"]);
	});

	it("ignores context files in hidden directories and node_modules", async () => {
		// Guards against loading vendored or tool-private instructions as project rules.
		setup({
			".hidden/AGENTS.md": "HIDDEN-CANARY",
			".hidden/x.ts": "x",
			"node_modules/dep/AGENTS.md": "DEP-CANARY",
			"node_modules/dep/index.js": "x",
		});
		const result = await run(
			tempDir,
			repo,
			[
				[
					{ name: "read", arguments: { path: ".hidden/x.ts" } },
					{ name: "read", arguments: { path: "node_modules/dep/index.js" } },
				],
			],
			ON,
		);
		expect(result.developerTexts).toEqual([]);
	});

	it("treats a full read of the context file itself as loaded", async () => {
		// Guards against delivering the same file twice: once as the read result, once injected.
		setup({ "pkg/AGENTS.md": "PKG-CANARY", "pkg/a.ts": "a" });
		const result = await run(
			tempDir,
			repo,
			[
				[{ name: "read", arguments: { path: "pkg/AGENTS.md" } }],
				[{ name: "read", arguments: { path: "pkg/a.ts" } }],
			],
			ON,
		);
		expect(result.developerTexts).toEqual([]);
	});

	it("caps each file and points at the rest", async () => {
		// Guards the per-file cost bound: an oversized file is truncated, not dropped or delivered whole.
		const big = `HEAD-CANARY\n${"x".repeat(NESTED_CONTEXT_FILE_MAX_CHARS)}TAIL-CANARY`;
		setup({ "pkg/AGENTS.md": big, "pkg/a.ts": "a" });
		const result = await run(tempDir, repo, [[{ name: "read", arguments: { path: "pkg/a.ts" } }]], ON);
		const text = result.developerTexts.join("\n");
		expect(text).toContain("HEAD-CANARY");
		expect(text).not.toContain("TAIL-CANARY");
		expect(text).toContain(
			`[truncated at ${NESTED_CONTEXT_FILE_MAX_CHARS} characters; read pkg/AGENTS.md for the rest]`,
		);
	});

	it("hands loaded files to subagents, and a session already holding a file does not load it again", async () => {
		// Guards subagent inheritance: the parent's loaded files reach the child's system prompt
		// with their content, and the child does not inject them a second time on its own touch.
		setup({ "pkg/AGENTS.md": "PKG-CANARY", "pkg/a.ts": "a" });
		const parent = await run(tempDir, repo, [[{ name: "read", arguments: { path: "pkg/a.ts" } }]], ON);
		expect(parent.carried).toEqual([{ path: path.join(repo, "pkg/AGENTS.md"), content: "PKG-CANARY" }]);

		const child = await run(tempDir, repo, [[{ name: "read", arguments: { path: "pkg/a.ts" } }]], ON, parent.carried);
		expect(child.contexts[0]?.systemPrompt?.join("\n")).toContain("PKG-CANARY");
		expect(child.developerTexts).toEqual([]);
	});
});

describe("inheritedContextFiles", () => {
	const nested = { path: "/repo/pkg/AGENTS.md", content: "PKG" };

	it("drops root AGENTS.md files and appends the parent's nested files", () => {
		const session = {
			contextFiles: [
				{ path: "/repo/AGENTS.md", content: "ROOT" },
				{ path: "/repo/CLAUDE.md", content: "CLAUDE" },
			],
			getNestedContextFiles: () => [nested],
		} as unknown as ToolSession;
		expect(inheritedContextFiles(session)).toEqual([{ path: "/repo/CLAUDE.md", content: "CLAUDE" }, nested]);
	});

	it("stays undefined when the parent has no resolved context files, so the child discovers its own", () => {
		// Guards child discovery: an empty array would disable it.
		const session = { getNestedContextFiles: () => [nested] } as unknown as ToolSession;
		expect(inheritedContextFiles(session)).toBeUndefined();
	});
});
