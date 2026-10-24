import { afterEach, describe, expect, it } from "bun:test";
import { withMCPSingleAttempt } from "@oh-my-pi/pi-coding-agent/mcp/execution-policy";
import { HttpTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/http";
import { LegacySseTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/sse";
import type { JsonRpcRequest } from "@oh-my-pi/pi-coding-agent/mcp/types";

const encoder = new TextEncoder();
const effectResult = { content: [{ type: "text", text: "effect recorded" }], isError: false };
let server: Bun.Server<undefined> | undefined;
let transport: HttpTransport | LegacySseTransport | undefined;

afterEach(async () => {
	try {
		await transport?.close();
	} finally {
		transport = undefined;
		server?.stop(true);
		server = undefined;
	}
});

describe("single-attempt MCP HTTP authentication", () => {
	it.each([
		["http", 401],
		["http", 403],
		["sse", 401],
		["sse", 403],
	] as const)("does not replay a %s POST after HTTP %i but ordinary calls still refresh", async (kind, status) => {
		const effects: unknown[] = [];
		const authorizations: (string | null)[] = [];
		let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "GET") {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								stream = controller;
								controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
							},
						}),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				if (req.method !== "POST") return new Response(null, { status: 405 });
				const body = (await req.json()) as JsonRpcRequest;
				effects.push((body.params?.arguments as Record<string, unknown> | undefined)?.effect);
				authorizations.push(req.headers.get("Authorization"));
				if (req.headers.get("Authorization") !== "Bearer refreshed") {
					return new Response("effect recorded before authentication failed", { status });
				}
				const message = { jsonrpc: "2.0", id: body.id, result: effectResult };
				if (kind === "sse") {
					if (!stream) throw new Error("Legacy SSE stream was not connected");
					stream.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
					return new Response(null, { status: 202 });
				}
				return Response.json(message);
			},
		});
		const config = {
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: 500,
			headers: { Authorization: "Bearer stale" },
		};
		const activeTransport =
			kind === "http"
				? new HttpTransport({ ...config, type: "http" })
				: new LegacySseTransport({ ...config, type: "sse" });
		transport = activeTransport;
		let refreshes = 0;
		activeTransport.onAuthError = async () => {
			refreshes++;
			return { Authorization: "Bearer refreshed" };
		};
		await activeTransport.connect();

		await expect(
			withMCPSingleAttempt(() =>
				activeTransport.request("tools/call", { name: "record_effect", arguments: { effect: "single" } }),
			),
		).rejects.toThrow(`HTTP ${status}`);

		expect(refreshes).toBe(0);
		expect(effects).toEqual(["single"]);
		expect(authorizations).toEqual(["Bearer stale"]);

		await expect(
			activeTransport.request("tools/call", { name: "record_effect", arguments: { effect: "ordinary" } }),
		).resolves.toEqual(effectResult);

		expect(refreshes).toBe(1);
		expect(effects).toEqual(["single", "ordinary", "ordinary"]);
		expect(authorizations).toEqual(["Bearer stale", "Bearer stale", "Bearer refreshed"]);
	});

	it.each([401, 403])("does not refresh an HTTP %i resume GET within a single attempt", async status => {
		const effects: unknown[] = [];
		const getAuthorizations: (string | null)[] = [];
		let requestId: string | number | undefined;
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "POST") {
					const body = (await req.json()) as JsonRpcRequest;
					requestId = body.id;
					effects.push((body.params?.arguments as Record<string, unknown> | undefined)?.effect);
					return new Response("id: recorded\nretry: 0\ndata:\n\n", {
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				if (req.method !== "GET") return new Response(null, { status: 405 });
				getAuthorizations.push(req.headers.get("Authorization"));
				if (req.headers.get("Authorization") !== "Bearer refreshed") {
					return new Response("expired", { status });
				}
				return new Response(
					`id: complete\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: requestId, result: effectResult })}\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const activeTransport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: 500,
			headers: { Authorization: "Bearer stale" },
		});
		transport = activeTransport;
		let refreshes = 0;
		activeTransport.onAuthError = async () => {
			refreshes++;
			return { Authorization: "Bearer refreshed" };
		};
		await activeTransport.connect();

		await expect(
			withMCPSingleAttempt(() =>
				activeTransport.request("tools/call", { name: "record_effect", arguments: { effect: "single" } }),
			),
		).rejects.toThrow(`HTTP ${status}`);

		expect(refreshes).toBe(0);
		expect(effects).toEqual(["single"]);
		expect(getAuthorizations).toEqual(["Bearer stale"]);

		await expect(
			activeTransport.request("tools/call", { name: "record_effect", arguments: { effect: "ordinary" } }),
		).resolves.toEqual(effectResult);

		expect(refreshes).toBe(1);
		expect(effects).toEqual(["single", "ordinary"]);
		expect(getAuthorizations).toEqual(["Bearer stale", "Bearer stale", "Bearer refreshed"]);
	});
});
