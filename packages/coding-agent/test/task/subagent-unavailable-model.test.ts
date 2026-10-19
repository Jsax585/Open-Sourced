import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ServingModel } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { createSessionDefaults } from "../helpers/session-defaults";

function model(provider: string, id: string): Model<Api> {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

const agent: AgentDefinition = { name: "astra-api", description: "test", systemPrompt: "test", source: "bundled" };

/**
 * Fake session that yields once. `servingModel` follows the real contract:
 * `runtimeFallback` emits the session's `retry_fallback_applied` event and
 * moves attribution onto the fallback, as a served fallback turn does.
 */
function createYieldingSession(
	servingModel: ServingModel,
	runtimeFallback?: { to: ServingModel; reason: string },
): AgentSession {
	const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
	const emit = (event: { type: string; [key: string]: unknown }): void => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		...createSessionDefaults(),
		agent: { state: { systemPrompt: ["test"] } },
		state: { messages: [] },
		model: model("primary", "declared-model"),
		servingModel,
		extensionRunner: undefined,
		isStreaming: false,
		setWorkPoolYieldItems: async () => {},
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			if (runtimeFallback) {
				emit({
					type: "retry_fallback_applied",
					from: servingModel.selector,
					to: runtimeFallback.to.selector,
					role: "subagent:unavailable",
					reason: runtimeFallback.reason,
				});
				session.servingModel = runtimeFallback.to;
				emit({
					type: "retry_fallback_succeeded",
					model: runtimeFallback.to.selector,
					role: "subagent:unavailable",
				});
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-yield",
				toolName: "yield",
				result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } },
				isError: false,
			});
		},
	};
	return session as unknown as AgentSession;
}

describe("subagent whose declared model cannot serve", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
	});

	it("records the model a deferred spawn settled on in session_init", async () => {
		const declared = model("primary", "declared-model");
		const parent = model("parent", "session-model");
		const session = createYieldingSession({ selector: "parent/session-model", isFallback: true });
		const appendSessionInit = vi.spyOn(session.sessionManager, "appendSessionInit");
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async () => ({ session, extensionsResult: {}, setToolUIContext: () => {} }) as never,
		);

		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "no-credentials",
			modelOverride: ["primary/declared-model"],
			modelRole: "smol",
			parentActiveModelPattern: "parent/session-model",
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [declared, parent],
				getApiKey: async (requested: Model) => (requested.provider === "primary" ? undefined : "parent-key"),
			} as never,
			enableLsp: false,
		});

		expect(appendSessionInit.mock.calls[0]?.[0]).toMatchObject({ resolvedModel: "parent/session-model" });
	});

	const parentFallback: ServingModel = {
		selector: "parent/session-model",
		modelIdentity: "parent/session-model",
		isFallback: false,
	};
	const startupModelFallback = {
		model: "parent/session-model",
		reason:
			"Fallback: primary/declared-model -> parent/session-model\nprimary/declared-model has no working credentials",
	};
	const unauthenticatedRegistry = {
		refresh: async () => {},
		getAvailable: () => [model("primary", "declared-model")],
		getApiKey: async () => undefined,
	};

	it("reports why a startup fallback served the run on the settled result", async () => {
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async () =>
				({
					// The parent-model fallback arms no retry fallback in the session itself.
					session: createYieldingSession(parentFallback),
					startupModelFallback,
					extensionsResult: {},
					setToolUIContext: () => {},
				}) as never,
		);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "startup-fallback",
			modelOverride: ["primary/declared-model"],
			settings: Settings.isolated(),
			modelRegistry: unauthenticatedRegistry as never,
			enableLsp: false,
		});

		expect(result.resolvedModel).toBe("parent/session-model");
		expect(result.resolvedModelIsFallback).toBe(true);
		expect(result.resolvedModelFallbackReason).toBe(startupModelFallback.reason);
	});

	it("reports the startup fallback on a follow-up turn of the same live session", async () => {
		const session = createYieldingSession(parentFallback);
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async () => ({ session, startupModelFallback, extensionsResult: {}, setToolUIContext: () => {} }) as never,
		);
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "startup-follow-up",
			modelOverride: ["primary/declared-model"],
			settings: Settings.isolated(),
			modelRegistry: unauthenticatedRegistry as never,
			enableLsp: false,
		});
		AgentRegistry.global().unregister("startup-follow-up");
		AgentRegistry.global().register({
			id: "startup-follow-up",
			displayName: "startup-follow-up",
			kind: "sub",
			status: "idle",
			session,
		});

		try {
			const followUp = await runSubagentFollowUpTurn({
				cwd: "/tmp",
				agent,
				index: 0,
				id: "startup-follow-up",
				message: "continue",
				settings: Settings.isolated(),
				enableLsp: false,
			} as never);

			expect(followUp.resolvedModel).toBe("parent/session-model");
			expect(followUp.resolvedModelIsFallback).toBe(true);
			expect(followUp.resolvedModelFallbackReason).toBe(startupModelFallback.reason);
		} finally {
			AgentRegistry.global().unregister("startup-follow-up");
		}
	});

	it("stops giving the startup reason once a runtime hop moves the run to another model", async () => {
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async () =>
				({
					session: createYieldingSession(parentFallback, {
						to: { selector: "fallback/working-model", modelIdentity: "fallback/working-model", isFallback: true },
						reason: "429 usage limit reached",
					}),
					startupModelFallback,
					extensionsResult: {},
					setToolUIContext: () => {},
				}) as never,
		);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "runtime-hop",
			modelOverride: ["primary/declared-model"],
			settings: Settings.isolated(),
			modelRegistry: unauthenticatedRegistry as never,
			enableLsp: false,
		});

		expect(result.resolvedModel).toBe("fallback/working-model");
		expect(result.resolvedModelIsFallback).toBe(true);
		expect(result.resolvedModelFallbackReason).toBeUndefined();
	});

	it("leaves the parent's registry intact when models.yml no longer parses at spawn time", async () => {
		const dir = path.join(os.tmpdir(), `omp-subagent-malformed-models-${Snowflake.next()}`);
		tempDirs.push(dir);
		fs.mkdirSync(dir, { recursive: true });
		const modelsPath = path.join(dir, "models.yml");
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  parent-provider:",
				"    baseUrl: https://parent.example.test/v1",
				"    apiKey: PARENT_KEY_LITERAL",
				"    api: openai-completions",
				"    models:",
				"      - id: parent-model",
			].join("\n"),
		);
		const authStorage = createInMemoryAuthStorage();
		try {
			const modelRegistry = new ModelRegistry(authStorage, modelsPath);
			expect(modelRegistry.find("parent-provider", "parent-model")).toBeDefined();
			// A save caught mid-edit: newer on disk and no longer valid YAML.
			fs.writeFileSync(modelsPath, "providers:\n  parent-provider: [unclosed\n");
			const later = new Date(Date.now() + 1000);
			fs.utimesSync(modelsPath, later, later);
			vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
				async () =>
					({
						session: createYieldingSession({ selector: "parent-provider/parent-model", isFallback: true }),
						extensionsResult: {},
						setToolUIContext: () => {},
					}) as never,
			);

			await runSubprocess({
				cwd: "/tmp",
				agent,
				task: "work",
				index: 0,
				id: "malformed-models-yml",
				modelOverride: ["missing-provider/missing-model"],
				parentActiveModelPattern: "parent-provider/parent-model",
				settings: Settings.isolated(),
				modelRegistry,
				enableLsp: false,
			});

			const parent = modelRegistry.find("parent-provider", "parent-model");
			if (!parent) throw new Error("The parent session's models.yml provider was dropped from its registry");
			expect(await modelRegistry.getApiKey(parent)).toBe("PARENT_KEY_LITERAL");
		} finally {
			authStorage.close();
		}
	});
});
