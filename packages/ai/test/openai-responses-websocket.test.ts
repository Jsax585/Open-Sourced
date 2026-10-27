import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { ServerWebSocket } from "bun";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { type as schemaType } from "@oh-my-pi/omptype";
import {
	clearCopilotIntegrationCache,
	getCachedCopilotIntegrationId,
	getCopilotIntegrationCacheKey,
	rememberCopilotWorkingIntegrationId,
} from "@oh-my-pi/pi-ai/providers/github-copilot-headers";
import { COPILOT_CAPI_IDENTITY_HEADERS, COPILOT_CHAT_INTEGRATION_ID } from "@oh-my-pi/pi-catalog/wire/github-copilot";
import {
	streamOpenAIResponses,
	openAIResponsesReplaysNativeHistory,
	type OpenAIResponsesOptions,
} from "@oh-my-pi/pi-ai/providers/openai-responses";
import type {
	AssistantMessage,
	Context,
	Model,
	ProviderSessionState,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai/types";
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
		content: [{ type: "output_text", text, annotations: [] }],
	};
	return [
		{ type: "response.created", response: { id } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{
			type: "response.content_part.added",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "", annotations: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id,
				status: "completed",
				output: [item],
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
			},
		},
	];
}

function send(socket: ServerWebSocket<{ id: number }>, events: Record<string, unknown>[]): void {
	for (const event of events) socket.send(JSON.stringify(event));
}

function endpoint(
	behavior?: (socket: ServerWebSocket<{ id: number }>, body: Record<string, unknown>, index: number) => void,
	setup?: {
		provider?: "github-copilot";
		rejectUpgrade?: (request: Request) => Response | undefined;
		httpResponse?: (body: Record<string, unknown>) => Response | undefined;
	},
) {
	if (setup?.provider === "github-copilot") {
		const previous = Bun.env.COPILOT_INTEGRATION_ID;
		delete Bun.env.COPILOT_INTEGRATION_ID;
		resources.push(async () => {
			if (previous === undefined) delete Bun.env.COPILOT_INTEGRATION_ID;
			else Bun.env.COPILOT_INTEGRATION_ID = previous;
		});
	}
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
				const rejection = setup?.rejectUpgrade?.(request);
				if (rejection) return rejection;
				if (server.upgrade(request, { data: { id: ++opened } })) return undefined;
				return new Response("Upgrade failed", { status: 400 });
			}
			const body = (await request.json()) as Record<string, unknown>;
			httpRequests.push(body);
			const rejection = setup?.httpResponse?.(body);
			if (rejection) return rejection;
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
		...((setup?.provider === "github-copilot"
			? getBundledModel("github-copilot", "gpt-5.4")
			: getBundledModel("openai", "gpt-5-mini")) as Model<"openai-responses">),
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
	};
	const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 1 }] };
	const options = {
		apiKey: "test-key",
		sessionId: "main",
		providerSessionState,
		streamFirstEventTimeoutMs: 1000,
		streamIdleTimeoutMs: 1000,
	};
	resources.push(async () => {
		for (const state of providerSessionState.values()) state.close();
		await server.stop(true);
		if (setup?.provider === "github-copilot") {
			const cacheKey = getCopilotIntegrationCacheKey("test-key", model.baseUrl);
			if (cacheKey) clearCopilotIntegrationCache(cacheKey);
		}
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
	for (const status of [400, 403]) {
		it(`negotiates a Copilot ${status} identity denial before generation and reuses the learned connection`, async () => {
			const cliId = COPILOT_CAPI_IDENTITY_HEADERS["Copilot-Integration-Id"];
			let allowed: string = cliId;
			const fixture = endpoint(undefined, {
				provider: "github-copilot",
				rejectUpgrade: request =>
					request.headers.get("Copilot-Integration-Id") === allowed
						? undefined
						: Response.json({ error: { code: "model_not_supported" } }, { status }),
			});
			const options = { ...fixture.options, preferWebsockets: true };
			const key = getCopilotIntegrationCacheKey("test-key", fixture.model.baseUrl);
			for (const turn of [1, 2]) {
				const result = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
				expect(result.stopReason).toBe("stop");
				expect(result.content).toMatchObject([{ type: "text", text: "WS" }]);
				expect(fixture.requests).toHaveLength(turn);
				expect(fixture.upgrades).toHaveLength(2);
			}
			expect(getCachedCopilotIntegrationId(key)).toBe(cliId);
			expect(fixture.upgrades.map(upgrade => upgrade.headers.get("Copilot-Integration-Id"))).toEqual([
				COPILOT_CHAT_INTEGRATION_ID,
				cliId,
			]);
			for (const state of fixture.providerSessionState.values()) state.releaseSession?.("main");
			allowed = COPILOT_CHAT_INTEGRATION_ID;
			const afterPolicyChange = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
			expect(afterPolicyChange.stopReason).toBe("stop");
			expect(fixture.requests).toHaveLength(3);
			expect(fixture.upgrades.map(upgrade => upgrade.headers.get("Copilot-Integration-Id"))).toEqual([
				COPILOT_CHAT_INTEGRATION_ID,
				cliId,
				cliId,
				COPILOT_CHAT_INTEGRATION_ID,
			]);
			expect(getCachedCopilotIntegrationId(key)).toBe(COPILOT_CHAT_INTEGRATION_ID);
			expect(fixture.httpRequests).toHaveLength(0);
		});
	}

	for (const scenario of [
		{ name: "pinned identity", status: 403, code: "model_not_supported", pinned: true },
		{ name: "unrelated 400", status: 400, code: "invalid_parameter", pinned: false },
		{ name: "authentication failure", status: 401, code: "unauthorized", pinned: false },
		{ name: "server failure", status: 503, code: "unavailable", pinned: false },
	]) {
		it(`does not retry a Copilot upgrade on ${scenario.name}`, async () => {
			const fixture = endpoint(undefined, {
				provider: "github-copilot",
				rejectUpgrade: () => Response.json({ error: { code: scenario.code } }, { status: scenario.status }),
			});
			const result = await streamOpenAIResponses(fixture.model, fixture.context, {
				...fixture.options,
				preferWebsockets: true,
				headers: scenario.pinned ? { "Copilot-Integration-Id": COPILOT_CHAT_INTEGRATION_ID } : undefined,
			}).result();
			expect(result.stopReason).toBe("error");
			expect(fixture.upgrades).toHaveLength(1);
			expect(fixture.requests).toHaveLength(0);
			expect(fixture.httpRequests).toHaveLength(0);
			expect(
				getCachedCopilotIntegrationId(getCopilotIntegrationCacheKey("test-key", fixture.model.baseUrl)),
			).toBeUndefined();
		});
	}

	it("stops after one rejected alternate Copilot upgrade and clears its stale cached identity", async () => {
		const fixture = endpoint(undefined, {
			provider: "github-copilot",
			rejectUpgrade: () => new Response("Denied", { status: 403 }),
		});
		const key = getCopilotIntegrationCacheKey("test-key", fixture.model.baseUrl);
		const cliId = COPILOT_CAPI_IDENTITY_HEADERS["Copilot-Integration-Id"];
		rememberCopilotWorkingIntegrationId(key, cliId);
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(fixture.upgrades.map(upgrade => upgrade.headers.get("Copilot-Integration-Id"))).toEqual([
			cliId,
			COPILOT_CHAT_INTEGRATION_ID,
		]);
		expect(fixture.requests).toHaveLength(0);
		expect(fixture.httpRequests).toHaveLength(0);
		expect(getCachedCopilotIntegrationId(key)).toBeUndefined();
	});

	it("cancels an incomplete Copilot upgrade body without trying another identity", async () => {
		const received = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<void>();
		const fixture = endpoint(undefined, {
			provider: "github-copilot",
			rejectUpgrade: () => {
				received.resolve();
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"error":'));
						},
						cancel() {
							cancelled.resolve();
						},
					}),
					{ status: 400 },
				);
			},
		});
		const controller = new AbortController();
		const result = streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
			signal: controller.signal,
		}).result();
		await received.promise;
		controller.abort();
		expect((await result).stopReason).toBe("aborted");
		await cancelled.promise;
		expect(fixture.upgrades).toHaveLength(1);
		expect(fixture.requests).toHaveLength(0);
		expect(fixture.httpRequests).toHaveLength(0);
	});

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

	it("omits SSE-only WS options while preserving HTTP and payload hooks", async () => {
		const fixture = endpoint(
			(socket, body) => {
				const metadata = body.metadata as { source?: string } | undefined;
				if (
					"stream" in body ||
					"stream_options" in body ||
					body.custom_gateway_field !== "same" ||
					metadata?.source !== "hook"
				) {
					socket.send(
						JSON.stringify({
							type: "error",
							error: { code: "invalid_parameter", message: "Invalid response.create fields" },
						}),
					);
					return;
				}
				send(socket, textEvents("WS accepted", "resp_valid_ws"));
			},
			{
				httpResponse: body => {
					const streamOptions = body.stream_options as { include_obfuscation?: boolean } | undefined;
					return body.stream === true && streamOptions?.include_obfuscation === false
						? undefined
						: Response.json({ error: { message: "Missing SSE obfuscation options" } }, { status: 400 });
				},
			},
		);
		const model: Model<"openai-responses"> = {
			...fixture.model,
			compat: { ...fixture.model.compat, supportsObfuscationOptOut: true },
		};
		const options: OpenAIResponsesOptions = {
			...fixture.options,
			extraBody: { custom_gateway_field: "same" },
			onPayload: payload => ({ ...(payload as object), metadata: { source: "hook" } }),
		};
		const http = await streamOpenAIResponses(model, fixture.context, options).result();
		expect(http.stopReason).toBe("stop");
		expect(http.content).toContainEqual(expect.objectContaining({ type: "text", text: "HTTP" }));
		const ws = await streamOpenAIResponses(model, fixture.context, { ...options, preferWebsockets: true }).result();
		expect(ws.stopReason).toBe("stop");
		expect(ws.content).toContainEqual(expect.objectContaining({ type: "text", text: "WS accepted" }));
		expect(fixture.httpRequests).toHaveLength(1);
		expect(fixture.requests).toHaveLength(1);
	});

	it("continues three SDK turns from the complete local transcript with store:false on one socket", async () => {
		const fixture = endpoint((socket, body, index) => {
			const input = body.input as Array<{ role?: string; content?: Array<{ text?: string }> }>;
			const expectedText = index === 1 ? "Hello" : `Turn ${index}`;
			if (
				body.store !== false ||
				body.previous_response_id !== (index === 1 ? undefined : `resp_${index - 1}`) ||
				input.length !== 1 ||
				input[0]?.role !== "user" ||
				input[0]?.content?.[0]?.text !== expectedText
			) {
				send(socket, [
					{ type: "error", error: { code: "invalid_request", message: "Invalid conversation continuation" } },
				]);
				return;
			}
			send(socket, textEvents(`Accepted ${expectedText}`, `resp_${index}`));
		});
		const options = { ...fixture.options, preferWebsockets: true, storeResponses: false };
		const context: Context = { messages: [...fixture.context.messages] };
		for (const turn of [1, 2, 3]) {
			if (turn > 1) context.messages.push({ role: "user", content: `Turn ${turn}`, timestamp: turn });
			const result = await streamSimple(fixture.model, context, options).result();
			expect(result.stopReason).toBe("stop");
			expect(result.content).toMatchObject([
				{ type: "text", text: `Accepted ${turn === 1 ? "Hello" : `Turn ${turn}`}` },
			]);
			context.messages.push(result);
		}
		expect(fixture.requests).toHaveLength(3);
		expect(fixture.requests.map(request => request.connection)).toEqual([1, 1, 1]);
		expect(fixture.requests.map(request => request.body.previous_response_id)).toEqual([
			undefined,
			"resp_1",
			"resp_2",
		]);
		expect(fixture.upgrades).toHaveLength(1);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("continues streamed function and custom tools using only each new result across three SDK turns", async () => {
		for (const kind of ["function", "custom"] as const) {
			const name = kind === "function" ? "lookup" : "apply_patch";
			const callType = kind === "function" ? "function_call" : "custom_tool_call";
			const fixture = endpoint((socket, body, index) => {
				const input = body.input as Array<{ type?: string; call_id?: string; output?: string; role?: string }>;
				const valid =
					index === 1
						? body.previous_response_id === undefined && input.length === 1 && input[0]?.role === "user"
						: body.previous_response_id === `resp_tool_${index - 1}` &&
							input.length === 1 &&
							input[0]?.type === `${callType}_output` &&
							input[0]?.call_id === `call_${index - 1}` &&
							input[0]?.output === `result ${index - 1}`;
				if (!valid) {
					send(socket, [
						{ type: "error", error: { code: "invalid_request", message: "Missing anchored tool result" } },
					]);
					return;
				}
				if (index === 3) {
					send(socket, textEvents("Both results accepted", "resp_done"));
					return;
				}
				const value = kind === "function" ? '{"query":"hello"}' : "*** Begin Patch\n*** End Patch\n";
				const field = kind === "function" ? "arguments" : "input";
				const item = {
					type: callType,
					id: `${kind === "function" ? "fc" : "ctc"}_${index}`,
					call_id: `call_${index}`,
					name,
					[field]: value,
					status: "completed",
				};
				send(socket, [
					{ type: "response.created", response: { id: `resp_tool_${index}` } },
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { ...item, [field]: "", status: "in_progress" },
					},
					{
						type:
							kind === "function"
								? "response.function_call_arguments.delta"
								: "response.custom_tool_call_input.delta",
						output_index: 0,
						item_id: item.id,
						delta: value,
					},
					{ type: "response.output_item.done", output_index: 0, item },
					{
						type: "response.completed",
						response: { id: `resp_tool_${index}`, status: "completed", output: [item] },
					},
				]);
			});
			const model = { ...fixture.model, ...(kind === "custom" ? { applyPatchToolType: "freeform" as const } : {}) };
			const context: Context = {
				...fixture.context,
				messages: [...fixture.context.messages],
				tools: [{ name, description: "Use the tool", parameters: schemaType({ query: "string" }) }],
			};
			const options = { ...fixture.options, preferWebsockets: true };
			for (const turn of [1, 2, 3]) {
				const result = await streamSimple(model, context, options).result();
				expect(result.stopReason).toBe(turn === 3 ? "stop" : "toolUse");
				context.messages.push(result);
				if (turn === 3) {
					expect(result.content).toMatchObject([{ type: "text", text: "Both results accepted" }]);
					continue;
				}
				const toolCall = result.content.find(block => block.type === "toolCall");
				if (toolCall?.type !== "toolCall") throw new Error("Expected streamed tool call");
				expect(toolCall.arguments).toEqual(
					kind === "function" ? { query: "hello" } : { input: "*** Begin Patch\n*** End Patch\n" },
				);
				context.messages.push({
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					content: [{ type: "text", text: `result ${turn}` }],
					isError: false,
					timestamp: turn + 1,
				});
			}
			expect(fixture.requests).toHaveLength(3);
			expect(fixture.requests.map(request => request.connection)).toEqual([1, 1, 1]);
			expect(fixture.upgrades).toHaveLength(1);
			expect(fixture.httpRequests).toHaveLength(0);
		}
	});

	it("replays complete history after history, tool, option, or post-hook payload changes", async () => {
		const fixture = endpoint((socket, body, index) => {
			if (
				body.previous_response_id !== undefined ||
				!Array.isArray(body.input) ||
				body.input.length !== index * 2 - 1
			) {
				send(socket, [
					{ type: "error", error: { code: "invalid_request", message: "Expected complete changed transcript" } },
				]);
				return;
			}
			send(socket, textEvents(`TURN ${index}`, `resp_${index}`));
		});
		let hookRevision = 0;
		const options: SimpleStreamOptions = {
			...fixture.options,
			preferWebsockets: true,
			onPayload: payload => ({ ...(payload as object), metadata: { revision: String(hookRevision) } }),
		};
		const context: Context = { messages: [...fixture.context.messages] };
		for (const turn of [1, 2, 3, 4, 5]) {
			if (turn > 1) context.messages.push({ role: "user", content: `Next ${turn}`, timestamp: turn });
			if (turn === 2) context.messages[0] = { role: "user", content: "Edited Hello", timestamp: 1 };
			if (turn === 3) context.tools = [{ name: "lookup", description: "Search", parameters: schemaType({}) }];
			// GPT-5 Mini drops sampling options in streamSimple; change an option
			// that actually survives SDK policy and reaches response.create.
			if (turn === 4) options.maxTokens = 1024;
			if (turn === 5) hookRevision++;
			const result = await streamSimple(fixture.model, context, options).result();
			expect(result.stopReason).toBe("stop");
			context.messages.push(result);
		}
		expect(fixture.requests[4]?.body.metadata).toEqual({ revision: "1" });
		expect(fixture.requests[3]?.body.max_output_tokens).toBe(1024);
		expect(fixture.requests[2]?.body.tools).toHaveLength(1);
		expect(JSON.stringify(fixture.requests[1]?.body.input)).toContain("Edited Hello");
		expect(fixture.requests).toHaveLength(5);
		expect(fixture.upgrades).toHaveLength(1);
	});

	it("lets statefulResponses:false opt out per request without forcing response storage", async () => {
		const fixture = endpoint();
		const options = { ...fixture.options, preferWebsockets: true, storeResponses: false };
		const context: Context = { messages: [...fixture.context.messages] };
		for (const turn of [1, 2, 3]) {
			if (turn > 1) context.messages.push({ role: "user", content: `Next ${turn}`, timestamp: turn });
			const result = await streamSimple(fixture.model, context, {
				...options,
				...(turn === 2 ? { statefulResponses: false } : {}),
			}).result();
			expect(result.stopReason).toBe("stop");
			context.messages.push(result);
		}
		expect(fixture.requests[1]?.body.previous_response_id).toBeUndefined();
		expect(fixture.requests[1]?.body.input).toHaveLength(3);
		expect(fixture.requests[2]?.body.previous_response_id).toBe("resp_2");
		expect(fixture.requests[2]?.body.input).toHaveLength(1);
		expect(fixture.requests.map(request => request.body.store)).toEqual([false, false, false]);
		expect(fixture.upgrades).toHaveLength(1);
	});

	it("clears the old anchor when a successful terminal response has no id", async () => {
		const fixture = endpoint((socket, body, index) => {
			const expectedAnchor = index === 2 ? "resp_1" : index === 4 ? "resp_3" : undefined;
			const expectedLength = index === 3 ? 5 : 1;
			if (
				body.previous_response_id !== expectedAnchor ||
				!Array.isArray(body.input) ||
				body.input.length !== expectedLength
			) {
				send(socket, [
					{
						type: "error",
						error: { code: "invalid_request", message: "Missing response id must break the anchor chain" },
					},
				]);
				return;
			}
			const events = textEvents(`TURN ${index}`, `resp_${index}`);
			if (index === 2) {
				// The locally constructed response keeps its created id, but not its terminal id.
				const completed = events[events.length - 1]?.response as Record<string, unknown>;
				delete completed.id;
			}
			send(socket, events);
		});
		const options = { ...fixture.options, preferWebsockets: true };
		const context: Context = { messages: [...fixture.context.messages] };
		for (const turn of [1, 2, 3, 4]) {
			if (turn > 1) context.messages.push({ role: "user", content: `Next ${turn}`, timestamp: turn });
			const result = await streamSimple(fixture.model, context, options).result();
			expect(result.stopReason).toBe("stop");
			expect(result.content).toMatchObject([{ type: "text", text: `TURN ${turn}` }]);
			context.messages.push(result);
		}
		expect(fixture.requests).toHaveLength(4);
		expect(fixture.upgrades).toHaveLength(1);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("retries explicit first-frame stale anchors once on the same socket with complete history", async () => {
		for (const rejection of [
			{ code: "previous_response_not_found", message: "Response expired", recover: true },
			{ code: "invalid_request_error", message: "Invalid previous_response_id", recover: true },
			{ code: "invalid_request_error", message: "previous_response_id unsupported", recover: false },
		]) {
			const fixture = endpoint((socket, body, index) => {
				const input = body.input as Array<{ role?: string; content?: Array<{ text?: string }> }>;
				if (index === 1) {
					send(socket, textEvents("FIRST", "resp_first"));
					return;
				}
				if (index === 2) {
					if (
						body.previous_response_id !== "resp_first" ||
						input.length !== 1 ||
						input[0]?.content?.[0]?.text !== "Next"
					) {
						send(socket, [
							{ type: "error", error: { code: "invalid_request", message: "Expected anchored new user" } },
						]);
						return;
					}
					send(socket, [{ type: "error", error: { code: rejection.code, message: rejection.message } }]);
					return;
				}
				if (index === 3) {
					if (
						body.previous_response_id !== undefined ||
						input.length !== 3 ||
						input[0]?.content?.[0]?.text !== "Hello" ||
						input[1]?.role !== "assistant" ||
						input[1]?.content?.[0]?.text !== "FIRST" ||
						input[2]?.content?.[0]?.text !== "Next"
					) {
						send(socket, [
							{ type: "error", error: { code: "invalid_request", message: "Expected complete stale recovery" } },
						]);
						return;
					}
					if (rejection.recover) send(socket, textEvents("RECOVERED", "resp_recovered"));
					else send(socket, [{ type: "error", error: { code: rejection.code, message: rejection.message } }]);
					return;
				}
				if (
					body.previous_response_id === "resp_recovered" &&
					input.length === 1 &&
					input[0]?.content?.[0]?.text === "Again"
				) {
					send(socket, textEvents("CONTINUED", "resp_continued"));
				} else {
					send(socket, [
						{ type: "error", error: { code: "invalid_request", message: "Invalid recovered baseline" } },
					]);
				}
			});
			const options = { ...fixture.options, preferWebsockets: true };
			const first = await streamSimple(fixture.model, fixture.context, options).result();
			expect(first.stopReason).toBe("stop");
			const context: Context = {
				messages: [...fixture.context.messages, first, { role: "user", content: "Next", timestamp: 2 }],
			};
			const second = await streamSimple(fixture.model, context, options).result();
			expect(second.stopReason).toBe(rejection.recover ? "stop" : "error");
			expect(fixture.requests).toHaveLength(3);
			expect(fixture.requests.map(request => request.connection)).toEqual([1, 1, 1]);
			if (rejection.recover) {
				expect(second.content).toMatchObject([{ type: "text", text: "RECOVERED" }]);
				context.messages.push(second, { role: "user", content: "Again", timestamp: 3 });
				const third = await streamSimple(fixture.model, context, options).result();
				expect(third.stopReason).toBe("stop");
				expect(third.content).toMatchObject([{ type: "text", text: "CONTINUED" }]);
				expect(fixture.requests).toHaveLength(4);
			} else {
				await fixture.waitForClosed(1);
			}
			expect(fixture.upgrades).toHaveLength(1);
			expect(fixture.httpRequests).toHaveLength(0);
		}
	});

	it("never replays unknown, generation, or post-progress anchor failures and retires their connection", async () => {
		for (const failure of ["unknown", "generation", "created", "output"] as const) {
			const fixture = endpoint((socket, body, index) => {
				if (index === 1) {
					send(socket, textEvents("FIRST", "resp_first"));
					return;
				}
				if (index > 2) {
					if (body.previous_response_id !== undefined || !Array.isArray(body.input) || body.input.length !== 3) {
						send(socket, [
							{
								type: "error",
								error: { code: "invalid_request", message: "Expected full history on replacement socket" },
							},
						]);
						return;
					}
					send(socket, textEvents("NEW CONNECTION", "resp_new"));
					return;
				}
				if (failure === "generation") {
					send(socket, [
						{
							type: "response.failed",
							response: {
								id: "resp_failed",
								status: "failed",
								error: { code: "server_error", message: "Generation failed" },
							},
						},
					]);
					return;
				}
				if (failure === "created") send(socket, [{ type: "response.created", response: { id: "resp_started" } }]);
				if (failure === "output") send(socket, textEvents("PARTIAL", "resp_partial").slice(0, 4));
				send(socket, [
					{
						type: "error",
						error:
							failure === "unknown"
								? { code: "invalid_request_error", message: "Unknown request failure" }
								: { code: "previous_response_not_found", message: "previous_response_id not found" },
					},
				]);
			});
			const options = { ...fixture.options, preferWebsockets: true };
			const first = await streamSimple(fixture.model, fixture.context, options).result();
			const context: Context = {
				messages: [...fixture.context.messages, first, { role: "user", content: "Next", timestamp: 2 }],
			};
			const stream = streamSimple(fixture.model, context, options);
			const deltas: string[] = [];
			for await (const event of stream) if (event.type === "text_delta") deltas.push(event.delta);
			const result = await stream.result();
			expect(result.stopReason).toBe("error");
			expect(deltas.join("")).toBe(failure === "output" ? "PARTIAL" : "");
			expect(fixture.requests).toHaveLength(2);
			expect(fixture.requests[1]?.body.previous_response_id).toBe("resp_first");
			await fixture.waitForClosed(1);
			expect((await streamSimple(fixture.model, context, options).result()).stopReason).toBe("stop");
			expect(fixture.requests).toHaveLength(3);
			expect(fixture.requests[2]?.connection).not.toBe(fixture.requests[0]?.connection);
			expect(fixture.upgrades).toHaveLength(2);
			expect(fixture.httpRequests).toHaveLength(0);
		}
	});

	it("reconnects a silent OPEN socket before submitting another generation", async () => {
		const actualNow = Date.now.bind(Date);
		let clockOffset = 0;
		const clock = spyOn(Date, "now").mockImplementation(() => actualNow() + clockOffset);
		const OriginalWebSocket = globalThis.WebSocket;
		resources.push(async () => {
			clock.mockRestore();
			globalThis.WebSocket = OriginalWebSocket;
		});
		let silent = false;
		let connections = 0;
		let firstSocket: WebSocket | undefined;
		globalThis.WebSocket = new Proxy(OriginalWebSocket, {
			construct(target, args) {
				const socket: WebSocket = Reflect.construct(target, args);
				const first = ++connections === 1;
				if (first) firstSocket = socket;
				socket.send = new Proxy(socket.send, {
					apply(target, receiver, args) {
						// Model Bun's half-open state: writes succeed without a close event
						// but never reach the peer after idle eviction.
						if (first && silent) return;
						return Reflect.apply(target, receiver, args);
					},
				});
				return socket;
			},
		});
		const fixture = endpoint();
		const options = { ...fixture.options, preferWebsockets: true };
		const first = await streamSimple(fixture.model, fixture.context, options).result();
		expect(first.stopReason).toBe("stop");
		clockOffset += 30_001;
		silent = true;
		expect(firstSocket?.readyState).toBe(OriginalWebSocket.OPEN);
		const result = await streamSimple(
			fixture.model,
			{
				messages: [...fixture.context.messages, first, { role: "user", content: "Next", timestamp: 2 }],
			},
			{
				...options,
				streamFirstEventTimeoutMs: 250,
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "WS" }));
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.requests).toHaveLength(2);
		expect(fixture.requests[1]?.body.previous_response_id).toBeUndefined();
		expect(fixture.requests[1]?.body.input).toHaveLength(3);
		expect(fixture.httpRequests).toHaveLength(0);
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

	it("rebuilds socket-owned computer history while preserving execution metadata and HTTP-native replay", async () => {
		const safetyChecks = [{ id: "must-ack", code: "confirm", message: "Confirm screenshot" }];
		const computerEvents = (id: string, callId: string) => {
			const item = {
				type: "computer_call",
				id,
				call_id: callId,
				status: "completed",
				actions: [{ type: "screenshot" }],
				pending_safety_checks: safetyChecks,
			};
			return [
				{ type: "response.created", response: { id: `resp_${id}` } },
				{ type: "response.output_item.added", output_index: 0, item },
				{ type: "response.output_item.done", output_index: 0, item },
				{
					type: "response.completed",
					response: {
						id: `resp_${id}`,
						status: "completed",
						output: [item],
						usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
					},
				},
			];
		};
		let httpTurns = 0;
		const foreignId = "cu_ws_owned";
		const denied = () =>
			Response.json({ error: { message: "input item does not belong to this connection" } }, { status: 401 });
		const fixture = endpoint(
			(socket, body, index) => {
				if (index > 1 && JSON.stringify(body.input).includes(foreignId)) {
					socket.send(
						JSON.stringify({
							type: "error",
							error: { code: "unauthorized", message: "input item does not belong to this connection" },
						}),
					);
				} else {
					send(
						socket,
						index === 1 ? computerEvents(foreignId, "call_ws") : textEvents("Continue", "resp_continue"),
					);
				}
			},
			{
				provider: "github-copilot",
				httpResponse: body => {
					if (JSON.stringify(body.input).includes(foreignId)) return denied();
					if (++httpTurns !== 1) return undefined;
					return new Response(
						computerEvents("cu_http_owned", "call_http")
							.map(event => `data: ${JSON.stringify(event)}\n\n`)
							.join(""),
						{
							headers: { "content-type": "text/event-stream" },
						},
					);
				},
			},
		);
		const model = { ...fixture.model, supportsComputerUse: true };
		let context: Context = {
			...fixture.context,
			tools: [
				{
					name: "computer",
					description: "Inspect the desktop",
					parameters: schemaType({}),
					native: { type: "computer" },
				},
			],
		};
		const options = {
			apiKey: fixture.options.apiKey,
			sessionId: fixture.options.sessionId,
			providerSessionState: fixture.providerSessionState,
			preferWebsockets: true,
		};
		const screenshot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ncVkAAAAASUVORK5CYII=";
		const appendComputerResult = (turn: AssistantMessage) => {
			expect(turn.stopReason).toBe("toolUse");
			const call = turn.content.find(block => block.type === "toolCall");
			if (call?.type !== "toolCall" || call.providerMetadata?.type !== "computer")
				throw new Error("Missing native computer call");
			// Keep actions and safety checks for executing the current call, not just its history.
			expect(call.providerMetadata.actions).toEqual([{ type: "screenshot" }]);
			expect(call.providerMetadata.pendingSafetyChecks).toEqual(safetyChecks);
			context = {
				...context,
				messages: JSON.parse(
					JSON.stringify([
						...context.messages,
						turn,
						{
							role: "toolResult",
							toolName: "computer",
							toolCallId: call.id,
							timestamp: 2,
							providerMetadata: {
								type: "computer",
								screenshot: { type: "computer_screenshot", image_url: `data:image/png;base64,${screenshot}` },
								acknowledgedSafetyChecks: safetyChecks,
							},
							content: [{ type: "image", mimeType: "image/png", data: screenshot }],
						},
					]),
				) as Context["messages"],
			};
		};
		appendComputerResult(await streamSimple(model, context, options).result());
		const reconnected = await streamSimple(model, context, { ...options, apiKey: "replacement-key" }).result();
		expect(reconnected.stopReason).toBe("stop");
		const rebuilt = JSON.stringify(fixture.requests[1]?.body.input);
		expect(rebuilt).not.toContain(foreignId);
		expect(rebuilt).toContain("screenshot");
		expect(rebuilt).toContain("data:image/png;base64,");
		context = { ...context, messages: [...context.messages, reconnected] };
		appendComputerResult(await streamSimple(model, context, { ...options, preferWebsockets: false }).result());
		const http = await streamSimple(model, context, { ...options, preferWebsockets: false }).result();
		expect(http.stopReason).toBe("stop");
		expect(JSON.stringify(fixture.httpRequests[1]?.input)).not.toContain(foreignId);
		expect(JSON.stringify(fixture.httpRequests[1]?.input)).toContain("cu_http_owned");
	});

	it("rebuilds connection-bound history across reconnects and repeated HTTP turns", async () => {
		const fixture = endpoint(
			(socket, body, index) => {
				if (index > 1 && JSON.stringify(body.input).includes("rs_resp_1")) {
					socket.send(
						JSON.stringify({
							type: "error",
							error: { code: "unauthorized", message: "401 input item does not belong to this connection" },
						}),
					);
					return;
				}
				const events = textEvents(`TURN ${index}`, `resp_${index}`);
				const reasoning = {
					type: "reasoning",
					id: `rs_resp_${index}`,
					summary: [],
					encrypted_content: `ws-owned-${index}`,
				};
				events.splice(
					events.length - 1,
					0,
					{ type: "response.output_item.added", output_index: 1, item: reasoning },
					{ type: "response.output_item.done", output_index: 1, item: reasoning },
				);
				// textEvents constructs a completed response with an output array.
				const completed = events[events.length - 1]?.response as { output: unknown[] };
				completed.output.push(reasoning);
				send(socket, events);
			},
			{
				provider: "github-copilot",
				httpResponse: body => {
					if (/rs_resp_|ws-owned-/.test(JSON.stringify(body.input))) {
						return Response.json(
							{ error: { message: "401 input item does not belong to this connection" } },
							{ status: 401 },
						);
					}
					const events = textEvents("HTTP", "resp_http");
					const reasoning = { type: "reasoning", id: "rs_http", summary: [], encrypted_content: "http-owned" };
					events.splice(
						events.length - 1,
						0,
						{ type: "response.output_item.added", output_index: 1, item: reasoning },
						{ type: "response.output_item.done", output_index: 1, item: reasoning },
					);
					// textEvents constructs a completed response with an output array.
					const completed = events[events.length - 1]?.response as { output: unknown[] };
					completed.output.push(reasoning);
					return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
						headers: { "content-type": "text/event-stream" },
					});
				},
			},
		);
		const model = fixture.model;
		const options = {
			apiKey: fixture.options.apiKey,
			sessionId: fixture.options.sessionId,
			providerSessionState: fixture.providerSessionState,
			preferWebsockets: true,
		};
		const first = await streamSimple(model, fixture.context, options).result();
		expect(first.stopReason).toBe("stop");
		const context: Context = {
			messages: [...fixture.context.messages, first, { role: "user", content: "Continue", timestamp: 2 }],
		};
		const warm = await streamSimple(model, context, options).result();
		expect(warm.stopReason).toBe("stop");
		// SDK-safe history omits socket-owned reasoning; continuation must not
		// secretly reconstruct it just to make the response prefix match.
		expect(fixture.requests[1]?.connection).toBe(fixture.requests[0]?.connection);
		expect(fixture.requests[1]?.body.previous_response_id).toBeUndefined();
		expect(fixture.requests[1]?.body.input).toHaveLength(3);
		expect(JSON.stringify(fixture.requests[1]?.body.input)).not.toContain("rs_resp_");
		expect(JSON.stringify(fixture.requests[1]?.body.input)).not.toContain("ws-owned-");
		context.messages.push(warm, { role: "user", content: "Reconnect", timestamp: 3 });
		const second = await streamSimple(model, context, { ...options, apiKey: "replacement-key" }).result();
		expect(second.stopReason).toBe("stop");
		expect(second.content).toContainEqual(expect.objectContaining({ type: "text", text: "TURN 3" }));
		expect(fixture.requests[2]?.body.previous_response_id).toBeUndefined();
		expect(JSON.stringify(fixture.requests[2]?.body.input)).not.toContain("rs_resp_");
		expect(JSON.stringify(fixture.requests[2]?.body.input)).toContain("TURN 1");
		expect(JSON.stringify(fixture.requests[2]?.body.input)).toContain("TURN 2");
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.httpRequests).toHaveLength(0);
		expect(openAIResponsesReplaysNativeHistory(model, fixture.providerSessionState, true)).toBe(false);
		expect(openAIResponsesReplaysNativeHistory(model, fixture.providerSessionState, false)).toBe(false);
		const httpContext: Context = {
			messages: [...context.messages, second, { role: "user", content: "Use HTTP", timestamp: 3 }],
		};
		const http = await streamSimple(model, httpContext, { ...options, preferWebsockets: false }).result();
		expect(http.stopReason).toBe("stop");
		expect(http.content).toContainEqual(expect.objectContaining({ type: "text", text: "HTTP" }));
		expect(JSON.stringify(fixture.httpRequests[0]?.input)).not.toContain("rs_resp_");
		expect(openAIResponsesReplaysNativeHistory(model, fixture.providerSessionState, false)).toBe(true);
		// Resume persisted history too: safety cannot depend on in-memory provenance.
		const resumed = JSON.parse(
			JSON.stringify({
				messages: [...httpContext.messages, http, { role: "user", content: "Continue HTTP", timestamp: 4 }],
			}),
		) as Context;
		const again = await streamSimple(model, resumed, { ...options, preferWebsockets: false }).result();
		expect(again.stopReason).toBe("stop");
		const replay = JSON.stringify(fixture.httpRequests[1]?.input);
		expect(replay).not.toContain("rs_resp_");
		expect(replay).not.toContain("ws-owned-");
		expect(replay).toContain("TURN 1");
		expect(replay).toContain("TURN 2");
		expect(replay).toContain("TURN 3");
		expect(replay).toContain("http-owned");
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
		expect(result.errorMessage).toContain("previous_response_id");
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

	it("isolates a concurrent temporary socket from the busy session's continuation anchor", async () => {
		const firstSeen = Promise.withResolvers<void>();
		let firstSocket: ServerWebSocket<{ id: number }> | undefined;
		const fixture = endpoint((socket, body, index) => {
			if (index === 1) {
				send(socket, textEvents("SEED", "resp_seed"));
				return;
			}
			if (index === 2) {
				firstSocket = socket;
				firstSeen.resolve();
			}
			const expectedAnchor = index === 2 ? "resp_seed" : index === 3 ? undefined : "resp_first";
			if (
				body.previous_response_id !== expectedAnchor ||
				!Array.isArray(body.input) ||
				body.input.length !== (index === 3 ? 3 : 1)
			) {
				send(socket, [
					{ type: "error", error: { code: "invalid_request", message: "Cross-connection continuation" } },
				]);
				return;
			}
			if (index !== 2) send(socket, textEvents(index === 3 ? "SECOND" : "AFTER", `resp_${index}`));
		});
		const options = { ...fixture.options, preferWebsockets: true };
		const seed = await streamSimple(fixture.model, fixture.context, options).result();
		expect(seed.stopReason).toBe("stop");
		const context: Context = {
			messages: [...fixture.context.messages, seed, { role: "user", content: "Primary", timestamp: 2 }],
		};
		const first = streamSimple(fixture.model, context, options).result();
		await firstSeen.promise;
		const second = await streamSimple(fixture.model, context, options).result();
		expect(second.content).toMatchObject([{ type: "text", text: "SECOND" }]);
		if (!firstSocket) throw new Error("Expected first socket");
		send(firstSocket, textEvents("FIRST", "resp_first"));
		const primary = await first;
		expect(primary.content).toMatchObject([{ type: "text", text: "FIRST" }]);
		const after = await streamSimple(
			fixture.model,
			{
				messages: [...context.messages, primary, { role: "user", content: "After", timestamp: 3 }],
			},
			options,
		).result();
		expect(after.content).toMatchObject([{ type: "text", text: "AFTER" }]);
		expect(fixture.requests.map(request => request.connection)).toEqual([1, 1, 2, 1]);
		expect(fixture.upgrades).toHaveLength(2);
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
		const first = await streamSimple(fixture.model, fixture.context, options).result();
		const context: Context = {
			messages: [...fixture.context.messages, first, { role: "user", content: "Next", timestamp: 2 }],
		};
		const second = await streamSimple(fixture.model, context, { ...options, apiKey: "replacement-key" }).result();
		expect(second.stopReason).toBe("stop");
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.upgrades[1]?.headers.get("authorization")).toBe("Bearer replacement-key");
		expect(fixture.requests[1]?.body.previous_response_id).toBeUndefined();
		expect(fixture.requests[1]?.body.input).toHaveLength(3);
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
