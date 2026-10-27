/**
 * The run status `EventController` publishes (title separator + OSC 7501
 * record): what a settled turn leaves behind, and how user-blocking prompts
 * move the run between `blocked` and `working`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Type } from "@oh-my-pi/omptype/typebox";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgToolsApproval, cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import * as runStatus from "@oh-my-pi/pi-coding-agent/utils/run-status";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

const authStorage = createInMemoryAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
afterAll(() => authStorage.close());

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

const AGENT_START = { type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>;

function assistant(stopReason: "stop" | "error" | "aborted", errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		stopReason,
		errorMessage,
		usage: { inputTokens: 0, outputTokens: 0 },
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

function agentEnd(messages: AssistantMessage[]): Extract<AgentSessionEvent, { type: "agent_end" }> {
	return { type: "agent_end", messages } as Extract<AgentSessionEvent, { type: "agent_end" }>;
}

function toolStart(toolCallId: string, toolName: string, args: Record<string, unknown>): AgentSessionEvent {
	return { type: "tool_execution_start", toolCallId, toolName, args } as unknown as AgentSessionEvent;
}

function toolEnd(toolCallId: string, toolName: string): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName,
		result: { content: [{ type: "text", text: "ok" }], details: {} },
		isError: false,
	} as unknown as AgentSessionEvent;
}

function askArgs(question: string): Record<string, unknown> {
	return { questions: [{ id: "q", question, options: [{ label: "Yes" }, { label: "No" }] }] };
}

describe("EventController run status at turn end", () => {
	it.each([
		["a finished turn leaves its result as done", [assistant("stop")], { state: "done" }],
		[
			"a failed turn reports error with the failure",
			[assistant("error", "429 overloaded")],
			{ state: "error", msg: "429 overloaded" },
		],
		["an interrupted turn goes back to idle", [assistant("aborted", "Interrupted by user")], { state: "idle" }],
		["a turn without a reply goes back to idle", [], { state: "idle" }],
	])("%s", async (_name, messages, expected) => {
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		const controller = new EventController(createInteractiveModeContext());

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(agentEnd(messages));

		expect(report).toHaveBeenLastCalledWith(expected);
	});

	it("reports idle, not error, for a failure an auto-retry is about to start over", async () => {
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		const controller = new EventController(createInteractiveModeContext());

		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 100,
			errorMessage: "overloaded",
		} as Extract<AgentSessionEvent, { type: "auto_retry_start" }>);
		await controller.handleEvent(agentEnd([assistant("error", "overloaded")]));

		expect(report).toHaveBeenLastCalledWith({ state: "idle" });
	});
});

describe("EventController run status while prompts wait on the user", () => {
	it("reports the prompt still waiting when another resolves, and working once none is left", async () => {
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		const controller = new EventController(createInteractiveModeContext());

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(toolStart("ask-1", "ask", askArgs("Use Postgres?")));
		await controller.handleEvent(toolStart("ask-2", "ask", askArgs("Deploy now?")));
		expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "question", msg: "Deploy now?" });

		await controller.handleEvent(toolEnd("ask-2", "ask"));
		expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "question", msg: "Use Postgres?" });

		await controller.handleEvent(toolEnd("ask-1", "ask"));
		expect(report).toHaveBeenLastCalledWith({ state: "working" });
	});

	it("reports a tool call that needs approval as blocked on permission", async () => {
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		cfgToolsApproval.override(settings, { bash: "prompt" });
		const bash = { name: "bash", label: "Bash" } as unknown as AgentTool;
		const controller = new EventController(createInteractiveModeContext({ session: { getToolByName: () => bash } }));

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(toolStart("bash-1", "bash", { command: "rm -rf build" }));

		expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ state: "blocked", kind: "permission" }));
	});
});

describe("final authorization run status and dialogs", () => {
	async function harness(
		factory: ExtensionFactory,
		select: (title: string) => Promise<string | undefined>,
		toolName = "guarded_command",
	) {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(factory, process.cwd(), new EventBus(), runtime);
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			process.cwd(),
			SessionManager.inMemory(),
			modelRegistry,
			undefined,
			settings,
		);
		runner.initialize(
			{} as never,
			{
				getModel: () => undefined,
				isIdle: () => true,
				abort: () => {},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: async () => {},
				getSystemPrompt: () => [],
			} as never,
			undefined,
			{ ...runner.getUIContext(), select },
		);
		const tool = {
			name: toolName,
			label: toolName,
			description: "Authorization fixture",
			parameters: Type.Object({}),
			approval: "exec" as const,
			mode: "replace",
			execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "executed" }] })),
		};
		const ctx = createInteractiveModeContext({
			session: { extensionRunner: runner, getToolByName: name => (name === toolName ? tool : undefined) },
		});
		const controller = new EventController(ctx);
		const context = (id: string): AgentToolContext =>
			({
				settings,
				toolCall: { batchId: "approval", index: 0, total: 1, toolCalls: [{ id, name: toolName }] },
			}) as AgentToolContext;
		return { runner, tool, controller, ctx, context, wrapped: new ExtensionToolWrapper(tool, runner) };
	}

	it("clears a mode-only permission block before executing an extension-allowed call", async () => {
		cfgToolsApprovalMode.override(settings, "always-ask");
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		const select = vi.fn(async () => "Approve");
		const { tool, controller, context, wrapped } = await harness(pi => {
			pi.on("tool_authorization", () => ({ decision: "allow" }));
		}, select);
		try {
			await controller.handleEvent(AGENT_START);
			await controller.handleEvent(toolStart("allowed", tool.name, {}));
			expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ state: "blocked", kind: "permission" }));
			tool.execute.mockImplementation(async () => {
				expect(report).toHaveBeenLastCalledWith({ state: "working" });
				return { content: [{ type: "text", text: "executed" }] };
			});
			await wrapped.execute("allowed", {}, undefined, undefined, context("allowed"));
			expect(select).not.toHaveBeenCalled();
			expect(tool.execute).toHaveBeenCalledTimes(1);
		} finally {
			controller.dispose();
		}
	});

	for (const approvalMode of ["yolo", "always-ask"] as const) {
		it(`reports permission-blocked only until an extension-requested approval settles (${approvalMode})`, async () => {
			cfgToolsApprovalMode.override(settings, approvalMode);
			const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
			const shown = Promise.withResolvers<void>();
			const answer = Promise.withResolvers<string>();
			const { tool, controller, context, wrapped } = await harness(
				pi => {
					pi.on("tool_authorization", () => ({ decision: "ask" }));
				},
				async () => {
					shown.resolve();
					return answer.promise;
				},
			);
			let execution: Promise<unknown> | undefined;
			try {
				await controller.handleEvent(AGENT_START);
				await controller.handleEvent(toolStart("ask", tool.name, {}));
				execution = wrapped.execute("ask", {}, undefined, undefined, context("ask"));
				await Promise.race([shown.promise, execution]);
				expect(report.mock.calls.at(-1)?.[0]).toMatchObject({ state: "blocked", kind: "permission" });
				expect(tool.execute).not.toHaveBeenCalled();
				answer.resolve("Approve");
				await execution;
				expect(report).toHaveBeenLastCalledWith({ state: "working" });
				await controller.handleEvent(toolEnd("ask", tool.name));
			} finally {
				answer.resolve("Deny");
				await execution?.catch(() => {});
				controller.dispose();
			}
		});
	}

	for (const block of ["same-question", "other-question", "other-permission"] as const) {
		it(`does not clear ${block} when allowing a scheduled call`, async () => {
			cfgToolsApprovalMode.override(settings, "always-ask");
			const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
			const { tool, controller, context, wrapped } = await harness(
				pi => {
					pi.on("tool_authorization", () => ({ decision: "allow" }));
				},
				async () => "Approve",
				block === "same-question" ? "ask" : "guarded_command",
			);
			try {
				await controller.handleEvent(AGENT_START);
				if (block !== "same-question") {
					await controller.handleEvent(
						toolStart("other", block === "other-question" ? "ask" : tool.name, askArgs("Keep question")),
					);
				}
				await controller.handleEvent(toolStart("allowed", tool.name, askArgs("Keep question")));
				await wrapped.execute("allowed", {}, undefined, undefined, context("allowed"));
				expect(report).toHaveBeenLastCalledWith(
					expect.objectContaining({
						state: "blocked",
						kind: block === "other-permission" ? "permission" : "question",
					}),
				);
			} finally {
				controller.dispose();
			}
		});
	}

	it("shows the rewritten edit preview before an authorizer-owned modal opens", async () => {
		const entered = Promise.withResolvers<void>();
		const args = { path: "/tmp/authorized-preview.ts", old_string: "old", new_string: "FINAL_REWRITTEN_EDIT" };
		let previewSent = false;
		const select = vi.fn(async () => {
			expect(previewSent).toBe(true);
			const rendered = ctx.pendingTools.get("edit-dialog")?.render(100).join("\n") ?? "";
			expect(Bun.stripANSI(rendered)).toContain("FINAL_REWRITTEN_EDIT");
			return "Approve";
		});
		const { runner, tool, controller, ctx, context, wrapped } = await harness(
			pi => {
				pi.on("tool_call", () => ({ input: args }));
				pi.on("tool_authorization", async (_event, ctx) => {
					entered.resolve();
					await ctx.ui.select("Review final edit?", ["Approve"]);
					return { decision: "allow" };
				});
			},
			select,
			"edit",
		);
		try {
			const rewritten = await runner.emitToolCall({
				type: "tool_call",
				toolName: "edit",
				toolCallId: "edit-dialog",
				input: { ...args, new_string: "original" },
			});
			runner.markToolCallEmitted("edit-dialog", "edit");
			await controller.handleEvent(toolStart("edit-dialog", "edit", rewritten?.input ?? {}));
			const execution = wrapped.execute(
				"edit-dialog",
				rewritten?.input ?? {},
				undefined,
				undefined,
				context("edit-dialog"),
			);
			await entered.promise;
			expect(select).not.toHaveBeenCalled();
			expect(tool.execute).not.toHaveBeenCalled();
			previewSent = true;
			await controller.handleEvent({
				type: "tool_stream_update",
				toolCallId: "edit-dialog",
				toolName: "edit",
				update: {
					generation: 1,
					streaming: false,
					files: [{ path: args.path, diff: "@@ -1 +1 @@\n-old\n+FINAL_REWRITTEN_EDIT", firstChangedLine: 1 }],
				},
			});
			await execution;
			expect(select).toHaveBeenCalledTimes(1);
			expect(tool.execute).toHaveBeenCalledTimes(1);
		} finally {
			controller.dispose();
		}
	});
});
