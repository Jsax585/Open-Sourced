import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import { streamSimple } from "../src/stream";
import type { Context, FetchImpl } from "../src/types";

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

async function capture(
	model: Model<"openai-completions">,
	reasoning?: Effort,
	disableReasoning = false,
	simple = true,
) {
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
	const stream = simple ? streamSimple : streamOpenAICompletions;
	const result = await stream(model, context, { apiKey: "test", fetch, reasoning, disableReasoning }).result();
	expect(result.stopReason).not.toBe("error");
	if (!body) throw new Error("Expected captured chat request");
	return body;
}

describe("Friendli reasoning wire contract", () => {
	it("streams rebuilt custom backend metadata through a real HTTP endpoint", async () => {
		const bodies: Record<string, unknown>[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				bodies.push((await request.json()) as Record<string, unknown>);
				return new Response(
					'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		try {
			const cached: Model<"openai-completions"> = JSON.parse(JSON.stringify(model({ provider: "private-alias" })));
			const rebuilt = buildModel({
				...cached,
				baseUrl: `${server.url}v1`,
				compat: cached.compatConfig,
			});
			for (const reasoning of [Effort.High, Effort.Max]) {
				const result = await streamSimple(rebuilt, context, { apiKey: "test", reasoning }).result();
				expect(result.stopReason).toBe("stop");
				expect(result.content).toEqual([{ type: "text", text: "ok" }]);
			}
			expect(bodies.map(body => body.reasoning_effort)).toEqual(["high", "max"]);
			for (const body of bodies) expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
		} finally {
			server.stop(true);
		}
	});

	it("persists custom endpoint policy across cache rebuilds and honors explicit backend overrides", async () => {
		const inferred = model({ provider: "private-alias" });
		expect(inferred.provider).toBe("private-alias");
		expect(inferred.providerType).toBe("friendli");
		const cached: Model<"openai-completions"> = JSON.parse(JSON.stringify(inferred));
		const rebuilt = buildModel({
			...cached,
			baseUrl: "https://proxy.example/v1",
			compat: cached.compatConfig,
		});
		for (const effort of [Effort.High, Effort.Max]) {
			const body = await capture(rebuilt, effort);
			expect(body.reasoning_effort).toBe(effort);
			expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
		}
		for (const providerType of ["nvidia", "custombackend"]) {
			const explicit = model({ provider: "private-alias", providerType });
			expect(explicit.providerType).toBe(providerType);
			const body = await capture(explicit, Effort.High);
			expect(body.reasoning_effort).toBe("high");
			expect(body.chat_template_kwargs).toBeUndefined();
		}
		const unrelated = model({ provider: "private-alias", baseUrl: "https://example.com/v1" });
		expect(unrelated.providerType).toBeUndefined();
	});

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

	it("merges enabled toggles with baseline routing fields and template configuration", async () => {
		const glm = model({
			compat: {
				extraBody: {
					gateway: "route-a",
					chat_template_kwargs: { template_option: "keep", enable_thinking: false },
				},
			},
		});
		const body = await capture(glm, Effort.High);
		expect(body.gateway).toBe("route-a");
		expect(body.chat_template_kwargs).toEqual({ template_option: "keep", enable_thinking: true });
		expect(body.reasoning_effort).toBe("high");
	});

	it("preserves encoded Off toggles with baseline sibling kwargs through both streaming APIs", async () => {
		for (const simple of [true, false]) {
			for (const kwargs of [
				{ template_option: "keep" },
				{ template_option: "keep", enable_thinking: true },
				null,
				"invalid",
				[],
			]) {
				const glm = model({
					compat: { extraBody: { gateway: "route-a", chat_template_kwargs: kwargs } },
				});
				const off = await capture(glm, Effort.High, true, simple);
				expect(off.gateway).toBe("route-a");
				expect(off.chat_template_kwargs).toEqual({
					...(kwargs !== null && typeof kwargs === "object" && !Array.isArray(kwargs) ? kwargs : {}),
					enable_thinking: false,
				});
				expect(off.reasoning_effort).toBeUndefined();
				const on = await capture(glm, Effort.High, false, simple);
				expect(on.gateway).toBe("route-a");
				expect(on.chat_template_kwargs).toEqual({
					...(kwargs !== null && typeof kwargs === "object" && !Array.isArray(kwargs) ? kwargs : {}),
					enable_thinking: true,
				});
				expect(on.reasoning_effort).toBe("high");
			}
		}
	});

	it("honors flat effort omission unless the authored enabled view overrides it", async () => {
		const omitted = model({ compat: { omitReasoningEffort: true } });
		expect((await capture(omitted, Effort.High)).reasoning_effort).toBeUndefined();
		const overridden = model({
			compat: {
				omitReasoningEffort: true,
				whenThinking: {
					thinkingFormat: "openai",
					supportsReasoningEffort: true,
					omitReasoningEffort: false,
				},
			},
		});
		expect((await capture(overridden, Effort.High)).reasoning_effort).toBe("high");
	});

	it("preserves authored flat and enabled-view capability overrides on the wire", async () => {
		for (const supportsReasoningEffort of [false, true]) {
			const declared = model({
				id: "future-reasoner",
				thinking: { mode: "effort", efforts: [Effort.High, Effort.Max] },
				compat: { supportsReasoningEffort },
			});
			for (const effort of [Effort.High, Effort.Max]) {
				const body = await capture(declared, effort);
				expect(body.reasoning_effort).toBe(supportsReasoningEffort ? effort : undefined);
			}
			const flat = model({ id: "unknown-reasoner", compat: { supportsReasoningEffort } });
			expect(flat.thinking).toBeUndefined();
			const flatBody = await capture(flat, Effort.High, false, false);
			expect(flatBody.reasoning_effort).toBe(supportsReasoningEffort ? "high" : undefined);
			const authored = model({
				id: "unknown-reasoner",
				compat: {
					supportsReasoningEffort: !supportsReasoningEffort,
					whenThinking: {
						thinkingFormat: "openai",
						supportsReasoningEffort,
						omitReasoningEffort: !supportsReasoningEffort,
					},
				},
			});
			expect(authored.thinking).toBeUndefined();
			const body = await capture(authored, Effort.High, false, false);
			expect(body.reasoning_effort).toBe(supportsReasoningEffort ? "high" : undefined);
		}
	});

	it("preserves endpoint defaults for sparse specs and distinguishes explicit disable", async () => {
		for (const provider of ["friendli", "custom-friendli"]) {
			for (const id of ["unknown-reasoner", "zai-org/GLM-4.5"]) {
				for (const thinking of [undefined, { mode: "effort", efforts: [] }] as const) {
					const sparse = model({ id, provider, thinking });
					expect(sparse.thinking).toBeUndefined();
					for (const effort of [undefined, Effort.High]) {
						const body = await capture(sparse, effort);
						expect(body.reasoning_effort).toBeUndefined();
						expect(body.chat_template_kwargs).toBeUndefined();
					}
					const direct = await capture(sparse, Effort.High, false, false);
					expect(direct.reasoning_effort).toBeUndefined();
					expect(direct.chat_template_kwargs).toEqual({ enable_thinking: true });
					const off = await capture(sparse, undefined, true);
					expect(off.reasoning_effort).toBeUndefined();
					expect(off.chat_template_kwargs).toEqual({ enable_thinking: false });
				}
			}
		}
	});

	it("resolves DeepSeek and MiniMax custom hosts without conflicting lineage ladders", async () => {
		for (const id of ["deepseek-ai/DeepSeek-V3.2", "MiniMaxAI/MiniMax-M2.5"]) {
			const declared = model({
				id,
				provider: "custom-friendli",
				thinking: { mode: "effort", efforts: [Effort.High] },
			});
			const body = await capture(declared, Effort.High);
			expect(body.reasoning_effort).toBe("high");
			expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
			expect(model({ id, provider: "custom-friendli" }).thinking).toBeUndefined();
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
		const body = await capture(nim, Effort.High, false, false);
		expect(body.reasoning_effort).toBeUndefined();
		expect(body.chat_template_kwargs).toMatchObject({ enable_thinking: true });
	});
});
