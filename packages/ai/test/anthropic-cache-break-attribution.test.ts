/**
 * The Anthropic provider must report WHY a request rewrote the cached prompt
 * prefix, so a cold turn can say what caused it instead of leaving the user to
 * guess. The reason rides on the returned `AssistantMessage`, which is the
 * observable contract these tests defend.
 *
 * The trap guarded here: omp deliberately expresses tool additions and removals
 * as `tool_addition` / `tool_removal` control transitions precisely so they do
 * NOT break the prefix. Reporting them as a cause would blame the wrong thing.
 *
 * No network: a capturing `fetch` returns a minimal successful SSE stream.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { type AnthropicOptions, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type {
	AssistantMessage,
	CacheRetention,
	Context,
	FetchImpl,
	Message,
	Model,
	ProviderSessionState,
	Tool,
} from "@oh-my-pi/pi-ai/types";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "./helpers";

// Opus 4.8 on the direct Anthropic endpoint is the deployment that carries
// mid-conversation tool changes, so tool add/remove really becomes a control
// transition rather than a re-baseline.
const MODEL: Model<"anthropic-messages"> = buildModel({
	id: "claude-opus-4-8",
	name: "Claude Opus 4.8",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

// Sonnet 3.7 carries no mid-conversation tool changes, so there is no
// stable-tools plane and any difference in the array rewrites the prefix.
const NO_TOOL_PLANE_MODEL: Model<"anthropic-messages"> = buildModel({
	id: "claude-3-7-sonnet-20250219",
	name: "Claude Sonnet 3.7",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

// Deployments that escape builtin tool names (Umans-hosted models, and every
// OAuth request) put tool names on the wire behind the `_` transport prefix,
// so the byte-stability plane sees `_bash` where the user configured `bash`.
const ESCAPED_TOOL_NAMES_MODEL: Model<"anthropic-messages"> = buildModel({
	id: "claude-opus-4-8",
	name: "Claude Opus 4.8",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	contextWindow: 200_000,
	maxTokens: 8_192,
	compat: { escapeBuiltinToolNames: true },
});

const SESSION_ID = "cache-break-attribution-session";

function tool(name: string, properties: Record<string, unknown>): Tool {
	return {
		name,
		description: `${name} tool`,
		parameters: { type: "object", properties, additionalProperties: false },
	};
}

function contextWithTools(tools: Tool[], systemPrompt = "You are a precise assistant."): Context {
	return {
		systemPrompt: [systemPrompt],
		messages: [{ role: "user", content: "Use the tools", timestamp: 1 }],
		tools,
	};
}

/**
 * Tool whose description carries a lone UTF-16 high surrogate, the way one
 * arrives from an extension or an MCP server. The provider rewrites it to
 * U+FFFD before the request leaves, so the bytes the cached prefix holds are
 * not the bytes `buildParams` assembled.
 */
const loneSurrogateTool: Tool = { ...tool("lookup", {}), description: "lookup tool \ud800" };

function assistantTurn(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: MODEL.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

/**
 * A conversation of `exchanges` completed assistant/user pairs after the
 * opening user turn, with every earlier message byte-identical across calls
 * and a real user turn last, so no `Continue.` pad is on the wire. An append
 * is therefore the only difference between `appendingHistory(n)` and
 * `appendingHistory(n + 1)`, which is what makes the prefix a turn inherited
 * — and a bound on it — observable at all.
 */
function appendingHistory(exchanges: number, tools: Tool[]): Context {
	const messages: Message[] = [{ role: "user", content: "Use the tools", timestamp: 1 }];
	for (let index = 0; index < exchanges; index++) {
		messages.push(assistantTurn([{ type: "text", text: `reply ${index}` }], index * 2 + 2));
		messages.push({ role: "user", content: `follow-up ${index}`, timestamp: index * 2 + 3 });
	}
	return { ...contextWithTools(tools), messages };
}

/**
 * Payload hook that returns a replacement body whose `messages[0]` is a
 * different message and whose system blocks, tool array, retention and later
 * messages are the ones `buildParams` assembled. A rewritten conversation root
 * is therefore the only difference between the assembled payload and the sent
 * one, and the assembled payload keeps its own root — an in-place mutation
 * would edit the object both sides hold and could not tell them apart.
 */
const rewriteWireRoot: NonNullable<AnthropicOptions["onPayload"]> = payload => {
	const assembled = payload as Record<string, unknown> & { messages: ReadonlyArray<unknown> };
	return {
		...assembled,
		messages: [
			{ role: "user", content: [{ type: "text", text: "Rewritten root." }] },
			...assembled.messages.slice(1),
		],
	};
};

/**
 * Payload hook that returns a replacement body whose `tools` array is the
 * assembled one with a rewritten description on its first entry. The array
 * stays present and keeps its length, so the declared tool bytes are the only
 * difference between the array the stable-tools plane produced and the one the
 * request actually sends.
 */
const rewriteWireTools: NonNullable<AnthropicOptions["onPayload"]> = payload => {
	const assembled = payload as Record<string, unknown> & { tools: ReadonlyArray<Record<string, unknown>> };
	return {
		...assembled,
		tools: assembled.tools.map((entry, index) =>
			index === 0 ? { ...entry, description: "rewritten after assembly" } : entry,
		),
	};
};

/**
 * `message_start` is the acceptance boundary: it carries this request's own
 * cache-creation usage, so Anthropic has processed the prompt and written its
 * cache entry before a single content block exists.
 */
const MESSAGE_START_FRAME = {
	type: "message_start",
	message: {
		id: "msg_cache_break",
		usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 4 },
	},
};

function sseBody(events: ReadonlyArray<{ type: string; [key: string]: unknown }>): string {
	return `${events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
}

function sseResponse(body: string | ReadableStream<Uint8Array>): Response {
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream", "request-id": "req_cache_break" },
	});
}

const successFetch: FetchImpl = async () =>
	sseResponse(
		sseBody([
			MESSAGE_START_FRAME,
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		]),
	);

/** {@link successFetch} that also records the request body the SDK serialized. */
function capturingFetch(sink: { body: string }): FetchImpl {
	return async (input, init) => {
		sink.body = requestBodyText(init) ?? "";
		return await successFetch(input, init);
	};
}

/** Rejects before any response body exists, the way a malformed request does. */
const rejectedFetch: FetchImpl = async () =>
	new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "rejected" } }), {
		status: 400,
		headers: { "Content-Type": "application/json" },
	});

/**
 * Accepts the request and then dies with no content at all: `message_start`,
 * then a terminal `error` frame. The provider only stamps `firstTokenTime` on
 * the first content block, so this is exactly the window where "nothing came
 * back yet" and "the prefix is not cached yet" disagree.
 */
const acceptedThenStreamErrorFetch: FetchImpl = async () =>
	sseResponse(
		sseBody([
			MESSAGE_START_FRAME,
			{ type: "error", error: { type: "invalid_request_error", message: "generation abandoned mid-envelope" } },
		]),
	);

/**
 * Accepts the request, streams a text block, and then the body ends with no
 * terminal envelope, the way a connection dropped mid-generation looks. Text
 * already streamed, so no arm replays the turn.
 */
const acceptedThenTruncatedFetch: FetchImpl = async () =>
	sseResponse(
		sseBody([
			MESSAGE_START_FRAME,
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		]),
	);

/**
 * Streams `message_start`, then aborts the caller's signal without ever
 * closing the body — a user cancelling a turn that had already started
 * streaming. The ordering is structural rather than timed: a stream's `pull`
 * runs while the read that drains the previous chunk is still settling, so the
 * abort is armed one frame late on purpose. `message_start` therefore reaches
 * the provider before the signal trips, and the keepalive behind it is the
 * frame the abort actually cancels.
 */
function abortAfterAcceptanceFetch(abort: AbortController): FetchImpl {
	return async () => {
		const chunks = [sseBody([MESSAGE_START_FRAME]), sseBody([{ type: "ping" }])];
		let pulls = 0;
		return sseResponse(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					const chunk = chunks[pulls];
					pulls += 1;
					if (chunk !== undefined) {
						controller.enqueue(new TextEncoder().encode(chunk));
						return;
					}
					abort.abort();
					// Never resolves: the abort, not the body, is what ends this turn.
					return Promise.withResolvers<void>().promise;
				},
			}),
		);
	};
}

/**
 * Rejects the first request of a turn with the compiled-grammar 400 Anthropic
 * returns when a strict tool schema is too large, then succeeds. Records every
 * serialized body, so a test can prove the retry really did strip `strict`
 * instead of passing on an unchanged payload.
 */
function grammarRejectedOnceFetch(sink: { bodies: string[] }): FetchImpl {
	return async (input, init) => {
		sink.bodies.push(requestBodyText(init) ?? "");
		if (sink.bodies.length === 1) {
			return new Response(
				JSON.stringify({
					type: "error",
					error: { type: "invalid_request_error", message: "compiled grammar is too large" },
				}),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}
		return await successFetch(input, init);
	};
}

/**
 * Rejects the first request of a turn with the 400 Anthropic returns when the
 * model or account does not carry fast mode, then succeeds. The retry rebuilds
 * the same turn without `speed`, and `speed` is not part of the cached prefix,
 * so the rebuild changes nothing the attribution pass looks at — which makes it
 * the clean way to ask what a rebuild reports about its own payload.
 */
function fastModeRejectedOnceFetch(sink: { bodies: string[] }): FetchImpl {
	return async (input, init) => {
		sink.bodies.push(requestBodyText(init) ?? "");
		if (sink.bodies.length === 1) {
			return new Response(
				JSON.stringify({
					type: "error",
					error: { type: "invalid_request_error", message: "This model does not support the speed parameter" },
				}),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}
		return await successFetch(input, init);
	};
}

/** Fast mode is what the in-provider degradation retry below strips. */
const PRIORITY: Pick<AnthropicOptions, "serviceTier"> = { serviceTier: "priority" };

/**
 * Payload hook that replaces the system prompt on the first attempt of a turn
 * and leaves every later rebuild alone, the way a hook keyed on some external
 * state does. The rejected attempt therefore sends a prompt the accepted one
 * does not.
 */
function systemPromptOnFirstAttempt(text: string): NonNullable<AnthropicOptions["onPayload"]> {
	let attempt = 0;
	return payload => {
		attempt += 1;
		if (attempt > 1) return undefined;
		return { ...(payload as Record<string, unknown>), system: [{ type: "text", text }] };
	};
}

const stateMaps: Array<Map<string, ProviderSessionState>> = [];

function createProviderSessionState(): Map<string, ProviderSessionState> {
	const states = new Map<string, ProviderSessionState>();
	stateMaps.push(states);
	return states;
}

async function turn(
	providerSessionState: Map<string, ProviderSessionState>,
	context: Context,
	cacheRetention?: CacheRetention,
	model: Model<"anthropic-messages"> = MODEL,
	fetch: FetchImpl = successFetch,
	options: Pick<
		AnthropicOptions,
		| "onPayload"
		| "onResponse"
		| "maxTokens"
		| "sessionId"
		| "promptCacheKey"
		| "serviceTier"
		| "effort"
		| "thinkingEnabled"
		| "signal"
		| "cacheBreakDiagnostics"
		| "anthropicCompaction"
	> = {},
): Promise<AssistantMessage> {
	return await streamAnthropic(model, context, {
		apiKey: "sk-ant-api-test",
		fetch,
		providerSessionState,
		cacheBreakDiagnostics: true,
		sessionId: SESSION_ID,
		...(cacheRetention ? { cacheRetention } : {}),
		...options,
	}).result();
}

/**
 * Drives a session up to and including the turn that learns the strict-tools
 * drop, and returns that turn.
 *
 * A strict-eligible tool is declared at baseline and then leaves the active
 * set, so the plane withdraws it with a `tool_removal` control and keeps
 * declaring it — `strict` and all. The third turn's first attempt is rejected
 * for the compiled grammar that declaration still produces, and the retry
 * strips `strict` from the whole declared array. The withdrawn tool is not in
 * the current array, so the plane's definition-key re-baseline never compares
 * it and names nothing: only the prefix fingerprints can speak for the rewrite.
 */
async function learnStrictToolsDropMidTurn(
	states: Map<string, ProviderSessionState>,
	sink: { bodies: string[] },
): Promise<{ message: AssistantMessage; context: Context }> {
	// `python` is on the strict allowlist, so its declaration really carries `strict`.
	const strictEligible = tool("python", { code: { type: "string" } });
	const plain = tool("lookup", {});
	const base = contextWithTools([strictEligible, plain]);
	const first = await turn(states, base);
	const withdrawn: Context = {
		...contextWithTools([plain]),
		inactiveTools: [strictEligible],
		messages: [...base.messages, first],
	};
	await turn(states, withdrawn);
	const message = await turn(states, withdrawn, undefined, MODEL, grammarRejectedOnceFetch(sink));
	return { message, context: withdrawn };
}

afterEach(() => {
	for (const states of stateMaps.splice(0)) {
		for (const state of states.values()) state.close();
		states.clear();
	}
});

withOfficialAnthropicEndpoint();

describe("anthropic cache-break attribution", () => {
	it("names the tool whose definition changed for an already-declared tool", async () => {
		const states = createProviderSessionState();
		await turn(states, contextWithTools([tool("lookup", {})]));
		const second = await turn(states, contextWithTools([tool("lookup", { key: { type: "string" } })]));

		expect(second.cacheBreakReason).toEqual({ kind: "tools", tool: "lookup" });
	});

	it.each([
		["short", "long"],
		["long", "short"],
	] as const)("does not blame a TTL-only change from %s to %s", async (from, to) => {
		const states = createProviderSessionState();
		const context = contextWithTools([tool("lookup", {})]);
		await turn(states, context, from);
		const sent = { body: "" };
		const second = await turn(states, context, to, MODEL, capturingFetch(sent));

		expect(sent.body).toContain('"cache_control"');
		expect(sent.body.includes('"ttl":"1h"')).toBe(to === "long");
		expect(second.cacheBreakReason).toBeUndefined();
	});

	it.each([false, true])("prioritizes tool changes (system also changes: %s)", async changeSystem => {
		const states = createProviderSessionState();
		const base = contextWithTools([tool("lookup", {})]);
		await turn(states, base, undefined, NO_TOOL_PLANE_MODEL);
		const second = await turn(
			states,
			{
				...base,
				tools: [...(base.tools ?? []), tool("search", {})],
				systemPrompt: changeSystem ? ["Different instructions"] : base.systemPrompt,
				messages: [{ role: "user", content: "Edited opening message", timestamp: 1 }],
			},
			undefined,
			NO_TOOL_PLANE_MODEL,
		);

		expect(second.stopReason).toBe("stop");
		expect(second.cacheBreakReason).toEqual({ kind: "tools" });
	});

	it("excludes the cache-neutral billing header from the system fingerprint and character delta", async () => {
		const states = createProviderSessionState();
		const base = contextWithTools([]);
		const header = "x-anthropic-billing-header: cc_version=1.0.0; cch=00000;";
		const changedHeader = "x-anthropic-billing-header: cc_version=12.0.0; cch=11111;";
		await turn(states, { ...base, systemPrompt: [header, "Stable instructions"] });
		const second = await turn(states, { ...base, systemPrompt: [changedHeader, "Stable instructions"] });
		const third = await turn(states, { ...base, systemPrompt: [header, "Stable instructions plus"] });

		expect(second.cacheBreakReason).toBeUndefined();
		expect(third.cacheBreakReason).toEqual({ kind: "system_prompt", charDelta: 5 });
	});

	it.each(["oneshot", "native-compaction"] as const)(
		"keeps same-session %s requests outside the main conversation baseline",
		async kind => {
			const states = createProviderSessionState();
			const model = buildModel({ ...MODEL, id: "claude-fable-5", name: "Claude Fable 5" });
			const base = appendingHistory(1, []);
			await turn(states, base, undefined, model);
			const side = await turn(
				states,
				{ systemPrompt: ["Summarize the conversation"], messages: [base.messages[0]] },
				undefined,
				model,
				successFetch,
				kind === "oneshot" ? { cacheBreakDiagnostics: false } : { anthropicCompaction: {} },
			);
			const next = await turn(states, appendingHistory(2, []), undefined, model);
			const changed = await turn(
				states,
				{ ...appendingHistory(3, []), systemPrompt: ["Changed main instructions"] },
				undefined,
				model,
			);

			expect(side.stopReason).toBe("stop");
			expect(next.stopReason).toBe("stop");
			expect(next.cacheBreakReason).toBeUndefined();
			expect(side.cacheBreakReason).toBeUndefined();
			expect(changed.cacheBreakReason?.kind).toBe("system_prompt");
		},
	);

	it("blames nothing on the first request of a conversation", async () => {
		const states = createProviderSessionState();
		const first = await turn(states, contextWithTools([tool("lookup", {})]));

		expect(first.cacheBreakReason).toBeUndefined();
	});

	it("does not blame a tool added or removed between requests", async () => {
		const states = createProviderSessionState();
		const base = contextWithTools([tool("lookup", {}), tool("compute", {})]);
		const first = await turn(states, base);
		const second = await turn(states, {
			...contextWithTools([tool("lookup", {}), tool("search", {})]),
			inactiveTools: [tool("compute", {})],
			messages: [...base.messages, first],
		});

		expect(second.cacheBreakReason).toBeUndefined();
	});

	it("blames the tool array on the turn that learns the strict-tools drop", async () => {
		const states = createProviderSessionState();
		const sink = { bodies: [] as string[] };
		const { message: learned } = await learnStrictToolsDropMidTurn(states, sink);

		// Without the retry really stripping `strict` off the declared array there
		// would be no prefix rewrite left to report, and this would pass on an
		// unchanged payload.
		expect(sink.bodies[0]).toContain('"strict":true');
		expect(sink.bodies[1]).not.toContain('"strict":true');
		expect(learned.cacheBreakReason).toEqual({ kind: "tools" });
	});

	it("does not blame a tool added after the strict-tools drop was learned", async () => {
		const states = createProviderSessionState();
		const { context } = await learnStrictToolsDropMidTurn(states, { bodies: [] });
		// The array stays stripped from every later turn, so treating the strip
		// as "not what the plane planned" would blame this turn — and every turn
		// after it — instead of the one that actually changed. `search` joins on
		// a `tool_addition` control here exactly as it does where the drop was
		// never learned, and the declared array grows a `defer_loading` entry, so
		// only the exemption can keep this silent. The conversation moves on
		// first, so the new control lands at its own history slot rather than
		// growing the one the earlier withdrawal already wrote.
		const added = await turn(states, {
			...context,
			tools: [tool("lookup", {}), tool("search", {})],
			messages: [...context.messages, { role: "user", content: "now search", timestamp: 3 }],
		});

		expect(added.cacheBreakReason).toBeUndefined();
	});

	it("blames the tool array on a deployment without mid-conversation tool changes", async () => {
		const states = createProviderSessionState();
		await turn(states, contextWithTools([tool("lookup", {})]), undefined, NO_TOOL_PLANE_MODEL);
		// No stable-tools plane here, so an added tool really does rewrite the
		// declared prefix — but no single tool can be blamed for it.
		const second = await turn(
			states,
			contextWithTools([tool("lookup", {}), tool("search", {})]),
			undefined,
			NO_TOOL_PLANE_MODEL,
		);

		expect(second.cacheBreakReason).toEqual({ kind: "tools" });
	});

	it("blames the tool array when only a description changed and there is no tool plane", async () => {
		const states = createProviderSessionState();
		await turn(states, contextWithTools([tool("lookup", {})]), undefined, NO_TOOL_PLANE_MODEL);
		// The plane's comparison key ignores descriptions because a control cannot
		// express one; without a plane the description is prefix like any other byte.
		const second = await turn(
			states,
			contextWithTools([{ ...tool("lookup", {}), description: "lookup tool, now with caveats" }]),
			undefined,
			NO_TOOL_PLANE_MODEL,
		);

		expect(second.cacheBreakReason).toEqual({ kind: "tools" });
	});

	it("does not report a retention switch when caching was merely switched on", async () => {
		const states = createProviderSessionState();
		const context = contextWithTools([tool("lookup", {})]);
		await turn(states, context, "none");
		const second = await turn(states, context, "long");

		expect(second.cacheBreakReason).toBeUndefined();
	});

	it("keeps the cause for a retry of a turn that was rejected before any response", async () => {
		const states = createProviderSessionState();
		const grown = contextWithTools([tool("lookup", {}), tool("search", {})]);
		await turn(states, contextWithTools([tool("lookup", {})]), undefined, NO_TOOL_PLANE_MODEL);
		const rejected = await turn(states, grown, undefined, NO_TOOL_PLANE_MODEL, rejectedFetch);
		// The rejected attempt never reached Anthropic, so its prefix was never
		// written and the retry is the turn that really pays for the change.
		const retried = await turn(states, grown, undefined, NO_TOOL_PLANE_MODEL);

		expect(rejected.stopReason).toBe("error");
		expect(retried.cacheBreakReason).toEqual({ kind: "tools" });
	});

	it.each(["system", "tool"] as const)("retains a %s cause across a rejected outer retry", async kind => {
		const states = createProviderSessionState();
		const base = contextWithTools([tool("lookup", {})]);
		await turn(states, base);
		const changed =
			kind === "system"
				? { ...base, systemPrompt: ["Changed instructions"] }
				: contextWithTools([tool("lookup", { key: { type: "string" } })]);
		const rejected = await turn(states, changed, undefined, MODEL, rejectedFetch);
		const retried = await turn(states, changed);

		expect(rejected.stopReason).toBe("error");
		expect(retried.stopReason).toBe("stop");
		expect(retried.cacheBreakReason).toEqual(
			kind === "system"
				? {
						kind: "system_prompt",
						charDelta: "Changed instructions".length - "You are a precise assistant.".length,
					}
				: { kind: "tools", tool: "lookup" },
		);
	});

	it("advances the snapshot for a stream that failed after it was accepted", async () => {
		const states = createProviderSessionState();
		const grown = contextWithTools([tool("lookup", {}), tool("search", {})]);
		await turn(states, contextWithTools([tool("lookup", {})]), undefined, NO_TOOL_PLANE_MODEL);
		const failed = await turn(states, grown, undefined, NO_TOOL_PLANE_MODEL, acceptedThenTruncatedFetch);
		// Anthropic accepted this prefix and wrote its cache entry before the
		// stream died, so the change belongs to the failed turn and the next one
		// changed nothing.
		const next = await turn(states, grown, undefined, NO_TOOL_PLANE_MODEL);

		expect(failed.stopReason).toBe("error");
		expect(failed.cacheBreakReason).toEqual({ kind: "tools" });
		expect(next.cacheBreakReason).toBeUndefined();
	});

	it("advances the snapshot for a stream accepted with no content at all", async () => {
		const states = createProviderSessionState();
		const grown = contextWithTools([tool("lookup", {}), tool("search", {})]);
		await turn(states, contextWithTools([tool("lookup", {})]), undefined, NO_TOOL_PLANE_MODEL);
		const failed = await turn(states, grown, undefined, NO_TOOL_PLANE_MODEL, acceptedThenStreamErrorFetch);
		// No content block ever opened, so the provider's "nothing came back"
		// signal is still unset here — the prefix is cached all the same.
		const next = await turn(states, grown, undefined, NO_TOOL_PLANE_MODEL);

		expect(failed.stopReason).toBe("error");
		expect(next.cacheBreakReason).toBeUndefined();
	});

	it("advances the snapshot for a turn aborted after it was accepted", async () => {
		const states = createProviderSessionState();
		const abort = new AbortController();
		const grown = contextWithTools([tool("lookup", {}), tool("search", {})]);
		await turn(states, contextWithTools([tool("lookup", {})]), undefined, NO_TOOL_PLANE_MODEL);
		const aborted = await turn(states, grown, undefined, NO_TOOL_PLANE_MODEL, abortAfterAcceptanceFetch(abort), {
			signal: abort.signal,
		});
		// A cancelled turn still paid for its prefix; the cache does not roll back
		// because the user changed their mind.
		const next = await turn(states, grown, undefined, NO_TOOL_PLANE_MODEL);

		expect(aborted.stopReason).toBe("aborted");
		expect(next.cacheBreakReason).toBeUndefined();
	});

	it("reports a system-prompt edit with the signed character delta", async () => {
		const states = createProviderSessionState();
		const before = "You are a precise assistant.";
		const after = "You are a precise assistant. Prefer short answers.";
		await turn(states, contextWithTools([tool("lookup", {})], before));
		const second = await turn(states, contextWithTools([tool("lookup", {})], after));

		expect(second.cacheBreakReason).toEqual({
			kind: "system_prompt",
			charDelta: after.length - before.length,
		});
	});

	it("counts an astral character as one system-prompt character", async () => {
		const states = createProviderSessionState();
		await turn(states, contextWithTools([], "Instructions"));
		const added = await turn(states, contextWithTools([], "Instructions\u{1f680}"));
		const removed = await turn(states, contextWithTools([], "Instructions"));

		expect(added.cacheBreakReason).toEqual({ kind: "system_prompt", charDelta: 1 });
		expect(removed.cacheBreakReason).toEqual({ kind: "system_prompt", charDelta: -1 });
	});

	it("does not blame a main turn for an isolated side request", async () => {
		const states = createProviderSessionState();
		const main = contextWithTools([tool("lookup", {})]);
		await turn(states, main);
		await turn(
			states,
			contextWithTools([tool("lookup", {})], "Summarize the conversation below."),
			undefined,
			MODEL,
			successFetch,
			{ sessionId: `${SESSION_ID}:side:1` },
		);
		const third = await turn(states, main);

		expect(third.cacheBreakReason).toBeUndefined();
	});

	it("attributes a payload-hook system edit and compares the next turn to the sent prompt", async () => {
		const states = createProviderSessionState();
		const before = "You are a precise assistant.";
		const after = "You are a precise assistant. Prefer short answers.";
		const context = contextWithTools([tool("lookup", {})], before);
		await turn(states, context);
		const second = await turn(states, context, undefined, MODEL, successFetch, {
			onPayload: payload => ({ ...(payload as Record<string, unknown>), system: [{ type: "text", text: after }] }),
		});
		const third = await turn(states, context);

		expect(second.cacheBreakReason).toEqual({ kind: "system_prompt", charDelta: after.length - before.length });
		expect(third.cacheBreakReason).toEqual({ kind: "system_prompt", charDelta: before.length - after.length });
	});

	it("keeps session-less system diagnostics keyed before a hook rewrites the root", async () => {
		const states = createProviderSessionState();
		const context = contextWithTools([tool("lookup", {})]);
		// Without a session id the snapshot is keyed on the root the caller
		// supplied. Keying it on the sent root instead would give a rewritten
		// root its own key, find no previous snapshot, and report nothing.
		await turn(states, context, undefined, MODEL, successFetch, { sessionId: undefined });
		const second = await turn(
			states,
			{ ...context, systemPrompt: ["Changed instructions"] },
			undefined,
			MODEL,
			successFetch,
			{ sessionId: undefined, onPayload: rewriteWireRoot },
		);

		expect(second.cacheBreakReason).toEqual({
			kind: "system_prompt",
			charDelta: "Changed instructions".length - "You are a precise assistant.".length,
		});
	});

	it("reports a change back to an earlier system prefix on the same session", async () => {
		const states = createProviderSessionState();
		const before = "You are a precise assistant.";
		const after = "You are a precise assistant. Prefer short answers.";
		const original = contextWithTools([tool("lookup", {})], before);
		await turn(states, original);
		await turn(states, contextWithTools([tool("lookup", {})], after));
		const third = await turn(states, original);

		expect(third.cacheBreakReason).toEqual({ kind: "system_prompt", charDelta: before.length - after.length });
	});

	it("reports omitted and restored tool arrays even with mid-conversation tool changes", async () => {
		const states = createProviderSessionState();
		const context = contextWithTools([tool("lookup", {})]);
		await turn(states, context);
		const second = await turn(states, { ...context, tools: undefined });
		const third = await turn(states, context);

		expect(second.cacheBreakReason).toEqual({ kind: "tools" });
		expect(third.cacheBreakReason).toEqual({ kind: "tools" });
	});

	it("blames a still-present tool array a payload hook rewrote under the tool plane", async () => {
		const states = createProviderSessionState();
		const context = contextWithTools([tool("lookup", {})]);
		await turn(states, context);
		// The plane earns its exemption by keeping the array it produces stable.
		// The hook runs after it and rewrites that array, so this request really
		// does declare different tools than the cached prefix holds.
		const second = await turn(states, context, undefined, MODEL, successFetch, { onPayload: rewriteWireTools });
		// The hook stops firing and the array changes straight back, which is the
		// same prefix rewrite in the other direction.
		const third = await turn(states, context);

		expect(second.cacheBreakReason).toEqual({ kind: "tools" });
		expect(third.cacheBreakReason).toEqual({ kind: "tools" });
	});

	it("blames nothing when a payload hook rewrites the tool array the same way on every turn", async () => {
		const states = createProviderSessionState();
		const context = contextWithTools([tool("lookup", {})]);
		const hooked = async (): Promise<AssistantMessage> =>
			await turn(states, context, undefined, MODEL, successFetch, { onPayload: rewriteWireTools });
		await hooked();
		// Every turn sends the same rewritten array, so the declared prefix stands
		// still. Treating "the hook touched it" as the cause rather than comparing
		// what was sent blames a steady state on every hooked turn forever.
		const second = await hooked();

		expect(second.cacheBreakReason).toBeUndefined();
	});

	it("does not blame an added tool when a declared description carries a lone surrogate", async () => {
		const states = createProviderSessionState();
		const sent = { body: "" };
		await turn(states, contextWithTools([loneSurrogateTool]));
		// The add appends a `defer_loading` entry, so the plane's array really
		// does change bytes between the two turns and only the exemption keeps
		// this silent. The exemption holds only when the fingerprint taken over
		// the plane's output describes the normalized array that was sent.
		const second = await turn(
			states,
			contextWithTools([loneSurrogateTool, tool("search", {})]),
			undefined,
			MODEL,
			capturingFetch(sent),
		);

		// Without the surrogate really being rewritten on the wire, the two
		// fingerprints would have nothing to disagree about.
		expect(sent.body).toContain("lookup tool \ufffd");
		expect(second.cacheBreakReason).toBeUndefined();
	});

	it("blames a hook-rewritten tool array even when a declared description carries a lone surrogate", async () => {
		const states = createProviderSessionState();
		const context = contextWithTools([loneSurrogateTool]);
		await turn(states, context);
		// Normalizing the planned array must not turn the comparison into a
		// rubber stamp: the hook still sends an array the plane never produced.
		const second = await turn(states, context, undefined, MODEL, successFetch, { onPayload: rewriteWireTools });

		expect(second.cacheBreakReason).toEqual({ kind: "tools" });
	});

	it("reports a system change across root replacement for a prompt-cache-key caller", async () => {
		const states = createProviderSessionState();
		const base = contextWithTools([tool("lookup", {})]);
		// An opted-in caller can declare its cache identity without a session id.
		// Falling back to the root would lose the system comparison after compaction.
		const identity: Pick<AnthropicOptions, "sessionId" | "promptCacheKey"> = {
			sessionId: undefined,
			promptCacheKey: "prompt-cache-key-without-session",
		};
		await turn(
			states,
			{
				...base,
				messages: [
					{ role: "user", content: "Use the tools", timestamp: 1 },
					assistantTurn([{ type: "text", text: "on it" }], 2),
					{ role: "user", content: "keep going", timestamp: 3 },
				],
			},
			undefined,
			MODEL,
			successFetch,
			identity,
		);
		const second = await turn(
			states,
			{
				...base,
				systemPrompt: ["Changed instructions"],
				messages: [{ role: "user", content: "Summary: the user wanted the tools exercised.", timestamp: 4 }],
			},
			undefined,
			MODEL,
			successFetch,
			identity,
		);

		expect(second.cacheBreakReason).toEqual({
			kind: "system_prompt",
			charDelta: "Changed instructions".length - "You are a precise assistant.".length,
		});
	});

	it("scopes diagnostics to the declared prompt cache key rather than the conversation root", async () => {
		const states = createProviderSessionState();
		const base = contextWithTools([tool("lookup", {})]);
		const conversation = (opening: string): Context => ({
			...base,
			systemPrompt: [opening],
			messages: [{ role: "user", content: opening, timestamp: 1 }],
		});
		const first = conversation("first conversation");
		const second = conversation("second conversation");
		const under = (
			promptCacheKey: string,
		): Pick<AnthropicOptions, "sessionId" | "promptCacheKey"> & { sessionId: undefined } => ({
			sessionId: undefined,
			promptCacheKey,
		});
		// A shared key compares the system prefixes even when their roots differ.
		await turn(states, first, undefined, MODEL, successFetch, under("shared"));
		const interleaved = await turn(states, second, undefined, MODEL, successFetch, under("shared"));
		const returned = await turn(states, first, undefined, MODEL, successFetch, under("shared"));
		// Distinct keys partition the snapshots despite interleaving.
		await turn(states, first, undefined, MODEL, successFetch, under("own-key-a"));
		await turn(states, second, undefined, MODEL, successFetch, under("own-key-b"));
		const isolated = await turn(states, first, undefined, MODEL, successFetch, under("own-key-a"));

		expect(interleaved.cacheBreakReason).toEqual({ kind: "system_prompt", charDelta: 1 });
		expect(returned.cacheBreakReason).toEqual({ kind: "system_prompt", charDelta: -1 });
		expect(isolated.cacheBreakReason).toBeUndefined();
	});

	it("names the internal tool rather than its wire name when an escaped tool is redefined", async () => {
		const states = createProviderSessionState();
		let sentToolNames: string[] = [];
		await turn(states, contextWithTools([tool("bash", {})]), undefined, ESCAPED_TOOL_NAMES_MODEL);
		// The reason is persisted on the AssistantMessage and printed in the
		// cache-miss marker, so it has to name the tool the user configured. The
		// wire name is asserted alongside it: without the transport prefix really
		// being applied, the decode this defends would be a no-op.
		const second = await turn(
			states,
			contextWithTools([tool("bash", { command: { type: "string" } })]),
			undefined,
			ESCAPED_TOOL_NAMES_MODEL,
			successFetch,
			{
				onPayload: payload => {
					const sent = payload as { tools?: Array<{ name: string }> };
					sentToolNames = (sent.tools ?? []).map(entry => entry.name);
				},
			},
		);

		expect(sentToolNames).toEqual(["_bash"]);
		expect(second.cacheBreakReason).toEqual({ kind: "tools", tool: "bash" });
	});

	it("blames nothing when a degradation retry no longer carries the rejected attempt's change", async () => {
		const states = createProviderSessionState();
		const before = "You are a precise assistant.";
		const after = "You are a precise assistant. Prefer short answers.";
		const context = contextWithTools([tool("lookup", {})], before);
		await turn(states, context, undefined, MODEL, successFetch, PRIORITY);
		const sink = { bodies: [] as string[] };
		// The hook edits the prompt only on the attempt that gets rejected. The
		// rebuild sends the prompt the cached prefix already holds, so the turn
		// that actually reached Anthropic changed nothing and must say so.
		const second = await turn(states, context, undefined, MODEL, fastModeRejectedOnceFetch(sink), {
			...PRIORITY,
			onPayload: systemPromptOnFirstAttempt(after),
		});
		// The snapshot has to come from the accepted attempt: had the rejected
		// one been stored, this unchanged turn would read as a prompt reverting
		// from `after` back to `before`.
		const third = await turn(states, context, undefined, MODEL, successFetch, PRIORITY);

		// Without two really different payloads there is no misattribution to make.
		expect(sink.bodies).toHaveLength(2);
		expect(sink.bodies[0]).toContain(after);
		expect(sink.bodies[1]).not.toContain(after);
		expect(second.cacheBreakReason).toBeUndefined();
		expect(third.cacheBreakReason).toBeUndefined();
	});

	it("still blames a change the successful attempt of a degradation retry carries", async () => {
		const states = createProviderSessionState();
		const before = "You are a precise assistant.";
		const after = "You are a precise assistant. Prefer short answers.";
		await turn(states, contextWithTools([tool("lookup", {})], before), undefined, MODEL, successFetch, PRIORITY);
		const sink = { bodies: [] as string[] };
		// The edit is the caller's own, so it survives the rebuild and is on the
		// wire of the attempt that succeeded. Clearing attribution per rebuild
		// must not turn into wiping it.
		const second = await turn(
			states,
			contextWithTools([tool("lookup", {})], after),
			undefined,
			MODEL,
			fastModeRejectedOnceFetch(sink),
			PRIORITY,
		);

		expect(sink.bodies).toHaveLength(2);
		expect(second.cacheBreakReason).toEqual({ kind: "system_prompt", charDelta: after.length - before.length });
	});

	it("keeps a tool redefinition cause when a degradation retry rebuilds the turn", async () => {
		const states = createProviderSessionState();
		await turn(states, contextWithTools([tool("lookup", {})]), undefined, MODEL, successFetch, PRIORITY);
		const sink = { bodies: [] as string[] };
		// The first attempt re-baselines the planner, but only an accepted
		// request advances diagnostics. The retry still compares the old tool hash.
		const second = await turn(
			states,
			contextWithTools([tool("lookup", { key: { type: "string" } })]),
			undefined,
			MODEL,
			fastModeRejectedOnceFetch(sink),
			PRIORITY,
		);

		expect(sink.bodies).toHaveLength(2);
		expect(second.cacheBreakReason).toEqual({ kind: "tools", tool: "lookup" });
	});

	it("names the redefined tool on a turn whose re-baseline also dropped a recorded control", async () => {
		const states = createProviderSessionState();
		await turn(states, contextWithTools([tool("lookup", {}), tool("compute", {})]));
		// `search` joins on a control transition, so this turn puts a synthetic
		// system message on the wire that the next one will not have.
		await turn(states, contextWithTools([tool("lookup", {}), tool("compute", {}), tool("search", {})]));
		// Redefining `lookup` re-baselines the planner and clears its transition.
		// Diagnostics still compare the accepted tool definitions.
		const third = await turn(
			states,
			contextWithTools([tool("lookup", { key: { type: "string" } }), tool("compute", {}), tool("search", {})]),
		);

		expect(third.cacheBreakReason).toEqual({ kind: "tools", tool: "lookup" });
	});

	it("reports the system-prompt edit that selected a fresh control state, not a rewrite", async () => {
		const states = createProviderSessionState();
		const before = "You are a precise assistant.";
		const after = "You are a precise assistant. Prefer short answers.";
		const tools = [tool("lookup", {}), tool("compute", {})];
		await turn(states, contextWithTools(tools, before));
		await turn(states, contextWithTools([...tools, tool("search", {})], before));
		// The control-state key carries the system texts, so editing the prompt
		// picks a fresh baseline whose transitions are empty — the control
		// message simply stops being sent. The prompt is the cause and is
		// already reported on its own dimension.
		const third = await turn(states, contextWithTools([...tools, tool("search", {})], after));

		expect(third.cacheBreakReason).toEqual({ kind: "system_prompt", charDelta: after.length - before.length });
	});

	it("reports no tool change when the accepted rebuild sent the cached array", async () => {
		const states = createProviderSessionState();
		const cached: { tools: unknown } = { tools: undefined };
		await turn(states, contextWithTools([tool("lookup", {})]), undefined, MODEL, successFetch, {
			...PRIORITY,
			onPayload: payload => {
				const sent = payload as { tools: unknown };
				cached.tools = sent.tools;
				return undefined;
			},
		});
		const sink = { bodies: [] as string[] };
		let attempt = 0;
		// The first attempt redefines `lookup`; the hook restores the cached
		// array on the rebuild. Attribute the accepted bytes, not the rejected ones.
		const second = await turn(
			states,
			contextWithTools([tool("lookup", { key: { type: "string" } })]),
			undefined,
			MODEL,
			fastModeRejectedOnceFetch(sink),
			{
				...PRIORITY,
				onPayload: payload => {
					attempt += 1;
					if (attempt === 1) return undefined;
					return { ...(payload as Record<string, unknown>), tools: cached.tools };
				},
			},
		);

		// The retry must actually restore a different array for this guard to matter.
		expect(sink.bodies).toHaveLength(2);
		expect(sink.bodies[0]).toContain('"key":{"type":"string"}');
		expect(sink.bodies[1]).not.toContain('"key":{"type":"string"}');
		expect(second.cacheBreakReason).toBeUndefined();
	});

	it("keeps the refreshed prefix when a one-token warming stream aborts after acceptance", async () => {
		const states = createProviderSessionState();
		const base = contextWithTools([tool("lookup", {})]);
		await turn(states, base);
		const refreshed = { ...base, systemPrompt: ["Refreshed instructions"] };
		const abort = new AbortController();
		const accepted = await turn(states, refreshed, undefined, MODEL, abortAfterAcceptanceFetch(abort), {
			maxTokens: 1,
			signal: abort.signal,
		});
		expect(accepted.stopReason).toBe("aborted");
		expect(accepted.cacheBreakReason?.kind).toBe("system_prompt");
		const next = await turn(states, refreshed);
		expect(next.cacheBreakReason).toBeUndefined();
	});

	it("establishes a first one-token warming request as the accepted baseline", async () => {
		const states = createProviderSessionState();
		const base = contextWithTools([tool("lookup", {})]);
		const first = await turn(states, base, undefined, MODEL, successFetch, { maxTokens: 1 });
		expect(first.cacheBreakReason).toBeUndefined();
		const next = await turn(states, { ...base, systemPrompt: ["Refreshed instructions"] });
		expect(next.cacheBreakReason?.kind).toBe("system_prompt");
	});

	it.each([false, true])(
		"does not blame a retention downgrade after compatibility retry (retry fails: %s)",
		async failRetry => {
			const states = createProviderSessionState();
			const context = contextWithTools([tool("lookup", {})]);
			await turn(states, context, "long");
			const bodies: string[] = [];
			const downgrade: FetchImpl = async (input, init) => {
				bodies.push(requestBodyText(init) ?? "");
				if (bodies.length === 1) {
					return new Response(
						JSON.stringify({
							type: "error",
							error: { type: "invalid_request_error", message: "cache_control: Extra inputs are not permitted" },
						}),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}
				return failRetry ? rejectedFetch(input, init) : successFetch(input, init);
			};
			const downgraded = await turn(states, context, "long", MODEL, downgrade);
			expect(bodies).toHaveLength(2);
			expect(bodies[0]).toContain('"ttl":"1h"');
			expect(bodies[1]).toContain('"cache_control":{"type":"ephemeral"}');
			expect(bodies[1]).not.toContain('"ttl"');
			expect(downgraded.stopReason).toBe(failRetry ? "error" : "stop");
			expect(downgraded.cacheBreakReason).toBeUndefined();
			const sent = { body: "" };
			const next = await turn(states, context, "long", MODEL, capturingFetch(sent));
			expect(next.stopReason).toBe("stop");
			expect(next.cacheBreakReason).toBeUndefined();
			if (failRetry) {
				// Neither a rejected snapshot nor an unproven compatibility downgrade is sticky.
				expect(sent.body).toContain('"ttl":"1h"');
				expect(next.disabledFeatures ?? []).not.toContain("prompt-cache-retention");
			} else {
				expect(sent.body).not.toContain('"ttl"');
				expect(next.disabledFeatures).toContain("prompt-cache-retention");
			}
		},
	);
});
