import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { hindsightBackend, rebindMemoryBackendForCwd } from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import { MEMORY_BACKEND_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/memory-backend/tool-names";
import { computeMnemopiBankScope } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { getMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { BUILTIN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { tinyModelClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import { getProjectAgentDir, getProjectDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

import { cfgAutolearnEnabled } from "@oh-my-pi/pi-coding-agent/autolearn/settings";
import {
	cfgHindsightApiToken,
	cfgHindsightApiUrl,
	cfgHindsightMentalModelsEnabled,
} from "@oh-my-pi/pi-coding-agent/hindsight/settings";
import { cfgMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/settings";
import { cfgMnemopiBank, cfgMnemopiRecallLimit, cfgMnemopiScoping } from "@oh-my-pi/pi-coding-agent/mnemopi/settings";

function createTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} memory tool`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
	};
}

interface RetainedSource {
	bankId: string;
	documentId: string;
	content: string;
	tags?: string[];
	metadata?: Record<string, string>;
}

interface HindsightWrite {
	method: "POST" | "DELETE";
	bankId: string;
	documentId: string;
	updateMode?: string;
	tags?: string[];
}

interface WireMemoryItem {
	content: string;
	document_id?: string;
	tags?: string[];
	metadata?: Record<string, string>;
	update_mode?: string;
}

/**
 * Loopback Hindsight server holding conversation sources keyed by bank and
 * document, so assertions read what the server would actually retain.
 */
class LoopbackHindsight {
	readonly sources = new Map<string, RetainedSource>();
	readonly writes: HindsightWrite[] = [];
	/** Decides each retain's HTTP status; 200 stores the item. */
	retainStatus: (item: WireMemoryItem) => number | Promise<number> = () => 200;
	/** Decides whether deleting a conversation source succeeds. */
	deleteStatus = 200;
	readonly #listeners = new Set<() => void>();
	readonly #server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: request => this.#handle(request),
	});

	get url(): string {
		return this.#server.url.href;
	}

	source(bankId: string, documentId: string): RetainedSource | undefined {
		return this.sources.get(`${bankId}\0${documentId}`);
	}

	containing(text: string): RetainedSource[] {
		return [...this.sources.values()].filter(source => source.content.includes(text));
	}

	/** Resolves once `predicate` holds, re-checked on every server-side change. */
	async until(predicate: () => boolean): Promise<void> {
		if (predicate()) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		const listener = () => {
			if (predicate()) resolve();
		};
		this.#listeners.add(listener);
		try {
			await promise;
		} finally {
			this.#listeners.delete(listener);
		}
	}

	async stop(): Promise<void> {
		await this.#server.stop(true);
	}

	#changed(): void {
		for (const listener of this.#listeners) listener();
	}

	async #handle(request: Request): Promise<Response> {
		// /v1/default/banks/{bank}/...
		const parts = new URL(request.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
		const bankId = parts[3] ?? "";
		const rest = parts.slice(4);
		if (request.method === "PUT" && rest.length === 0) return Response.json({});
		if (request.method === "POST" && rest.join("/") === "memories") {
			const body = (await request.json()) as { items: WireMemoryItem[] };
			for (const item of body.items) {
				const documentId = item.document_id ?? "";
				this.writes.push({ method: "POST", bankId, documentId, updateMode: item.update_mode, tags: item.tags });
				this.#changed();
				const status = await this.retainStatus(item);
				if (status !== 200) return new Response("unavailable", { status });
				this.sources.set(`${bankId}\0${documentId}`, {
					bankId,
					documentId,
					content: item.content,
					tags: item.tags,
					metadata: item.metadata,
				});
				this.#changed();
			}
			return Response.json({ success: true, bank_id: bankId, items_count: body.items.length, async: true });
		}
		if (request.method === "DELETE" && rest[0] === "documents" && rest[1]) {
			this.writes.push({ method: "DELETE", bankId, documentId: rest[1] });
			if (this.deleteStatus !== 200) return new Response("unavailable", { status: this.deleteStatus });
			this.sources.delete(`${bankId}\0${rest[1]}`);
			this.#changed();
			return Response.json({ success: true });
		}
		if (request.method === "POST" && rest.join("/") === "memories/recall") return Response.json({ results: [] });
		if (request.method === "GET" && rest.join("/") === "mental-models") return Response.json({ items: [] });
		return new Response("Unexpected request", { status: 404 });
	}
}

function only<T>(items: T[]): T {
	expect(items).toHaveLength(1);
	return items[0]!;
}

describe("AgentSession memory backend lifecycle", () => {
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let settings: Settings;
	let tempDir: TempDir;
	let hindsight: LoopbackHindsight | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@memory-backend-lifecycle-");
		authStorage = createInMemoryAuthStorage();
		settings = Settings.isolated({
			"compaction.enabled": false,
			"memory.backend": "off",
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
		});
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		await hindsight?.stop();
		hindsight = undefined;
		resetMemoryForTests();
		vi.restoreAllMocks();
		authStorage.close();
		// `Settings.loadIsolated` opens agent.db under tempDir; close it before the directory goes away.
		AgentStorage.close();
		tempDir.removeSync();
	});

	function createSession(
		createMemoryTools: () => Promise<AgentTool[]>,
		options: { responses?: MockResponseSource; sessionManager?: SessionManager } = {},
	): AgentSession {
		const model = buildModel({
			id: "mock",
			name: "mock",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		});
		// AgentSession validates the prompt key through the registry for the session model's provider;
		// without a runtime key it falls back to ambient env/~/.env credentials.
		authStorage.keys.setRuntime(model.provider, "test-key");
		const read = createTool("read");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [read] },
			streamFn: createMockModel({ responses: options.responses ?? [{ content: ["ok"] }, { content: ["ok"] }] })
				.stream,
		});
		const toolRegistry = new Map<string, AgentTool>([[read.name, read]]);
		session = new AgentSession({
			agent,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			memoryAgentDir: tempDir.path(),
			memoryTaskDepth: 0,
			createMemoryTools,
			toolRegistry,
			builtInToolNames: [read.name],
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`backend:${cfgMemoryBackend.get(settings)};tools:${toolNames.sort().join(",")}`],
			}),
		});
		return session;
	}

	async function startMemoryCompletion(models: Model<Api>[], thinking: readonly (string | undefined)[] = []) {
		const selectors = models.map((model, index) => {
			const level = thinking[index];
			return `${model.provider}/${model.id}${level ? `:${level}` : ""}`;
		});
		settings = Settings.isolated({
			"compaction.enabled": false,
			"memory.backend": "mnemopi",
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "smol",
			"mnemopi.autoRetain": false,
			modelRoles: { memory: selectors[0]! },
			"retry.fallbackChains": { memory: selectors.slice(1) },
		});
		const current = createSession(async () => []);
		for (const model of models) authStorage.keys.setRuntime(model.provider, "test-key");
		spyOn(current.modelRegistry, "getAvailable").mockReturnValue(models);
		spyOn(current.modelRegistry, "getApiKeyForProvider").mockResolvedValue(undefined);
		await current.applyMemoryBackend();
		const llm = getMnemopiSessionState(current)!.config.providerOptions.llm;
		const complete =
			typeof llm === "function"
				? llm
				: llm && typeof llm === "object" && "complete" in llm
					? llm.complete
					: undefined;
		if (!complete) throw new Error("Expected managed memory completion");
		return { current, complete };
	}

	function memoryReply(model: Model<Api>, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "Sam works at Globex." }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 8,
				output: 4,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12,
				cost: { input: 0.000024, output: 0.00006, cacheRead: 0, cacheWrite: 0, total: 0.000084 },
			},
			stopReason,
			errorMessage: stopReason === "error" ? "Invalid request" : undefined,
			timestamp: Date.now(),
		};
	}

	it("journals one remote memory completion with its reported usage on the active branch", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6")!;
		const response = memoryReply(model);
		spyOn(ai, "completeSimple").mockImplementation(async (_model, _context, options) => {
			options?.onAttempt?.(response);
			return response;
		});
		const { current, complete } = await startMemoryCompletion([model]);
		const manager = current.sessionManager;
		manager.appendMessage({ role: "user", content: "Remember Sam's employer.", timestamp: 1 });
		const leafBefore = manager.getLeafId();

		await complete("Sam works at Globex.");

		const usage = manager.getBranch().filter(entry => entry.type === "model_usage");
		expect(usage).toHaveLength(1);
		expect(usage[0]).toMatchObject({
			parentId: leafBefore,
			purpose: "memory",
			role: "memory",
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: response.usage,
			stopReason: "stop",
		});
		expect(manager.getLeafId()).toBe(usage[0]!.id);
	});

	it("journals both the billed memory failure and its successful remote fallback", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6")!;
		const backup = { ...model, id: "memory-backup" };
		const failed = memoryReply(model, "error");
		const succeeded = memoryReply(backup);
		spyOn(ai, "completeSimple").mockImplementation(async (candidate, _context, options) => {
			const response = candidate.id === model.id ? failed : succeeded;
			options?.onAttempt?.(response);
			return response;
		});
		const { current, complete } = await startMemoryCompletion([model, backup]);

		expect(await complete("Sam works at Globex.")).toBe("Sam works at Globex.");

		const usage = current.sessionManager.getBranch().filter(entry => entry.type === "model_usage");
		expect(usage).toHaveLength(2);
		expect(usage).toMatchObject([
			{
				purpose: "memory",
				role: "memory",
				model: model.id,
				usage: failed.usage,
				stopReason: "error",
				errorMessage: "Invalid request",
			},
			{ purpose: "memory", role: "memory", model: backup.id, usage: succeeded.usage, stopReason: "stop" },
		]);
	});

	it.each([
		{
			name: "an explicit level as the reasoning effort",
			suffix: "low",
			reasoning: "low",
			disableReasoning: undefined,
		},
		{ name: ":off as disabled reasoning", suffix: "off", reasoning: undefined, disableReasoning: true },
		{ name: "neither option without a suffix", suffix: undefined, reasoning: undefined, disableReasoning: undefined },
	])("sends the memory role's $name", async ({ suffix, reasoning, disableReasoning }) => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6")!;
		const sent: Array<{ reasoning: unknown; disableReasoning: unknown }> = [];
		spyOn(ai, "completeSimple").mockImplementation(async (_model, _context, options) => {
			sent.push({ reasoning: options?.reasoning, disableReasoning: options?.disableReasoning });
			return memoryReply(model);
		});
		const { complete } = await startMemoryCompletion([model], [suffix]);

		expect(await complete("Sam works at Globex.")).toBe("Sam works at Globex.");
		expect(sent).toEqual([{ reasoning, disableReasoning }]);
	});

	it("sends each memory fallback candidate its own thinking suffix", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6")!;
		const backup = { ...model, id: "memory-backup" };
		const sent: Array<{ model: string; reasoning: unknown; disableReasoning: unknown }> = [];
		spyOn(ai, "completeSimple").mockImplementation(async (candidate, _context, options) => {
			sent.push({ model: candidate.id, reasoning: options?.reasoning, disableReasoning: options?.disableReasoning });
			return memoryReply(candidate, candidate.id === model.id ? "error" : "stop");
		});
		const { complete } = await startMemoryCompletion([model, backup], ["off", "high"]);

		expect(await complete("Sam works at Globex.")).toBe("Sam works at Globex.");
		expect(sent).toEqual([
			{ model: model.id, reasoning: undefined, disableReasoning: true },
			{ model: backup.id, reasoning: "high", disableReasoning: undefined },
		]);
	});

	it("does not journal unbilled local-inference memory completions", async () => {
		const model = getBundledModel("local", "qwen2.5-1.5b")!;
		spyOn(tinyModelClient, "complete").mockResolvedValue("Sam works at Globex.");
		const { current, complete } = await startMemoryCompletion([model]);

		expect(await complete("Sam works at Globex.")).toBe("Sam works at Globex.");
		expect(current.sessionManager.getBranch().filter(entry => entry.type === "model_usage")).toEqual([]);
	});

	it("drops a late memory usage entry after the session changes", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6")!;
		const started = Promise.withResolvers<void>();
		const response = Promise.withResolvers<AssistantMessage>();
		spyOn(ai, "completeSimple").mockImplementation(async (_model, _context, options) => {
			started.resolve();
			const message = await response.promise;
			options?.onAttempt?.(message);
			return message;
		});
		const { current, complete } = await startMemoryCompletion([model]);
		const pending = complete("Sam works at Globex.");
		await started.promise;
		await current.sessionManager.newSession();
		response.resolve(memoryReply(model));

		expect(await pending).toBe("Sam works at Globex.");
		expect(current.sessionManager.getBranch().filter(entry => entry.type === "model_usage")).toEqual([]);
	});

	it("journals a successful memory completion on the session that started after a switch", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6")!;
		const response = memoryReply(model);
		spyOn(ai, "completeSimple").mockImplementation(async (_model, _context, options) => {
			options?.onAttempt?.(response);
			return response;
		});
		const { current, complete } = await startMemoryCompletion([model]);
		const previousSessionId = current.sessionManager.getSessionId();
		await current.sessionManager.newSession();
		expect(current.sessionManager.getSessionId()).not.toBe(previousSessionId);
		current.sessionManager.appendMessage({ role: "user", content: "Remember Sam's employer.", timestamp: 1 });
		const leafBefore = current.sessionManager.getLeafId();

		expect(await complete("Sam works at Globex.")).toBe("Sam works at Globex.");

		const usage = current.sessionManager.getBranch().filter(entry => entry.type === "model_usage");
		expect(usage).toHaveLength(1);
		expect(usage[0]).toMatchObject({
			parentId: leafBefore,
			purpose: "memory",
			role: "memory",
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: response.usage,
			stopReason: "stop",
		});
	});

	it("removes unusable Hindsight tools after a cwd reload clears the URL and restores them when configured", async () => {
		const apiUrl = "http://127.0.0.1:1";
		cfgMemoryBackend.override(settings, "hindsight");
		cfgHindsightApiUrl.override(settings, apiUrl);
		cfgHindsightMentalModelsEnabled.override(settings, false);
		cfgAutolearnEnabled.override(settings, true);
		const toolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			settings,
			getHindsightSessionState: () => session?.getHindsightSessionState(),
		} as ToolSession;
		const current = createSession(async () => {
			const tools = await Promise.all(MEMORY_BACKEND_TOOL_NAMES.map(name => BUILTIN_TOOLS[name](toolSession)));
			return tools.filter((tool): tool is AgentTool => tool !== null);
		});
		await current.applyMemoryBackend();
		expect(current.getActiveToolNames()).toEqual(expect.arrayContaining(["recall", "retain", "reflect", "learn"]));

		cfgHindsightApiUrl.override(settings, "");
		await settings.reloadForCwd(path.join(tempDir.path(), "destination"));
		await rebindMemoryBackendForCwd(current);

		expect(current.getHindsightSessionState()).toBeUndefined();
		expect(current.getAllToolNames()).toEqual(["read"]);
		expect(current.getActiveToolNames()).toEqual(["read"]);

		cfgHindsightApiUrl.override(settings, apiUrl);
		await settings.reloadForCwd(path.join(tempDir.path(), "source"));
		await rebindMemoryBackendForCwd(current);
		expect(current.getHindsightSessionState()).toBeDefined();
		expect(current.getActiveToolNames()).toEqual(expect.arrayContaining(["recall", "retain", "reflect", "learn"]));
	});

	it("applies memory settings edited mid-session before the next prompt", async () => {
		const current = createSession(async () =>
			cfgMemoryBackend.get(settings) === "mnemopi" ? [createTool("retain")] : [],
		);

		cfgMemoryBackend.override(settings, "mnemopi");
		await current.prompt("first");
		const started = getMnemopiSessionState(current);
		expect(started?.config.recallLimit).toBe(8);
		expect(current.getActiveToolNames()).toEqual(["read", "retain"]);

		cfgMnemopiRecallLimit.override(settings, 2);
		await current.prompt("second");
		const rebuilt = getMnemopiSessionState(current);
		expect(rebuilt).not.toBe(started);
		expect(rebuilt?.config.recallLimit).toBe(2);
	});

	it("switches runtime state, memory tools, and prompt in one apply", async () => {
		const current = createSession(async () =>
			cfgMemoryBackend.get(settings) === "mnemopi" ? [createTool("retain"), createTool("memory_edit")] : [],
		);

		cfgMemoryBackend.override(settings, "mnemopi");
		await current.applyMemoryBackend();

		expect(getMnemopiSessionState(current)).toBeDefined();
		expect(current.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "retain", "memory_edit"]));
		expect(current.systemPrompt).toEqual(["backend:mnemopi;tools:memory_edit,read,retain"]);

		cfgMemoryBackend.override(settings, "off");
		await current.applyMemoryBackend();

		expect(getMnemopiSessionState(current)).toBeUndefined();
		expect(current.getActiveToolNames()).toEqual(["read"]);
		expect(current.getAllToolNames()).toEqual(["read"]);
		expect(current.systemPrompt).toEqual(["backend:off;tools:read"]);
	});
	it.each([
		["mnemopi", "mnemopi"],
		["mnemopi", "off"],
		["off", "mnemopi"],
	] as const)("rebinds %s to %s on a cwd move without Hindsight", async (source, destination) => {
		cfgMemoryBackend.override(settings, source);
		await settings.reloadForCwd(path.join(tempDir.path(), "source"));
		const current = createSession(async () =>
			cfgMemoryBackend.get(settings) === "mnemopi" ? [createTool("retain")] : [],
		);
		await current.applyMemoryBackend();

		const destinationCwd = path.join(tempDir.path(), "destination");
		current.sessionManager.setCwdWithoutRelocation(destinationCwd);
		cfgMemoryBackend.override(settings, destination);
		await settings.reloadForCwd(destinationCwd);
		await rebindMemoryBackendForCwd(current);

		const state = getMnemopiSessionState(current);
		if (destination === "mnemopi") {
			const scope = computeMnemopiBankScope(
				cfgMnemopiBank.get(settings),
				destinationCwd,
				cfgMnemopiScoping.get(settings),
			);
			expect(state?.config.retainBank).toBe(scope.retainBank);
			expect(state?.config.recallBanks).toEqual(scope.recallBanks);
			expect(current.getActiveToolNames()).toEqual(["read", "retain"]);
			expect(current.systemPrompt).toEqual(["backend:mnemopi;tools:read,retain"]);
		} else {
			expect(state).toBeUndefined();
			expect(current.getActiveToolNames()).toEqual(["read"]);
			expect(current.getAllToolNames()).toEqual(["read"]);
			expect(current.systemPrompt).toEqual(["backend:off;tools:read"]);
		}
	});

	it.each([false, true])("headless /move suppresses teardown retention (rollback: %s)", async rollback => {
		const sourceCwd = tempDir.path();
		const destinationCwd = path.join(sourceCwd, "destination");
		await Promise.all(
			[sourceCwd, destinationCwd].map(cwd =>
				Bun.write(
					path.join(getProjectAgentDir(cwd), "config.yml"),
					Bun.YAML.stringify({
						memory: { backend: "mnemopi" },
						mnemopi: {
							scoping: "per-project",
							autoRetain: true,
							noEmbeddings: true,
							llmMode: "none",
						},
					}),
				),
			),
		);
		settings = await Settings.loadIsolated({ cwd: sourceCwd, agentDir: path.join(sourceCwd, "agent") });
		const current = createSession(async () => []);
		await current.applyMemoryBackend();
		current.sessionManager.appendMessage({
			role: "user",
			content: "The source project uses a dedicated release branch for production deployments.",
			timestamp: Date.now(),
		});
		const sourceDbPath = getMnemopiSessionState(current)!.memory.dbPath!;
		let destinationDbPath: string | undefined;
		const output: string[] = [];
		const originalProjectDir = getProjectDir();
		try {
			await executeAcpBuiltinSlashCommand("/move " + destinationCwd, {
				session: current,
				sessionManager: current.sessionManager,
				settings,
				cwd: sourceCwd,
				output: text => {
					output.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {
					if (current.sessionManager.getCwd() !== destinationCwd) return;
					destinationDbPath = getMnemopiSessionState(current)!.memory.dbPath!;
					if (rollback) throw new Error("destination plugin rescope failed");
				},
			});
		} finally {
			setProjectDir(originalProjectDir);
		}
		const committedCwd = rollback ? sourceCwd : destinationCwd;
		expect(current.sessionManager.getCwd()).toBe(committedCwd);
		expect(output).toContainEqual(
			expect.stringContaining(rollback ? "destination plugin rescope failed" : destinationCwd),
		);
		expect(destinationDbPath).toBeDefined();
		expect(destinationDbPath).not.toBe(sourceDbPath);
		const transcriptRows = (dbPath: string) => {
			const db = new Database(dbPath, { readonly: true });
			try {
				return db
					.query(
						"SELECT json_extract(metadata_json, '$.cwd') AS cwd FROM working_memory WHERE source = 'coding-agent-transcript'",
					)
					.all();
			} finally {
				db.close();
			}
		};
		expect(transcriptRows(sourceDbPath)).toEqual([]);
		expect(transcriptRows(destinationDbPath!)).toEqual([]);

		// Ordinary backend changes still retain once, in the committed project.
		cfgMemoryBackend.override(settings, "off");
		await current.applyMemoryBackend();
		expect(transcriptRows(sourceDbPath)).toEqual(rollback ? [{ cwd: sourceCwd }] : []);
		expect(transcriptRows(destinationDbPath!)).toEqual(rollback ? [] : [{ cwd: destinationCwd }]);
	});

	it.each(["mnemopi", "hindsight"] as const)(
		"headless /move rolls back from %s when destination Mnemopi cannot open its database",
		async source => {
			const sourceCwd = tempDir.path();
			const destinationCwd = path.join(sourceCwd, "destination");
			const sourceDbPath = path.join(sourceCwd, "source.db");
			const destinationConfig = path.join(getProjectAgentDir(destinationCwd), "config.yml");
			const mnemopi = { scoping: "global", autoRetain: false, noEmbeddings: true, llmMode: "none" };
			await Bun.write(
				path.join(getProjectAgentDir(sourceCwd), "config.yml"),
				Bun.YAML.stringify({
					memory: { backend: source },
					mnemopi: { ...mnemopi, dbPath: sourceDbPath },
					hindsight: { apiUrl: "http://127.0.0.1:1", mentalModelsEnabled: false },
				}),
			);
			// An existing directory is not a SQLite database, regardless of filesystem permissions.
			await Bun.write(
				destinationConfig,
				Bun.YAML.stringify({ memory: { backend: "mnemopi" }, mnemopi: { ...mnemopi, dbPath: sourceCwd } }),
			);
			settings = await Settings.loadIsolated({ cwd: sourceCwd, agentDir: path.join(sourceCwd, "agent") });
			const toolSession = {
				cwd: sourceCwd,
				hasUI: false,
				settings,
				getHindsightSessionState: () => session?.getHindsightSessionState(),
				getMnemopiSessionState: () => session?.getMnemopiSessionState(),
			} as ToolSession;
			const current = createSession(async () => {
				const tools = await Promise.all(MEMORY_BACKEND_TOOL_NAMES.map(name => BUILTIN_TOOLS[name](toolSession)));
				return tools.filter((tool): tool is AgentTool => tool !== null);
			});
			await current.applyMemoryBackend();
			const sourceTools = current.getActiveToolNames();
			const sourcePrompt = current.systemPrompt;
			const sourceBank = source === "hindsight" ? current.getHindsightSessionState()!.bankId : undefined;
			const output: string[] = [];
			const runtime = {
				session: current,
				sessionManager: current.sessionManager,
				settings,
				cwd: sourceCwd,
				output: (text: string) => {
					output.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			};
			const originalProjectDir = getProjectDir();
			try {
				await executeAcpBuiltinSlashCommand("/move " + destinationCwd, runtime);
				expect(output).toContainEqual(expect.stringMatching(/Move failed:.*Mnemopi/));
				expect(current.sessionManager.getCwd()).toBe(sourceCwd);
				expect(cfgMemoryBackend.get(settings)).toBe(source);
				expect(current.getActiveToolNames()).toEqual(sourceTools);
				expect(current.systemPrompt).toEqual(sourcePrompt);
				if (source === "mnemopi") {
					expect(current.getMnemopiSessionState()?.memory.dbPath).toBe(sourceDbPath);
				} else {
					expect(current.getHindsightSessionState()?.bankId).toBe(sourceBank);
				}

				// Repair the destination and retry the same command; the installed tool must really write there.
				const destinationDbPath = path.join(destinationCwd, "memory.db");
				await Bun.write(
					destinationConfig,
					Bun.YAML.stringify({
						memory: { backend: "mnemopi" },
						mnemopi: { ...mnemopi, dbPath: destinationDbPath },
					}),
				);
				await executeAcpBuiltinSlashCommand("/move " + destinationCwd, runtime);
				expect(current.sessionManager.getCwd()).toBe(destinationCwd);
				await current.getToolByName("retain")!.execute("after-move", {
					items: [{ content: "The destination project deploys from its release branch." }],
				});
				const db = new Database(destinationDbPath, { readonly: true });
				try {
					expect(
						db.query("SELECT content FROM working_memory WHERE source = 'coding-agent-retain'").all(),
					).toEqual([{ content: "The destination project deploys from its release branch." }]);
				} finally {
					db.close();
				}
			} finally {
				setProjectDir(originalProjectDir);
			}
		},
	);

	// The re-scope's settings listener starts the backend switch; the rebind must
	// judge the destination only once that switch settled, however many
	// microtasks separate the reload from the rebind.
	it.each([0, 1].flatMap(hops => [[hops, true] as const, [hops, false] as const]))(
		"headless /move from Hindsight settles a pending Mnemopi switch (%i reload hops, destination usable: %p)",
		async (hops, usable) => {
			const sourceCwd = tempDir.path();
			const destinationCwd = path.join(sourceCwd, "destination");
			const destinationDbPath = path.join(destinationCwd, "memory.db");
			await Bun.write(
				path.join(getProjectAgentDir(sourceCwd), "config.yml"),
				Bun.YAML.stringify({
					memory: { backend: "hindsight" },
					hindsight: { apiUrl: "http://127.0.0.1:1", mentalModelsEnabled: false },
				}),
			);
			await Bun.write(
				path.join(getProjectAgentDir(destinationCwd), "config.yml"),
				Bun.YAML.stringify({
					memory: { backend: "mnemopi" },
					mnemopi: {
						scoping: "global",
						autoRetain: false,
						noEmbeddings: true,
						llmMode: "none",
						// An existing directory is not a SQLite database.
						dbPath: usable ? destinationDbPath : sourceCwd,
					},
				}),
			);
			settings = await Settings.loadIsolated({ cwd: sourceCwd, agentDir: path.join(sourceCwd, "agent") });
			const current = createSession(async () => [
				createTool(cfgMemoryBackend.get(settings) === "hindsight" ? "recall" : "retain"),
			]);
			await current.applyMemoryBackend();
			const sourceBank = current.getHindsightSessionState()?.bankId;
			const sourcePrompt = current.systemPrompt;
			expect(sourceBank).toBeDefined();

			// Park every backend startup behind a macrotask, so the switch the
			// re-scope starts is still pending wherever the rebind first looks.
			const startSpies = [mnemopiBackend, hindsightBackend].map(backend => {
				const start = backend.start;
				return spyOn(backend, "start").mockImplementation(async options => {
					await new Promise<void>(resolve => setImmediate(resolve));
					await start.call(backend, options);
				});
			});
			const reload = settings.reloadForCwd;
			const reloadSpy = spyOn(settings, "reloadForCwd").mockImplementation(async cwd => {
				await reload.call(settings, cwd);
				for (let i = 0; i < hops; i++) await Promise.resolve();
			});
			const output: string[] = [];
			const originalProjectDir = getProjectDir();
			try {
				await executeAcpBuiltinSlashCommand("/move " + destinationCwd, {
					session: current,
					sessionManager: current.sessionManager,
					settings,
					cwd: sourceCwd,
					output: text => {
						output.push(text);
					},
					refreshCommands: () => {},
					reloadPlugins: async () => {},
				});
			} finally {
				for (const spy of startSpies) spy.mockRestore();
				reloadSpy.mockRestore();
				setProjectDir(originalProjectDir);
			}
			if (usable) {
				expect(output.join("\n")).not.toContain("Move failed");
				expect(current.sessionManager.getCwd()).toBe(destinationCwd);
				expect(current.getHindsightSessionState()).toBeUndefined();
				expect(getMnemopiSessionState(current)?.memory.dbPath).toBe(destinationDbPath);
				expect(current.getActiveToolNames()).toEqual(["read", "retain"]);
			} else {
				expect(output).toContainEqual(expect.stringMatching(/Move failed:.*Mnemopi/));
				expect(current.sessionManager.getCwd()).toBe(sourceCwd);
				expect(getMnemopiSessionState(current)).toBeUndefined();
				expect(current.getHindsightSessionState()?.bankId).toBe(sourceBank);
				expect(current.getActiveToolNames()).toEqual(["read", "recall"]);
				expect(current.systemPrompt).toEqual(sourcePrompt);
			}
		},
	);

	it("cancels a displaced local startup generation", async () => {
		const current = createSession(async () => []);
		const localStartup = current.beginLocalMemoryStartup();

		await current.applyMemoryBackend();

		expect(localStartup.aborted).toBe(true);
	});

	it("serializes concurrent backend applies", async () => {
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let calls = 0;
		let running = 0;
		let maxRunning = 0;
		const current = createSession(async () => {
			calls++;
			running++;
			maxRunning = Math.max(maxRunning, running);
			if (calls === 1) {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			running--;
			return [];
		});

		const first = current.applyMemoryBackend();
		await firstStarted.promise;
		const second = current.applyMemoryBackend();
		await Promise.resolve();
		expect(calls).toBe(1);
		releaseFirst.resolve();
		await Promise.all([first, second]);

		expect(maxRunning).toBe(1);
		expect(calls).toBe(2);
	});

	it("applies the destination project's memory backend on a cwd move", async () => {
		cfgMemoryBackend.override(settings, "hindsight");
		cfgHindsightMentalModelsEnabled.override(settings, false);
		const current = createSession(async () =>
			cfgMemoryBackend.get(settings) === "hindsight" ? [createTool("recall"), createTool("retain")] : [],
		);

		await current.applyMemoryBackend();
		expect(current.getHindsightSessionState()).toBeDefined();
		expect(current.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "recall", "retain"]));

		cfgMemoryBackend.override(settings, "off");
		await rebindMemoryBackendForCwd(current);

		expect(current.getHindsightSessionState()).toBeUndefined();
		expect(current.getActiveToolNames()).toEqual(["read"]);
	});

	// A hook-triggered retry may find teardown already done; that no-op must preserve the failure.
	it.each([false, true])("reports destination rebind failures (coalesced no-op: %s)", async coalesced => {
		cfgMemoryBackend.override(settings, "hindsight");
		cfgHindsightMentalModelsEnabled.override(settings, false);
		let failToolBuild = false;
		const current = createSession(async () => {
			if (failToolBuild) throw new Error("destination memory tools unavailable");
			return cfgMemoryBackend.get(settings) === "hindsight" ? [createTool("recall")] : [];
		});

		await current.applyMemoryBackend();
		expect(current.getHindsightSessionState()).toBeDefined();
		cfgMemoryBackend.override(settings, "off");
		failToolBuild = true;
		if (coalesced) await settings.reloadForCwd(path.join(tempDir.path(), "destination"));

		await expect(rebindMemoryBackendForCwd(current)).rejects.toThrow("destination memory tools unavailable");
	});

	describe("Hindsight retained sources at session boundaries", () => {
		const alphaQuestion = "Which branch does the alpha service deploy from?";
		const alphaAnswer = "The alpha service deploys from the release-alpha branch every Tuesday.";
		const betaQuestion = "Which database does the beta service use?";
		const betaAnswer = "The beta service stores orders in a dedicated Postgres cluster named beta-orders.";
		const returnQuestion = "What changed in the alpha service after the beta work?";
		const returnAnswer = "The alpha service now pins its build image to the alpha-builder tag.";

		function useHindsight(overrides: Record<string, unknown> = {}): LoopbackHindsight {
			const server = new LoopbackHindsight();
			hindsight = server;
			settings = Settings.isolated({
				"compaction.enabled": false,
				"memory.backend": "hindsight",
				"hindsight.apiUrl": server.url,
				"hindsight.scoping": "per-project-tagged",
				"hindsight.autoRecall": false,
				"hindsight.mentalModelsEnabled": false,
				"hindsight.mentalModelAutoSeed": false,
				"hindsight.retainEveryNTurns": 2,
				...overrides,
			});
			return server;
		}

		function projectDirs(): { alpha: string; beta: string } {
			const alpha = path.join(tempDir.path(), "alpha");
			const beta = path.join(tempDir.path(), "beta");
			fs.mkdirSync(alpha, { recursive: true });
			fs.mkdirSync(beta, { recursive: true });
			return { alpha, beta };
		}

		function scopeOf(current: AgentSession): { bankId: string; tags: string[] | undefined } {
			const state = current.getHindsightSessionState();
			if (!state) throw new Error("Expected an active Hindsight state");
			return { bankId: state.bankId, tags: state.retainTags };
		}

		async function runHeadless(
			current: AgentSession,
			command: string,
			reloadPlugins: () => Promise<void> = async () => {},
		): Promise<string> {
			const output: string[] = [];
			const originalProjectDir = getProjectDir();
			try {
				await executeAcpBuiltinSlashCommand(command, {
					session: current,
					sessionManager: current.sessionManager,
					settings,
					cwd: current.sessionManager.getCwd(),
					output: text => {
						output.push(text);
					},
					refreshCommands: () => {},
					reloadPlugins,
				});
			} finally {
				setProjectDir(originalProjectDir);
			}
			return output.join("\n");
		}

		function branchMessage(current: AgentSession, role: "user" | "assistant", text: string) {
			const entry = current.sessionManager
				.getBranch()
				.find(
					candidate =>
						candidate.type === "message" &&
						candidate.message.role === role &&
						JSON.stringify(candidate.message.content).includes(text),
				);
			if (!entry) throw new Error(`Expected a ${role} entry containing ${text}`);
			return entry;
		}

		function branchUserTurns(current: AgentSession): number {
			return current.sessionManager
				.getBranch()
				.filter(entry => entry.type === "message" && entry.message.role === "user").length;
		}

		/** Alpha turn, move to beta, beta turn, move back, return-alpha turn, then explicit `/memory enqueue`. */
		async function writeAcrossProjects(current: AgentSession, dirs: { alpha: string; beta: string }) {
			const server = hindsight!;
			await current.applyMemoryBackend();
			const alpha = scopeOf(current);
			await current.prompt(alphaQuestion);
			expect(await runHeadless(current, `/move ${dirs.beta}`)).not.toContain("Move failed");
			const beta = scopeOf(current);
			await current.prompt(betaQuestion);
			expect(await runHeadless(current, `/move ${dirs.alpha}`)).not.toContain("Move failed");
			expect(scopeOf(current)).toEqual(alpha);
			await current.prompt(returnQuestion);
			await runHeadless(current, "/memory enqueue");
			expect(server.sources.size).toBe(3);
			return {
				alpha,
				beta,
				initial: only(server.containing(alphaAnswer)),
				betaSource: only(server.containing(betaAnswer)),
				returned: only(server.containing(returnAnswer)),
			};
		}

		it("moving a Hindsight session finishes the source scope before destination writes", async () => {
			const server = useHindsight();
			const dirs = projectDirs();
			const current = createSession(async () => [], {
				sessionManager: SessionManager.inMemory(dirs.alpha),
				responses: [{ content: [alphaAnswer] }, { content: [betaAnswer] }, { content: [returnAnswer] }],
			});
			await current.applyMemoryBackend();
			const alpha = scopeOf(current);
			await current.prompt(alphaQuestion);
			// One turn is below the two-turn cadence: nothing is retained yet.
			expect(server.writes).toEqual([]);

			const release = Promise.withResolvers<void>();
			server.retainStatus = async () => {
				await release.promise;
				return 200;
			};
			const moving = runHeadless(current, `/move ${dirs.beta}`);
			await server.until(() => server.writes.length > 0);
			// The move waits on the source-scope retain and has not changed cwd or scope yet.
			expect(current.sessionManager.getCwd()).toBe(dirs.alpha);
			expect(scopeOf(current)).toEqual(alpha);
			expect(server.writes).toEqual([
				{
					method: "POST",
					bankId: alpha.bankId,
					documentId: current.sessionManager.getSessionId(),
					updateMode: "replace",
					tags: alpha.tags,
				},
			]);
			release.resolve();
			expect(await moving).not.toContain("Move failed");
			expect(current.sessionManager.getCwd()).toBe(dirs.beta);
			const beta = scopeOf(current);
			expect(beta.tags).not.toEqual(alpha.tags);
			server.retainStatus = () => 200;

			await current.prompt(betaQuestion);
			expect(await runHeadless(current, `/move ${dirs.alpha}`)).not.toContain("Move failed");
			expect(scopeOf(current)).toEqual(alpha);
			await current.prompt(returnQuestion);
			await runHeadless(current, "/memory enqueue");

			expect(server.sources.size).toBe(3);
			const initial = only(server.containing(alphaAnswer));
			const betaSource = only(server.containing(betaAnswer));
			const returned = only(server.containing(returnAnswer));
			expect(initial).toMatchObject({ bankId: alpha.bankId, tags: alpha.tags });
			expect(initial.content).toContain(alphaQuestion);
			expect(betaSource).toMatchObject({ bankId: beta.bankId, tags: beta.tags });
			expect(betaSource.content).toContain(betaQuestion);
			expect(betaSource.content).not.toContain(alphaQuestion);
			expect(returned).toMatchObject({ bankId: alpha.bankId, tags: alpha.tags });
			expect(returned.content).toContain(returnQuestion);
			for (const text of [alphaQuestion, alphaAnswer, betaQuestion, betaAnswer]) {
				expect(returned.content).not.toContain(text);
			}
			expect(new Set([initial.documentId, betaSource.documentId, returned.documentId]).size).toBe(3);
			for (const source of [initial, betaSource, returned]) {
				expect(source.metadata?.session_id).toBe(current.sessionManager.getSessionId());
			}
			// No destination-scope write precedes the first source-scope write.
			const firstBetaWrite = server.writes.findIndex(write => Bun.deepEquals(write.tags, beta.tags));
			expect(firstBetaWrite).toBeGreaterThan(0);
		});

		it.each([false, true])(
			"a last-turn cross-scope move posts its outgoing window once (redundant retain fails: %s)",
			async failRedundant => {
				const server = useHindsight({ "hindsight.retainMode": "last-turn" });
				const dirs = projectDirs();
				const current = createSession(async () => [], {
					sessionManager: SessionManager.inMemory(dirs.alpha),
					responses: [{ content: [alphaAnswer] }],
				});
				await current.applyMemoryBackend();
				const alpha = scopeOf(current);
				await current.prompt(alphaQuestion);
				let retains = 0;
				server.retainStatus = () => (++retains > 1 && failRedundant ? 503 : 200);

				expect(await runHeadless(current, `/move ${dirs.beta}`)).not.toContain("Move failed");

				expect(current.sessionManager.getCwd()).toBe(dirs.beta);
				expect(server.writes).toHaveLength(1);
				expect(server.writes[0]).toMatchObject({ method: "POST", bankId: alpha.bankId, tags: alpha.tags });
				expect(only(server.containing(alphaAnswer)).content).toContain(alphaQuestion);
			},
		);

		it("a failed last-turn cross-scope move preserves its receipt so rewind deletes the accepted source", async () => {
			const server = useHindsight({ "hindsight.retainMode": "last-turn" });
			const dirs = projectDirs();
			const current = createSession(async () => [], {
				sessionManager: SessionManager.inMemory(dirs.alpha),
				responses: [{ content: [alphaAnswer] }],
			});
			await current.applyMemoryBackend();
			const alpha = scopeOf(current);
			await current.prompt(alphaQuestion);
			const firstUser = branchMessage(current, "user", alphaQuestion);

			const output = await runHeadless(current, `/move ${dirs.beta}`, async () => {
				if (current.sessionManager.getCwd() === dirs.beta) throw new Error("destination plugin rescope failed");
			});

			expect(output).toContain("destination plugin rescope failed");
			expect(current.sessionManager.getCwd()).toBe(dirs.alpha);
			expect(scopeOf(current)).toEqual(alpha);
			const accepted = server.writes[0]!;
			expect(accepted.method).toBe("POST");
			const source = server.source(alpha.bankId, accepted.documentId)!;
			expect(source.content).toContain(alphaAnswer);
			expect(source.documentId).not.toBe(current.sessionId);
			expect(
				current.sessionManager
					.getEntries()
					.filter(entry => entry.type === "custom" && entry.customType === "hindsight_retention_document"),
			).toContainEqual(
				expect.objectContaining({ data: expect.objectContaining({ documentId: source.documentId }) }),
			);

			expect((await current.navigateTree(firstUser.id, { summarize: false })).cancelled).toBe(false);
			expect(server.sources.size).toBe(0);
			expect(server.writes.at(-1)).toEqual({
				method: "DELETE",
				bankId: alpha.bankId,
				documentId: source.documentId,
			});
		});

		it.each(["apiUrl", "apiToken"] as const)(
			"changing hindsight.%s leaves another account's receipt live until its owning account returns",
			async setting => {
				// Account switching must not be masked by an ambient HINDSIGHT_API_TOKEN.
				spyOn(cfgHindsightApiToken, "envValue").mockReturnValue(undefined);
				const server = useHindsight({
					"hindsight.retainMode": "last-turn",
					"hindsight.apiToken": "account-a-secret",
				});
				const other = setting === "apiUrl" ? new LoopbackHindsight() : server;
				try {
					const current = createSession(async () => [], { responses: [{ content: [alphaAnswer] }] });
					await current.applyMemoryBackend();
					await current.prompt(alphaQuestion);
					await current.getHindsightSessionState()!.forceRetainCurrentSession();
					const source = only(server.containing(alphaAnswer));
					const firstUser = branchMessage(current, "user", alphaQuestion);
					const changeAccount = async (account: "a" | "b") => {
						if (setting === "apiUrl")
							cfgHindsightApiUrl.override(settings, account === "a" ? server.url : other.url);
						else cfgHindsightApiToken.override(settings, `account-${account}-secret`);
						await hindsightBackend.applySettings!(current, [`hindsight.${setting}`]);
					};
					const receipt = () =>
						current.sessionManager
							.getEntries()
							.findLast(
								entry =>
									entry.type === "custom" &&
									entry.customType === "hindsight_retention_document" &&
									typeof entry.data === "object" &&
									entry.data !== null &&
									"documentId" in entry.data &&
									entry.data.documentId === source.documentId,
							);

					await changeAccount("b");
					const writesBeforeRewind = other.writes.length;
					expect((await current.navigateTree(firstUser.id, { summarize: false })).cancelled).toBe(false);
					expect(other.writes.slice(writesBeforeRewind)).toEqual([]);
					expect(server.source(source.bankId, source.documentId)).toEqual(source);
					expect(receipt()).toMatchObject({ data: { documentId: source.documentId } });
					expect(receipt()).not.toMatchObject({ data: { deleted: true } });
					const ledger = JSON.stringify(current.sessionManager.getEntries());
					expect(ledger).not.toContain("account-a-secret");
					expect(ledger).not.toContain("account-b-secret");

					await changeAccount("a");
					await current.getHindsightSessionState()!.synchronizeRetainedBranch();
					expect(server.source(source.bankId, source.documentId)).toBeUndefined();
					expect(server.writes.at(-1)).toEqual({
						method: "DELETE",
						bankId: source.bankId,
						documentId: source.documentId,
					});
					expect(receipt()).toMatchObject({ data: { deleted: true } });
				} finally {
					if (other !== server) await other.stop();
				}
			},
		);

		it("new session drains an in-flight agent-end retain into its originating ledger", async () => {
			const server = useHindsight({ "hindsight.retainEveryNTurns": 1 });
			const dirs = projectDirs();
			const manager = SessionManager.create(dirs.alpha, path.join(tempDir.path(), "sessions"));
			const current = createSession(async () => [], {
				sessionManager: manager,
				responses: [{ content: [alphaAnswer] }],
			});
			await current.applyMemoryBackend();
			const originatingId = manager.getSessionId();
			const state = current.getHindsightSessionState()!;
			const release = Promise.withResolvers<number>();
			server.retainStatus = () => release.promise;
			await current.prompt(alphaQuestion);
			await server.until(() => server.writes.length === 1);
			const originatingFile = manager.getSessionFile()!;
			const drainStarted = Promise.withResolvers<void>();
			const flushRetainQueue = state.flushRetainQueue.bind(state);
			spyOn(state, "flushRetainQueue").mockImplementation(() => {
				drainStarted.resolve();
				return flushRetainQueue();
			});
			const switching = current.newSession();
			try {
				// Release only once the transition drains retention or has incorrectly swapped ledgers.
				await Promise.race([switching, drainStarted.promise]);
			} finally {
				release.resolve(200);
			}
			expect(await switching).toBe(true);
			await state.flushRetainQueue();
			expect(manager.getSessionId()).not.toBe(originatingId);
			expect(
				manager
					.getEntries()
					.filter(entry => entry.type === "custom" && entry.customType === "hindsight_retention_document"),
			).toEqual([]);
			const originating = await SessionManager.open(originatingFile);
			try {
				const receipts = originating
					.getEntries()
					.filter(entry => entry.type === "custom" && entry.customType === "hindsight_retention_document");
				expect(receipts).toHaveLength(1);
				expect(receipts[0]).toMatchObject({
					data: { sessionId: originatingId, documentId: server.writes[0]!.documentId },
				});
			} finally {
				await originating.close();
			}
		});

		it("a source retention failure leaves a Hindsight move in the source project", async () => {
			const server = useHindsight();
			const dirs = projectDirs();
			const current = createSession(async () => [], {
				sessionManager: SessionManager.inMemory(dirs.alpha),
				responses: [{ content: [alphaAnswer] }],
			});
			await current.applyMemoryBackend();
			const alpha = scopeOf(current);
			const sourceBackend = cfgMemoryBackend.get(settings);
			await current.prompt(alphaQuestion);
			server.retainStatus = () => 503;

			expect(await runHeadless(current, `/move ${dirs.beta}`)).toContain("Move failed");

			expect(current.sessionManager.getCwd()).toBe(dirs.alpha);
			expect(cfgMemoryBackend.get(settings)).toBe(sourceBackend);
			expect(scopeOf(current)).toEqual(alpha);
			expect(server.writes.length).toBeGreaterThan(0);
			for (const write of server.writes) {
				expect(write).toMatchObject({ method: "POST", bankId: alpha.bankId, tags: alpha.tags });
			}
			expect(server.sources.size).toBe(0);
		});

		it("tree navigation repairs retained sources before returning without another prompt", async () => {
			const server = useHindsight({ "hindsight.retainEveryNTurns": 1 });
			const current = createSession(async () => [], {
				responses: [{ content: [alphaAnswer] }, { content: [betaAnswer] }],
			});
			await current.applyMemoryBackend();
			const scope = scopeOf(current);
			const documentId = current.sessionManager.getSessionId();
			await current.prompt(alphaQuestion);
			await current.prompt(betaQuestion);
			await server.until(() => server.source(scope.bankId, documentId)?.content.includes(betaAnswer) === true);
			const firstUser = branchMessage(current, "user", alphaQuestion);
			const firstAnswer = branchMessage(current, "assistant", alphaAnswer);

			const repairFrom = server.writes.length;
			expect((await current.navigateTree(firstAnswer.id, { summarize: false })).cancelled).toBe(false);
			const repaired = server.source(scope.bankId, documentId);
			expect(repaired?.content).toContain(alphaAnswer);
			expect(repaired?.content).not.toContain(betaQuestion);
			expect(repaired?.content).not.toContain(betaAnswer);
			expect(server.writes.slice(repairFrom)).toEqual([
				{ method: "POST", bankId: scope.bankId, documentId, updateMode: "replace", tags: scope.tags },
			]);
			expect(branchUserTurns(current)).toBe(1);

			const deleteFrom = server.writes.length;
			expect((await current.navigateTree(firstUser.id, { summarize: false })).cancelled).toBe(false);
			expect(server.sources.size).toBe(0);
			expect(server.writes.slice(deleteFrom)).toEqual([{ method: "DELETE", bankId: scope.bankId, documentId }]);
			expect(branchUserTurns(current)).toBe(0);
		});

		it.each(["POST", "DELETE"] as const)(
			"tree navigation stays usable after a Hindsight %s failure and a later sync repairs the source",
			async method => {
				const server = useHindsight({ "hindsight.retainEveryNTurns": 1 });
				const current = createSession(async () => [], {
					responses: [{ content: [alphaAnswer] }, { content: [betaAnswer] }],
				});
				await current.applyMemoryBackend();
				const scope = scopeOf(current);
				const documentId = current.sessionManager.getSessionId();
				await current.prompt(alphaQuestion);
				await current.prompt(betaQuestion);
				await server.until(() => server.source(scope.bankId, documentId)?.content.includes(betaAnswer) === true);
				const target = branchMessage(
					current,
					method === "POST" ? "assistant" : "user",
					method === "POST" ? alphaAnswer : alphaQuestion,
				);
				server.retainStatus = () => 503;
				server.deleteStatus = 503;

				expect((await current.navigateTree(target.id, { summarize: false })).cancelled).toBe(false);
				expect(branchUserTurns(current)).toBe(method === "POST" ? 1 : 0);
				expect(server.source(scope.bankId, documentId)?.content).toContain(betaAnswer);

				server.retainStatus = () => 200;
				server.deleteStatus = 200;
				await current.getHindsightSessionState()!.synchronizeRetainedBranch();
				if (method === "POST") {
					expect(server.source(scope.bankId, documentId)?.content).toContain(alphaAnswer);
					expect(server.source(scope.bankId, documentId)?.content).not.toContain(betaAnswer);
				} else {
					expect(server.sources.size).toBe(0);
				}
			},
		);

		it("reloading a rewritten Hindsight transcript reconciles persisted sources before returning", async () => {
			const server = useHindsight();
			const dirs = projectDirs();
			const agentDir = path.join(tempDir.path(), "agent");
			const independentQuestion = "Who owns the alpha on-call rotation?";
			const independentAnswer = "The alpha on-call rotation is owned by the platform reliability group.";
			const current = createSession(async () => [], {
				sessionManager: SessionManager.create(
					dirs.alpha,
					SessionManager.getDefaultSessionDir(dirs.alpha, agentDir),
				),
				responses: [
					{ content: [alphaAnswer] },
					{ content: [betaAnswer] },
					{ content: [returnAnswer] },
					{ content: [independentAnswer] },
				],
			});
			const { beta, initial, betaSource, returned } = await writeAcrossProjects(current, dirs);
			const firstAnswer = branchMessage(current, "assistant", alphaAnswer);
			const sessionFile = current.sessionFile;
			if (!sessionFile) throw new Error("Expected a persisted session file");

			// Rewrite the persisted leaf outside this session, then reload it from disk.
			await current.sessionManager.close();
			const external = await SessionManager.open(sessionFile);
			external.branchWithSummary(firstAnswer.id, "Returned to the first alpha answer.");
			await external.close();

			const reloadFrom = server.writes.length;
			await current.reload();
			expect([...server.sources.values()]).toEqual([initial]);
			const reloadWrites = server.writes.slice(reloadFrom);
			expect(reloadWrites).toHaveLength(2);
			expect(reloadWrites).toEqual(
				expect.arrayContaining([
					{ method: "DELETE", bankId: beta.bankId, documentId: betaSource.documentId },
					{ method: "DELETE", bankId: returned.bankId, documentId: returned.documentId },
				]),
			);
			expect(branchUserTurns(current)).toBe(1);

			// An independent retained session: switching between the two neither deletes nor relabels either.
			expect(await current.newSession()).toBe(true);
			await current.prompt(independentQuestion);
			await runHeadless(current, "/memory enqueue");
			const independent = only(server.containing(independentAnswer));
			expect(independent.metadata?.session_id).toBe(current.sessionManager.getSessionId());
			expect(independent.content).not.toContain(alphaAnswer);
			const independentFile = current.sessionFile;
			if (!independentFile) throw new Error("Expected a persisted independent session file");
			expect(server.source(initial.bankId, initial.documentId)).toEqual(initial);

			const switchFrom = server.writes.length;
			expect(await current.switchSession(sessionFile, { keepModel: true })).toBe(true);
			expect(await current.switchSession(independentFile, { keepModel: true })).toBe(true);
			expect(server.writes.slice(switchFrom)).toEqual([]);
			expect(server.sources.size).toBe(2);
			expect(server.source(initial.bankId, initial.documentId)).toEqual(initial);
			expect(server.source(independent.bankId, independent.documentId)).toEqual(independent);
		});
	});
});
