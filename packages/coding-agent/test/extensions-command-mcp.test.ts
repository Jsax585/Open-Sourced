import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { emitSessionShutdownEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionCommandContext,
	ExtensionFactory,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { connectToServer } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isEnoent, removeWithRetries } from "@oh-my-pi/pi-utils";

const TOOL_NAME = "record_effect";
const TOOL_DEFINITION = {
	name: TOOL_NAME,
	inputSchema: {
		type: "object" as const,
		properties: { crash: { type: "boolean" }, authChallenge: { type: "boolean" } },
	},
};

let tempDir: string;
let auth: AuthStorage;
const sessions: AgentSession[] = [];
const connections: MCPServerConnection[] = [];
const assertNoModelTurns: (() => void)[] = [];

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-command-mcp-"));
	auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("openai", "unused-command-test-key");
});

afterEach(async () => {
	try {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const connection of connections.splice(0)) await connection.transport.close();
		for (const assertNoTurn of assertNoModelTurns.splice(0)) assertNoTurn();
	} finally {
		vi.restoreAllMocks();
		auth.close();
		await removeWithRetries(tempDir);
	}
});

async function nativeTool(serverName = "side-effect", effectFile = "effects.txt") {
	const effectsPath = path.join(tempDir, effectFile);
	const connection = await connectToServer(serverName, {
		type: "stdio",
		command: process.execPath,
		args: [path.join(import.meta.dir, "fixtures", "side-effect-mcp.ts"), effectsPath],
		timeout: 5_000,
	});
	connections.push(connection);
	return { tool: new MCPTool(connection, TOOL_DEFINITION), connection, effectsPath };
}

async function effects(effectsPath: string): Promise<string[]> {
	try {
		const text = await Bun.file(effectsPath).text();
		return text.trimEnd().split("\n").filter(Boolean);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

async function commandSession(
	mcpTools: MCPTool[],
	options: {
		extensions?: ExtensionFactory[];
		settings?: Record<string, unknown>;
		approve?: ExtensionUIContext["approve"];
	} = {},
) {
	let savedContext: ExtensionCommandContext | undefined;
	const captureCommand: ExtensionFactory = pi => {
		pi.registerCommand("capture-mcp-context", {
			handler: async (_args, ctx) => {
				savedContext = ctx;
			},
		});
	};
	const settings = Settings.isolated({ "tools.approvalMode": "yolo", ...options.settings });
	const model = getBundledModel("openai", "gpt-4o-mini");
	if (!model) throw new Error("Expected a bundled model for SDK initialization");
	const modelRegistry = new ModelRegistry(auth, path.join(tempDir, "models.yml"), {
		ignoreLocalModelConfig: true,
		settings,
	});
	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir: tempDir,
		authStorage: auth,
		modelRegistry,
		model,
		settings,
		sessionManager: SessionManager.inMemory(tempDir),
		disableExtensionDiscovery: true,
		preloadedCustomToolPaths: [],
		extensions: [captureCommand, ...(options.extensions ?? [])],
		mcpTools,
		enableMCP: false,
		enableLsp: false,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		toolNames: ["read"],
		workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});
	sessions.push(session);
	const stream = vi.spyOn(session.agent, "streamFn").mockImplementation(() => {
		throw new Error("Command MCP calls must not request a model turn");
	});
	assertNoModelTurns.push(() => expect(stream).not.toHaveBeenCalled());
	const runner = session.extensionRunner;
	if (!runner) throw new Error("Expected the SDK extension runner");
	await initializeExtensions(session, {
		reportSendError: (_action, error) => {
			throw error;
		},
		reportRuntimeError: error => {
			throw new Error(error.error);
		},
		...(options.approve
			? { mode: "tui" as const, uiContext: { ...runner.getUIContext(), approve: options.approve } }
			: {}),
	});
	const context = async (): Promise<ExtensionCommandContext> => {
		const command = runner.getCommand("capture-mcp-context");
		if (!command) throw new Error("Expected the registered command");
		await runner.runScoped(() => command.handler("", runner.createCommandContext()));
		if (!savedContext) throw new Error("Expected a command context");
		return savedContext;
	};
	return { session, runner, context, ctx: await context() };
}

describe("extension command MCP dispatch", () => {
	it("validates arguments and preserves hook input revisions and result overrides without a model turn", async () => {
		const { tool, effectsPath } = await nativeTool();
		const callIds: string[] = [];
		const observedInputs: unknown[] = [];
		const observedResults: AgentToolResult[] = [];
		const extension: ExtensionFactory = pi => {
			pi.on("tool_call", event => {
				if (event.toolName !== tool.name) return;
				callIds.push(event.toolCallId);
				return { input: { crash: false } };
			});
			pi.on("tool_result", event => {
				if (event.toolName !== tool.name) return;
				observedInputs.push(event.input);
				observedResults.push({ content: event.content, details: event.details, isError: event.isError });
				return {
					content: [{ type: "text", text: "extension-reviewed effect" }],
					details: { reviewed: true },
					isError: true,
				};
			});
		};
		const { ctx } = await commandSession([tool], { extensions: [extension] });

		await expect(ctx.callMCPTool("side-effect", TOOL_NAME, { crash: "invalid" })).rejects.toThrow();
		expect(await effects(effectsPath)).toEqual([]);
		expect(callIds).toEqual([]);
		for (let index = 0; index < 2; index++) {
			const result = await ctx.callMCPTool("side-effect", TOOL_NAME, { crash: true });
			expect(result).toMatchObject({
				content: [{ type: "text", text: "extension-reviewed effect" }],
				details: { reviewed: true },
				isError: true,
			});
		}
		expect(await effects(effectsPath)).toEqual([TOOL_NAME, TOOL_NAME]);
		expect(observedInputs).toEqual([{ crash: false }, { crash: false }]);
		expect(observedResults).toEqual([
			expect.objectContaining({ content: [{ type: "text", text: "effect recorded" }], isError: false }),
			expect.objectContaining({ content: [{ type: "text", text: "effect recorded" }], isError: false }),
		]);
		expect(callIds).toHaveLength(2);
		expect(new Set(callIds).size).toBe(2);
	});

	it("rejects invalid hook-revised arguments before any native effect", async () => {
		const { tool, effectsPath } = await nativeTool();
		const extension: ExtensionFactory = pi => {
			pi.on("tool_call", event => {
				if (event.toolName === tool.name) return { input: { crash: "invalid" } };
			});
		};
		const { ctx } = await commandSession([tool], { extensions: [extension] });

		const error = await ctx.callMCPTool("side-effect", TOOL_NAME, { crash: false }).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(await effects(effectsPath)).toEqual([]);
		expect(error).toBeInstanceOf(Error);
	});

	it("does not reconnect or replay an auth-challenged native call from a command", async () => {
		const { connection, effectsPath } = await nativeTool();
		const reconnect = vi.fn(async () => connection);
		const tool = new MCPTool(connection, TOOL_DEFINITION, reconnect);
		const { ctx } = await commandSession([tool]);

		const result = await ctx.callMCPTool("side-effect", TOOL_NAME, { authChallenge: true });

		expect(result).toMatchObject({ details: { isError: true } });
		expect(await effects(effectsPath)).toEqual([TOOL_NAME]);
		expect(reconnect).not.toHaveBeenCalled();
	});

	it("never routes an exact source request to another source sharing its minted alias", async () => {
		const winner = await nativeTool("side-effect", "winner.txt");
		const loser = await nativeTool("side_effect", "loser.txt");
		expect(winner.tool.name).toBe(loser.tool.name);
		const { ctx, session } = await commandSession([loser.tool, winner.tool]);

		await expect(ctx.callMCPTool("side_effect", TOOL_NAME, {})).rejects.toThrow();
		await expect(ctx.callMCPTool("side-effect", "record-effect", {})).rejects.toThrow();
		await expect(ctx.callMCPTool(null as unknown as string, TOOL_NAME, {})).rejects.toThrow();
		await expect(ctx.callMCPTool("side-effect", 42 as unknown as string, {})).rejects.toThrow();
		expect(await effects(winner.effectsPath)).toEqual([]);
		expect(await effects(loser.effectsPath)).toEqual([]);
		await ctx.callMCPTool("side-effect", TOOL_NAME, {});
		expect(await effects(winner.effectsPath)).toEqual([TOOL_NAME]);

		await session.refreshMCPTools([winner.tool, loser.tool]);
		await expect(ctx.callMCPTool("side_effect", TOOL_NAME, {})).rejects.toThrow();
		await session.refreshMCPTools([loser.tool]);
		await expect(ctx.callMCPTool("side-effect", TOOL_NAME, {})).rejects.toThrow();
		await ctx.callMCPTool("side_effect", TOOL_NAME, {});
		expect(await effects(winner.effectsPath)).toEqual([TOOL_NAME]);
		expect(await effects(loser.effectsPath)).toEqual([TOOL_NAME]);
	});

	it("uses the current wrapped registry after replacement, disabling, and removal", async () => {
		const original = await nativeTool("side-effect", "original.txt");
		const replacement = await nativeTool("side-effect", "replacement.txt");
		const { ctx, session } = await commandSession([original.tool]);
		await ctx.callMCPTool("side-effect", TOOL_NAME, {});
		await session.refreshMCPTools([replacement.tool]);
		await ctx.callMCPTool("side-effect", TOOL_NAME, {});
		expect(await effects(original.effectsPath)).toEqual([TOOL_NAME]);
		expect(await effects(replacement.effectsPath)).toEqual([TOOL_NAME]);

		await session.setActiveToolsByName(session.getEnabledToolNames().filter(name => name !== replacement.tool.name));
		await expect(ctx.callMCPTool("side-effect", TOOL_NAME, {})).rejects.toThrow();
		await session.setActiveToolsByName([...session.getEnabledToolNames(), replacement.tool.name]);
		await ctx.callMCPTool("side-effect", TOOL_NAME, {});
		await session.refreshMCPTools([]);
		await expect(ctx.callMCPTool("side-effect", TOOL_NAME, {})).rejects.toThrow();
		expect(await effects(original.effectsPath)).toEqual([TOOL_NAME]);
		expect(await effects(replacement.effectsPath)).toEqual([TOOL_NAME, TOOL_NAME]);
	});

	it.each(["deny", "headless-prompt", "interactive-rejection"] as const)(
		"cannot bypass approval: %s",
		async policy => {
			const { tool, effectsPath } = await nativeTool();
			const approve = vi.fn(async () => "deny" as const);
			const { ctx } = await commandSession([tool], {
				settings: { "tools.approval": { [tool.name]: policy === "deny" ? "deny" : "prompt" } },
				...(policy === "interactive-rejection" ? { approve } : {}),
			});

			await expect(ctx.callMCPTool("side-effect", TOOL_NAME, {})).rejects.toThrow();
			expect(await effects(effectsPath)).toEqual([]);
			if (policy === "interactive-rejection") expect(approve).toHaveBeenCalledTimes(1);
			else expect(approve).not.toHaveBeenCalled();
		},
	);

	it.each(["extension", "preflight"] as const)("honors a %s block before native execution", async blocker => {
		const { tool, effectsPath } = await nativeTool();
		let blocked = false;
		const extension: ExtensionFactory = pi => {
			pi.on("tool_call", event => {
				if (event.toolName === tool.name && blocked && blocker === "extension") return { block: true };
			});
		};
		const { ctx, runner, session } = await commandSession([tool], { extensions: [extension] });
		if (blocker === "preflight") {
			runner.setToolCallPreflight({ before: async () => (blocked ? { block: true } : undefined) });
		}
		await ctx.callMCPTool("side-effect", TOOL_NAME, {});
		blocked = true;
		await session.refreshMCPTools([tool]);
		await expect(ctx.callMCPTool("side-effect", TOOL_NAME, {})).rejects.toThrow();
		expect(await effects(effectsPath)).toEqual([TOOL_NAME]);
	});

	it.each(["caller", "session-abort", "transition", "shutdown"] as const)(
		"cancels an awaited hook without a late effect at the %s boundary",
		async boundary => {
			const { tool, effectsPath } = await nativeTool();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const exited = Promise.withResolvers<void>();
			let pause = true;
			const extension: ExtensionFactory = pi => {
				pi.on("tool_call", async event => {
					if (event.toolName !== tool.name || !pause) return;
					pause = false;
					entered.resolve();
					try {
						await release.promise;
					} finally {
						exited.resolve();
					}
				});
			};
			const { ctx, session, runner, context } = await commandSession([tool], { extensions: [extension] });
			const controller = new AbortController();
			const pending = ctx.callMCPTool("side-effect", TOOL_NAME, {}, { signal: controller.signal });
			const rejected = pending.catch((error: unknown) => error);
			try {
				await entered.promise;
				switch (boundary) {
					case "caller":
						controller.abort();
						break;
					case "session-abort":
						await session.abort();
						break;
					case "transition":
						expect(await session.resetSessionContext()).toBeDefined();
						break;
					case "shutdown":
						await emitSessionShutdownEvent(runner);
						break;
				}
				expect(await rejected).toBeInstanceOf(Error);
			} finally {
				release.resolve();
			}
			await exited.promise;
			expect(await effects(effectsPath)).toEqual([]);

			if (boundary !== "caller") {
				await expect(ctx.callMCPTool("side-effect", TOOL_NAME, {})).rejects.toThrow();
			}
			const current = await context();
			if (boundary === "shutdown") {
				await expect(current.callMCPTool("side-effect", TOOL_NAME, {})).rejects.toThrow();
				expect(await effects(effectsPath)).toEqual([]);
			} else {
				// A completed call on this same stdio stream is also a fence against a
				// cancelled continuation dispatching after its hook has been released.
				await (boundary === "caller" ? ctx : current).callMCPTool("side-effect", TOOL_NAME, {});
				expect(await effects(effectsPath)).toEqual([TOOL_NAME]);
			}
		},
	);
});
