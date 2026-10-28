import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, type Context, Effort, type Model, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AUTO_PREWALK_TIMEOUT_MS, type PrewalkRoute } from "@oh-my-pi/pi-coding-agent/auto-prewalk/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	cfgCompactionEnabled,
	cfgCompactionThresholdTokens,
	cfgContextPromotionEnabled,
} from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { PrewalkCoordinator, type PrewalkCoordinatorHost } from "@oh-my-pi/pi-coding-agent/session/prewalk";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionTools } from "@oh-my-pi/pi-coding-agent/session/session-tools";
import { cfgPrewalkAuto } from "@oh-my-pi/pi-coding-agent/session/settings";
import { EAGER_TODO_PRELUDE_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/todo-tracker";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";
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
	 * `gate` parks the route question until its promise settles.
	 */
	function stubJudge(replies: Reply[] = [], gate?: { hold: Promise<void>; requested: () => void }): JudgeCall[] {
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
				if (gate) {
					gate.requested();
					await gate.hold;
				}
				const reply = replies.shift() ?? DIRECT;
				if (reply === "http-400") return new Response("bad request", { status: 400 });
				return Response.json({ model: "jev", answers: { route: reply }, usage });
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
		suppressAutoPrewalk?: boolean;
		/** `todo.eager`, which adds a first-turn reminder before the judge answers. */
		todoEager?: "preferred" | "always";
		beforeStream?: (context: Context, options?: SimpleStreamOptions) => Promise<void>;
	}

	function createFixture(responses: MockResponse[], options: FixtureOptions = {}) {
		const primary = modelOrThrow("claude-sonnet-4-5");
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
		});
		settings.setModelRole("smol", `${target.provider}/${target.id}:low`);
		const mock = createMockModel({ responses });
		const requested: string[] = [];
		const efforts: Array<string | undefined> = [];
		const nudges: string[][] = [];
		const customs: string[][] = [];
		const contexts: string[] = [];
		let requestCustoms: string[] = [];
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
				efforts.push(agent.state.thinkingLevel);
				nudges.push(requestCustoms.filter(customType => customType.startsWith("prewalk-")));
				customs.push(requestCustoms);
				contexts.push(JSON.stringify(context.messages));
				await options.beforeStream?.(context, streamOptions);
				return mock.stream(model, context, streamOptions);
			},
		});
		const startupTarget = options.startupArm === true ? target : options.startupArm || undefined;
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry,
			thinkingLevel: Effort.High,
			prewalk: startupTarget ? { target: startupTarget, thinkingLevel: Effort.Low } : undefined,
			agentKind: options.agentKind,
			suppressAutoPrewalk: options.suppressAutoPrewalk,
		});
		session = created;
		const notices: string[] = [];
		created.subscribe(event => {
			if (event.type === "notice" && event.source === "prewalk") notices.push(event.message);
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
			modelRegistry,
			primary,
			target,
			requested,
			efforts,
			nudges,
			customs,
			contexts,
			notices,
			ctx,
		};
	}

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

		it("a context-promoted auto handoff still returns to its planning model at the next task", async () => {
			stubJudge([PREWALK, DIRECT]);
			const promoted = modelOrThrow("claude-opus-4-6");
			const f = createFixture([...cycle(), done("promoted"), done("next")], {
				auto: "on",
				beforeStream: async () => {
					if (f.session.model?.id === promoted.id) cfgCompactionEnabled.override(f.settings, false);
				},
			});
			vi.spyOn(SessionMaintenance.prototype, "deferThresholdCompactionToSpeculation").mockReturnValue(false);
			vi.spyOn(SessionMaintenance.prototype, "resolveContextPromotionTarget").mockImplementation(async current =>
				current.id === f.target.id ? promoted : undefined,
			);
			f.session.subscribe(event => {
				if (event.type !== "model_changed" || f.session.model?.id !== f.target.id) return;
				cfgCompactionEnabled.override(f.settings, true);
				cfgCompactionThresholdTokens.override(f.settings, 1);
				cfgContextPromotionEnabled.override(f.settings, true);
			});

			await f.session.prompt(TASK);
			expect(f.requested).toContain(promoted.id);

			await f.session.prompt("explain the cursor without changing any files");

			expect(f.requested.at(-1)).toBe(f.primary.id);
			expect(f.efforts.at(-1)).toBe(Effort.High);
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

		it.each(["same model", "other model", "thinking"] as const)(
			"an explicit %s pick after a task armed drops its pending auto handoff",
			async selection => {
				stubJudge([PREWALK]);
				const manual = modelOrThrow("claude-opus-4-6");
				let picked = false;
				const f = createFixture(cycle(), {
					auto: "on",
					beforeStream: async () => {
						if (picked) return;
						picked = true;
						if (selection === "thinking") f.session.setThinkingLevel(Effort.Medium);
						else await f.session.setModelTemporary(selection === "same model" ? f.primary : manual);
						// The first request delivered the plan; cancellation drops pending arm/steering, not in-flight history.
						expect(f.session.getPrewalkState()).toBeUndefined();
						expect(
							f.session.agent
								.peekSteeringQueue()
								.some(
									message =>
										message.role === "custom" &&
										(message.customType === "prewalk-plan" || message.customType === "prewalk-continue"),
								),
						).toBe(false);
					},
				});

				await f.session.prompt(TASK);

				const selected = selection === "other model" ? manual : f.primary;
				expect(f.nudges[0]).toContain("prewalk-plan");
				expect(f.requested).toEqual([f.primary.id, selected.id, selected.id]);
				expect(f.efforts).toEqual([
					Effort.High,
					selection === "thinking" ? Effort.Medium : Effort.High,
					selection === "thinking" ? Effort.Medium : Effort.High,
				]);
				expect(f.nudges.flat()).not.toContain("prewalk-checklist");
				expect(f.session.getPrewalkState()).toBeUndefined();
				expect(f.session.model?.id).toBe(selected.id);
			},
		);

		it.each(["metadata", "reconciliation"] as const)(
			"an explicit Medium pick and manual Opus arm during the handoff's target %s survive the stale switch",
			async phase => {
				stubJudge([PREWALK, DIRECT]);
				const f = createFixture([...cycle(), done("independent")], { auto: "on" });
				const opus = modelOrThrow("claude-opus-4-6");
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				let held = false;
				if (phase === "metadata") {
					const refresh = f.modelRegistry.refreshSelectedModelMetadata.bind(f.modelRegistry);
					vi.spyOn(f.modelRegistry, "refreshSelectedModelMetadata").mockImplementation(async model => {
						if (!held && model.id === f.target.id && f.requested.length === 2) {
							held = true;
							entered.resolve();
							await release.promise;
						}
						return refresh(model);
					});
				} else {
					const reconcile = SessionTools.prototype.reconcileThinkTool;
					vi.spyOn(SessionTools.prototype, "reconcileThinkTool").mockImplementation(async function (
						this: SessionTools,
						...args
					) {
						if (!held && f.session.model?.id === f.target.id) {
							held = true;
							entered.resolve();
							await release.promise;
						}
						return reconcile.apply(this, args);
					});
				}
				const selections: string[] = [];
				f.session.subscribe(event => {
					if (event.type === "model_changed" || event.type === "thinking_level_changed") selections.push(event.type);
				});
				const task = f.session.prompt(TASK);
				await entered.promise;
				f.session.setThinkingLevel(Effort.Medium);
				expect(f.session.armPrewalk(opus, Effort.Max)).toBe(true);
				const manualArm = f.session.getPrewalkState();
				const boundary = selections.length;
				release.resolve();
				await task;

				const selected = phase === "metadata" ? f.primary : f.target;
				expect(f.session.model?.id).toBe(selected.id);
				expect(f.session.configuredThinkingLevel()).toBe(Effort.Medium);
				expect(f.session.getPrewalkState()).toBe(manualArm);
				expect(selections.slice(boundary)).toEqual([]);
				expect(f.notices.some(notice => notice.startsWith("Prewalk: switched"))).toBe(false);
				expect(f.nudges.flat()).not.toContain("prewalk-checklist");

				await f.session.prompt("explain the cursor without changing any files");

				expect(f.requested.at(-1)).toBe(selected.id);
				expect(f.efforts.at(-1)).toBe(Effort.Medium);
				expect(f.session.getPrewalkState()).toBe(manualArm);
			},
		);

		it("an effort a subscriber selects while the handoff publishes its own stays at the next task", async () => {
			stubJudge([PREWALK, DIRECT]);
			const f = createFixture([...cycle(), done("two")], { auto: "on" });
			let picked = false;
			f.session.subscribe(event => {
				if (event.type !== "thinking_level_changed" || picked || f.session.model?.id !== f.target.id) return;
				picked = true;
				f.session.setThinkingLevel(Effort.Medium);
			});
			await f.session.prompt("task one");
			expect(picked).toBe(true);

			await f.session.prompt("task two");

			expect(f.requested.at(-1)).toBe(f.target.id);
			expect(f.efforts.at(-1)).toBe(Effort.Medium);
		});

		it("preserves an explicit pick and replacement manual arm when an obsolete auto handoff resumes after persistence", async () => {
			const f = createFixture([], { auto: "on" });
			const entered = Promise.withResolvers<void>();
			const persistence = Promise.withResolvers<void>();
			const unused = (): never => {
				throw new Error("Unexpected plan-mode capability");
			};
			const host: PrewalkCoordinatorHost = {
				agent: f.session.agent,
				sessionManager: f.session.sessionManager,
				settings: f.settings,
				model: () => f.session.model,
				configuredThinkingLevel: () => f.session.configuredThinkingLevel(),
				restoreThinkingLevel: level => f.session.setThinkingLevel(level),
				resolveDefaultPrewalk: () => undefined,
				resolveAutoPrewalkTarget: () => ({ target: f.target, thinkingLevel: Effort.Low }),
				classifyAutoPrewalk: async () => undefined,
				emitNotice: () => {},
				setModelTemporary: async (model, level) => {
					await f.session.setModelTemporary(model, level);
					return true;
				},
				setActiveToolsByName: unused,
				restoreNonMCPToolPresentation: unused,
				getAllToolNames: () => ["todo", "write"],
				getActiveToolNames: () => ["todo", "write"],
				getEnabledToolNames: () => ["todo", "write"],
				getMountedXdevToolNames: () => [],
				hasBuiltInTool: () => false,
				getPlanModeState: () => undefined,
				setPlanModeState: unused,
				getPlanReferencePath: unused,
				setPlanProposalHandler: unused,
				waitForSessionMessagePersistence: async () => {
					entered.resolve();
					await persistence.promise;
				},
				localProtocolOptions: unused,
			};
			const coordinator = new PrewalkCoordinator(host);
			const plan = coordinator.applyAuto({
				route: "prewalk",
				probabilities: { prewalk: 0.9, primary: 0.07, direct: 0.03 },
				confidence: 0.9,
				arm: true,
			});
			expect(plan).toBeDefined();
			const liveMessages = [plan!];
			f.session.agent.appendMessage(plan!);
			const turn = coordinator.advanceAtTurnEnd(liveMessages, {
				message: createAssistantMessage("implementing"),
				toolResults: ["todo", "write"].map(toolName => ({
					role: "toolResult" as const,
					toolCallId: toolName,
					toolName,
					content: [{ type: "text" as const, text: "ok" }],
					isError: false,
					timestamp: Date.now(),
				})),
				additionalMessages: [],
				willContinue: false,
			});
			await entered.promise;
			let replacementArm;
			let replacementSteering;
			try {
				f.session.setThinkingLevel(Effort.Medium);
				coordinator.releaseHandoff();
				expect(coordinator.state).toBeUndefined();
				expect(coordinator.arm(modelOrThrow("claude-opus-4-6"), Effort.Medium)).toBe(true);
				replacementArm = coordinator.state;
				replacementSteering = f.session.agent.peekSteeringQueue();
			} finally {
				persistence.resolve();
			}
			await turn;

			expect(f.session.model).toBe(f.primary);
			expect(f.session.configuredThinkingLevel()).toBe(Effort.Medium);
			expect(coordinator.state).toBe(replacementArm);
			expect(f.session.agent.peekSteeringQueue()).toEqual(replacementSteering);
			expect(
				replacementSteering?.some(message => message.role === "custom" && message.customType === "prewalk-plan"),
			).toBe(true);
			expect(
				f.session.agent
					.peekSteeringQueue()
					.some(message => message.role === "custom" && message.customType === "prewalk-checklist"),
			).toBe(false);
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
