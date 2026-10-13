import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type Context, toolWireSchema } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgEvalJs } from "@oh-my-pi/pi-coding-agent/eval/settings";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import {
	type CreateAgentSessionOptions,
	type CustomTool,
	createAgentSession,
	type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgToolsCodeMode, cfgToolsCodeModeDirectTools } from "@oh-my-pi/pi-coding-agent/tools/settings";
import * as activeRepoContext from "@oh-my-pi/pi-coding-agent/utils/active-repo-context";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const normalizeSchema = type({ samples: "number[]", scale: "number" });

function normalizeTool(name = "normalize_samples") {
	return {
		name,
		label: "Normalize Samples",
		description: "Scale numeric samples and return their total.",
		parameters: normalizeSchema,
		loadMode: "essential",
		approval: "read",
		async execute(_id, { samples, scale }) {
			return {
				content: [{ type: "text", text: JSON.stringify({ total: samples.reduce((a, b) => a + b, 0) * scale }) }],
			};
		},
	} satisfies CustomTool<typeof normalizeSchema>;
}

function text(result: AgentToolResult): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

async function execute(session: AgentSession, name: string, args: Record<string, unknown>): Promise<AgentToolResult> {
	const tool = session.getToolByName(name);
	if (!tool) throw new Error(`Missing session tool ${name}`);
	return tool.execute(`code-mode-${crypto.randomUUID()}`, args);
}

async function evaluate(session: AgentSession, code: string): Promise<string> {
	const result = await execute(session, "eval", { language: "js", code, timeout: 10 });
	expect(result.isError).not.toBe(true);
	return text(result);
}

function wireTools(context: Context): string {
	return JSON.stringify(
		context.tools?.map(tool => ({
			name: tool.customWireName ?? tool.name,
			description: tool.description,
			parameters: toolWireSchema(tool),
			strict: tool.strict,
			customFormat: tool.customFormat,
		})),
	);
}

describe("provider-neutral Code Mode", () => {
	const cleanup: Array<() => Promise<void>> = [];

	afterEach(async () => {
		for (const dispose of cleanup.splice(0).reverse()) await dispose();
		vi.restoreAllMocks();
	});

	async function fixture(overrides: Partial<CreateAgentSessionOptions> = {}) {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-code-mode-"));
		const auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-fable-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const settings = Settings.isolated({
			"tools.codeMode": true,
			"tools.xdev": false,
			"tools.xdevDocs": "inline",
			"eval.py": false,
			"eval.js": true,
			"eval.autoBackground.enabled": false,
			"tools.approvalMode": "yolo",
			"compaction.enabled": false,
		});
		cleanup.push(async () => {
			auth.close();
			await fs.rm(cwd, { recursive: true, force: true });
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			modelRegistry: new ModelRegistry(auth),
			model,
			settings,
			sessionManager: SessionManager.inMemory(cwd),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			...overrides,
		});
		cleanup.push(() => session.dispose());
		return { session, settings: overrides.settings ?? settings, cwd };
	}

	it("hides non-control schemas on Anthropic while real eval and xd transports execute the enabled APIs", async () => {
		const { session, cwd } = await fixture({
			toolNames: ["read", "write", "eval", "bash", "grep", "normalize_samples"],
			customTools: [normalizeTool()],
		});
		await Bun.write(path.join(cwd, "samples.txt"), "selected=17\nignored=4\n");
		const mock = createMockModel({ provider: "anthropic", handler: { content: ["Ready."] } });
		session.agent.streamFn = mock.stream;
		await session.prompt("Inspect the available tool interfaces.");
		const context = mock.calls[0]?.context;
		expect(context).toBeDefined();
		const names = context!.tools?.map(tool => tool.name);
		expect(names).toEqual(expect.arrayContaining(["read", "write", "eval"]));
		for (const name of ["bash", "grep", "normalize_samples"]) {
			expect(names).not.toContain(name);
			expect(session.getMountedXdevToolNames()).toContain(name);
		}
		// This field belongs only to the hidden API schema, not the native eval description.
		expect(wireTools(context!)).not.toContain('"samples"');
		const docs = await execute(session, "read", { path: "xd://normalize_samples" });
		expect(text(docs)).toContain("samples");
		expect(text(docs)).toContain("scale");
		const dispatched = await execute(session, "write", {
			path: "xd://normalize_samples",
			content: JSON.stringify({ samples: [2, 5, 9], scale: 3 }),
		});
		expect(text(dispatched)).toContain('"total":48');
		const output = await evaluate(
			session,
			`
			const docResult = await tool.read({ path: "xd://grep" });
			const docs = typeof docResult === "string" ? docResult : docResult.text;
			if (!docs.includes("pattern")) throw new Error("Missing callable grep schema");
			const grepResult = await tool.grep({ pattern: "selected=", path: "samples.txt" });
			const matches = typeof grepResult === "string" ? grepResult : grepResult.text;
			if (!matches.includes("selected=17")) throw new Error("Wrong grep output");
			const scaled = JSON.parse(await tool.normalize_samples({ samples: [3, 7], scale: 4 }));
			print(JSON.stringify({ normalized: scaled.total + 2 }));
		`,
		);
		expect(output).toContain('"normalized":42');
	});

	it("keeps disabled, hidden and default-inactive APIs inaccessible and never upgrades read-only write grants", async () => {
		let forbiddenCalls = 0;
		const inactiveExtension: ExtensionFactory = pi => {
			pi.registerTool({
				name: "inactive_probe",
				label: "Inactive Probe",
				description: "Must remain inaccessible without activation.",
				parameters: type({}),
				defaultInactive: true,
				async execute() {
					forbiddenCalls++;
					return { content: [{ type: "text", text: "unauthorized" }] };
				},
			});
		};
		const { session, cwd } = await fixture({
			toolNames: ["read", "eval", "grep", "normalize_samples"],
			customTools: [normalizeTool(), { ...normalizeTool("hidden_probe"), hidden: true }],
			extensions: [inactiveExtension],
		});
		await session.setActiveToolsByName(session.getEnabledToolNames().filter(name => name !== "normalize_samples"));
		const unavailable = ["bash", "normalize_samples", "hidden_probe", "inactive_probe"];
		const listing = text(await execute(session, "read", { path: "xd://" }));
		for (const name of unavailable) {
			expect(session.getActiveToolNames()).not.toContain(name);
			expect(session.getMountedXdevToolNames()).not.toContain(name);
			expect(listing).not.toContain(`xd://${name}`);
		}
		const target = path.join(cwd, "unauthorized.txt");
		await expect(execute(session, "write", { path: target, content: "unauthorized" })).rejects.toThrow(
			"Filesystem writes are not available",
		);
		const output = await evaluate(
			session,
			`
			const denied = [];
			for (const name of ${JSON.stringify(unavailable)}) {
				try { await tool[name]({ samples: [1], scale: 2 }); }
				catch { denied.push(name); }
			}
			let filesystemDenied = false;
			try { await tool.write({ path: ${JSON.stringify(target)}, content: "unauthorized" }); }
			catch { filesystemDenied = true; }
			print(JSON.stringify({ denied, filesystemDenied }));
		`,
		);
		expect(output).toContain(JSON.stringify({ denied: unavailable, filesystemDenied: true }));
		expect(forbiddenCalls).toBe(0);
		expect(await Bun.file(target).exists()).toBe(false);
	});

	it("moves enabled direct exceptions live without granting disabled APIs", async () => {
		const { session, settings } = await fixture({
			toolNames: ["read", "write", "eval", "grep", "normalize_samples"],
			customTools: [normalizeTool(), { ...normalizeTool("hidden_probe"), hidden: true }],
		});
		cfgToolsCodeModeDirectTools.set(settings, ["normalize_samples", "grep", "hidden_probe", "bash"]);
		await Promise.resolve();
		await session.refreshBaseSystemPrompt();
		const context = await session.agent.buildSideRequestContext([]);
		const names = context.tools?.map(tool => tool.name);
		expect(names).toEqual(expect.arrayContaining(["normalize_samples", "grep"]));
		expect(names).not.toContain("hidden_probe");
		expect(names).not.toContain("bash");
		expect(text(await execute(session, "normalize_samples", { samples: [4, -1], scale: 7 }))).toBe('{"total":21}');
		cfgToolsCodeModeDirectTools.set(settings, []);
		await Promise.resolve();
		await session.refreshBaseSystemPrompt();
		expect(session.getActiveToolNames()).not.toContain("normalize_samples");
		expect(session.getMountedXdevToolNames()).toContain("normalize_samples");
		expect(await evaluate(session, "print(await tool.normalize_samples({ samples: [5, 2], scale: 3 }))")).toContain(
			'"total":21',
		);
	});

	it("does not expand restricted host tool grants when Code Mode is configured", async () => {
		const { session, cwd } = await fixture({
			restrictToolNames: true,
			toolNames: ["read", "eval", "grep"],
			customTools: [normalizeTool()],
		});
		const target = path.join(cwd, "restricted.txt");
		await Bun.write(target, "restricted-result=23\n");
		const context = await session.agent.buildSideRequestContext([]);
		expect(context.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(["read", "eval", "grep"]));
		expect(session.getActiveToolNames()).not.toContain("write");
		expect(session.getMountedXdevToolNames()).toEqual([]);
		expect(session.getToolForEvalBridge("normalize_samples")).toBeUndefined();
		expect(session.getToolForEvalBridge("write")).toBeUndefined();
		expect(text(await execute(session, "grep", { pattern: "restricted-result", path: target }))).toContain(
			"restricted-result=23",
		);
	});

	it("adds and retires a read-only discovery transport across live mode and backend changes", async () => {
		const settings = Settings.isolated({
			"tools.codeMode": false,
			"tools.xdev": false,
			"eval.py": false,
			"eval.js": true,
			"tools.approvalMode": "yolo",
		});
		const { session, cwd } = await fixture({ settings, toolNames: ["read", "eval", "grep"] });
		const original = session.getActiveToolNames();
		cfgToolsCodeMode.override(settings, true);
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => {});
		expect(session.getActiveToolNames()).toContain("write");
		expect(session.getActiveToolNames()).not.toContain("grep");
		await expect(execute(session, "write", { path: path.join(cwd, "forbidden.txt"), content: "x" })).rejects.toThrow(
			"Filesystem writes are not available",
		);
		cfgEvalJs.override(settings, false);
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => {});
		expect(session.getActiveToolNames()).toEqual(["read", "grep"]);
		cfgEvalJs.override(settings, true);
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => {});
		expect(session.getActiveToolNames()).toContain("eval");
		expect(session.getMountedXdevToolNames()).toContain("grep");
		cfgToolsCodeMode.override(settings, false);
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => {});
		expect(session.getActiveToolNames().sort()).toEqual(original.sort());
		expect(session.getToolForEvalBridge("write")).toBeUndefined();
	});

	it("rejects nested terminal controls before they can silently consume a subagent result", async () => {
		const { session } = await fixture({
			toolNames: ["read", "eval", "grep", "yield"],
			requireYieldTool: true,
		});
		const output = await evaluate(
			session,
			`
			try { await tool.yield({ result: "must not be submitted" }); }
			catch (error) { print(error.message); }
		`,
		);
		expect(output).toContain("must be called directly");
		expect(session.getActiveToolNames()).toContain("yield");
		const nested = await evaluate(
			session,
			`
			const result = await tool.write({path: "xd://yield", content: JSON.stringify({data: "lost"})});
			print(JSON.stringify({blocked: result.hasError === true, message: result.text}));
		`,
		);
		expect(nested).toContain('"blocked":true');
		expect(nested).toContain("must be called directly");
		const direct = await execute(session, "yield", { data: "delivered" });
		expect(direct.details).toMatchObject({ data: "delivered", status: "success" });
	});

	it("restores native tools when switched off or eval is unavailable, then remounts without losing grants", async () => {
		const { session, settings } = await fixture({
			toolNames: ["read", "write", "eval", "bash", "grep", "normalize_samples"],
			customTools: [normalizeTool()],
		});
		const enabled = session.getEnabledToolNames();
		cfgToolsCodeMode.override(settings, false);
		await Promise.resolve();
		await session.refreshBaseSystemPrompt();
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "grep", "normalize_samples"]));
		cfgToolsCodeMode.override(settings, true);
		await Promise.resolve();
		await session.refreshBaseSystemPrompt();
		expect(session.getActiveToolNames()).not.toContain("bash");
		await session.setActiveToolsByName(enabled.filter(name => name !== "eval"));
		expect(session.getActiveToolNames()).not.toContain("eval");
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "grep", "normalize_samples"]));
		expect(text(await execute(session, "normalize_samples", { samples: [6, 2], scale: 5 }))).toBe('{"total":40}');
		await session.setActiveToolsByName(enabled);
		expect(session.getActiveToolNames()).toContain("eval");
		expect(session.getActiveToolNames()).not.toContain("bash");
		expect(await evaluate(session, "print(await tool.normalize_samples({ samples: [6, 2], scale: 5 }))")).toContain(
			'"total":40',
		);
	});

	it("keeps captured system and native schemas byte-stable after late custom and MCP additions", async () => {
		let inputTurns = 0;
		const extension: ExtensionFactory = pi => {
			pi.on("input", () => {
				if (++inputTurns !== 2) return;
				pi.registerTool({
					name: "late_sum",
					label: "Late Sum",
					description: "Sum values registered after the first assistant turn.",
					parameters: normalizeSchema,
					approval: "read",
					async execute(_id, { samples, scale }) {
						return { content: [{ type: "text", text: String(samples.reduce((a, b) => a + b, 0) * scale) }] };
					},
				});
			});
		};
		const { session } = await fixture({ extensions: [extension] });
		const lifecycleErrors: unknown[] = [];
		await initializeExtensions(session, {
			reportSendError: (_action, error) => lifecycleErrors.push(error),
			reportRuntimeError: error => lifecycleErrors.push(error),
		});
		const runner = session.extensionRunner;
		if (!runner) throw new Error("Expected extension input lifecycle");
		const requests: Array<{ system: string; tools: string; context: Context }> = [];
		const mock = createMockModel({ provider: "anthropic", handler: { content: ["Acknowledged."] } });
		session.agent.streamFn = (model, context, options) => {
			requests.push({ system: JSON.stringify(context.systemPrompt), tools: wireTools(context), context });
			return mock.stream(model, context, options);
		};
		await runner.emitInput("Establish the first turn.", undefined, "interactive");
		await session.prompt("Establish the first turn.");
		expect(session.messages.some(message => message.role === "assistant")).toBe(true);
		expect(requests).toHaveLength(1);
		await session.refreshMCPTools([
			{
				...normalizeTool("mcp__late_scale"),
				loadMode: "discoverable",
				mcpServerName: "late",
				mcpToolName: "scale",
			},
		]);
		await runner.emitInput("Discover the newly connected APIs.", undefined, "interactive");
		await session.prompt("Discover the newly connected APIs.");
		expect(lifecycleErrors).toEqual([]);
		expect(requests).toHaveLength(2);
		expect(requests[1]!.system).toBe(requests[0]!.system);
		expect(requests[1]!.tools).toBe(requests[0]!.tools);
		for (const name of ["late_sum", "mcp__late_scale"]) {
			expect(session.getActiveToolNames()).not.toContain(name);
			expect(session.getMountedXdevToolNames()).toContain(name);
			expect(JSON.stringify(requests[1]!.context.messages)).toContain(name);
		}
		const output = await evaluate(
			session,
			`
			const listResult = await tool.read({ path: "xd://" });
			const listing = typeof listResult === "string" ? listResult : listResult.text;
			for (const name of ["late_sum", "mcp__late_scale"]) {
				if (!listing.includes(name)) throw new Error("Tool missing from catalog: " + name);
				const docResult = await tool.read({ path: "xd://" + name });
				const docs = typeof docResult === "string" ? docResult : docResult.text;
				if (!docs.includes("samples") || !docs.includes("scale")) throw new Error("Incomplete schema");
			}
			const sum = Number(await tool.late_sum({ samples: [2, 7], scale: 2 }));
			const scaled = JSON.parse(await tool.mcp__late_scale({ samples: [sum, 3], scale: 2 }));
			print(JSON.stringify({ combined: scaled.total }));
		`,
		);
		expect(output).toContain('"combined":42');
	});

	it("keeps discoverable APIs direct when a custom eval disables Code Mode and xdev is off", async () => {
		const { session } = await fixture({
			customTools: [normalizeTool("eval"), { ...normalizeTool("discoverable_probe"), loadMode: "discoverable" }],
		});
		expect(session.getActiveToolNames()).toContain("discoverable_probe");
		expect(session.getMountedXdevToolNames()).toEqual([]);
		expect(text(await execute(session, "discoverable_probe", { samples: [1, 4], scale: 2 }))).toBe('{"total":10}');
	});

	it("delivers docs for a late direct API when native descriptions are pruned", async () => {
		const settings = Settings.isolated({
			"tools.codeMode": true,
			"tools.codeModeDirectTools": ["mcp__late_scale"],
			inlineToolDescriptors: "on",
			"eval.py": false,
			"compaction.enabled": false,
		});
		const { session } = await fixture({ settings });
		const mock = createMockModel({ provider: "anthropic", handler: { content: ["Ready."] } });
		session.agent.streamFn = mock.stream;
		await session.prompt("Establish the inline inventory.");
		await session.refreshMCPTools([
			{
				...normalizeTool("mcp__late_scale"),
				loadMode: "discoverable",
				mcpServerName: "late",
				mcpToolName: "scale",
			},
		]);
		await session.prompt("Use the newly exposed direct API.");
		const request = mock.calls.at(-1)!.context;
		expect(request.tools?.find(tool => tool.name === "mcp__late_scale")?.description).toBe("");
		const documentation = request.systemPrompt?.join("\n");
		expect(documentation).toContain("Scale numeric samples and return their total.");
		expect(documentation).toContain("samples");
		expect(documentation).toContain("scale");
	});

	it("appends bounded instruction-only MCP changes without rewriting the established prefix", async () => {
		const manager = new MCPManager("/tmp");
		cleanup.push(() => manager.disconnectAll());
		const instructions = new Map<string, string>();
		spyOn(manager, "getServerInstructions").mockImplementation(() => new Map(instructions));
		const { session } = await fixture({ enableMCP: true, mcpManager: manager });
		const requests: Array<{ system: string; tools: string; context: Context }> = [];
		const mock = createMockModel({ provider: "anthropic", handler: { content: ["Ready."] } });
		session.agent.streamFn = (model, context, options) => {
			requests.push({ system: JSON.stringify(context.systemPrompt), tools: wireTools(context), context });
			return mock.stream(model, context, options);
		};
		await session.prompt("Establish an empty MCP baseline.");
		instructions.set("late", "Use tenant=blue for this server.");
		await session.refreshMCPTools([]);
		await session.prompt("Read the late server's instructions.");
		expect(JSON.stringify(requests[1]!.context.messages)).toContain("Use tenant=blue for this server.");
		instructions.set("late", `Use tenant=green.${"x".repeat(4_500)}OMITTED_INSTRUCTION_TAIL`);
		await session.refreshMCPTools([]);
		await session.prompt("Read the replacement instructions.");
		const updatedMessages = JSON.stringify(requests[2]!.context.messages);
		expect(updatedMessages).toContain("Use tenant=green.");
		expect(updatedMessages).not.toContain("OMITTED_INSTRUCTION_TAIL");
		instructions.clear();
		await session.refreshMCPTools([]);
		await session.prompt("Observe the removed server instructions.");
		const lastNotice = session.messages.findLast(
			message => message.role === "custom" && message.customType === "xdev-mount-notice",
		);
		if (lastNotice?.role !== "custom") throw new Error("Missing MCP metadata notice");
		expect(lastNotice.content).toContain("late");
		expect(lastNotice.details).toMatchObject({ mcpInstructions: [], mcpInstructionsRemoved: ["late"] });
		const noticeCount = session.messages.filter(
			message => message.role === "custom" && message.customType === "xdev-mount-notice",
		).length;
		await session.prompt("No further metadata changed.");
		expect(
			session.messages.filter(message => message.role === "custom" && message.customType === "xdev-mount-notice"),
		).toHaveLength(noticeCount);
		for (const request of requests.slice(1)) {
			expect(request.system).toBe(requests[0]!.system);
			expect(request.tools).toBe(requests[0]!.tools);
		}
	});

	it("replays instruction changes after a prompt override hides a rebuilt baseline", async () => {
		const manager = new MCPManager("/tmp");
		cleanup.push(() => manager.disconnectAll());
		const instructions = new Map<string, string>();
		spyOn(manager, "getServerInstructions").mockImplementation(() => new Map(instructions));
		let override = false;
		const extension: ExtensionFactory = pi => {
			pi.on("before_agent_start", () =>
				override ? { systemPrompt: ["Override without MCP metadata."] } : undefined,
			);
		};
		const { session } = await fixture({ enableMCP: true, mcpManager: manager, extensions: [extension] });
		await initializeExtensions(session, {
			reportSendError: () => {},
			reportRuntimeError: error => {
				throw error;
			},
		});
		const mock = createMockModel({ provider: "anthropic", handler: { content: ["Ready."] } });
		session.agent.streamFn = mock.stream;
		await session.prompt("Establish the base.");
		const baselineMessages = [...session.messages];
		instructions.set("late", "Use project=delta.");
		await session.refreshMCPTools([]);
		await session.refreshBaseSystemPrompt();
		override = true;
		await session.prompt("Override the base while learning updated metadata.");
		let request = mock.calls.at(-1)!.context;
		expect(request.systemPrompt).toEqual(["Override without MCP metadata."]);
		expect(JSON.stringify(request.messages)).toContain("Use project=delta.");
		// A history replacement drops the notice; it must not remain marked delivered.
		session.agent.replaceMessages(baselineMessages);
		await session.prompt("The replaced history needs current metadata again.");
		request = mock.calls.at(-1)!.context;
		expect(JSON.stringify(request.messages)).toContain("Use project=delta.");
	});

	it("delivers a nonempty MCP baseline when the outgoing override hides it", async () => {
		const manager = new MCPManager("/tmp");
		cleanup.push(() => manager.disconnectAll());
		const instructions = new Map([["existing", "Use project=existing-baseline."]]);
		spyOn(manager, "getServerInstructions").mockImplementation(() => new Map(instructions));
		let override = false;
		const extension: ExtensionFactory = pi => {
			pi.on("before_agent_start", () =>
				override ? { systemPrompt: ["Replacement without server instructions."] } : undefined,
			);
		};
		const { session } = await fixture({ enableMCP: true, mcpManager: manager, extensions: [extension] });
		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error;
			},
		});
		const mock = createMockModel({ provider: "anthropic", handler: { content: ["Ready."] } });
		session.agent.streamFn = mock.stream;
		await session.prompt("Use the original instruction baseline.");
		expect(mock.calls[0]!.context.systemPrompt?.join("\n")).toContain("Use project=existing-baseline.");
		expect(JSON.stringify(mock.calls[0]!.context.messages)).not.toContain("Use project=existing-baseline.");
		override = true;
		await session.prompt("Replace the system prompt without changing MCP instructions.");
		const replaced = mock.calls.at(-1)!.context;
		expect(replaced.systemPrompt).toEqual(["Replacement without server instructions."]);
		expect(JSON.stringify(replaced.messages)).toContain("Use project=existing-baseline.");
		const delivered = session.messages.findLast(
			message => message.role === "custom" && message.customType === "xdev-mount-notice",
		);
		if (delivered?.role !== "custom") throw new Error("Missing instruction baseline notice");
		expect(delivered.details).toMatchObject({ mcpInstructions: [["existing", "Use project=existing-baseline."]] });
		await session.prompt("Keep the replacement with the same surviving instruction notice.");
		expect(
			session.messages.filter(message => message.role === "custom" && message.customType === "xdev-mount-notice"),
		).toHaveLength(1);
		// Rebuilding the hidden base must not invalidate instructions still present in a notice.
		const before = session.systemPrompt.join("\n");
		await session.sessionManager.setAdditionalDirectories(["/tmp"]);
		await session.refreshBaseSystemPrompt();
		expect(session.systemPrompt.join("\n")).not.toBe(before);
		await session.prompt("The surviving notice still supplies the unchanged server instructions.");
		expect(JSON.stringify(mock.calls.at(-1)!.context.messages)).toContain("Use project=existing-baseline.");
		expect(
			session.messages.filter(message => message.role === "custom" && message.customType === "xdev-mount-notice"),
		).toHaveLength(1);
		// Dropping that notice must trigger re-delivery, not credit a previous system prompt.
		session.agent.replaceMessages(session.messages.filter(message => message !== delivered));
		await session.prompt("Restore the instructions missing from this replacement request.");
		const restored = session.messages.findLast(
			message => message.role === "custom" && message.customType === "xdev-mount-notice",
		);
		if (restored?.role !== "custom") throw new Error("Missing re-delivered baseline instructions");
		expect(restored.content).toContain("Use project=existing-baseline.");
	});

	it("withdraws surviving override instructions after returning to a rebuilt base", async () => {
		const manager = new MCPManager("/tmp");
		cleanup.push(() => manager.disconnectAll());
		const instructions = new Map([["existing", "Use project=retired-override."]]);
		spyOn(manager, "getServerInstructions").mockImplementation(() => new Map(instructions));
		let override = true;
		const extension: ExtensionFactory = pi => {
			pi.on("before_agent_start", () =>
				override ? { systemPrompt: ["Replacement without server instructions."] } : undefined,
			);
		};
		const { session } = await fixture({ enableMCP: true, mcpManager: manager, extensions: [extension] });
		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error;
			},
		});
		const mock = createMockModel({ provider: "anthropic", handler: { content: ["Ready."] } });
		session.agent.streamFn = mock.stream;
		await session.prompt("Learn the initial instructions under the replacement prompt.");
		const originalNotice = session.messages.findLast(
			message => message.role === "custom" && message.customType === "xdev-mount-notice",
		);
		if (originalNotice?.role !== "custom") throw new Error("Missing initial instruction notice");
		expect(originalNotice.details).toMatchObject({
			mcpInstructions: [["existing", "Use project=retired-override."]],
		});
		instructions.clear();
		await session.refreshMCPTools([]);
		await session.refreshBaseSystemPrompt();
		override = false;
		await session.prompt("The server disconnected; return to the rebuilt base prompt.");
		const returned = mock.calls.at(-1)!.context;
		expect(returned.systemPrompt?.join("\n")).not.toContain("Use project=retired-override.");
		const withdrawal = session.messages.findLast(
			message => message.role === "custom" && message.customType === "xdev-mount-notice",
		);
		if (withdrawal?.role !== "custom") throw new Error("Missing instruction withdrawal");
		expect(withdrawal.details).toMatchObject({ mcpInstructions: [], mcpInstructionsRemoved: ["existing"] });
		expect(
			returned.messages.some(message => {
				const content =
					typeof message.content === "string"
						? message.content
						: message.content
								.flatMap(block => (block.type === "text" && "text" in block ? [block.text] : []))
								.join("");
				return content === withdrawal.content;
			}),
		).toBe(true);
		await session.prompt("No further metadata changed.");
		expect(
			session.messages.filter(message => message.role === "custom" && message.customType === "xdev-mount-notice"),
		).toHaveLength(2);
		// A reconnect must supersede the still-visible withdrawal, even when a new base contains it.
		instructions.set("existing", "Use project=restored-base.");
		await session.refreshMCPTools([]);
		await session.refreshBaseSystemPrompt();
		await session.prompt("The server reconnected with a new project.");
		const restored = session.messages.findLast(
			message => message.role === "custom" && message.customType === "xdev-mount-notice",
		);
		if (restored?.role !== "custom") throw new Error("Missing reconnect instruction notice");
		expect(restored.details).toMatchObject({
			mcpInstructions: [["existing", "Use project=restored-base."]],
			mcpInstructionsRemoved: [],
		});
		await session.prompt("The reconnected instructions are unchanged.");
		expect(
			session.messages.filter(message => message.role === "custom" && message.customType === "xdev-mount-notice"),
		).toHaveLength(3);
	});

	it("does not treat another server's surviving notice as delivery of dropped instructions", async () => {
		const manager = new MCPManager("/tmp");
		cleanup.push(() => manager.disconnectAll());
		const instructions = new Map<string, string>();
		spyOn(manager, "getServerInstructions").mockImplementation(() => new Map(instructions));
		const { session } = await fixture({ enableMCP: true, mcpManager: manager });
		const mock = createMockModel({ provider: "anthropic", handler: { content: ["Ready."] } });
		session.agent.streamFn = mock.stream;
		await session.prompt("Start without servers.");
		instructions.set("alpha", "Alpha requires tenant=first.");
		await session.refreshMCPTools([]);
		await session.prompt("Learn alpha.");
		const alphaNotice = session.messages.findLast(
			message => message.role === "custom" && message.customType === "xdev-mount-notice",
		);
		if (!alphaNotice) throw new Error("Missing alpha instructions");
		instructions.set("beta", "Beta requires tenant=second.");
		await session.refreshMCPTools([]);
		await session.prompt("Learn beta.");
		session.agent.replaceMessages(session.messages.filter(message => message !== alphaNotice));
		await session.prompt("Restore only missing instruction context.");
		const restored = session.messages.findLast(
			message => message.role === "custom" && message.customType === "xdev-mount-notice",
		);
		if (restored?.role !== "custom") throw new Error("Missing re-announced instructions");
		expect(restored.content).toContain("Alpha requires tenant=first.");
		expect(restored.content).not.toContain("Beta requires tenant=second.");
	});

	it("does not restore a revoked filesystem write grant when Code Mode adds its transport", async () => {
		const settings = Settings.isolated({
			"tools.codeMode": false,
			"tools.xdev": false,
			"eval.py": false,
			"tools.approvalMode": "yolo",
		});
		const { session, cwd } = await fixture({ settings, toolNames: ["read", "write", "eval", "grep"] });
		await session.setActiveToolsByName(["read", "eval", "grep"]);
		cfgToolsCodeMode.override(settings, true);
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => {});
		const target = path.join(cwd, "revoked.txt");
		await expect(execute(session, "write", { path: target, content: "revoked" })).rejects.toThrow(
			"Filesystem writes are not available",
		);
		cfgToolsCodeMode.override(settings, false);
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => {});
		expect(session.getToolForEvalBridge("write")).toBeUndefined();
		await session.setActiveToolsByName(["read", "write", "eval", "grep"]);
		await execute(session, "write", { path: target, content: "explicitly granted" });
		expect(await Bun.file(target).text()).toBe("explicitly granted");
	});

	it("hands off prewalk after a bridged todo and workspace write complete", async () => {
		const target = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!target) throw new Error("Missing prewalk target");
		const { session, cwd } = await fixture({
			toolNames: ["read", "write", "eval", "todo"],
			prewalk: { target },
		});
		const primary = session.model!.id;
		const code = `
			await tool.todo({op: "init", items: ["Write the requested file"]});
			const written = await tool.write({path: "prewalk.txt", content: "implemented"});
			if (written.hasError) throw new Error(written.text);
			await tool.todo({op: "done", task: "Write the requested file"});
		`;
		const mock = createMockModel({
			provider: "anthropic",
			responses: [
				{
					content: [
						{ type: "toolCall", id: "bridged-implementation", name: "eval", arguments: { language: "js", code } },
					],
				},
				{ content: ["Finished."] },
			],
		});
		const models: string[] = [];
		session.agent.streamFn = (model, context, options) => {
			models.push(model.id);
			return mock.stream(model, context, options);
		};
		await session.prompt("Implement the planned file.");
		expect(await Bun.file(path.join(cwd, "prewalk.txt")).text()).toBe("implemented");
		expect(models).toEqual([primary, target.id]);
		expect(session.getPrewalkState()).toBeUndefined();
	});

	it("renders the same MCP instruction snapshot it commits across an awaited rebuild", async () => {
		const manager = new MCPManager("/tmp");
		cleanup.push(() => manager.disconnectAll());
		const instructions = new Map<string, string>();
		spyOn(manager, "getServerInstructions").mockImplementation(() => new Map(instructions));
		const { session } = await fixture({ enableMCP: true, mcpManager: manager });
		const mock = createMockModel({ provider: "anthropic", handler: { content: ["Ready."] } });
		session.agent.streamFn = mock.stream;
		await session.prompt("Establish the instruction baseline.");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		spyOn(activeRepoContext, "resolveActiveRepoContext").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			return null;
		});
		const rebuild = session.refreshBaseSystemPrompt();
		await entered.promise;
		instructions.set("fleeting", "Use workspace=ephemeral.");
		release.resolve();
		await rebuild;
		instructions.clear();
		await session.prompt("The server disconnected before metadata delivery.");
		expect(JSON.stringify(mock.calls.at(-1)!.context)).not.toContain("Use workspace=ephemeral.");
	});

	it("announces MCP instructions connected after the initial prompt was rendered", async () => {
		const manager = new MCPManager("/tmp");
		cleanup.push(() => manager.disconnectAll());
		const instructions = new Map<string, string>();
		spyOn(manager, "getServerInstructions").mockImplementation(() => new Map(instructions));
		const { session } = await fixture({
			enableMCP: true,
			mcpManager: manager,
			systemPrompt: blocks => {
				instructions.set("startup", "Use project=startup-race.");
				return blocks;
			},
		});
		const mock = createMockModel({ provider: "anthropic", handler: { content: ["Ready."] } });
		session.agent.streamFn = mock.stream;
		await session.prompt("Read instructions that connected during startup.");
		expect(JSON.stringify(mock.calls[0]!.context)).toContain("Use project=startup-race.");
	});

	it("keeps equivalent direct MCP reconnects cache-stable but publishes changed wire schemas", async () => {
		const manager = new MCPManager("/tmp");
		cleanup.push(() => manager.disconnectAll());
		const instructions = new Map<string, string>();
		spyOn(manager, "getServerInstructions").mockImplementation(() => new Map(instructions));
		const settings = Settings.isolated({
			"tools.codeMode": true,
			"tools.codeModeDirectTools": ["mcp__stable_measure"],
			"eval.py": false,
			"compaction.enabled": false,
		});
		const { session } = await fixture({ settings, enableMCP: true, mcpManager: manager });
		const connection = { name: "stable" } as MCPServerConnection;
		const definition = {
			name: "measure",
			description: "Measure a sample count.",
			inputSchema: { type: "object" as const, properties: { count: { type: "number" } }, required: ["count"] },
		};
		await session.refreshMCPTools(MCPTool.fromTools(connection, [definition]));
		const requests: Array<{ system: string; tools: string; context: Context }> = [];
		const mock = createMockModel({ provider: "anthropic", handler: { content: ["Ready."] } });
		session.agent.streamFn = (model, context, options) => {
			requests.push({ system: JSON.stringify(context.systemPrompt), tools: wireTools(context), context });
			return mock.stream(model, context, options);
		};
		await session.prompt("Establish the direct MCP schema.");
		instructions.set("stable", "Use units=seconds.");
		await session.refreshMCPTools(MCPTool.fromTools(connection, [structuredClone(definition)]));
		await session.prompt("The same tool reconnected.");
		expect(requests[1]!.system).toBe(requests[0]!.system);
		expect(requests[1]!.tools).toBe(requests[0]!.tools);
		expect(JSON.stringify(requests[1]!.context.messages)).toContain("Use units=seconds.");
		await session.refreshMCPTools(
			MCPTool.fromTools(connection, [
				{
					...definition,
					inputSchema: {
						type: "object",
						properties: { count: { type: "number" }, unit: { type: "string" } },
						required: ["count", "unit"],
					},
				},
			]),
		);
		await session.prompt("Read the updated input schema.");
		const schema = requests[2]!.context.tools?.find(tool => tool.name === "mcp__stable_measure");
		if (!schema) throw new Error("Missing reconnected direct MCP tool");
		expect(toolWireSchema(schema).required).toContain("unit");
	});

	it("announces MCP instructions omitted by a fixed SDK system prompt", async () => {
		const manager = new MCPManager("/tmp");
		cleanup.push(() => manager.disconnectAll());
		const instructions = new Map([["fixed", "Use tenant=fixed-sdk."]]);
		spyOn(manager, "getServerInstructions").mockImplementation(() => new Map(instructions));
		const { session } = await fixture({ enableMCP: true, mcpManager: manager, systemPrompt: "Fixed SDK policy." });
		const mock = createMockModel({ provider: "anthropic", handler: { content: ["Ready."] } });
		session.agent.streamFn = mock.stream;
		await session.prompt("Use the connected server instructions.");
		expect(mock.calls[0]!.context.systemPrompt).toEqual(["Fixed SDK policy."]);
		expect(JSON.stringify(mock.calls[0]!.context.messages)).toContain("Use tenant=fixed-sdk.");
		await session.refreshBaseSystemPrompt();
		await session.prompt("The fixed SDK policy and instructions are unchanged.");
		expect(
			session.messages.filter(message => message.role === "custom" && message.customType === "xdev-mount-notice"),
		).toHaveLength(1);
	});

	it("credits only MCP instruction sections retained by an SDK prompt callback", async () => {
		const manager = new MCPManager("/tmp");
		cleanup.push(() => manager.disconnectAll());
		const instructions = new Map([
			["retained", "Use tenant=retained-sdk."],
			["omitted", "Use tenant=omitted-sdk."],
		]);
		spyOn(manager, "getServerInstructions").mockImplementation(() => new Map(instructions));
		let keepGenerated = true;
		const { session } = await fixture({
			enableMCP: true,
			mcpManager: manager,
			systemPrompt: blocks =>
				keepGenerated ? blocks : ["SDK replacement policy.", "### retained\nUse tenant=retained-sdk."],
		});
		const mock = createMockModel({ provider: "anthropic", handler: { content: ["Ready."] } });
		session.agent.streamFn = mock.stream;
		await session.prompt("Use the original generated instructions.");
		expect(JSON.stringify(mock.calls[0]!.context.messages)).not.toContain("Use tenant=omitted-sdk.");
		keepGenerated = false;
		await session.refreshBaseSystemPrompt();
		await session.prompt("Use the instructions after SDK replacement.");
		const request = mock.calls.at(-1)!.context;
		expect(request.systemPrompt).toEqual(["SDK replacement policy.", "### retained\nUse tenant=retained-sdk."]);
		const notice = session.messages.findLast(
			message => message.role === "custom" && message.customType === "xdev-mount-notice",
		);
		if (notice?.role !== "custom") throw new Error("Missing omitted SDK instruction notice");
		expect(notice.details).toMatchObject({ mcpInstructions: [["omitted", "Use tenant=omitted-sdk."]] });
		expect(JSON.stringify(request.messages)).toContain("Use tenant=omitted-sdk.");
		await session.refreshBaseSystemPrompt();
		await session.prompt("Reuse the unchanged replacement.");
		expect(
			session.messages.filter(message => message.role === "custom" && message.customType === "xdev-mount-notice"),
		).toHaveLength(1);
	});
});
