import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function model(overrides: Partial<ModelSpec<"openai-completions">> = {}): Model<"openai-completions"> {
	return buildModel({
		id: "zai-org/GLM-5.2",
		name: "GLM-5.2",
		api: "openai-completions",
		provider: "friendli",
		baseUrl: "https://api.friendli.ai/serverless/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		...overrides,
	});
}

async function capture(model: Model<"openai-completions">, reasoning?: Effort, disableReasoning = false) {
	let body: Record<string, unknown> | undefined;
	const fetch: FetchImpl = async (_input, init) => {
		body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return new Response(
			'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
			{
				headers: { "content-type": "text/event-stream" },
			},
		);
	};
	const result = await streamOpenAICompletions(model, context, {
		apiKey: "test",
		fetch,
		reasoning,
		disableReasoning,
	}).result();
	expect(result.stopReason).not.toBe("error");
	if (!body) throw new Error("Expected captured chat request");
	return body;
}

describe("Friendli reasoning wire contract", () => {
	it("keeps identity-derived high/max distinct and disables the toggle without sending effort", async () => {
		const glm = model();
		expect(glm.thinking?.efforts).toEqual([Effort.High, Effort.Max]);
		for (const effort of [Effort.High, Effort.Max]) {
			const body = await capture(glm, effort);
			expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
			expect(body.reasoning_effort).toBe(effort);
		}
		const off = await capture(glm, undefined, true);
		expect(off.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(off.reasoning_effort).toBeUndefined();
	});

	it("preserves explicit ladders over identity and supports custom-named Friendli hosts", async () => {
		for (const id of ["zai-org/GLM-5.2", "future-reasoner"]) {
			const declared = model({
				id,
				provider: "custom-friendli",
				thinking: { mode: "effort", efforts: [Effort.Low, Effort.Max] },
			});
			expect(declared.thinking?.efforts).toEqual([Effort.Low, Effort.Max]);
			const body = await capture(declared, Effort.Low);
			expect(body.reasoning_effort).toBe("low");
			expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
		}
	});

	it("does not invent tiers or send effort for sparse specs", async () => {
		for (const id of ["unknown-reasoner", "zai-org/GLM-4.5"]) {
			const sparse = model({ id });
			expect(sparse.thinking).toBeUndefined();
			const body = await capture(sparse, Effort.High);
			expect(body.reasoning_effort).toBeUndefined();
		}
	});

	it("keeps GLM-5.3 always on and uses its low/high/max ladder", async () => {
		const glm = model({ id: "zai-org/GLM-5.3" });
		expect(glm.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(glm.thinking?.requiresEffort).toBe(true);
		const off = await capture(glm, undefined, true);
		expect(off.reasoning_effort).toBe("low");
		expect(off.chat_template_kwargs).toBeUndefined();
	});

	it("leaves NIM template effort kwargs-only", async () => {
		const nim = model({
			id: "qwen/qwen3.8-235b-a22b",
			provider: "nvidia",
			baseUrl: "https://integrate.api.nvidia.com/v1",
		});
		const body = await capture(nim, Effort.High);
		expect(body.reasoning_effort).toBeUndefined();
		expect(body.chat_template_kwargs).toMatchObject({ enable_thinking: true });
	});
});
