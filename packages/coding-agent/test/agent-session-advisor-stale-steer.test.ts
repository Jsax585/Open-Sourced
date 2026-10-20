import { afterEach, expect, it, spyOn } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const stepSchema = type({});
type StepTool = AgentTool<typeof stepSchema, undefined>;

function textResponse(text: string): MockResponse {
	return { content: [text], stopReason: "stop" };
}

function toolResponse(id: string, name: string, arguments_: Record<string, unknown> = {}): MockResponse {
	return { content: [{ type: "toolCall", id, name, arguments: arguments_ }], stopReason: "toolUse" };
}

let active:
	| { session: AgentSession; auth: AuthStorage; temp: TempDir; releaseFourthStep: PromiseWithResolvers<void> }
	| undefined;

afterEach(async () => {
	const teardown = active;
	if (!teardown) return;
	teardown.releaseFourthStep.resolve();
	await teardown.session.dispose().catch(() => {});
	teardown.auth.close();
	await teardown.temp.remove().catch(() => {});
	active = undefined;
});

it.each([
	{ setting: 2, reviewInterval: 1, expectedChannel: "aside", freshness: "stale", stale: true },
	{ setting: 2, reviewInterval: 3, expectedChannel: "steer", freshness: "fresh", stale: false },
	{ setting: 0, reviewInterval: 1, expectedChannel: "steer", freshness: "stale", stale: true },
] as const)(
	"routes a $expectedChannel blocker for a $freshness covered turn (threshold=$setting)",
	async ({ setting, reviewInterval, expectedChannel, stale }) => {
		const temp = TempDir.createSync("@pi-advisor-stale-steer-");
		const auth = await AuthStorage.create(":memory:");
		auth.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");

		const reviewStarted = Promise.withResolvers<void>();
		const releaseReview = Promise.withResolvers<void>();
		const adviceAccepted = Promise.withResolvers<void>();
		const fourthStepStarted = Promise.withResolvers<void>();
		const releaseFourthStep = Promise.withResolvers<void>();
		let reviewCalls = 0;
		const note = `freshness gate ${expectedChannel} ${setting} ${reviewInterval}`;
		const primaryMock = createMockModel({
			id: "advisor-stale-steer-primary",
			provider: "anthropic",
			responses: [
				toolResponse("step-1", "step"),
				toolResponse("step-2", "step"),
				toolResponse("step-3", "step"),
				toolResponse("step-4", "step"),
				textResponse("primary complete"),
			],
		});
		const advisorMock = createMockModel({
			id: "advisor-stale-steer-reviewer",
			provider: "anthropic",
			handler: async () => {
				if (reviewCalls++ === 0) {
					reviewStarted.resolve();
					await releaseReview.promise;
					return toolResponse("stale-advice", "advise", { note, severity: "blocker" });
				}
				return textResponse("advisor quiet");
			},
		});
		const step: StepTool = {
			name: "step",
			label: "Step",
			description: "Advance primary work",
			parameters: stepSchema,
			execute: async toolCallId => {
				if (toolCallId === "step-4") {
					fourthStepStarted.resolve();
					await releaseFourthStep.promise;
				}
				return { content: [{ type: "text", text: "step complete" }] };
			},
		};
		const settings = Settings.isolated({
			"advisor.syncBacklog": "off",
			"advisor.reviewInterval": reviewInterval,
			"advisor.staleSteerTurns": setting,
			"compaction.enabled": false,
			"retry.enabled": false,
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["advisor freshness regression"], tools: [step] },
				streamFn: primaryMock.stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		active = { session, auth, temp, releaseFourthStep };
		if (!session.setAdvisorEnabled(true)) throw new Error("Expected advisor runtime");
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent");
		const advise = advisor.state.tools.find(tool => tool.name === "advise");
		if (!advise) throw new Error("Expected advise tool");
		const originalExecute = advise.execute.bind(advise);
		advise.execute = async (...args) => {
			const result = await originalExecute(...args);
			adviceAccepted.resolve();
			return result;
		};

		const advisorQueue = spyOn(session.yieldQueue, "enqueue");
		const sessionSend = spyOn(session, "sendCustomMessage");
		const run = session.prompt("advance four steps, then finish");
		await Promise.all([reviewStarted.promise, fourthStepStarted.promise]);
		// The first review covers turn 1, two turns before the current fourth step;
		// the interval-3 review covers turn 3 and is only one turn old.
		releaseReview.resolve();
		await adviceAccepted.promise;

		if (expectedChannel === "aside") {
			const queued = advisorQueue.mock.calls.find(([kind]) => kind === "advisor");
			expect(queued).toBeDefined();
			expect(queued?.[1]).toMatchObject({ note, ...(stale && setting > 0 ? { turnsAgo: 2 } : {}) });
		} else {
			expect(
				sessionSend.mock.calls.some(
					([message, options]) =>
						typeof message === "object" &&
						message !== null &&
						"customType" in message &&
						message.customType === "advisor" &&
						options?.deliverAs === "steer",
				),
			).toBe(true);
			expect(advisorQueue.mock.calls.some(([kind]) => kind === "advisor")).toBe(false);
		}

		releaseFourthStep.resolve();
		await run;
		await session.waitForIdle();
	},
);
