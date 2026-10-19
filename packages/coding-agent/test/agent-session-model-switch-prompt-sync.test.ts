import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { formatModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolveEditMode } from "@oh-my-pi/pi-coding-agent/utils/edit-mode";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/** Model switches must leave the provider request with the active model's prompt policy and tools. */
describe("AgentSession model-switch prompt sync", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-model-switch-prompt-sync-");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
	});

	afterAll(() => {
		tempDir.removeSync();
	});

	function required(model: Model<Api> | undefined): Model<Api> {
		if (!model) throw new Error("Expected bundled test model");
		return model;
	}

	const schema = type({});
	function tool(name: string, description: () => string): AgentTool {
		return {
			name,
			label: name,
			get description() {
				return description();
			},
			parameters: schema,
			async execute() {
				return { content: [{ type: "text", text: name }], details: undefined };
			},
		} as AgentTool;
	}

	interface ProviderRequest {
		model: string;
		systemPrompt: string[] | undefined;
		tools: string[];
	}

	function createSession(options: {
		initial: Model<Api>;
		settings: Settings;
		modelRegistry: ModelRegistry;
		tools?: AgentTool[];
		createThinkTool?: () => Promise<AgentTool | null>;
		rebuildSystemPrompt: (names: string[]) => Promise<{ systemPrompt: string[] }>;
	}) {
		const mock = createMockModel();
		const requests: ProviderRequest[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: options.initial,
				systemPrompt: ["Test"],
				tools: options.tools ?? [],
				messages: [],
			},
			streamFn: (model, context, streamOptions) => {
				requests.push({
					model: model.id,
					systemPrompt: context.systemPrompt,
					tools: (context.tools ?? []).map(entry => `${entry.name}:${entry.description}`),
				});
				mock.push({ content: ["done"] });
				return mock.stream(model, context, streamOptions);
			},
		});
		// The resolver `createAgentSession` installs: rows adopt this session's context tier.
		agent.setModelResolver(next => options.modelRegistry.fitContextWindow(next, options.settings));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: options.settings,
			modelRegistry: options.modelRegistry,
			toolRegistry: new Map((options.tools ?? []).map(entry => [entry.name, entry])),
			createThinkTool: options.createThinkTool,
			rebuildSystemPrompt: options.rebuildSystemPrompt,
		});
		return { session, requests };
	}

	it("syncs the prompt and tools for the context-fitted row the session resolver publishes", async () => {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("google", "test-key");
		authStorage.keys.setRuntime("openai", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const terra = modelRegistry.find("openai", "gpt-5.6-terra");
		if (!terra) throw new Error("Expected the openai/gpt-5.6-terra catalog row");
		// The registry's standard tier differs from this session's extended tier.
		const settings = Settings.isolated({
			"compaction.enabled": false,
			extendedContext: true,
			externalThinking: true,
		});
		expect(modelRegistry.fitContextWindow(terra, settings).contextWindow).not.toBe(terra.contextWindow);

		const think = tool("think", () => "scratchpad");
		const { session, requests } = createSession({
			// Native reasoning only: no `think` scratchpad until the switch.
			initial: required(getBundledModel("google", "gemini-2.5-pro")),
			settings,
			modelRegistry,
			createThinkTool: async () => think,
			rebuildSystemPrompt: async names => ({
				systemPrompt: [`model:${session.model?.id}`, `tools:${names.join(",")}`],
			}),
		});
		await session.refreshBaseSystemPrompt();

		await session.setModelTemporary(terra);
		await session.prompt("hello");

		expect(session.model?.contextWindow).toBe(modelRegistry.fitContextWindow(terra, settings).contextWindow);
		expect(requests).toEqual([
			{ model: "gpt-5.6-terra", systemPrompt: ["model:gpt-5.6-terra", "tools:think"], tools: ["think:scratchpad"] },
		]);
	});

	it("publishes the active edit mode when an overlapping switch superseded the one that changed it", async () => {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const hashline = required(getBundledModel("anthropic", "claude-sonnet-4-5"));
		const replaceA = required(getBundledModel("anthropic", "claude-sonnet-4-6"));
		const replaceB = required(getBundledModel("anthropic", "claude-opus-4-6"));
		// Without the model id, all three share one model-policy key; only the edit mode differs.
		const settings = Settings.isolated({
			"compaction.enabled": false,
			includeModelInPrompt: false,
			"edit.modelVariants": { [replaceA.id]: "replace", [replaceB.id]: "replace" },
		});
		const editMode = () =>
			resolveEditMode({
				settings,
				getActiveModelString: () => (session?.model ? formatModelString(session.model) : undefined),
			});
		const hold = Promise.withResolvers<void>();
		let holding = false;
		const rendering = Promise.withResolvers<void>();
		const { session, requests } = createSession({
			initial: hashline,
			settings,
			modelRegistry,
			tools: [tool("edit", () => `mode:${editMode()}`)],
			rebuildSystemPrompt: async () => {
				const mode = editMode();
				if (holding) {
					rendering.resolve();
					await hold.promise;
				}
				return { systemPrompt: [`edit:${mode}`] };
			},
		});
		await session.refreshBaseSystemPrompt();
		expect(session.agent.state.systemPrompt).toEqual(["edit:hashline"]);

		const published = (id: string) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			const unsubscribe = session.subscribe(event => {
				if (event.type !== "model_changed" || session.model?.id !== id) return;
				unsubscribe();
				resolve();
			});
			return promise;
		};
		// An unrelated rebuild holds the tool-registry queue, so switch A publishes
		// `replace` but cannot sync its prompt before switch B supersedes it.
		holding = true;
		const unrelatedRebuild = session.refreshBaseSystemPrompt();
		await rendering.promise;
		const publishedA = published(replaceA.id);
		const switchA = session.setModelTemporary(replaceA);
		await publishedA;
		const publishedB = published(replaceB.id);
		const switchB = session.setModelTemporary(replaceB);
		await publishedB;
		hold.resolve();
		await Promise.all([unrelatedRebuild, switchA, switchB]);
		await session.prompt("overlapping");

		// Sequential switches still follow the edit mode back.
		await session.setModelTemporary(hashline);
		await session.prompt("sequential");

		expect(requests).toEqual([
			{ model: replaceB.id, systemPrompt: ["edit:replace"], tools: ["edit:mode:replace"] },
			{ model: hashline.id, systemPrompt: ["edit:hashline"], tools: ["edit:mode:hashline"] },
		]);
	});
});
