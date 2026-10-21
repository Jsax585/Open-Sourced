import { afterEach, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

const stepSchema = type({});
type StepTool = AgentTool<typeof stepSchema, undefined>;

const waitSchema = type({});
type WaitTool = AgentTool<typeof waitSchema, undefined>;

function textResponse(text: string): MockResponse {
	return { content: [text], stopReason: "stop" };
}

function toolResponse(id: string, name: string, arguments_: Record<string, unknown> = {}): MockResponse {
	return { content: [{ type: "toolCall", id, name, arguments: arguments_ }], stopReason: "toolUse" };
}

function waitBatchResponse(): MockResponse {
	return {
		content: [
			{ type: "toolCall", id: "wait-first", name: "wait", arguments: {} },
			{ type: "toolCall", id: "wait-second", name: "wait", arguments: {} },
		],
		stopReason: "toolUse",
	};
}

let active:
	| {
			session: AgentSession;
			auth: AuthStorage;
			temp: TempDir;
			releaseReview: PromiseWithResolvers<void>;
			releaseWait: PromiseWithResolvers<void>;
	  }
	| undefined;

afterEach(async () => {
	const teardown = active;
	if (!teardown) return;
	teardown.releaseReview.resolve();
	teardown.releaseWait.resolve();
	await teardown.session.dispose().catch(() => {});
	teardown.auth.close();
	await teardown.temp.remove().catch(() => {});
	active = undefined;
});

async function createHarness(options: {
	setting: number;
	reviewInterval: number;
	primaryResponses: MockResponse[];
	note: string;
}) {
	const temp = TempDir.createSync("@pi-advisor-stale-steer-");
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");

	const reviewStarted = Promise.withResolvers<void>();
	const releaseReview = Promise.withResolvers<void>();
	const adviceAccepted = Promise.withResolvers<void>();
	const waitStarted = Promise.withResolvers<void>();
	const waitAborted = Promise.withResolvers<void>();
	const releaseWait = Promise.withResolvers<void>();
	const completedWaits: string[] = [];
	let waitWasAborted = false;
	let reviewCalls = 0;
	const primaryMock = createMockModel({
		id: "advisor-stale-steer-primary",
		provider: "anthropic",
		responses: options.primaryResponses,
	});
	const advisorMock = createMockModel({
		id: "advisor-stale-steer-reviewer",
		provider: "anthropic",
		handler: async () => {
			if (reviewCalls++ === 0) {
				reviewStarted.resolve();
				await releaseReview.promise;
				return toolResponse("stale-advice", "advise", { note: options.note, severity: "blocker" });
			}
			return textResponse("advisor quiet");
		},
	});
	const step: StepTool = {
		name: "step",
		label: "Step",
		description: "Advance primary work",
		parameters: stepSchema,
		execute: async () => ({ content: [{ type: "text", text: "step complete" }] }),
	};
	const wait: WaitTool = {
		name: "wait",
		label: "Wait",
		description: "Wait until released or interrupted",
		parameters: waitSchema,
		concurrency: "exclusive",
		interruptible: true,
		async execute(toolCallId, _args, signal) {
			if (toolCallId === "wait-first") {
				const interrupted = Promise.withResolvers<void>();
				const onAbort = () => {
					waitWasAborted = true;
					waitAborted.resolve();
					interrupted.resolve();
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				waitStarted.resolve();
				try {
					await Promise.race([releaseWait.promise, interrupted.promise]);
					if (signal?.aborted) {
						return {
							content: [{ type: "text", text: "Wait interrupted by message." }],
							details: undefined,
						};
					}
				} finally {
					signal?.removeEventListener("abort", onAbort);
				}
			}
			completedWaits.push(toolCallId);
			return {
				content: [{ type: "text", text: `${toolCallId} completed normally` }],
				details: undefined,
			};
		},
	};
	const settings = Settings.isolated({
		"advisor.syncBacklog": "off",
		"advisor.reviewInterval": options.reviewInterval,
		"advisor.staleSteerTurns": options.setting,
		"compaction.enabled": false,
		"retry.enabled": false,
	});
	settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["advisor freshness regression"], tools: [step, wait] },
			streamFn: primaryMock.stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
		advisorTools: [],
		advisorStreamFn: advisorMock.stream,
	});
	active = { session, auth, temp, releaseReview, releaseWait };
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
	return {
		session,
		primaryMock,
		reviewStarted: reviewStarted.promise,
		releaseReview,
		adviceAccepted: adviceAccepted.promise,
		waitStarted: waitStarted.promise,
		waitAborted: waitAborted.promise,
		releaseWait,
		completedWaits,
		wasWaitAborted: () => waitWasAborted,
	};
}

it.each([
	{ setting: 2, reviewInterval: 1, expectedChannel: "aside", freshness: "stale" },
	{ setting: 2, reviewInterval: 3, expectedChannel: "steer", freshness: "fresh" },
	{ setting: 0, reviewInterval: 1, expectedChannel: "steer", freshness: "stale" },
] as const)(
	"delivers a $expectedChannel blocker for a $freshness covered turn (threshold=$setting)",
	async ({ setting, reviewInterval, expectedChannel }) => {
		const note = `freshness gate ${expectedChannel} ${setting} ${reviewInterval}`;
		const {
			session,
			primaryMock: _primaryMock,
			reviewStarted,
			releaseReview,
			adviceAccepted,
			waitStarted,
			waitAborted,
			releaseWait,
			completedWaits,
			wasWaitAborted,
		} = await createHarness({
			setting,
			reviewInterval,
			note,
			primaryResponses: [
				toolResponse("step-1", "step"),
				toolResponse("step-2", "step"),
				toolResponse("step-3", "step"),
				waitBatchResponse(),
				textResponse("primary complete"),
			],
		});

		const run = session.prompt("advance three steps, then wait");
		await Promise.all([reviewStarted, waitStarted]);
		// The first review covers turn 1, two turns before the fourth tool step;
		// the interval-3 review covers the more recent third turn.
		releaseReview.resolve();
		await adviceAccepted;

		if (expectedChannel === "aside") {
			expect(wasWaitAborted()).toBe(false);
			releaseWait.resolve();
		} else {
			await withTimeout(waitAborted, 2_000, "Fresh advisor steering did not interrupt the wait tool");
			releaseWait.resolve();
		}

		await run;
		await session.waitForIdle();

		const advisorContent = session.agent.state.messages
			.filter(
				(message): message is Extract<(typeof session.agent.state.messages)[number], { role: "custom" }> =>
					message.role === "custom" && "customType" in message && message.customType === "advisor",
			)
			.map(message => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
			.join("\n");
		const transcript = JSON.stringify(session.agent.state.messages);
		expect(advisorContent).toContain(note);
		if (expectedChannel === "aside") {
			expect(advisorContent).toContain('turns_ago="2"');
			expect(transcript).toContain("wait-first completed normally");
			expect(transcript).toContain("wait-second completed normally");
			expect(transcript).not.toContain("Skipped due to pending system advisory");
			expect(completedWaits).toEqual(["wait-first", "wait-second"]);
		} else {
			expect(transcript).toContain("Skipped due to pending system advisory");
			expect(completedWaits).toEqual([]);
		}
	},
);

it("delivers a stale blocker as a fresh steer when the primary is idle after a failed turn", async () => {
	const note = "idle stale blocker is delivered";
	const { session, primaryMock, reviewStarted, releaseReview, adviceAccepted } = await createHarness({
		setting: 2,
		reviewInterval: 1,
		note,
		primaryResponses: [
			toolResponse("step-1", "step"),
			toolResponse("step-2", "step"),
			toolResponse("step-3", "step"),
			toolResponse("step-4", "step"),
			{ throw: new Error("primary failed after its fourth step") },
			textResponse("idle advisor advice received"),
		],
	});

	const run = session.prompt("advance four steps, then fail");
	await reviewStarted;
	await run.catch(() => undefined);
	await session.waitForIdle();
	expect(session.agent.state.isStreaming).toBe(false);
	const failedTurn = [...session.agent.state.messages].reverse().find(message => message.role === "assistant");
	expect(failedTurn?.stopReason).toBe("error");
	const primaryCallsBeforeDelivery = primaryMock.calls.length;

	releaseReview.resolve();
	await adviceAccepted;
	await session.waitForIdle();

	const deliveredMessages = session.agent.state.messages
		.filter(
			(message): message is Extract<(typeof session.agent.state.messages)[number], { role: "custom" }> =>
				message.role === "custom" && "customType" in message && message.customType === "advisor",
		)
		.map(message => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
		.join("\n");
	expect(deliveredMessages).toContain(note);
	expect(primaryMock.calls.length).toBeGreaterThan(primaryCallsBeforeDelivery);
});
