import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentMessage, agentLoop } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { CodingAgentSpeculativeExecutionHost } from "@oh-my-pi/pi-coding-agent/speculation/host";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => removeWithRetries(directory)));
});

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "images.autoResize": false, "tools.speculativeExecution.enabled": true }),
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

describe("enabled speculative local reads", () => {
	it("cannot start or deliver a speculative read while final authorization waits or denies", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "authorized-read-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "guarded content");
		const session = createSession(directory);
		const tool = new ReadTool(session);
		const finalized = tool.speculation.finalized;
		if (!finalized) throw new Error("Expected read speculation");
		const speculativeExecute = vi.spyOn(finalized, "execute");
		const execute = vi.spyOn(tool, "execute");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("tool_authorization", async () => {
					entered.resolve();
					await release.promise;
					return { decision: "deny", reason: "Read policy denied" };
				});
			},
			directory,
			new EventBus(),
			runtime,
		);
		const auth = createInMemoryAuthStorage();
		try {
			const runner = new ExtensionRunner(
				[extension],
				runtime,
				directory,
				SessionManager.inMemory(directory),
				new ModelRegistry(auth),
			);
			const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, runner);
			const mock = createMockModel({
				responses: [
					{ content: [{ type: "toolCall", id: "guarded-read", name: "read", arguments: { path: "note.txt" } }] },
					{ content: ["done"] },
				],
			});
			let delivered = false;
			const execution = agentLoop(
				[{ role: "user", content: "Read the note", timestamp: Date.now() }],
				{
					systemPrompt: [""],
					messages: [],
					tools: [new ExtensionToolWrapper<typeof tool.parameters, ReadToolDetails>(tool, runner)],
				},
				{ model: mock.model, convertToLlm: identityConverter, speculativeToolExecution: { enabled: true, host } },
				undefined,
				mock.stream,
			)
				.result()
				.then(messages => {
					delivered = true;
					return messages;
				});
			const reached = await Promise.race([entered.promise.then(() => true), execution.then(() => false)]);
			expect(reached).toBe(true);
			expect(delivered).toBe(false);
			expect(speculativeExecute).not.toHaveBeenCalled();
			expect(execute).not.toHaveBeenCalled();
			release.resolve();
			const messages = await execution;
			const results = messages.filter(message => message.role === "toolResult");
			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ isError: true, content: [{ type: "text", text: "Read policy denied" }] });
			expect(speculativeExecute).not.toHaveBeenCalled();
			expect(execute).not.toHaveBeenCalled();
		} finally {
			release.resolve();
			auth.close();
			vi.restoreAllMocks();
		}
	});

	it("starts the physical read before provider completion and commits one normal result", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-read-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "content");
		const session = createSession(directory);
		const tool = new ReadTool(session);
		const finalized = tool.speculation.finalized;
		if (!finalized) throw new Error("read tool has no finalized speculation policy");
		const execute = finalized.execute;
		const started = Promise.withResolvers<void>();
		let providerDone = false;
		let startedBeforeProviderDone = false;
		finalized.execute = async (context, signal) => {
			startedBeforeProviderDone = !providerDone;
			started.resolve();
			return await execute(context, signal);
		};
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });
		const mock = createMockModel({ responses: [] });
		let turn = 0;
		const streamFn = (_model: unknown, _context: Context) => {
			const response = new AssistantMessageEventStream();
			void (async () => {
				if (turn++ === 0) {
					const toolCall = {
						type: "toolCall" as const,
						id: "read-1",
						name: "read",
						arguments: { path: "note.txt" },
					};
					const partial = assistant([toolCall], "toolUse");
					response.push({ type: "start", partial });
					response.push({ type: "toolcall_start", contentIndex: 0, partial });
					response.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
					await started.promise;
					providerDone = true;
					response.push({ type: "done", reason: "toolUse", message: partial });
					return;
				}
				const partial = assistant([{ type: "text", text: "done" }], "stop");
				response.push({ type: "start", partial });
				response.push({ type: "done", reason: "stop", message: partial });
			})();
			return response;
		};

		const messages = await agentLoop(
			[{ role: "user", content: "Read the note", timestamp: Date.now() }],
			{ systemPrompt: [""], messages: [], tools: [tool] },
			{
				model: mock.model,
				convertToLlm: identityConverter,
				speculativeToolExecution: { enabled: true, host },
			},
			undefined,
			streamFn,
		).result();

		expect(startedBeforeProviderDone).toBe(true);
		expect(messages.filter(message => message.role === "toolResult")).toHaveLength(1);
	});
});
