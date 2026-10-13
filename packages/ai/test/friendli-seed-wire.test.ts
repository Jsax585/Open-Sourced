import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

/**
 * Friendli's bundled GLM-5.3 seed must resolve through buildModel (identity
 * ladder low/high/max, thinkingFormat "openai") and the chat-completions encoder
 * must put the selected tier on the wire as top-level `reasoning_effort` —
 * distinct per tier, absent when no effort is requested.
 */
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function chatSse(): Response {
	const chunk = (delta: unknown, finish: string | null) =>
		JSON.stringify({
			id: "x",
			object: "chat.completion.chunk",
			created: 0,
			choices: [{ index: 0, delta, finish_reason: finish }],
		});
	return new Response(`data: ${chunk({ content: "ok" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function captureBody(reasoning: Effort | undefined, maxTokens?: number): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
		return chatSse();
	});
	const model = buildModel(seedModels<"openai-completions">("friendli")[0]) as Model<"openai-completions">;
	for await (const event of streamOpenAICompletions(model, context, {
		apiKey: "k",
		fetch: fetchMock,
		reasoning,
		maxTokens,
	})) {
		if (event.type === "done" || event.type === "error") break;
	}
	if (!body) throw new Error("no captured body");
	return body;
}

afterEach(() => vi.restoreAllMocks());

describe("Friendli GLM-5.3 wire dialect", () => {
	it("sends distinct top-level reasoning_effort per tier", async () => {
		const low = await captureBody(Effort.Low);
		expect(low.reasoning_effort).toBe("low");
		const max = await captureBody(Effort.Max);
		expect(max.reasoning_effort).toBe("max");
		expect(low.reasoning_effort).not.toBe(max.reasoning_effort);
		const high = await captureBody(Effort.High);
		expect(high.reasoning_effort).toBe("high");
	});

	it("emits no reasoning_effort when no effort is requested", async () => {
		const none = await captureBody(undefined);
		expect("reasoning_effort" in none).toBe(false);
	});

	it("uses Friendli's advertised output cap instead of OpenAI's generic clamp", async () => {
		const supported = await captureBody(Effort.High, 131_072);
		expect(supported.max_completion_tokens).toBe(131_072);
		const clamped = await captureBody(Effort.High, 2_097_152);
		expect(clamped.max_completion_tokens).toBe(1_048_576);
	});
});
