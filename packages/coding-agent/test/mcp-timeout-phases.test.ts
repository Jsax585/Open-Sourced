/**
 * Each MCP phase must be bounded by its own deadline: `initialize` by `connect`, `*\/list` by
 * `catalog`, everything else by `execution`. A fake server answers instantly except for the
 * methods listed in `stall`, which never reply, so the deadline that fires (and the phase it
 * names) identifies which timeout was applied.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { callTool, connectToServer, listTools } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPConnectionTimeoutError } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { setMCPGlobalTimeouts } from "@oh-my-pi/pi-coding-agent/mcp/timeout";
import { StdioTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/stdio";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";

const GUARD_MS = 3_000;
let server: Bun.Server<undefined> | null = null;
const originalEnv = process.env.OMP_MCP_TIMEOUT_MS;

afterEach(() => {
	server?.stop(true);
	server = null;
	setMCPGlobalTimeouts({});
	if (originalEnv === undefined) delete process.env.OMP_MCP_TIMEOUT_MS;
	else process.env.OMP_MCP_TIMEOUT_MS = originalEnv;
});

function startServer(stall: Set<string>, delayMs: Record<string, number> = {}): string {
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			// The optional GET SSE listener is declined; DELETE ends the session.
			if (request.method === "GET") return new Response(null, { status: 405 });
			if (request.method === "DELETE") return new Response(null, { status: 204 });
			const body = (await request.json()) as { id?: number; method: string };
			if (stall.has(body.method)) {
				// Hold the socket open until the client gives up.
				await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve()));
				return new Response(null, { status: 499 });
			}
			if (body.id === undefined) return new Response(null, { status: 202 });
			if (delayMs[body.method]) await Bun.sleep(delayMs[body.method]);
			const results: Record<string, unknown> = {
				initialize: {
					protocolVersion: "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "f", version: "1" },
				},
				"tools/list": { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
				"tools/call": { content: [{ type: "text", text: "ok" }] },
			};
			return Response.json({ jsonrpc: "2.0", id: body.id, result: results[body.method] ?? {} });
		},
	});
	return `http://127.0.0.1:${server.port}/mcp`;
}

async function outcome<T>(promise: Promise<T>): Promise<{ error?: Error; ms: number }> {
	const started = performance.now();
	const guard = Bun.sleep(GUARD_MS).then(() => new Error(`still pending after ${GUARD_MS}ms`));
	const error = await Promise.race([
		promise.then(
			() => undefined,
			(e: Error) => e,
		),
		guard,
	]);
	return { error, ms: performance.now() - started };
}

describe("MCP per-phase timeouts over Streamable HTTP", () => {
	it("applies catalog to tools/list and execution to tools/call independently", async () => {
		const url = startServer(new Set(["tools/list", "tools/call"]));
		const config: MCPServerConfig = { type: "http", url, timeout: { connect: 2_000, catalog: 60, execution: 250 } };
		const connection = await connectToServer("fixture", config);
		try {
			const list = await outcome(listTools(connection));
			expect(list.error?.message).toContain("Request timeout after 60ms (catalog timeout, tools/list)");
			expect(list.ms).toBeLessThan(250);

			const call = await outcome(callTool(connection, "echo", {}));
			expect(call.error?.message).toContain("Request timeout after 250ms (execution timeout, tools/call)");
			// A catalog-sized deadline must not cut a tool call short.
			expect(call.ms).toBeGreaterThanOrEqual(200);
		} finally {
			await connection.transport.close();
		}
	});

	it("applies connect to initialize without touching the other phases", async () => {
		const url = startServer(new Set(["initialize"]));
		const result = await outcome(
			connectToServer("fixture", { type: "http", url, timeout: { connect: 60, catalog: 2_000, execution: 2_000 } }),
		);

		expect(result.error).toBeInstanceOf(MCPConnectionTimeoutError);
		expect(result.error?.message).toBe('Connection to MCP server "fixture" timed out after 60ms (connect timeout)');
		expect(result.ms).toBeLessThan(1_000);
	});

	it("a bare number bounds every phase, and a per-server phase beats the global setting", async () => {
		const url = startServer(new Set(["tools/list", "tools/call"]));
		setMCPGlobalTimeouts({ catalog: 2_000, execution: 2_000 });

		const bare = await connectToServer("bare", { type: "http", url, timeout: 70 });
		try {
			expect((await outcome(listTools(bare))).error?.message).toContain("after 70ms (catalog timeout");
			expect((await outcome(callTool(bare, "echo", {}))).error?.message).toContain("after 70ms (execution timeout");
		} finally {
			await bare.transport.close();
		}

		const partial = await connectToServer("partial", { type: "http", url, timeout: { catalog: 80 } });
		try {
			// catalog from the server entry, execution inherited from the global setting
			setMCPGlobalTimeouts({ catalog: 2_000, execution: 120 });
			expect((await outcome(listTools(partial))).error?.message).toContain("after 80ms (catalog timeout");
			expect((await outcome(callTool(partial, "echo", {}))).error?.message).toContain(
				"after 120ms (execution timeout",
			);
		} finally {
			await partial.transport.close();
		}
	});

	it("timeout.execution = 0 lets a slow call outlive a short catalog deadline", async () => {
		const url = startServer(new Set(), { "tools/call": 120 });
		const unbounded = await connectToServer("unbounded", {
			type: "http",
			url,
			timeout: { catalog: 30, execution: 0 },
		});
		const bounded = await connectToServer("bounded", {
			type: "http",
			url,
			timeout: { catalog: 2_000, execution: 30 },
		});
		try {
			expect((await callTool(unbounded, "echo", {})).content).toEqual([{ type: "text", text: "ok" }]);
			expect((await outcome(callTool(bounded, "echo", {}))).error?.message).toContain(
				"after 30ms (execution timeout",
			);
		} finally {
			await unbounded.transport.close();
			await bounded.transport.close();
		}
	});
});

describe.skipIf(process.platform === "win32")("MCP per-phase timeouts over stdio", () => {
	// A raw JSON-RPC child: answers initialize, then never answers tools/list or tools/call.
	const script = `
		const rl = require("node:readline").createInterface({ input: process.stdin });
		rl.on("line", line => {
			const msg = JSON.parse(line);
			if (msg.method === "initialize") {
				console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "f", version: "1" } } }));
			}
		});
		setInterval(() => {}, 1000);
	`;

	it("rejects tools/list and tools/call with their own phase deadline", async () => {
		const transport = new StdioTransport({
			command: process.execPath,
			args: ["-e", script],
			timeout: { connect: 2_000, catalog: 60, execution: 200 },
		});
		await transport.connect();
		try {
			const init = await transport.request("initialize", {});
			expect(init).toBeDefined();
			const list = await outcome(transport.request("tools/list", {}));
			expect(list.error?.message).toContain("Request timeout after 60ms (catalog timeout, tools/list)");
			const call = await outcome(transport.request("tools/call", { name: "echo", arguments: {} }));
			expect(call.error?.message).toContain("Request timeout after 200ms (execution timeout, tools/call)");
			expect(call.ms).toBeGreaterThanOrEqual(150);
		} finally {
			await transport.close();
		}
	});
});
