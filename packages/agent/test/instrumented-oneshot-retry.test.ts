import { describe, expect, it } from "bun:test";
import { instrumentedCompleteSimple } from "@oh-my-pi/pi-agent-core/telemetry";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { encodeStream, parseRequest } from "@oh-my-pi/pi-ai/providers/pi-native-server";
import type {
	Api,
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	ProviderSessionState,
	SimpleStreamOptions,
	Usage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Defends the opt-in contract of the oneshot retry funnel.
 *
 * `instrumentedCompleteSimple` is the single entry point for every oneshot LLM
 * call in the agent (compaction summaries, handoff, branch summary, image
 * inspection). A transient Anthropic failure surfaces as a **resolved**
 * `AssistantMessage` with `stopReason: "error"`, so retry has to be decided
 * here rather than by a try/catch anywhere above.
 *
 * Retry is deliberately opt-in: `oneshotKind` is free-form and callers may pass
 * arbitrary `ctx.tools`, so the funnel cannot prove an arbitrary request is
 * replay-safe. These tests pin both halves of that contract — omitted means one
 * attempt, `{}` means the transient failure is re-issued — plus the
 * attempt-local header reset that keeps a stale `retry-after` from leaking into
 * a later attempt.
 */

const emptyUsage = (): Usage =>
	({
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	}) as unknown as Usage;

const model = {
	id: "claude-sonnet-4-6",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
} as unknown as Model<Api>;

const ctx = { systemPrompt: "s", messages: [] } as unknown as Context;

function reply(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	} as AssistantMessage;
}

const overloaded = (): AssistantMessage =>
	reply({
		stopReason: "error",
		errorStatus: 529,
		errorMessage: "Anthropic stream error (overloaded_error): Overloaded",
	});

describe("instrumentedCompleteSimple transient retry", () => {
	it("does not retry when `retry` is omitted", async () => {
		let calls = 0;
		const result = await instrumentedCompleteSimple(model, ctx, {} as SimpleStreamOptions, {
			telemetry: undefined,
			oneshotKind: "test_no_retry",
			completeImpl: () => {
				calls += 1;
				return Promise.resolve(overloaded());
			},
		});

		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
	});

	it("re-issues a transient failure when `retry: {}` is set", async () => {
		let calls = 0;
		const result = await instrumentedCompleteSimple(model, ctx, {} as SimpleStreamOptions, {
			telemetry: undefined,
			oneshotKind: "test_retry",
			retry: { baseDelayMs: 1 },
			completeImpl: () => {
				calls += 1;
				return Promise.resolve(calls === 1 ? overloaded() : reply());
			},
		});

		expect(calls).toBe(2);
		expect(result.stopReason).toBe("stop");
	});

	it("keeps the caller's failure contract once attempts are exhausted", async () => {
		let calls = 0;
		const result = await instrumentedCompleteSimple(model, ctx, {} as SimpleStreamOptions, {
			telemetry: undefined,
			oneshotKind: "test_exhausted",
			retry: { baseDelayMs: 1, maxAttempts: 2 },
			completeImpl: () => {
				calls += 1;
				return Promise.resolve(overloaded());
			},
		});

		expect(calls).toBe(2);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("overloaded_error");
	});

	it("does not reuse a previous attempt's retry-after header", async () => {
		// Attempt 1 fails WITH a retry-after header; attempt 2 fails WITHOUT one.
		// If headers were not cleared per attempt, the stale hint would be applied
		// again and the second wait would jump from ~1ms backoff back to 300ms.
		const waits: number[] = [];
		let calls = 0;
		await instrumentedCompleteSimple(model, ctx, {} as SimpleStreamOptions, {
			telemetry: undefined,
			oneshotKind: "test_header_reset",
			retry: { baseDelayMs: 1, maxAttempts: 3, onRetry: info => waits.push(info.delayMs) },
			completeImpl: (_model, _ctx, options) => {
				calls += 1;
				if (calls === 1) {
					options.onResponse?.({ status: 429, headers: { "retry-after-ms": "300" } }, undefined as never);
				}
				return Promise.resolve(calls < 3 ? overloaded() : reply());
			},
		});

		expect(calls).toBe(3);
		expect(waits).toHaveLength(2);
		expect(waits[0]).toBe(300);
		// Second failure carried no header, so it must fall back to plain backoff.
		expect(waits[1]).toBeLessThan(50);
	});

	it.each(["default", "custom", "pi-native"] as const)(
		"isolates same-session summaries from cache attribution (%s completion)",
		async completion => {
			const model = buildModel({
				id: "claude-sonnet-4-5",
				name: "Claude Sonnet 4.5",
				provider: "anthropic",
				api: "anthropic-messages",
				baseUrl: "https://api.anthropic.com",
				transport: completion === "pi-native" ? "pi-native" : undefined,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_192,
			});
			const events = [
				{
					type: "message_start",
					message: {
						id: "msg_summary",
						usage: { input_tokens: 4, output_tokens: 0, cache_creation_input_tokens: 4 },
					},
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "summary" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			];
			const fetch: FetchImpl = async () =>
				new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
					headers: { "Content-Type": "text/event-stream" },
				});
			const providerSessionState = new Map<string, ProviderSessionState>();
			const upstreamModel: Model<"anthropic-messages"> = { ...model, transport: undefined };
			const gatewayFetch: FetchImpl = async (_input, init) => {
				const parsed = parseRequest(JSON.parse(String(init?.body)));
				const response = streamSimple(upstreamModel, parsed.context, {
					...parsed.options,
					apiKey: "sk-ant-api-test",
					providerSessionState,
					fetch,
				});
				return new Response(encodeStream(response), { headers: { "Content-Type": "text/event-stream" } });
			};
			const options: SimpleStreamOptions = {
				apiKey: "sk-ant-api-test",
				sessionId: "summary-cache-attribution",
				providerSessionState,
				cacheBreakDiagnostics: true,
				fetch: completion === "pi-native" ? gatewayFetch : fetch,
			};
			const main: Context = {
				systemPrompt: ["Stable system"],
				messages: [{ role: "user", content: "Opening turn", timestamp: 1 }],
			};
			try {
				const first = await streamSimple(model, main, options).result();
				const summary = await instrumentedCompleteSimple(
					model,
					{
						systemPrompt: ["Summarize the conversation"],
						messages: [{ role: "user", content: "Conversation to summarize", timestamp: 2 }],
					},
					options,
					{
						telemetry: undefined,
						oneshotKind: "compaction_summary",
						...(completion === "custom"
							? {
									completeImpl: (requestModel, requestContext, requestOptions) =>
										streamSimple(requestModel, requestContext, requestOptions).result(),
								}
							: {}),
					},
				);
				const continued: Context = {
					...main,
					messages: [...main.messages, first, { role: "user", content: "Next turn", timestamp: 3 }],
				};
				const next = await streamSimple(model, continued, options).result();
				const changed = await streamSimple(
					model,
					{ ...continued, systemPrompt: ["Changed main system"] },
					options,
				).result();

				expect([first.stopReason, summary.stopReason, next.stopReason, changed.stopReason]).toEqual([
					"stop",
					"stop",
					"stop",
					"stop",
				]);
				expect(next.cacheBreakReason).toBeUndefined();
				expect(summary.cacheBreakReason).toBeUndefined();
				expect(changed.cacheBreakReason?.kind).toBe("system_prompt");
			} finally {
				for (const state of providerSessionState.values()) state.close();
			}
		},
	);
});
