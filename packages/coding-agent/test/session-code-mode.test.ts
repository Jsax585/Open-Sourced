import { afterEach, describe, expect, it } from "bun:test";
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
			toolNames: ["read", "eval", "yield"],
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
});
