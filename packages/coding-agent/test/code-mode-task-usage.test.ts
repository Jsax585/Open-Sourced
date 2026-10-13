import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionStatsTracker } from "@oh-my-pi/pi-coding-agent/session/session-stats";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executor from "@oh-my-pi/pi-coding-agent/task/executor";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

it("counts direct Code Mode task child usage once in live and persisted totals and rejects nested task dispatch", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-code-mode-task-"));
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-fable-5");
	if (!model) throw new Error("Expected bundled Anthropic model");
	const modelRegistry = new ModelRegistry(auth);
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const discoverySpy = spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: [
			{
				name: "task",
				description: "Usage fixture",
				systemPrompt: "Complete the assignment.",
				source: "bundled",
				blocking: true,
			},
		],
		projectAgentsDir: null,
	});
	// Only replace the child process boundary: SDK dispatch, TaskTool execution,
	// batch aggregation, tool-result events and both accounting consumers are real.
	const childSpy = spyOn(executor, "runSubprocess").mockImplementation(async options => {
		const scale = options.id === "UsageOne" ? 1 : 2;
		const usage: Usage = {
			input: 10 * scale,
			output: 4 * scale,
			cacheRead: 3 * scale,
			cacheWrite: 2 * scale,
			totalTokens: 19 * scale,
			cost: {
				input: 0.0625 * scale,
				output: 0.03125 * scale,
				cacheRead: 0.015625 * scale,
				cacheWrite: 0.015625 * scale,
				total: 0.125 * scale,
			},
		};
		return {
			index: 0,
			id: options.id ?? "missing",
			agent: "task",
			agentSource: "bundled",
			task: "Count usage",
			assignment: "Count usage",
			exitCode: 0,
			output: `Processed ${usage.totalTokens} tokens`,
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: usage.totalTokens,
			requests: 1,
			usage,
		};
	});
	let dispose: (() => Promise<void>) | undefined;
	try {
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			model,
			modelRegistry,
			sessionManager: manager,
			settings: Settings.isolated({
				"tools.codeMode": true,
				"tools.xdev": false,
				"tools.approvalMode": "yolo",
				"eval.py": false,
				"eval.js": true,
				"eval.autoBackground.enabled": false,
				"task.batch": true,
				"task.isolation.enabled": false,
				"async.enabled": false,
				"compaction.enabled": false,
			}),
			toolNames: ["read", "write", "eval", "task"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		dispose = () => session.dispose();
		const taskArgs = {
			context: "Count child usage.",
			tasks: [
				{ name: "UsageOne", agent: "task", task: "Count first child usage." },
				{ name: "UsageTwo", agent: "task", task: "Count second child usage." },
			],
		};
		const parentUsage = {
			input: 2,
			output: 3,
			totalTokens: 5,
			cost: { input: 0.015625, output: 0.015625, total: 0.03125 },
		};
		const scripted = createMockModel({
			provider: "anthropic",
			responses: [
				{
					content: [{ type: "toolCall", id: "direct-task", name: "task", arguments: taskArgs }],
					usage: parentUsage,
				},
				{
					content: [
						{
							type: "toolCall",
							id: "nested-eval",
							name: "eval",
							arguments: {
								language: "js",
								timeout: 10,
								code: `try { await tool.task(${JSON.stringify(taskArgs)}); print("unexpected execution"); } catch (error) { print(String(error)); }`,
							},
						},
					],
					usage: parentUsage,
				},
				{
					content: [
						{
							type: "toolCall",
							id: "nested-device",
							name: "write",
							arguments: { path: "xd://task", content: JSON.stringify(taskArgs) },
						},
					],
					usage: parentUsage,
				},
				{ content: ["Finished accounting."], usage: parentUsage },
			],
		});
		session.agent.streamFn = scripted.stream;
		await session.prompt("Run the task and check indirect dispatch is denied.");
		expect(scripted.calls).toHaveLength(4);
		expect(scripted.calls[0].context.tools?.map(tool => tool.name)).toContain("task");
		expect(session.getMountedXdevToolNames()).not.toContain("task");
		expect(childSpy).toHaveBeenCalledTimes(2);
		const results = session.messages.filter(message => message.role === "toolResult");
		for (const id of ["nested-eval", "nested-device"]) {
			const result = results.find(message => message.toolCallId === id);
			expect(result?.content).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "text", text: expect.stringContaining("must be called directly") }),
				]),
			);
		}
		expect(results.find(message => message.toolCallId === "direct-task")?.isError).toBe(false);
		const tokens = { input: 38, output: 24, cacheRead: 9, cacheWrite: 6, reasoning: 0, total: 77 };
		expect(session.getSessionStats()).toMatchObject({ tokens, cost: 0.5 });
		const tracker = new SessionStatsTracker({
			session,
			agent: session.agent,
			sessionManager: manager,
			modelRegistry,
			model: () => session.model,
			sessionId: () => manager.getSessionId(),
		});
		expect(tracker.getTokenTotals()).toEqual(tokens);
		const ledger = { input: 38, output: 24, cacheRead: 9, cacheWrite: 6, totalTokens: 77, cost: 0.5 };
		expect(manager.getUsageStatistics()).toMatchObject(ledger);
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		await session.dispose();
		dispose = undefined;
		const reopened = await SessionManager.open(sessionFile);
		try {
			expect(reopened.getUsageStatistics()).toMatchObject(ledger);
		} finally {
			await reopened.close();
		}
	} finally {
		await dispose?.();
		await manager.close();
		childSpy.mockRestore();
		discoverySpy.mockRestore();
		auth.close();
		await fs.rm(cwd, { recursive: true, force: true });
	}
}, 30_000);
