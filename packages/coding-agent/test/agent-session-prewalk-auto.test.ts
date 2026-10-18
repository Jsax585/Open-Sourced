import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	type Api,
	type Context,
	Effort,
	type ImageContent,
	type Model,
	type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AUTO_PREWALK_TIMEOUT_MS, type PrewalkRoute } from "@oh-my-pi/pi-coding-agent/auto-prewalk/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { AgentSessionConfig } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { ModelControls } from "@oh-my-pi/pi-coding-agent/session/model-controls";
import { SessionTools } from "@oh-my-pi/pi-coding-agent/session/session-tools";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionProviderBoundary } from "@oh-my-pi/pi-coding-agent/session/session-provider-boundary";
import {
	cfgCompactionEnabled,
	cfgCompactionThresholdTokens,
	cfgContextPromotionEnabled,
} from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { cfgPrewalkAuto } from "@oh-my-pi/pi-coding-agent/session/settings";
import { EAGER_TODO_PRELUDE_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/todo-tracker";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { asGlobalFetch } from "./helpers/fetch-mock";

/**
 * `prewalk.auto`: the native judge decides per user task whether to arm the
 * existing prewalk handoff from the active model. The judge is the real
 * TypeSafe client against a stubbed `fetch`, so the whole path — classifier,
 * judge chain, coordinator, handoff — runs without network.
 */
describe("AgentSession auto-prewalk", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-prewalk-auto-");
	});

	afterEach(async () => {
		if (session) await session.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		vi.restoreAllMocks();
	});

	afterAll(() => {
		tempDir.removeSync();
	});

	function modelOrThrow(id: string): Model<Api> {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected bundled model ${id}`);
		return model;
	}

	const toolSchema = type({});
	const todoTool: AgentTool<typeof toolSchema, undefined> = {
		name: "todo",
		label: "Todo",
		description: "Track tasks",
		parameters: toolSchema,
		async execute() {
			return { content: [{ type: "text", text: "listed" }], details: undefined };
		},
	};
	const writeTool: AgentTool<typeof toolSchema, undefined> = {
		name: "write",
		label: "Write",
		description: "Write a file",
		parameters: toolSchema,
		async execute() {
			return { content: [{ type: "text", text: "wrote" }], details: undefined };
		},
	};
	const toolRegistry = new Map<string, AgentTool>([
		[todoTool.name, todoTool as AgentTool],
		[writeTool.name, writeTool as AgentTool],
	]);

	function toolCall(id: string, name: string): MockResponse {
		return { content: [{ type: "toolCall", id, name, arguments: {} }], stopReason: "toolUse" };
	}

	/** One task that plans, writes its todo list, then edits: the shape that crosses the handoff. */
	const cycle = (): MockResponse[] => [toolCall("todo", "todo"), toolCall("write", "write"), { content: ["done"] }];
	const done = (label: string): MockResponse => ({ content: [`done ${label}`] });

	const TASK = "trace the sync engine, then fix the stale cursor";

	function verdict(prewalk: number, primary: number, direct: number) {
		const probabilities: Record<PrewalkRoute, number> = { prewalk, primary, direct };
		const choice: PrewalkRoute =
			prewalk >= primary && prewalk >= direct ? "prewalk" : primary >= direct ? "primary" : "direct";
		return { type: "choice", choice, probabilities, confidence: probabilities[choice] };
	}
	const PREWALK = verdict(0.9, 0.07, 0.03);
	const PRIMARY = verdict(0.1, 0.8, 0.1);
	const DIRECT = verdict(0.05, 0.1, 0.85);
	const WEAK_PREWALK = verdict(0.55, 0.35, 0.1);
	const MALFORMED = { type: "choice", choice: "prewalk" };

	type Reply = "http-400" | { type: string; [key: string]: unknown };
	interface JudgeCall {
		questions: string[];
		state: Record<string, string>;
		/** Session state at the moment the judge was asked. */
		model: string | undefined;
		configured: ConfiguredThinkingLevel | undefined;
	}

	/**
	 * Answer System One requests from `replies` (then `DIRECT`) and record each one.
	 * `gate` parks matching questions until its promise settles.
	 */
	function stubJudge(
		replies: Reply[] = [],
		gate?: { hold: Promise<void>; requested: () => void; question?: "level"; reply?: Reply },
	): JudgeCall[] {
		const calls: JudgeCall[] = [];
		const usage = { input_tokens: 8, output_tokens: 2 };
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				if (!String(input).endsWith("/v1/systemone")) throw new Error(`unexpected request: ${String(input)}`);
				const body = JSON.parse(String(init?.body)) as {
					state: Record<string, string>;
					questions: Record<string, unknown>;
				};
				const questions = Object.keys(body.questions);
				calls.push({
					questions,
					state: body.state,
					model: session?.model?.id,
					configured: session?.configuredThinkingLevel(),
				});
				const gated = gate && (!gate.question || questions.includes(gate.question));
				if (gate && gated) {
					gate.requested();
					await gate.hold;
				}
				const reply = (gated && gate?.reply) || replies.shift() || DIRECT;
				if (reply === "http-400") return new Response("bad request", { status: 400 });
				return Response.json({ model: "jev", answers: { [questions[0]!]: reply }, usage });
			}),
		);
		return calls;
	}

	const asked = (calls: JudgeCall[]) => calls.filter(call => call.questions.includes("route"));

	interface FixtureOptions {
		auto?: "off" | "suggest" | "on";
		/** Credential the native judge (default true). */
		judge?: boolean;
		agentKind?: "main" | "sub";
		/** Arm prewalk at startup, as `--prewalk`/`prewalk.enabled` (true = the default `@smol` target) or task prewalk would. */
		startupArm?: boolean | Model;
		planYolo?: boolean;
		suppressAutoPrewalk?: boolean;
		/** `todo.eager`, which adds a first-turn reminder before the judge answers. */
		todoEager?: "preferred" | "always";
		beforeStream?: (context: Context, options?: SimpleStreamOptions) => Promise<void>;
		planningModel?: string;
		autoTarget?: string;
		initialPlanner?: boolean;
		textOnlyBaseline?: boolean;
		thinkingLevel?: ConfiguredThinkingLevel;
		rebuildSystemPrompt?: AgentSessionConfig["rebuildSystemPrompt"];
		memory?: boolean;
	}

	function createFixture(responses: MockResponse[], options: FixtureOptions = {}) {
		const planner = modelOrThrow("claude-opus-4-6");
		const initial = options.initialPlanner ? planner : modelOrThrow("claude-sonnet-4-5");
		const primary: Model<Api> = options.textOnlyBaseline ? { ...initial, input: ["text"] } : initial;
		const target = modelOrThrow("claude-sonnet-4-6");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		if (options.judge !== false) authStorage.keys.setRuntime("typesafe", "ts-key");
		// Only the credentials set here exist. Ambient provider keys (TYPESAFE_API_KEY, OPENROUTER_API_KEY, …) must
		// neither conjure a native judge nor give the chain a fallback candidate that reaches the network.
		const credentialed = options.judge === false ? ["anthropic"] : ["anthropic", "typesafe"];
		const source = authStorage.keys.source.bind(authStorage.keys);
		vi.spyOn(authStorage.keys, "source").mockImplementation((provider, sourceOptions) =>
			credentialed.includes(provider) ? source(provider, sourceOptions) : undefined,
		);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"prewalk.enabled": false,
			modelRoles: { judge: "typesafe/jev-1.14.0" },
			...(options.auto ? { "prewalk.auto": options.auto } : {}),
			...(options.todoEager ? { "todo.eager": options.todoEager } : {}),
			...(options.planningModel !== undefined ? { "prewalk.autoPlanningModel": options.planningModel } : {}),
			...(options.autoTarget !== undefined ? { "prewalk.autoTarget": options.autoTarget } : {}),
			...(options.memory
				? {
						"memory.backend": "hindsight",
						"hindsight.apiUrl": "http://unused.invalid",
						"hindsight.autoRetain": false,
						"hindsight.autoRecall": true,
						"hindsight.mentalModelsEnabled": false,
					}
				: {}),
		});
		settings.setModelRole("smol", `${target.provider}/${target.id}:low`);
		settings.setModelRole("slow", `${planner.provider}/${planner.id}:max`);
		const mock = createMockModel({ responses });
		const requested: string[] = [];
		const efforts: Array<string | undefined> = [];
		const nudges: string[][] = [];
		const customs: string[][] = [];
		const contexts: string[] = [];
		let requestCustoms: string[] = [];
		const sequence: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [todoTool as AgentTool, writeTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.High,
			},
			convertToLlm: messages => {
				requestCustoms = messages.flatMap(message => (message.role === "custom" ? [message.customType] : []));
				return convertToLlm(messages);
			},
			streamFn: async (model, context, streamOptions) => {
				requested.push(model.id);
				sequence.push(`stream:${model.id}`);
				efforts.push(agent.state.thinkingLevel);
				nudges.push(requestCustoms.filter(customType => customType.startsWith("prewalk-")));
				customs.push(requestCustoms);
				contexts.push(JSON.stringify(context.messages));
				await options.beforeStream?.(context, streamOptions);
				return mock.stream(model, context, streamOptions);
			},
		});
		const startupTarget = options.startupArm === true ? target : options.startupArm || undefined;
		const manager = SessionManager.inMemory(tempDir.path());
		const runner = new ExtensionRunner([], new ExtensionRuntime(), manager.getCwd(), manager, modelRegistry);
		const created = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
			toolRegistry,
			thinkingLevel: options.thinkingLevel ?? Effort.High,
			prewalk: startupTarget ? { target: startupTarget, thinkingLevel: Effort.Low } : undefined,
			planYolo: options.planYolo ? { target, thinkingLevel: Effort.Low } : undefined,
			agentKind: options.agentKind,
			suppressAutoPrewalk: options.suppressAutoPrewalk,
			extensionRunner: runner,
			rebuildSystemPrompt: options.rebuildSystemPrompt,
		});
		session = created;
		const notices: string[] = [];
		const warnings: string[] = [];
		created.subscribe(event => {
			if (event.type === "model_changed") sequence.push(`model:${created.model?.id}`);
			if (event.type === "notice" && event.source === "prewalk") {
				notices.push(event.message);
				if (event.level === "warning") warnings.push(event.message);
			}
		});
		const ctx = {
			session: created,
			sessionManager: created.sessionManager,
			settings,
			collabGuest: false,
			showStatus: vi.fn(),
			editor: { setText: vi.fn() },
			refreshSlashCommandState: vi.fn(),
		} as unknown as InteractiveModeContext;
		return {
			session: created,
			settings,
			primary,
			planner,
			modelRegistry,
			runner,
			sequence,
			target,
			requested,
			efforts,
			nudges,
			customs,
			contexts,
			notices,
			warnings,
			ctx,
		};
	}

	describe("early planning model", () => {
		const image: ImageContent = {
			type: "image",
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
		};

		async function expectAttachedImage(context: string | undefined) {
			if (!context) throw new Error("Expected provider context");
			const messages = JSON.parse(context) as Context["messages"];
			const images: ImageContent[] = [];
			for (const message of messages) {
				if (!Array.isArray(message.content)) continue;
				for (const part of message.content) {
					if (part.type === "image") images.push(part);
				}
			}
			expect(images).toHaveLength(1);
			await new Bun.Image(Buffer.from(images[0]!.data, "base64")).png().bytes();
		}

		it.each(["direct", "skill"] as const)(
			"%s attachments use the image-capable planner, not the text-only baseline",
			async delivery => {
				const calls = stubJudge([PREWALK]);
				const f = createFixture([done("image")], { auto: "on", planningModel: "@slow", textOnlyBaseline: true });
				const observed: string[] = [];
				const describe = SessionProviderBoundary.prototype.buildImageDescriptionNotice;
				vi.spyOn(SessionProviderBoundary.prototype, "buildImageDescriptionNotice").mockImplementation(
					async function (this: SessionProviderBoundary, ...args) {
						observed.push(f.session.model!.id);
						const result = await describe.apply(this, args);
						expect(result).toBeUndefined();
						return result;
					},
				);
				if (delivery === "direct") await f.session.prompt(TASK, { images: [image] });
				else {
					await f.session.promptCustomMessage({
						customType: "skill-prompt",
						content: [{ type: "text", text: TASK }, image],
						display: true,
						attribution: "user",
					});
				}
				expect(asked(calls)).toHaveLength(1);
				expect(observed).toEqual([f.planner.id]);
				expect(f.requested.length).toBeGreaterThan(0);
				expect(f.requested.every(id => id === f.planner.id)).toBe(true);
				await expectAttachedImage(f.contexts[0]);
			},
		);

		it.each(["follow-up", "promoted steering"] as const)(
			"defers %s image decisions until delivery and does not classify promoted steering",
			async delivery => {
				const calls = stubJudge(delivery === "follow-up" ? [DIRECT, PREWALK] : [PREWALK]);
				const text = "inspect the attached cursor state and fix the race";
				const observed: string[] = [];
				let queued = false;
				const f = createFixture([done("initial"), done("image")], {
					auto: "on",
					planningModel: "@slow",
					textOnlyBaseline: true,
					beforeStream: async () => {
						if (queued) return;
						queued = true;
						await f.session.prompt(text, { images: [image], streamingBehavior: "followUp" });
						expect(observed).toEqual([]);
						if (delivery === "promoted steering") expect(f.session.promoteQueuedMessage(text)).toBe(true);
					},
				});
				const describe = SessionProviderBoundary.prototype.buildImageDescriptionNotice;
				vi.spyOn(SessionProviderBoundary.prototype, "buildImageDescriptionNotice").mockImplementation(
					async function (this: SessionProviderBoundary, ...args) {
						observed.push(f.session.model!.id);
						const result = await describe.apply(this, args);
						expect(result).toBeUndefined();
						return result;
					},
				);
				await f.session.prompt(TASK);
				await f.session.waitForIdle();
				expect(asked(calls).map(call => call.state.request)).toEqual(
					delivery === "follow-up" ? [TASK, text] : [TASK],
				);
				expect(observed).toEqual([f.planner.id]);
				expect(f.requested[0]).toBe(delivery === "follow-up" ? f.primary.id : f.planner.id);
				expect(f.requested.slice(1).length).toBeGreaterThan(0);
				expect(f.requested.slice(1).every(id => id === f.planner.id)).toBe(true);
				await expectAttachedImage(f.contexts.at(-1));
			},
		);

		it("defers setup-time steering images until the planner is selected without classifying steering", async () => {
			const hold = Promise.withResolvers<void>();
			const requested = Promise.withResolvers<void>();
			const calls = stubJudge([PREWALK], { hold: hold.promise, requested: requested.resolve });
			const observed: string[] = [];
			const f = createFixture([done("initial"), done("steered image")], {
				auto: "on",
				planningModel: "@slow",
				textOnlyBaseline: true,
			});
			const describe = SessionProviderBoundary.prototype.buildImageDescriptionNotice;
			vi.spyOn(SessionProviderBoundary.prototype, "buildImageDescriptionNotice").mockImplementation(async function (
				this: SessionProviderBoundary,
				...args
			) {
				observed.push(f.session.model!.id);
				const result = await describe.apply(this, args);
				expect(result).toBeUndefined();
				return result;
			});
			const task = f.session.prompt(TASK);
			try {
				await requested.promise;
				await f.session.prompt("also inspect this cursor snapshot", {
					images: [image],
					streamingBehavior: "steer",
				});
				expect(observed).toEqual([]);
			} finally {
				hold.resolve();
			}
			await task;
			await f.session.waitForIdle();
			expect(asked(calls).map(call => call.state.request)).toEqual([TASK]);
			expect(observed).toEqual([f.planner.id]);
			expect(f.requested.length).toBeGreaterThan(0);
			expect(f.requested.every(id => id === f.planner.id)).toBe(true);
			await expectAttachedImage(f.contexts.find(context => context.includes('"type":"image"')));
		});

		it.each(["same model", "other model", "same auto effort"] as const)(
			"discards a delayed auto-thinking judgment after explicit %s selection",
			async selection => {
				const hold = Promise.withResolvers<void>();
				const requested = Promise.withResolvers<void>();
				const calls = stubJudge([PREWALK, DIRECT], {
					hold: hold.promise,
					requested: requested.resolve,
					question: "level",
					reply: {
						type: "choice",
						choice: "low",
						probabilities: { low: 0.97, medium: 0.01, high: 0.01, xhigh: 0.01 },
						confidence: 0.97,
					},
				});
				const f = createFixture([done("selected")], { auto: "on", planningModel: "@slow" });
				f.settings.setModelRole("slow", `${f.planner.provider}/${f.planner.id}:auto`);
				const dropped: string[] = [];
				f.session.setPromptDropped(prompt => dropped.push(prompt.text));
				const resolved: Array<string | undefined> = [];
				f.session.subscribe(event => {
					if (event.type === "thinking_level_changed") resolved.push(event.resolved);
				});
				const text = `${TASK}; preserve explicit ${selection}`;
				const task = f.session.prompt(text);
				let boundary = 0;
				let selectedEffort: Agent["state"]["thinkingLevel"];
				try {
					await requested.promise;
					if (selection === "same auto effort") f.session.setThinkingLevel("auto");
					else await f.session.setModel(selection === "same model" ? f.planner : f.target);
					boundary = resolved.length;
					selectedEffort = f.session.agent.state.thinkingLevel;
				} finally {
					hold.resolve();
				}
				await task;
				expect(calls.filter(call => call.questions.includes("level")).map(call => call.model)).toEqual([
					f.planner.id,
				]);
				expect(resolved.slice(boundary)).toEqual([]);
				if (selection === "other model") {
					expect(dropped).toEqual([text]);
					// The drop is announced, not only handed back: a skill prompt has no editor to return to.
					expect(f.warnings).toHaveLength(1);
					expect(f.requested).toEqual([]);
					expect(f.session.model?.id).toBe(f.target.id);
					expect(f.session.agent.state.thinkingLevel).toBe(selectedEffort);
					await f.session.prompt("explain the cursor using the explicitly selected model");
					expect(f.requested).toEqual([f.target.id]);
					expect(calls.filter(call => call.questions.includes("level")).at(-1)?.model).toBe(f.target.id);
				} else {
					expect(dropped).toEqual([]);
					expect(f.warnings).toEqual([]);
					expect(f.requested).toEqual([f.planner.id]);
					expect(f.efforts).toEqual([selectedEffort]);
				}
				expect(f.session.getPrewalkState()).toBeUndefined();
			},
		);

		it("context promotion during the planner's preparation dispatches the task instead of dropping it", async () => {
			const calls = stubJudge([PREWALK]);
			const f = createFixture([done("promoted")], {
				auto: "on",
				planningModel: "@slow",
				// Only the pre-prompt pass should see the tiny threshold.
				beforeStream: async () => {
					cfgCompactionEnabled.override(f.settings, false);
				},
			});
			const dropped: string[] = [];
			f.session.setPromptDropped(prompt => dropped.push(prompt.text));
			cfgCompactionEnabled.override(f.settings, true);
			cfgCompactionThresholdTokens.override(f.settings, 1);
			cfgContextPromotionEnabled.override(f.settings, true);
			vi.spyOn(SessionMaintenance.prototype, "deferThresholdCompactionToSpeculation").mockReturnValue(false);
			const promotion = vi
				.spyOn(SessionMaintenance.prototype, "resolveContextPromotionTarget")
				.mockImplementation(async current => (current.id === f.planner.id ? f.target : undefined));

			await f.session.prompt(TASK);

			expect(asked(calls).map(call => call.model)).toEqual([f.primary.id]);
			expect(promotion).toHaveBeenCalled();
			expect(dropped).toEqual([]);
			expect(f.warnings).toEqual([]);
			expect(f.requested[0]).toBe(f.target.id);
		});

		it.each([
			["no planning model", undefined],
			["the planning model already active", "anthropic/claude-sonnet-4-5"],
		] as const)("with %s, judgment runs alongside preparation and still arms the task", async (_label, planner) => {
			const hold = Promise.withResolvers<void>();
			const requested = Promise.withResolvers<void>();
			const calls = stubJudge([], { hold: hold.promise, requested: requested.resolve, reply: PREWALK });
			const f = createFixture(cycle(), { auto: "on", planningModel: planner });
			// Only preparation releases the judge: a judge that blocked preparation would never settle.
			vi.spyOn(f.runner, "emitBeforeAgentStart").mockImplementation(async () => {
				hold.resolve();
				return undefined;
			});
			const task = f.session.prompt(TASK);
			await requested.promise;
			await task;
			expect(asked(calls).map(call => call.model)).toEqual([f.primary.id]);
			expect(f.requested[0]).toBe(f.primary.id);
			expect(f.nudges[0]).toContain("prewalk-plan");
		});

		function pausePlannerSelection(
			f: { session: AgentSession; modelRegistry: ModelRegistry; planner: Model },
			phase: "metadata" | "reconciliation",
		) {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let held = false;
			if (phase === "metadata") {
				vi.spyOn(f.modelRegistry, "refreshSelectedModelMetadata").mockImplementation(async model => {
					if (!held && model.id === f.planner.id) {
						held = true;
						entered.resolve();
						await release.promise;
					}
					return model;
				});
			} else {
				const reconcile = SessionTools.prototype.reconcileThinkTool;
				vi.spyOn(SessionTools.prototype, "reconcileThinkTool").mockImplementation(async function (
					this: SessionTools,
					...args
				) {
					if (!held && f.session.model?.id === f.planner.id) {
						held = true;
						entered.resolve();
						await release.promise;
					}
					return reconcile.apply(this, args);
				});
			}
			return { entered: entered.promise, release: release.resolve };
		}

		it("does not judge or select an automatic planner while plan-yolo is pending activation", async () => {
			const calls = stubJudge([PREWALK]);
			const f = createFixture([done("plan")], { auto: "on", planningModel: "@slow", planYolo: true });
			expect(f.session.getPlanModeState()?.enabled).not.toBe(true);
			await f.session.prompt(TASK);
			expect(calls).toEqual([]);
			expect(f.requested.length).toBeGreaterThan(0);
			expect(f.requested.every(id => id === f.primary.id)).toBe(true);
			expect(f.sequence.some(event => event === `model:${f.planner.id}`)).toBe(false);
		});

		it.each([Effort.Medium, "auto"] as const)(
			"publishes and persists restored baseline thinking %s before the next task's policy hooks",
			async configured => {
				stubJudge([PREWALK, DIRECT]);
				const f = createFixture([...cycle(), done("restored")], {
					auto: "on",
					planningModel: "@slow",
					autoTarget: "@smol",
					thinkingLevel: configured,
				});
				const baselineEffort = f.session.thinkingLevel;
				await f.session.prompt(TASK);
				expect(f.session.model?.id).toBe(f.target.id);
				expect(f.session.configuredThinkingLevel()).toBe(Effort.Low);
				const events: Array<{ model: string | undefined; configured: ConfiguredThinkingLevel | undefined }> = [];
				f.session.subscribe(event => {
					if (event.type === "thinking_level_changed") {
						events.push({ model: f.session.model?.id, configured: event.configured ?? event.thinkingLevel });
					}
				});
				const policy = vi.spyOn(f.runner, "emitBeforeAgentStart").mockImplementation(async () => {
					expect(f.session.model?.id).toBe(f.primary.id);
					expect(f.session.configuredThinkingLevel()).toBe(configured);
					expect(f.session.thinkingLevel).toBe(baselineEffort);
					expect(events).toContainEqual({ model: f.primary.id, configured });
					const context = f.session.sessionManager.buildSessionContext();
					expect(context.thinkingLevel).toBe(baselineEffort);
					expect(context.configuredThinkingLevel).toBe(configured);
					expect(
						f.session.sessionManager
							.getBranch()
							.filter(entry => entry.type === "thinking_level_change")
							.at(-1),
					).toMatchObject({
						thinkingLevel: baselineEffort,
						configured,
					});
					return undefined;
				});
				await f.session.prompt("ultrathink explain the restored cursor");
				expect(policy).toHaveBeenCalledTimes(1);
				expect(f.requested.at(-1)).toBe(f.primary.id);
			},
		);

		it("a reentrant explicit effort subscriber supersedes the planner receipt before it can regain ownership", async () => {
			const calls = stubJudge([PREWALK, DIRECT]);
			const f = createFixture([done("selected"), done("next")], { auto: "on", planningModel: "@slow" });
			let selected = false;
			const observed: Array<ThinkingLevel | undefined> = [];
			f.session.subscribe(event => {
				if (event.type !== "thinking_level_changed" || f.session.model?.id !== f.planner.id) return;
				observed.push(event.thinkingLevel);
				if (selected) return;
				selected = true;
				f.session.setThinkingLevel(Effort.Low);
			});
			await f.session.prompt(TASK);
			expect(observed.slice(0, 2)).toEqual([Effort.Max, Effort.Low]);
			expect(f.session.model?.id).toBe(f.planner.id);
			expect(f.session.configuredThinkingLevel()).toBe(Effort.Low);
			expect(f.session.getPrewalkState()).toBeUndefined();
			expect(f.nudges.flat()).not.toContain("prewalk-plan");

			await f.session.prompt("explain the independently selected cursor effort");

			expect(asked(calls).map(call => ({ model: call.model, configured: call.configured }))).toEqual([
				{ model: f.primary.id, configured: Effort.High },
				{ model: f.planner.id, configured: Effort.Low },
			]);
			expect(f.requested).toEqual([f.planner.id, f.planner.id]);
			expect(f.efforts).toEqual([Effort.Low, Effort.Low]);
			expect(f.session.model?.id).toBe(f.planner.id);
			expect(f.session.configuredThinkingLevel()).toBe(Effort.Low);
			expect(f.session.getPrewalkState()).toBeUndefined();
		});

		it("a manual arm during planner reconciliation keeps model, effort, and rebuilt policy coherent", async () => {
			stubJudge([PREWALK, DIRECT]);
			const f = createFixture([...cycle(), done("next")], {
				auto: "on",
				planningModel: "@slow",
				rebuildSystemPrompt: async () => ({
					systemPrompt: [`model:${session?.model?.id}`, `effort:${session?.configuredThinkingLevel()}`],
				}),
				beforeStream: async context => {
					const policy = context.systemPrompt?.join("\n") ?? "";
					expect(policy).toContain(`model:${f.session.model?.id}`);
					expect(policy).toContain(`effort:${f.session.configuredThinkingLevel()}`);
				},
			});
			const gate = pausePlannerSelection(f, "reconciliation");
			const policy = vi
				.spyOn(f.runner, "emitBeforeAgentStart")
				.mockImplementation(async (_prompt, _images, systemPrompt) => {
					expect(f.session.model?.id).toBe(f.planner.id);
					expect(f.session.configuredThinkingLevel()).toBe(Effort.Max);
					expect(systemPrompt.join("\n")).toContain(`model:${f.planner.id}`);
					expect(systemPrompt.join("\n")).toContain(`effort:${Effort.Max}`);
					return undefined;
				});
			const task = f.session.prompt(TASK);
			try {
				await gate.entered;
				expect(f.session.model?.id).toBe(f.planner.id);
				expect(f.session.configuredThinkingLevel()).toBe(Effort.Max);
				expect(f.session.armPrewalk(f.target, Effort.Low)).toBe(true);
			} finally {
				gate.release();
			}
			await task;
			expect(policy).toHaveBeenCalledTimes(1);
			expect(f.requested).toEqual([f.planner.id, f.planner.id, f.target.id]);
			expect(f.efforts).toEqual([Effort.Max, Effort.Max, Effort.Low]);
			policy.mockRestore();
			const boundary = f.requested.length;
			await f.session.prompt("explain the manually selected cursor model");
			expect(f.requested.slice(boundary)).toEqual([f.target.id]);
			expect(f.session.configuredThinkingLevel()).toBe(Effort.Low);
		});

		it.each([
			["metadata", "same model"],
			["metadata", "other model"],
			["metadata", "effort"],
			["reconciliation", "same model"],
			["reconciliation", "other model"],
			["reconciliation", "effort"],
		] as const)("explicit %s-wait %s selection supersedes automatic ownership", async (phase, selection) => {
			stubJudge([PREWALK, DIRECT]);
			const f = createFixture([done("current"), done("next")], { auto: "on", planningModel: "@slow" });
			const gate = pausePlannerSelection(f, phase);
			const task = f.session.prompt(TASK);
			let selected: Model | undefined;
			try {
				await gate.entered;
				selected = selection === "other model" ? f.target : f.session.model;
				if (selection === "effort") f.session.setThinkingLevel(Effort.Medium);
				else {
					if (!selected) throw new Error("Expected current model");
					await f.session.setModel(selected);
				}
			} finally {
				gate.release();
			}
			await task;
			await f.session.prompt("explain the selected cursor model");
			expect(f.requested).toEqual([selected!.id, selected!.id]);
			expect(f.session.model?.id).toBe(selected!.id);
			expect(f.session.getPrewalkState()).toBeUndefined();
			expect(f.nudges.flat()).not.toContain("prewalk-plan");
			if (selection === "effort") expect(f.efforts).toEqual([Effort.Medium, Effort.Medium]);
		});

		it.each(["metadata", "reconciliation"] as const)(
			"cancellation during %s retires ownership before a replacement task",
			async phase => {
				const calls = stubJudge([PREWALK, DIRECT]);
				const f = createFixture([done("replacement")], { auto: "on", planningModel: "@slow" });
				const gate = pausePlannerSelection(f, phase);
				const task = f.session.prompt(TASK);
				let replacement: Promise<unknown> | undefined;
				try {
					await gate.entered;
					await f.session.abort();
					replacement = f.session.prompt("explain the replacement cursor");
				} finally {
					gate.release();
				}
				await task.catch(() => {});
				await replacement;
				expect(asked(calls).at(-1)?.model).toBe(f.primary.id);
				expect(f.requested).toEqual([f.primary.id]);
				expect(f.efforts).toEqual([Effort.High]);
				expect(f.session.getPrewalkState()).toBeUndefined();
				expect(f.nudges.flat()).not.toContain("prewalk-plan");
				expect(f.sequence.filter(event => event.startsWith("model:"))).toEqual(
					phase === "metadata" ? [] : [`model:${f.planner.id}`, `model:${f.primary.id}`],
				);
			},
		);

		it("an aborted judgment cannot switch or arm the replacement task", async () => {
			const hold = Promise.withResolvers<void>();
			const requested = Promise.withResolvers<void>();
			const calls = stubJudge([PREWALK, DIRECT], { hold: hold.promise, requested: requested.resolve });
			const f = createFixture([done("replacement")], { auto: "on", planningModel: "@slow" });
			const task = f.session.prompt(TASK);
			let replacement: Promise<unknown> | undefined;
			try {
				await requested.promise;
				await f.session.abort();
				replacement = f.session.prompt("explain the replacement cursor");
			} finally {
				hold.resolve();
			}
			await task.catch(() => {});
			await replacement;
			expect(asked(calls).map(call => call.model)).toEqual([f.primary.id, f.primary.id]);
			expect(f.sequence).toEqual([`stream:${f.primary.id}`]);
			expect(f.session.getPrewalkState()).toBeUndefined();
		});

		it("publishes the planner before tools, recall, policy hooks, auto-thinking, and the first stream, once each", async () => {
			const calls = stubJudge([PREWALK]);
			const f = createFixture([done("planned")], {
				auto: "on",
				planningModel: "@slow",
				memory: true,
				rebuildSystemPrompt: async names => ({
					systemPrompt: [`model:${session?.model?.id}`, `tools:${names.join(",")}`],
				}),
				beforeStream: async context => {
					const prompt = context.systemPrompt?.join("\n") ?? "";
					expect(prompt).toContain(`model:${f.planner.id}`);
					expect(prompt).toContain(`policy:${f.planner.id}`);
					expect(prompt).toContain("planner-only memory");
					expect(context.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(["todo", "write"]));
				},
			});
			f.settings.setModelRole("slow", `${f.planner.provider}/${f.planner.id}:auto`);
			const client = new HindsightApi({ baseUrl: "http://unused.invalid" });
			f.session.setHindsightSessionState(
				new HindsightSessionState({
					sessionId: f.session.sessionId,
					session: f.session,
					config: loadHindsightConfig(f.settings),
					client,
					bankId: "test-bank",
					banksSet: new Set(["test-bank"]),
				}),
			);
			const recall = vi.spyOn(client, "recall").mockImplementation(async () => {
				f.sequence.push(`recall:${f.session.model?.id}`);
				return { results: [{ id: "planning-memory", text: "planner-only memory" }] };
			});
			const reconcile = SessionTools.prototype.reconcileThinkTool;
			vi.spyOn(SessionTools.prototype, "reconcileThinkTool").mockImplementation(async function (
				this: SessionTools,
				...args
			) {
				f.sequence.push(`tools:${f.session.model?.id}`);
				return reconcile.apply(this, args);
			});
			const hook = vi
				.spyOn(f.runner, "emitBeforeAgentStart")
				.mockImplementation(async (_prompt, _images, systemPrompt) => {
					f.sequence.push(`hook:${f.session.model?.id}`);
					expect(systemPrompt.join("\n")).toContain(`model:${f.planner.id}`);
					expect(systemPrompt.join("\n")).toContain("planner-only memory");
					return { systemPrompt: [...systemPrompt, `policy:${f.session.model?.id}`] };
				});
			const autoThinking = ModelControls.prototype.applyAutoThinkingLevel;
			const thinking = vi
				.spyOn(ModelControls.prototype, "applyAutoThinkingLevel")
				.mockImplementation(async function (this: ModelControls, ...args) {
					f.sequence.push(`thinking:${f.session.model?.id}`);
					return autoThinking.apply(this, args);
				});

			await f.session.prompt(`ultrathink ${TASK}`);

			expect(asked(calls).map(call => call.model)).toEqual([f.primary.id]);
			expect(f.sequence[0]).toBe(`model:${f.planner.id}`);
			for (const consumer of ["tools", "recall", "hook", "thinking", "stream"]) {
				const events = f.sequence.filter(event => event.startsWith(`${consumer}:`));
				expect(events.length).toBeGreaterThan(0);
				expect(events.every(event => event === `${consumer}:${f.planner.id}`)).toBe(true);
			}
			expect(f.sequence.indexOf(`recall:${f.planner.id}`)).toBeLessThan(f.sequence.indexOf(`hook:${f.planner.id}`));
			expect(f.sequence.indexOf(`hook:${f.planner.id}`)).toBeLessThan(
				f.sequence.indexOf(`thinking:${f.planner.id}`),
			);
			expect(f.sequence.at(-1)).toBe(`stream:${f.planner.id}`);
			expect(recall).toHaveBeenCalledTimes(1);
			expect(hook).toHaveBeenCalledTimes(1);
			expect(thinking).toHaveBeenCalledTimes(1);
			expect(f.nudges[0]).toContain("prewalk-plan");
		});

		it("hands todo-gated implementation back to the exact baseline model and configured effort", async () => {
			stubJudge([PREWALK]);
			const f = createFixture([toolCall("early", "write"), ...cycle()], {
				auto: "on",
				planningModel: "@slow",
				thinkingLevel: Effort.Medium,
			});

			await f.session.prompt(TASK);

			expect(f.requested).toEqual([f.planner.id, f.planner.id, f.planner.id, f.primary.id]);
			expect(f.efforts.at(-1)).toBe(Effort.Medium);
			expect(f.session.configuredThinkingLevel()).toBe(Effort.Medium);
			expect(f.nudges[3]).toContain("prewalk-checklist");
		});

		it.each(["@smol", "anthropic/claude-sonnet-4-6:low"])(
			"honors an explicitly configured target %s instead of the dynamic baseline",
			async autoTarget => {
				stubJudge([PREWALK]);
				const f = createFixture(cycle(), { auto: "on", planningModel: "@slow", autoTarget });
				await f.session.prompt(TASK);
				expect(f.requested).toEqual([f.planner.id, f.planner.id, f.target.id]);
				expect(f.efforts.at(-1)).toBe(Effort.Low);
			},
		);

		it("already on the planner still makes a useful handoff to the default smol role", async () => {
			stubJudge([PREWALK]);
			const f = createFixture(cycle(), { auto: "on", planningModel: "@slow", initialPlanner: true });
			await f.session.prompt(TASK);
			expect(f.requested).toEqual([f.planner.id, f.planner.id, f.target.id]);
		});

		it.each([
			["primary", PRIMARY],
			["direct", DIRECT],
			["weak prewalk", WEAK_PREWALK],
			["malformed verdict", MALFORMED],
			["judgment failure", "http-400"],
		] as const)("leaves the baseline unchanged for %s", async (_label, reply) => {
			stubJudge([reply]);
			const f = createFixture([done("baseline")], { auto: "on", planningModel: "@slow" });
			await f.session.prompt(TASK);
			expect(f.sequence).toEqual([`stream:${f.primary.id}`]);
			expect(f.efforts).toEqual([Effort.High]);
			expect(f.session.getPrewalkState()).toBeUndefined();
		});

		it("suggest does not select a configured planner or arm a handoff", async () => {
			stubJudge([PREWALK]);
			const f = createFixture(cycle(), { auto: "suggest", planningModel: "@slow" });
			await f.session.prompt(TASK);
			expect(f.sequence).toEqual(Array(3).fill(`stream:${f.primary.id}`));
			expect(f.session.getPrewalkState()).toBeUndefined();
			expect(f.nudges.flat()).toEqual([]);
		});

		it("restores the next task's baseline despite an unrelated settings override", async () => {
			const calls = stubJudge([PREWALK, DIRECT]);
			const f = createFixture([done("plan only"), done("next")], { auto: "on", planningModel: "@slow" });
			cfgPrewalkAuto.override(f.settings, "on");
			await f.session.prompt(TASK);
			expect(f.session.model?.id).toBe(f.planner.id);
			expect(f.session.getPrewalkState()?.target.id).toBe(f.primary.id);
			const boundary = f.requested.length;
			expect(f.requested.every(id => id === f.planner.id)).toBe(true);
			f.settings.setModelRole("smol", `${f.target.provider}/${f.target.id}:medium`);
			await f.session.prompt("explain the cursor next");
			expect(asked(calls).map(call => call.model)).toEqual([f.primary.id, f.primary.id]);
			expect(f.requested.slice(boundary)).toEqual([f.primary.id]);
			expect(f.session.model?.id).toBe(f.primary.id);
			expect(f.efforts.at(-1)).toBe(Effort.High);
			expect(f.session.getPrewalkState()).toBeUndefined();
		});

		it("/new restores an early planner selection that never handed off", async () => {
			stubJudge([PREWALK]);
			const f = createFixture([done("plan only")], {
				auto: "on",
				planningModel: "@slow",
				thinkingLevel: Effort.Medium,
			});
			await f.session.prompt(TASK);
			expect(f.session.model?.id).toBe(f.planner.id);
			expect(await f.session.newSession()).toBe(true);
			expect(f.session.model?.id).toBe(f.primary.id);
			expect(f.session.configuredThinkingLevel()).toBe(Effort.Medium);
			expect(f.session.getPrewalkState()).toBeUndefined();
		});

		it.each([
			["missing planner", "planner"],
			["missing target", "target"],
			["planner credential lookup failure", "planner-key"],
			["target credential lookup failure", "target-key"],
			["unavailable planner selector", "planner-selector"],
			["unavailable target selector", "target-selector"],
		] as const)("fails open without publishing when %s", async (_label, failure) => {
			stubJudge([PREWALK]);
			const f = createFixture(cycle(), {
				auto: "on",
				planningModel: failure === "planner-selector" ? "missing-provider/missing-model" : "@slow",
				autoTarget: failure === "target-selector" ? "missing-provider/missing-model" : "@smol",
			});
			const hasAuth = f.modelRegistry.hasConfiguredAuth.bind(f.modelRegistry);
			vi.spyOn(f.modelRegistry, "hasConfiguredAuth").mockImplementation(model =>
				(failure === "planner" && model.id === f.planner.id) || (failure === "target" && model.id === f.target.id)
					? false
					: hasAuth(model),
			);
			const getApiKey = f.modelRegistry.getApiKey.bind(f.modelRegistry);
			vi.spyOn(f.modelRegistry, "getApiKey").mockImplementation(async (model, sessionId) =>
				(failure === "planner-key" && model.id === f.planner.id) ||
				(failure === "target-key" && model.id === f.target.id)
					? undefined
					: getApiKey(model, sessionId),
			);
			await f.session.prompt(TASK);
			expect(f.sequence).toEqual(Array(3).fill(`stream:${f.primary.id}`));
			expect(f.session.getPrewalkState()).toBeUndefined();
		});

		it("queued follow-ups choose independently while steering keeps the running planner task", async () => {
			const calls = stubJudge([PREWALK, DIRECT, PREWALK]);
			const negative = "explain the lock manager";
			const positive = "fix the queued cursor race";
			const taskModels: Record<string, string[]> = { initial: [], negative: [], positive: [] };
			let steered = false;
			let positiveQueued = false;
			const f = createFixture([...cycle(), done("negative"), ...cycle()], {
				auto: "on",
				planningModel: "@slow",
				beforeStream: async context => {
					const current = context.messages.findLast(message => message.role === "user");
					const text =
						typeof current?.content === "string"
							? current.content
							: current?.content
									.filter(part => part.type === "text")
									.map(part => part.text)
									.join("\n");
					const task = text === negative ? "negative" : text === positive ? "positive" : "initial";
					taskModels[task]!.push(f.session.model!.id);
					if (!steered) {
						steered = true;
						await f.session.steer("also preserve the retry cursor");
						await f.session.followUp(negative);
					} else if (task === "negative" && !positiveQueued) {
						positiveQueued = true;
						await f.session.followUp(positive);
					}
				},
			});
			await f.session.prompt(TASK);
			await f.session.waitForIdle();
			expect(asked(calls).map(call => call.state.request)).toEqual([TASK, negative, positive]);
			expect(taskModels).toEqual({
				initial: [f.planner.id, f.planner.id, f.primary.id],
				negative: [f.primary.id],
				positive: [f.planner.id, f.planner.id, f.primary.id],
			});
			expect(f.contexts.some(context => context.includes("also preserve the retry cursor"))).toBe(true);
		});
	});

	describe("modes", () => {
		it("does nothing and asks the judge nothing while prewalk.auto is off, the default", async () => {
			const calls = stubJudge([PREWALK]);
			const f = createFixture(cycle());

			await f.session.prompt(TASK);

			expect(calls).toEqual([]);
			expect(f.requested).toEqual([f.primary.id, f.primary.id, f.primary.id]);
			expect(f.session.getPrewalkState()).toBeUndefined();
			expect(f.notices).toEqual([]);
		});

		it("suggest reports each decision without arming, nudging, or switching models", async () => {
			const calls = stubJudge([PREWALK, PRIMARY]);
			const f = createFixture([...cycle(), done("two")], { auto: "suggest" });

			await f.session.prompt(TASK);
			expect(f.notices).toEqual(["Auto-prewalk: prewalk 0.90"]);
			expect(f.requested).toEqual([f.primary.id, f.primary.id, f.primary.id]);
			expect(f.session.getPrewalkState()).toBeUndefined();
			expect(f.nudges.flat()).toEqual([]);

			await f.session.prompt("what races in the cache layer?");
			expect(f.notices).toEqual(["Auto-prewalk: prewalk 0.90", "Auto-prewalk: primary (prewalk 0.10)"]);
			expect(asked(calls)).toHaveLength(2);
			expect(f.session.model?.id).toBe(f.primary.id);
		});

		it("on arms a confident prewalk from the active model, and the todo-gated first write does the switch", async () => {
			const calls = stubJudge([PREWALK]);
			const f = createFixture(
				[toolCall("early", "write"), toolCall("todo", "todo"), toolCall("write", "write"), { content: ["done"] }],
				{ auto: "on" },
			);

			await f.session.prompt(TASK);

			expect(asked(calls)).toHaveLength(1);
			// The write before the todo list leaves the gate shut; the one after it hands off.
			expect(f.requested).toEqual([f.primary.id, f.primary.id, f.primary.id, f.target.id]);
			expect(f.session.model?.id).toBe(f.target.id);
			// The plan nudge rides the task's own first request.
			expect(f.nudges[0]).toContain("prewalk-plan");
			expect(f.nudges[3]).toContain("prewalk-checklist");
			expect(f.notices.filter(message => message.startsWith("Prewalk: armed"))).toHaveLength(1);
			expect(f.notices.some(message => message.startsWith("Auto-prewalk"))).toBe(false);
			const usage = f.session.sessionManager.getBranch().filter(entry => entry.type === "model_usage");
			expect(usage).toEqual([expect.objectContaining({ purpose: "auto-prewalk", role: "typesafe" })]);
		});

		it.each([
			["an arm drops the eager todo reminder, as a configured prewalk would", "on", false],
			["a suggestion leaves the eager todo reminder alone", "suggest", true],
		] as const)("todo.eager: %s", async (_label, auto, keeps) => {
			stubJudge([PREWALK]);
			const f = createFixture(cycle(), { auto, todoEager: "preferred" });

			await f.session.prompt(TASK);

			expect(f.customs[0]?.includes(EAGER_TODO_PRELUDE_MESSAGE_TYPE)).toBe(keeps);
			expect(f.nudges[0]?.includes("prewalk-plan")).toBe(!keeps);
		});

		it("on stays quiet when the active model already is the target", async () => {
			stubJudge([PREWALK]);
			const f = createFixture([done("one")], { auto: "on" });
			f.settings.setModelRole("smol", `${f.primary.provider}/${f.primary.id}:high`);

			await f.session.prompt(TASK);

			expect(f.session.getPrewalkState()).toBeUndefined();
			expect(f.notices).toEqual([]);
			expect(f.requested).toEqual([f.primary.id]);
		});

		it("on arms nothing, and reports nothing, for primary, direct, or a prewalk below the threshold", async () => {
			stubJudge([PRIMARY, DIRECT, WEAK_PREWALK]);
			const f = createFixture([done("one"), done("two"), done("three")], { auto: "on" });

			await f.session.prompt("fix the race in the lock manager");
			await f.session.prompt("what does this function return?");
			await f.session.prompt("maybe tidy up the retry code");

			expect(f.requested).toEqual(Array(3).fill(f.primary.id));
			expect(f.session.getPrewalkState()).toBeUndefined();
			expect(f.notices).toEqual([]);
		});
	});

	describe("failing open", () => {
		it("continues the turn without arming when the judge errors, answers garbage, or times out", async () => {
			stubJudge(["http-400", MALFORMED, PREWALK]);
			const f = createFixture([done("one"), done("two"), done("three")], { auto: "on" });

			await f.session.prompt("first task");
			await f.session.prompt("second task");
			// A stuck judge: the timeout fires before the request is ever sent.
			const realTimeout = AbortSignal.timeout.bind(AbortSignal);
			vi.spyOn(AbortSignal, "timeout").mockImplementation(ms =>
				ms === AUTO_PREWALK_TIMEOUT_MS
					? AbortSignal.abort(new DOMException("timed out", "TimeoutError"))
					: realTimeout(ms),
			);
			await f.session.prompt("third task");

			expect(f.requested).toEqual(Array(3).fill(f.primary.id));
			expect(f.session.getPrewalkState()).toBeUndefined();
			expect(f.notices).toEqual([]);
		});

		it("drops a judgment that lands after the prompt was aborted", async () => {
			const hold = Promise.withResolvers<void>();
			const requested = Promise.withResolvers<void>();
			const calls = stubJudge([PREWALK], { hold: hold.promise, requested: requested.resolve });
			const f = createFixture([done("never requested")], { auto: "on" });

			const first = f.session.prompt(TASK);
			await requested.promise;
			await f.session.abort();
			hold.resolve();
			await first.catch(() => {});

			expect(asked(calls)).toHaveLength(1);
			expect(f.session.getPrewalkState()).toBeUndefined();
			expect(f.requested).toEqual([]);
			expect(f.notices).toEqual([]);
		});

		it("makes no judgment and no change without a native judge", async () => {
			const calls = stubJudge([PREWALK]);
			const f = createFixture(cycle(), { auto: "on", judge: false });

			await f.session.prompt(TASK);

			expect(calls).toEqual([]);
			expect(f.requested).toEqual([f.primary.id, f.primary.id, f.primary.id]);
			expect(f.session.getPrewalkState()).toBeUndefined();
		});
	});

	describe("eligibility", () => {
		it.each([
			["a synthetic continuation", { synthetic: true }],
			["an agent-attributed prompt", { attribution: "agent" }],
		] as const)("never classifies %s", async (_label, promptOptions) => {
			const calls = stubJudge([PREWALK]);
			const f = createFixture([done("one")], { auto: "on" });

			await f.session.prompt(TASK, promptOptions);

			expect(calls).toEqual([]);
			expect(f.session.getPrewalkState()).toBeUndefined();
		});

		it("never asks the judge about an acknowledgement", async () => {
			const calls = stubJudge([PREWALK]);
			const f = createFixture([done("one")], { auto: "on" });

			await f.session.prompt("thanks");

			expect(calls).toEqual([]);
		});

		it("never classifies a plan-mode turn, whose plan-file write would trip the handoff", async () => {
			const calls = stubJudge([PREWALK]);
			const f = createFixture([done("one")], { auto: "on" });
			f.session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel" });

			await f.session.prompt(TASK);

			expect(calls).toEqual([]);
			expect(f.session.getPrewalkState()).toBeUndefined();
		});

		it("hands a short follow-up the earlier request and the agent's reply", async () => {
			const calls = stubJudge([DIRECT, PREWALK]);
			const reply = "The cursor resets because sync() reads a stale offset. Fix: persist it before awaiting.";
			const f = createFixture([{ content: [reply] }, ...cycle()], { auto: "on" });

			await f.session.prompt("why does the sync cursor reset after a reconnect?");
			await f.session.prompt("do that");

			const [first, second] = asked(calls);
			expect(first!.state).toEqual({ request: "why does the sync cursor reset after a reconnect?" });
			expect(second!.state).toEqual({
				request: "do that",
				previous_request: "why does the sync cursor reset after a reconnect?",
				previous_response: reply,
			});
			expect(f.session.model?.id).toBe(f.target.id);
		});
	});

	describe("queued input", () => {
		it("never judges steering, which amends the running task", async () => {
			const calls = stubJudge([DIRECT, PREWALK]);
			let steered = false;
			const f = createFixture([done("first"), done("steered")], {
				auto: "on",
				beforeStream: async () => {
					if (steered) return;
					steered = true;
					await f.session.steer(TASK);
				},
			});

			await f.session.prompt("explain the sync engine");
			await f.session.waitForIdle();

			expect(asked(calls).map(call => call.state.request)).toEqual(["explain the sync engine"]);
			expect(f.contexts.some(context => context.includes(TASK))).toBe(true);
			expect(f.session.getPrewalkState()).toBeUndefined();
			expect(f.requested.every(id => id === f.primary.id)).toBe(true);
		});

		it("judges a queued follow-up as its own task in suggest mode", async () => {
			const calls = stubJudge([DIRECT, PREWALK]);
			const f = createFixture([done("first"), done("follow-up")], { auto: "suggest" });
			let queued = false;
			f.session.agent.setOnBeforeYield(async () => {
				if (queued) return;
				queued = true;
				await f.session.followUp("fix the cursor next");
			});

			await f.session.prompt("explain the sync engine");
			await f.session.waitForIdle();

			expect(asked(calls).map(call => call.state.request)).toEqual([
				"explain the sync engine",
				"fix the cursor next",
			]);
			expect(f.notices).toEqual(["Auto-prewalk: direct (prewalk 0.05)", "Auto-prewalk: prewalk 0.90"]);
			expect(f.requested).toEqual([f.primary.id, f.primary.id]);
			expect(f.nudges.flat()).toEqual([]);
		});

		it("arms a queued follow-up and delivers its plan nudge with it", async () => {
			stubJudge([DIRECT, PREWALK]);
			const f = createFixture([done("first"), ...cycle()], { auto: "on" });
			let queued = false;
			f.session.agent.setOnBeforeYield(async () => {
				if (queued) return;
				queued = true;
				await f.session.followUp(TASK);
			});

			await f.session.prompt("explain the sync engine");
			await f.session.waitForIdle();

			expect(f.nudges[0]).toEqual([]);
			expect(f.nudges[1]).toContain("prewalk-plan");
			expect(f.requested).toEqual([f.primary.id, f.primary.id, f.primary.id, f.target.id]);
		});
	});

	describe("one task at a time", () => {
		it.each([
			["primary", PRIMARY],
			["direct", DIRECT],
			["a prewalk below the threshold", WEAK_PREWALK],
			["a failed judgment", "http-400" as const],
		] as const)("the next task starts back on the planning model and effort for %s", async (_label, reply) => {
			const calls = stubJudge([PREWALK, reply]);
			const f = createFixture([...cycle(), done("two")], { auto: "on" });
			await f.session.prompt("task one");
			expect(f.session.model?.id).toBe(f.target.id);

			await f.session.prompt("task two");

			expect(asked(calls).at(-1)?.model).toBe(f.primary.id);
			expect(f.requested.at(-1)).toBe(f.primary.id);
			expect(f.efforts.at(-1)).toBe(Effort.High);
			expect(f.session.getPrewalkState()).toBeUndefined();
		});

		it("a later positive task plans on the planning model and hands off again", async () => {
			stubJudge([PREWALK, PREWALK]);
			const f = createFixture([...cycle(), ...cycle()], { auto: "on" });
			await f.session.prompt("task one");
			const boundary = f.requested.length;

			await f.session.prompt("task two");

			expect(f.requested.slice(boundary)).toEqual([f.primary.id, f.primary.id, f.target.id]);
			expect(f.nudges[boundary]).toContain("prewalk-plan");
		});

		it("drops an auto arm its task never used and judges the next task afresh", async () => {
			const calls = stubJudge([PREWALK, PRIMARY]);
			const f = createFixture([{ content: ["plan only"] }, { content: ["still planning"] }, done("two")], {
				auto: "on",
			});
			await f.session.prompt(TASK);
			expect(f.session.getPrewalkState()?.target.id).toBe(f.target.id);

			await f.session.prompt("now fix the lock race");

			expect(asked(calls)).toHaveLength(2);
			expect(f.session.getPrewalkState()).toBeUndefined();
			// Only the dropped arm's plan nudge is withdrawn; delivered continuations stay in history.
			expect(f.nudges.at(-1)).not.toContain("prewalk-plan");
		});

		it.each([
			["another model", "other"],
			["the handoff model again", "target"],
		] as const)("an explicit selection of %s after the handoff keeps the session there", async (_label, pick) => {
			stubJudge([PREWALK, DIRECT]);
			const f = createFixture([...cycle(), done("two")], { auto: "on" });
			await f.session.prompt("task one");
			const manual = pick === "other" ? modelOrThrow("claude-opus-4-6") : f.target;
			await f.session.setModel(manual);

			await f.session.prompt("task two");

			expect(f.requested.at(-1)).toBe(manual.id);
		});

		it("an explicit effort selection after the handoff keeps the model and effort the user chose", async () => {
			stubJudge([PREWALK, DIRECT]);
			const f = createFixture([...cycle(), done("two")], { auto: "on" });
			await f.session.prompt("task one");
			f.session.setThinkingLevel(Effort.Medium);

			await f.session.prompt("task two");

			expect(f.requested.at(-1)).toBe(f.target.id);
			expect(f.efforts.at(-1)).toBe(Effort.Medium);
		});

		it("never restores a handoff that /prewalk made", async () => {
			stubJudge([DIRECT]);
			const f = createFixture([...cycle(), done("two")], { auto: "on" });
			expect(f.session.armPrewalk(f.target, Effort.Low)).toBe(true);
			await f.session.prompt("task one");
			expect(f.session.model?.id).toBe(f.target.id);

			await f.session.prompt("task two");

			expect(f.requested.at(-1)).toBe(f.target.id);
		});

		it("/new returns an auto handoff to its planning model", async () => {
			stubJudge([PREWALK]);
			const f = createFixture(cycle(), { auto: "on" });
			await f.session.prompt(TASK);
			expect(f.session.model?.id).toBe(f.target.id);

			expect(await f.session.newSession()).toBe(true);

			expect(f.session.model?.id).toBe(f.primary.id);
			expect(f.session.configuredThinkingLevel()).toBe(Effort.High);
		});

		it("suggest never moves models, even over an earlier auto handoff", async () => {
			stubJudge([PREWALK, PRIMARY]);
			const f = createFixture([...cycle(), done("two")], { auto: "on" });
			await f.session.prompt(TASK);
			expect(f.session.model?.id).toBe(f.target.id);

			cfgPrewalkAuto.override(f.settings, "suggest");
			await f.session.prompt("what races in the cache layer?");

			expect(f.requested.at(-1)).toBe(f.target.id);
			expect(f.notices.at(-1)).toBe("Auto-prewalk: primary (prewalk 0.10)");
		});
	});

	describe("manual control", () => {
		it("leaves a configured arm untouched: no judgment, no retargeting", async () => {
			const calls = stubJudge([PREWALK]);
			const configured = modelOrThrow("claude-opus-4-6");
			const f = createFixture(cycle(), { auto: "on", startupArm: configured });

			await f.session.prompt(TASK);

			expect(asked(calls)).toHaveLength(0);
			expect(f.requested).toEqual([f.primary.id, f.primary.id, configured.id]);
		});

		it("an explicit /prewalk takes over a pending auto arm, so the next task keeps it", async () => {
			const calls = stubJudge([PREWALK]);
			const f = createFixture(
				[{ content: ["plan only"] }, { content: ["still planning"] }, ...cycle(), done("three")],
				{ auto: "on" },
			);
			await f.session.prompt(TASK);

			expect(f.session.armPrewalk(f.target, Effort.Low)).toBe(true);
			await f.session.prompt("go ahead");
			expect(f.session.model?.id).toBe(f.target.id);
			await f.session.prompt("task three");

			expect(asked(calls)).toHaveLength(2);
			expect(f.requested.at(-1)).toBe(f.target.id);
		});

		it("/prewalk off keeps auto-prewalk out of the session until /new", async () => {
			const calls = stubJudge([PREWALK]);
			const f = createFixture([done("one"), ...cycle()], { auto: "on" });
			expect(await executeBuiltinSlashCommand("/prewalk off", { ctx: f.ctx })).toBe(true);

			await f.session.prompt(TASK);
			expect(asked(calls)).toHaveLength(0);

			expect(await f.session.newSession()).toBe(true);
			const boundary = f.requested.length;
			await f.session.prompt(TASK);

			expect(asked(calls)).toHaveLength(1);
			expect(f.requested.slice(boundary)).toEqual([f.primary.id, f.primary.id, f.target.id]);
		});

		it("--no-prewalk keeps auto-prewalk out of the startup session only", async () => {
			const calls = stubJudge([PREWALK]);
			const f = createFixture([done("one"), ...cycle()], { auto: "on", suppressAutoPrewalk: true });

			await f.session.prompt(TASK);
			expect(asked(calls)).toHaveLength(0);

			expect(await f.session.newSession()).toBe(true);
			const boundary = f.requested.length;
			await f.session.prompt(TASK);

			expect(f.requested.slice(boundary)).toEqual([f.primary.id, f.primary.id, f.target.id]);
		});
	});

	it("never judges a subagent's tasks", async () => {
		const calls = stubJudge([PREWALK]);
		const f = createFixture([done("one"), done("two")], { auto: "on", agentKind: "sub" });

		await f.session.prompt("task one");
		await f.session.prompt("task two");

		expect(asked(calls)).toHaveLength(0);
		expect(f.requested).toEqual([f.primary.id, f.primary.id]);
	});
});
