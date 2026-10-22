import { afterEach, describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import { streamOpenAIResponses, type OpenAIResponsesOptions } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const resources: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of resources.splice(0)) await dispose();
});

function textEvents(text: string, id: string): Record<string, unknown>[] {
	const item = {
		type: "message",
		id: `msg_${id}`,
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text }],
	};
	return [
		{ type: "response.created", response: { id } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{
			type: "response.content_part.added",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "" },
		},
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: { id, status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } },
		},
	];
}

function send(socket: ServerWebSocket<{ id: number }>, events: Record<string, unknown>[]): void {
	for (const event of events) socket.send(JSON.stringify(event));
}

function endpoint(
	behavior?: (socket: ServerWebSocket<{ id: number }>, body: Record<string, unknown>, index: number) => void,
) {
	const requests: Array<{ connection: number; body: Record<string, unknown> }> = [];
	const upgrades: Array<{ path: string; headers: Headers }> = [];
	const httpRequests: Array<Record<string, unknown>> = [];
	const sockets = new Map<number, ServerWebSocket<{ id: number }>>();
	const providerSessionState = new Map<string, ProviderSessionState>();
	const closeWaiters: Array<{ count: number; resolve: () => void }> = [];
	let opened = 0;
	let closed = 0;
	const server = Bun.serve<{ id: number }>({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, server) {
			if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
				upgrades.push({ path: new URL(request.url).pathname, headers: request.headers });
				if (server.upgrade(request, { data: { id: ++opened } })) return undefined;
				return new Response("Upgrade failed", { status: 400 });
			}
			httpRequests.push((await request.json()) as Record<string, unknown>);
			return new Response(
				`${textEvents("HTTP", "resp_http")
					.map(event => `data: ${JSON.stringify(event)}\n\n`)
					.join("")}`,
				{
					headers: { "content-type": "text/event-stream" },
				},
			);
		},
		websocket: {
			open(socket) {
				sockets.set(socket.data.id, socket);
			},
			message(socket, message) {
				const body = JSON.parse(String(message)) as Record<string, unknown>;
				requests.push({ connection: socket.data.id, body });
				if (behavior) behavior(socket, body, requests.length);
				else send(socket, textEvents("WS", `resp_${requests.length}`));
			},
			close(socket) {
				sockets.delete(socket.data.id);
				closed++;
				for (const waiter of closeWaiters) if (closed >= waiter.count) waiter.resolve();
			},
		},
	});
	const model: Model<"openai-responses"> = {
		...(getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">),
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
	};
	const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 1 }] };
	const options: OpenAIResponsesOptions = {
		apiKey: "test-key",
		sessionId: "main",
		providerSessionState,
		streamFirstEventTimeoutMs: 1000,
		streamIdleTimeoutMs: 1000,
	};
	resources.push(async () => {
		for (const state of providerSessionState.values()) state.close();
		await server.stop(true);
	});
	return {
		model,
		context,
		options,
		requests,
		upgrades,
		httpRequests,
		sockets,
		providerSessionState,
		waitForClosed(count: number): Promise<void> {
			if (closed >= count) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			closeWaiters.push({ count, resolve });
			return promise;
		},
	};
}

// These tests exercise the public provider stream against real Bun HTTP/WS endpoints.
describe("standard OpenAI Responses WebSocket opt-in", () => {
	it("uses HTTP/SSE when unconfigured", async () => {
		const fixture = endpoint();
		const result = await streamOpenAIResponses(fixture.model, fixture.context, fixture.options).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toMatchObject([{ type: "text", text: "HTTP" }]);
		expect(fixture.httpRequests).toHaveLength(1);
		expect(fixture.upgrades).toHaveLength(0);
	});

	it("uses response.create on the standard path with unchanged auth and custom headers", async () => {
		const fixture = endpoint();
		const observed: string[] = [];
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
			headers: { "X-Test-Header": "preserved", "OpenAI-Organization": "test-org" },
			onSseEvent: event => {
				if (event.event) observed.push(event.event);
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toMatchObject([{ type: "text", text: "WS" }]);
		expect(result.usage.input).toBe(5);
		expect(result.usage.output).toBe(3);
		expect(fixture.upgrades[0]?.path).toBe("/v1/responses");
		expect(fixture.upgrades[0]?.headers.get("authorization")).toBe("Bearer test-key");
		expect(fixture.upgrades[0]?.headers.get("x-test-header")).toBe("preserved");
		expect(fixture.upgrades[0]?.headers.get("openai-organization")).toBe("test-org");
		expect(fixture.upgrades[0]?.headers.get("openai-beta")).toBeNull();
		expect(fixture.requests[0]?.body).toMatchObject({ type: "response.create", model: fixture.model.id });
		expect(fixture.requests[0]?.body.stream).toBeUndefined();
		expect(fixture.requests[0]?.body.background).toBeUndefined();
		expect(fixture.httpRequests).toHaveLength(0);
		expect(observed).toContain("response.output_text.delta");
	});

	it("honors model opt-in and lets explicit false force HTTP", async () => {
		const fixture = endpoint();
		const model = { ...fixture.model, preferWebsockets: true };
		expect((await streamOpenAIResponses(model, fixture.context, fixture.options).result()).stopReason).toBe("stop");
		expect(
			(await streamOpenAIResponses(model, fixture.context, { ...fixture.options, preferWebsockets: false }).result())
				.stopReason,
		).toBe("stop");
		expect(fixture.requests).toHaveLength(1);
		expect(fixture.httpRequests).toHaveLength(1);
	});

	it("keeps the standard request builder and onPayload semantics", async () => {
		const fixture = endpoint();
		const options: OpenAIResponsesOptions = {
			...fixture.options,
			statefulResponses: false,
			temperature: 0.3,
			maxTokens: 128,
			extraBody: { custom_gateway_field: "same" },
			onPayload: payload => ({ ...(payload as object), metadata: { source: "hook" } }),
		};
		await streamOpenAIResponses(fixture.model, fixture.context, options).result();
		await streamOpenAIResponses(fixture.model, fixture.context, { ...options, preferWebsockets: true }).result();
		const { stream: _stream, ...httpBody } = fixture.httpRequests[0]!;
		const { type: _type, ...wsBody } = fixture.requests[0]!.body;
		expect(wsBody).toEqual(httpBody);
	});

	it("reuses an idle session socket but replays full history even when statefulResponses is true", async () => {
		const fixture = endpoint();
		const options = { ...fixture.options, preferWebsockets: true, statefulResponses: true };
		const first = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
		const second = await streamOpenAIResponses(
			fixture.model,
			{
				messages: [...fixture.context.messages, first, { role: "user", content: "Next", timestamp: 2 }],
			},
			options,
		).result();
		expect(second.stopReason).toBe("stop");
		expect(fixture.upgrades).toHaveLength(1);
		expect(fixture.requests).toHaveLength(2);
		expect(fixture.requests[1]?.connection).toBe(fixture.requests[0]?.connection);
		expect(fixture.requests[1]?.body.previous_response_id).toBeUndefined();
		expect(fixture.requests[1]?.body.input).toHaveLength(3);
	});

	it("continues a streamed tool call with its full call and result on the same socket", async () => {
		const fixture = endpoint((socket, _body, index) => {
			if (index !== 1) {
				send(socket, textEvents("Found", "resp_tool_result"));
				return;
			}
			const item = {
				type: "function_call",
				id: "fc_lookup",
				call_id: "call_lookup",
				name: "lookup",
				arguments: '{"query":"hello"}',
			};
			send(socket, [
				{ type: "response.created", response: { id: "resp_tool" } },
				{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
				{
					type: "response.function_call_arguments.delta",
					output_index: 0,
					item_id: item.id,
					delta: item.arguments,
				},
				{ type: "response.output_item.done", output_index: 0, item },
				{ type: "response.completed", response: { id: "resp_tool", status: "completed" } },
			]);
		});
		const options = { ...fixture.options, preferWebsockets: true, statefulResponses: true };
		const first = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
		expect(first.stopReason).toBe("toolUse");
		const toolCall = first.content.find(block => block.type === "toolCall");
		if (!toolCall || toolCall.type !== "toolCall") throw new Error("Expected streamed tool call");
		expect(toolCall.arguments).toEqual({ query: "hello" });
		const second = await streamOpenAIResponses(
			fixture.model,
			{
				messages: [
					...fixture.context.messages,
					first,
					{
						role: "toolResult",
						toolCallId: toolCall.id,
						toolName: "lookup",
						content: [{ type: "text", text: "found" }],
						isError: false,
						timestamp: 2,
					},
				],
			},
			options,
		).result();
		expect(second.stopReason).toBe("stop");
		expect(fixture.upgrades).toHaveLength(1);
		expect(fixture.requests[1]?.body.previous_response_id).toBeUndefined();
		expect(fixture.requests[1]?.body.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "function_call", call_id: "call_lookup" }),
				expect.objectContaining({ type: "function_call_output", call_id: "call_lookup", output: "found" }),
			]),
		);
	});

	it("reconnects after server close without sending a cross-connection response anchor", async () => {
		const fixture = endpoint((socket, _body, index) => {
			send(socket, textEvents("WS", `resp_${index}`));
			if (index === 1) socket.close(1000, "retire");
		});
		const clientClosed = Promise.withResolvers<void>();
		const OriginalWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = new Proxy(OriginalWebSocket, {
			construct(target, args) {
				const socket: WebSocket = Reflect.construct(target, args);
				socket.addEventListener("close", () => clientClosed.resolve(), { once: true });
				return socket;
			},
		});
		resources.push(async () => {
			globalThis.WebSocket = OriginalWebSocket;
		});
		const options = { ...fixture.options, preferWebsockets: true, statefulResponses: true };
		const first = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
		expect(first.stopReason).toBe("stop");
		await fixture.waitForClosed(1);
		// Bun's server close callback can run before the client even receives completed.
		// Wait for the peer close to be observable rather than racing a still-OPEN client.
		await clientClosed.promise;
		const second = await streamOpenAIResponses(
			fixture.model,
			{
				messages: [...fixture.context.messages, first, { role: "user", content: "Next", timestamp: 2 }],
			},
			options,
		).result();
		expect(second.stopReason).toBe("stop");
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.requests[1]?.body.previous_response_id).toBeUndefined();
		expect(fixture.requests[1]?.body.input).toHaveLength(3);
	});

	it("keeps generation and socket reuse intact when the diagnostic observer throws", async () => {
		const fixture = endpoint((socket, _body, index) => {
			send(socket, textEvents(`TURN ${index}`, `resp_${index}`));
		});
		let observedDeltas = 0;
		const options: OpenAIResponsesOptions = {
			...fixture.options,
			preferWebsockets: true,
			onSseEvent: event => {
				if (event.event !== "response.output_text.delta") return;
				observedDeltas++;
				throw new Error("Diagnostic observer failed");
			},
		};
		for (const turn of [1, 2]) {
			const result = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
			expect(result.stopReason).toBe("stop");
			expect(result.content).toMatchObject([{ type: "text", text: `TURN ${turn}` }]);
		}
		expect(observedDeltas).toBe(2);
		expect(fixture.upgrades).toHaveLength(1);
		expect(fixture.requests).toHaveLength(2);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("rejects previous_response_id injected by onPayload rather than silently changing it", async () => {
		const fixture = endpoint();
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
			onPayload: payload => ({ ...(payload as object), previous_response_id: "resp_foreign" }),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("previous_response_id is not supported");
		expect(fixture.upgrades).toHaveLength(0);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("rejects background requests locally", async () => {
		const fixture = endpoint();
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
			extraBody: { background: true },
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("background: true");
		expect(fixture.upgrades).toHaveLength(0);
	});

	it("isolates concurrent same-session calls and does not close an in-flight socket", async () => {
		const firstSeen = Promise.withResolvers<void>();
		let firstSocket: ServerWebSocket<{ id: number }> | undefined;
		const fixture = endpoint((socket, _body, index) => {
			if (index === 1) {
				firstSocket = socket;
				firstSeen.resolve();
			} else send(socket, textEvents("SECOND", "resp_second"));
		});
		const options = { ...fixture.options, preferWebsockets: true };
		const first = streamOpenAIResponses(fixture.model, fixture.context, options).result();
		await firstSeen.promise;
		const second = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
		expect(second.content).toMatchObject([{ type: "text", text: "SECOND" }]);
		if (!firstSocket) throw new Error("Expected first socket");
		send(firstSocket, textEvents("FIRST", "resp_first"));
		expect((await first).content).toMatchObject([{ type: "text", text: "FIRST" }]);
		expect(fixture.requests[0]?.connection).not.toBe(fixture.requests[1]?.connection);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("cancels only its own concurrent request and retires the cancelled socket", async () => {
		const firstSeen = Promise.withResolvers<void>();
		const secondSeen = Promise.withResolvers<void>();
		let secondSocket: ServerWebSocket<{ id: number }> | undefined;
		const fixture = endpoint((socket, _body, index) => {
			if (index === 1) firstSeen.resolve();
			else {
				secondSocket = socket;
				secondSeen.resolve();
			}
		});
		const controller = new AbortController();
		const options = { ...fixture.options, preferWebsockets: true };
		const first = streamOpenAIResponses(fixture.model, fixture.context, {
			...options,
			signal: controller.signal,
		}).result();
		await firstSeen.promise;
		const second = streamOpenAIResponses(fixture.model, fixture.context, options).result();
		await secondSeen.promise;
		controller.abort();
		expect((await first).stopReason).toBe("aborted");
		await fixture.waitForClosed(1);
		if (!secondSocket) throw new Error("Expected concurrent socket");
		send(secondSocket, textEvents("SURVIVED", "resp_survived"));
		expect((await second).content).toMatchObject([{ type: "text", text: "SURVIVED" }]);
		expect(fixture.requests).toHaveLength(2);
	});

	for (const failure of ["error", "close", "malformed"] as const) {
		it(`surfaces ${failure} before output without replay or HTTP fallback`, async () => {
			const fixture = endpoint(socket => {
				if (failure === "error")
					socket.send(
						JSON.stringify({
							type: "error",
							error: { code: "rate_limit_exceeded", message: "Deliberate rejection" },
						}),
					);
				else if (failure === "malformed") socket.send("not JSON");
				else socket.close(1011, "dropped");
			});
			const result = await streamOpenAIResponses(fixture.model, fixture.context, {
				...fixture.options,
				preferWebsockets: true,
			}).result();
			expect(result.stopReason).toBe("error");
			expect(fixture.requests).toHaveLength(1);
			expect(fixture.upgrades).toHaveLength(1);
			expect(fixture.httpRequests).toHaveLength(0);
			await fixture.waitForClosed(1);
		});
	}

	it("preserves already-visible deltas on interruption without resubmitting", async () => {
		const fixture = endpoint(socket => {
			send(socket, textEvents("PARTIAL", "resp_partial").slice(0, 4));
			socket.close(1011, "dropped after output");
		});
		const stream = streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
		});
		const deltas: string[] = [];
		for await (const event of stream) if (event.type === "text_delta") deltas.push(event.delta);
		const result = await stream.result();
		expect(deltas.join("")).toBe("PARTIAL");
		expect(result.stopReason).toBe("error");
		expect(fixture.requests).toHaveLength(1);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("closes sockets without provider session state instead of retaining an unreachable pool", async () => {
		const fixture = endpoint();
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
			providerSessionState: undefined,
		}).result();
		expect(result.stopReason).toBe("stop");
		await fixture.waitForClosed(1);
		expect(fixture.sockets.size).toBe(0);
	});

	it("releaseSession closes only that conversation and close cleans the remainder", async () => {
		const fixture = endpoint();
		const options = { ...fixture.options, preferWebsockets: true };
		await streamOpenAIResponses(fixture.model, fixture.context, options).result();
		await streamOpenAIResponses(fixture.model, fixture.context, { ...options, sessionId: "other" }).result();
		for (const state of fixture.providerSessionState.values()) state.releaseSession?.("main");
		await fixture.waitForClosed(1);
		expect(fixture.sockets.size).toBe(1);
		await streamOpenAIResponses(fixture.model, fixture.context, { ...options, sessionId: "other" }).result();
		expect(fixture.upgrades).toHaveLength(2);
		for (const state of fixture.providerSessionState.values()) state.close();
		await fixture.waitForClosed(2);
		expect(fixture.sockets.size).toBe(0);
	});

	it("replaces an idle socket on credential change without reusing its authentication", async () => {
		const fixture = endpoint();
		const options = { ...fixture.options, preferWebsockets: true };
		await streamOpenAIResponses(fixture.model, fixture.context, options).result();
		await streamOpenAIResponses(fixture.model, fixture.context, { ...options, apiKey: "replacement-key" }).result();
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.upgrades[1]?.headers.get("authorization")).toBe("Bearer replacement-key");
		expect(fixture.requests[1]?.body.previous_response_id).toBeUndefined();
	});
	it("does not retry a rejected upgrade or fall back to HTTP", async () => {
		let upgradeAttempts = 0;
		let postAttempts = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (request.headers.has("upgrade")) upgradeAttempts++;
				if (request.method === "POST") postAttempts++;
				return new Response("WebSocket unavailable", { status: 403 });
			},
		});
		resources.push(async () => {
			await server.stop(true);
		});
		const fixture = endpoint();
		const result = await streamOpenAIResponses(
			{
				...fixture.model,
				baseUrl: `http://127.0.0.1:${server.port}/v1`,
			},
			fixture.context,
			{ ...fixture.options, preferWebsockets: true },
		).result();
		expect(result.stopReason).toBe("error");
		expect(upgradeAttempts).toBe(1);
		expect(postAttempts).toBe(0);
	});

	it("handles a signal aborted before the handshake without opening a socket", async () => {
		const fixture = endpoint();
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
			signal: AbortSignal.abort(),
		}).result();
		expect(result.stopReason).toBe("aborted");
		expect(fixture.upgrades).toHaveLength(0);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("times out a stalled response without replay and closes its socket", async () => {
		const fixture = endpoint(() => {});
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
			streamFirstEventTimeoutMs: 30,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("timed out");
		expect(fixture.requests).toHaveLength(1);
		expect(fixture.httpRequests).toHaveLength(0);
		await fixture.waitForClosed(1);
	});

	it("can close an active provider session and reconnect on its next request", async () => {
		const firstSeen = Promise.withResolvers<void>();
		const fixture = endpoint((socket, _body, index) => {
			if (index === 1) firstSeen.resolve();
			else send(socket, textEvents("AFTER CLOSE", "resp_after_close"));
		});
		const options = { ...fixture.options, preferWebsockets: true };
		const first = streamOpenAIResponses(fixture.model, fixture.context, options).result();
		await firstSeen.promise;
		for (const state of fixture.providerSessionState.values()) state.close();
		expect((await first).stopReason).toBe("error");
		await fixture.waitForClosed(1);
		const second = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
		expect(second.stopReason).toBe("stop");
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.requests[1]?.body.previous_response_id).toBeUndefined();
	});
});
