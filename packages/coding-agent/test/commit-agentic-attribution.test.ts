import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { runCommitAgentSession } from "@oh-my-pi/pi-coding-agent/commit/agentic/agent";
import * as toolsModule from "@oh-my-pi/pi-coding-agent/commit/agentic/tools";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession, type PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("commit agent prompt attribution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("marks generated commit prompts and reminders as agent-attributed", async () => {
		const prompts: Array<{ text: string; options?: PromptOptions }> = [];
		const session = {
			prompt: async (text: string, options?: PromptOptions) => {
				prompts.push({ text, options });
			},
			subscribe: () => () => {},
			dispose: async () => {},
		};

		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as unknown as CreateAgentSessionResult);
		vi.spyOn(toolsModule, "createCommitTools").mockReturnValue([]);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 model to exist");
		}

		await runCommitAgentSession({
			cwd: "/tmp",
			model,
			settings: Settings.isolated(),
			modelRegistry: {} as never,
			authStorage: {} as never,
			changelogTargets: [],
			requireChangelog: false,
		});

		expect(prompts).toHaveLength(4);
		for (const prompt of prompts) {
			expect(prompt.options?.attribution).toBe("agent");
			expect(prompt.options?.expandPromptTemplates).toBe(false);
		}
		expect(prompts[0].options?.admissionOrigin).toBeUndefined();
		expect(prompts[0].options?.synthetic).toBeUndefined();
		for (const reminder of prompts.slice(1)) {
			expect(reminder.options?.admissionOrigin).toBe("continuation");
			expect(reminder.options?.synthetic).toBe(true);
		}
	});

	it("keeps all proposal reminders on the real session fallback until a new request", async () => {
		using tempDir = TempDir.createSync("@pi-commit-fallback-");
		await initTheme();
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		let session: AgentSession | undefined;
		try {
			const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
			const fallback = getBundledModel("openai-codex", "gpt-5.6-sol");
			if (!primary || !fallback) throw new Error("Expected bundled commit fallback models");
			const primaryId = `${primary.provider}/${primary.id}`;
			const fallbackId = `${fallback.provider}/${fallback.id}`;
			authStorage.keys.setRuntime(primary.provider, "primary-test-key");
			authStorage.keys.setRuntime(fallback.provider, "fallback-test-key");
			const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.fallbackChains": { default: [fallbackId] },
				"retry.fallbackRevertPolicy": "next-turn",
			});
			settings.setModelRole("default", primaryId);
			const requestedModels: string[] = [];
			const mock = createMockModel();
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					// Successful text-only responses deliberately omit the proposal tool,
					// so the helper exhausts all three proposal-completion reminders.
					mock.push(
						requestedModels.length === 1
							? { throw: "rate limit exceeded retry-after-ms=60000" }
							: { content: ["Still inspecting the changes."] },
					);
					return mock.stream(model, context, options);
				},
			});
			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(tempDir.path()),
				settings,
				modelRegistry,
			});
			const activeSession = session;
			vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
				session: activeSession,
			} as unknown as CreateAgentSessionResult);
			vi.spyOn(toolsModule, "createCommitTools").mockReturnValue([]);

			const state = await runCommitAgentSession({
				cwd: tempDir.path(),
				model: primary,
				settings,
				modelRegistry,
				authStorage,
				changelogTargets: [],
				requireChangelog: false,
				onComplete: async () => {
					expect(requestedModels).toEqual([primaryId, fallbackId, fallbackId, fallbackId, fallbackId]);
					expect(activeSession.model?.id).toBe(fallback.id);
					const userMessages = activeSession.messages.filter(message => message.role === "user");
					expect(userMessages).toHaveLength(1);
					const reminders = activeSession.messages.filter(
						message => message.role === "developer" && message.synthetic === true,
					);
					expect(reminders).toHaveLength(3);
					// A genuine new request still restores the primary model.
					await activeSession.prompt("Start a separate commit request");
					await activeSession.waitForIdle();
					expect(requestedModels.at(-1)).toBe(primaryId);
					expect(activeSession.model?.id).toBe(primary.id);
				},
			});
			expect(state.proposal).toBeUndefined();
		} finally {
			await session?.dispose();
			authStorage.close();
		}
	});

	it("runs completion before session disposal", async () => {
		const events: string[] = [];
		const session = {
			prompt: async () => {},
			subscribe: () => () => {},
			dispose: async () => {
				events.push("dispose");
			},
		};

		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as unknown as CreateAgentSessionResult);
		vi.spyOn(toolsModule, "createCommitTools").mockImplementation(options => {
			options.state.proposal = {
				analysis: {
					type: "fix",
					scope: "commit",
					details: [],
					issueRefs: [],
				},
				summary: "create commit before teardown",
				warnings: [],
			};
			return [];
		});

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 model to exist");
		}

		await runCommitAgentSession({
			cwd: "/tmp",
			model,
			settings: Settings.isolated(),
			modelRegistry: {} as never,
			authStorage: {} as never,
			changelogTargets: [],
			requireChangelog: false,
			onComplete: state => {
				events.push(state.proposal?.summary ?? "missing proposal");
			},
		});

		expect(events).toEqual(["create commit before teardown", "dispose"]);
	});
});
