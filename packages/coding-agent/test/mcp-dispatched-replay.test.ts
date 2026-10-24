import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { connectToServer } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { withMCPSingleAttempt } from "@oh-my-pi/pi-coding-agent/mcp/execution-policy";
import { DeferredMCPTool, MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const TOOL_DEF = { name: "record_effect", inputSchema: { type: "object" as const } };
const connections: MCPServerConnection[] = [];
let tempDir: string;
let effectsPath: string;
let auth: AuthStorage;
let context: CustomToolContext;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-no-replay-"));
	effectsPath = path.join(tempDir, "effects.txt");
	await Bun.write(effectsPath, "");
	auth = await AuthStorage.create(":memory:");
	context = {
		sessionManager: SessionManager.inMemory(),
		modelRegistry: new ModelRegistry(auth),
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
});

afterEach(async () => {
	for (const connection of connections) await connection.transport.close();
	connections.length = 0;
	auth.close();
	await removeWithRetries(tempDir);
});

async function openConnection(): Promise<MCPServerConnection> {
	const connection = await connectToServer("side-effect", {
		type: "stdio",
		command: process.execPath,
		args: [path.join(import.meta.dir, "fixtures", "side-effect-mcp.ts"), effectsPath],
		timeout: 300,
	});
	connections.push(connection);
	return connection;
}

async function effects(): Promise<string[]> {
	const recorded = (await Bun.file(effectsPath).text()).trimEnd();
	return recorded ? recorded.split("\n") : [];
}

describe("MCP tool calls after dispatch", () => {
	it("does not replay a crashed MCPTool call and recovers for the next call", async () => {
		let reconnects = 0;
		const tool = new MCPTool(await openConnection(), TOOL_DEF, async () => {
			reconnects++;
			return openConnection();
		});

		const failed = await tool.execute("crash", { crash: true }, undefined, context);

		expect(failed.details?.isError).toBe(true);
		const diagnostic = failed.content[0];
		if (diagnostic?.type !== "text") throw new Error("Expected MCP failure diagnostics");
		expect(diagnostic.text).toContain("retryable: no");
		expect(diagnostic.text).toContain("may already have run; check its effect before retrying");
		expect(reconnects).toBe(0);
		expect(await effects()).toEqual(["record_effect"]);

		const recovered = await tool.execute("recover", {}, undefined, context);

		expect(recovered.details?.isError).toBeFalsy();
		expect(recovered.content).toEqual([{ type: "text", text: "effect recorded" }]);
		expect(reconnects).toBe(1);
		expect(await effects()).toEqual(["record_effect", "record_effect"]);
	});

	it("does not replay a crashed DeferredMCPTool call", async () => {
		const connection = await openConnection();
		let reconnects = 0;
		const tool = new DeferredMCPTool(
			"side-effect",
			TOOL_DEF,
			async () => connection,
			undefined,
			async () => {
				reconnects++;
				return openConnection();
			},
		);

		const result = await tool.execute("crash", { crash: true }, undefined, context);

		expect(result.details?.isError).toBe(true);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("retryable: no"),
		});
		expect(reconnects).toBe(0);
		expect(await effects()).toEqual(["record_effect"]);
	});

	it("reconnects and retries a definitely unsent call exactly once", async () => {
		const connection = await openConnection();
		let reconnects = 0;
		const tool = new MCPTool(connection, TOOL_DEF, async () => {
			reconnects++;
			return openConnection();
		});
		await connection.transport.close();

		const result = await tool.execute("unsent", {}, undefined, context);

		expect(result.details?.isError).toBeFalsy();
		expect(result.content).toEqual([{ type: "text", text: "effect recorded" }]);
		expect(reconnects).toBe(1);
		expect(await effects()).toEqual(["record_effect"]);
	});
});

describe("single-attempt MCP calls", () => {
	for (const deferred of [false, true]) {
		describe(deferred ? "DeferredMCPTool" : "MCPTool", () => {
			it("leaves a closed connection unsent until a subsequent ordinary call reconnects", async () => {
				const connection = await openConnection();
				let reconnects = 0;
				const reconnect = async () => {
					reconnects++;
					return openConnection();
				};
				const tool = deferred
					? new DeferredMCPTool("side-effect", TOOL_DEF, async () => connection, undefined, reconnect)
					: new MCPTool(connection, TOOL_DEF, reconnect);
				await connection.transport.close();

				const failed = await withMCPSingleAttempt(() => tool.execute("single-unsent", {}, undefined, context));

				expect(failed.details?.isError).toBe(true);
				expect(reconnects).toBe(0);
				expect(await effects()).toEqual([]);

				const recovered = await tool.execute("ordinary-unsent", {}, undefined, context);

				expect(recovered.details?.isError).toBeFalsy();
				expect(reconnects).toBe(1);
				expect(await effects()).toEqual(["record_effect"]);
			});

			it("records an auth-challenged effect once while ordinary calls still retry the challenge", async () => {
				const connection = await openConnection();
				let reconnects = 0;
				const reconnect = async () => {
					reconnects++;
					return openConnection();
				};
				const tool = deferred
					? new DeferredMCPTool("side-effect", TOOL_DEF, async () => connection, undefined, reconnect)
					: new MCPTool(connection, TOOL_DEF, reconnect);

				const failed = await withMCPSingleAttempt(() =>
					tool.execute("single-auth", { authChallenge: true }, undefined, context),
				);

				expect(failed.details?.isError).toBe(true);
				expect(reconnects).toBe(0);
				expect(await effects()).toEqual(["record_effect"]);

				const ordinary = await tool.execute("ordinary-auth", { authChallenge: true }, undefined, context);

				expect(ordinary.details?.isError).toBe(true);
				expect(reconnects).toBe(1);
				expect(await effects()).toEqual(["record_effect", "record_effect", "record_effect"]);
			});
		});
	}

	it("does not reconnect a failed deferred lookup until a subsequent ordinary call", async () => {
		let reconnects = 0;
		const tool = new DeferredMCPTool(
			"side-effect",
			TOOL_DEF,
			async () => {
				throw new Error("MCP server not connected");
			},
			undefined,
			async () => {
				reconnects++;
				return openConnection();
			},
		);

		const failed = await withMCPSingleAttempt(() => tool.execute("single-lookup", {}, undefined, context));

		expect(failed.details?.isError).toBe(true);
		expect(reconnects).toBe(0);
		expect(await effects()).toEqual([]);

		const recovered = await tool.execute("ordinary-lookup", {}, undefined, context);

		expect(recovered.details?.isError).toBeFalsy();
		expect(reconnects).toBe(1);
		expect(await effects()).toEqual(["record_effect"]);
	});

	it("keeps retry policy isolated while scoped and ordinary calls overlap", async () => {
		const scopedConnection = await openConnection();
		const ordinaryConnection = await openConnection();
		await scopedConnection.transport.close();
		await ordinaryConnection.transport.close();
		const lookupEntered = Promise.withResolvers<void>();
		const releaseLookup = Promise.withResolvers<void>();
		let scopedReconnects = 0;
		let ordinaryReconnects = 0;
		const scopedTool = new DeferredMCPTool(
			"side-effect",
			TOOL_DEF,
			async () => {
				lookupEntered.resolve();
				await releaseLookup.promise;
				return scopedConnection;
			},
			undefined,
			async () => {
				scopedReconnects++;
				return openConnection();
			},
		);
		const ordinaryTool = new MCPTool(ordinaryConnection, TOOL_DEF, async () => {
			ordinaryReconnects++;
			return openConnection();
		});

		const pending = withMCPSingleAttempt(() => scopedTool.execute("overlapping-single", {}, undefined, context));
		await lookupEntered.promise;
		const [ordinary, failed] = await Promise.all([
			ordinaryTool.execute("overlapping-ordinary", {}, undefined, context).finally(() => releaseLookup.resolve()),
			pending,
		]);

		expect(ordinary.details?.isError).toBeFalsy();
		expect(ordinaryReconnects).toBe(1);
		expect(failed.details?.isError).toBe(true);
		expect(scopedReconnects).toBe(0);
		expect(await effects()).toEqual(["record_effect"]);
	});

	it("restores ordinary retries for background work inherited from a completed command", async () => {
		const scopedTool = new MCPTool(await openConnection(), TOOL_DEF);
		const ordinaryConnection = await openConnection();
		await ordinaryConnection.transport.close();
		let reconnects = 0;
		const ordinaryTool = new MCPTool(ordinaryConnection, TOOL_DEF, async () => {
			reconnects++;
			return openConnection();
		});
		const release = Promise.withResolvers<void>();
		let backgroundCall: Promise<unknown> | undefined;
		await withMCPSingleAttempt(async () => {
			backgroundCall = release.promise.then(() => ordinaryTool.execute("later-ordinary", {}, undefined, context));
			return scopedTool.execute("completed-command", {}, undefined, context);
		});

		release.resolve();
		expect(await backgroundCall).toMatchObject({ content: [{ type: "text", text: "effect recorded" }] });
		expect(reconnects).toBe(1);
		expect(await effects()).toEqual(["record_effect", "record_effect"]);
	});
});
