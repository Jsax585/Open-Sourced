import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { registerCustomApi, unregisterCustomApis } from "../src/api-registry";
import { getModelPolicyCandidates, ModelPolicyScope, withModelPolicyScope } from "../src/model-policy";
import { stream, streamSimple } from "../src/stream";
import type { Context, FetchImpl, Model, SimpleStreamOptions } from "../src/types";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
function fixture(baseUrl: string, id = "good"): Model<"openai-completions"> {
	const model = buildModel({
		provider: "policy-test",
		api: "openai-completions",
		id,
		name: id,
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 1024,
	});
	return {
		...model,
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
		compat: {
			...model.compat,
			supportsReasoningParams: true,
			supportsReasoningEffort: true,
			omitReasoningEffort: false,
		},
	} as Model<"openai-completions">;
}
function transport() {
	const requests: Record<string, unknown>[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			requests.push((await request.json()) as Record<string, unknown>);
			return new Response(
				'data: {"id":"request","object":"chat.completion.chunk","created":1,"model":"good","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"request","object":"chat.completion.chunk","created":1,"model":"good","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	return { server, requests, model: fixture(`http://127.0.0.1:${server.port}/v1`) };
}
function policy(): ModelPolicyScope {
	const scope = new ModelPolicyScope();
	scope.register({ id: "floor", allowedEfforts: model => (model.id === "good" ? [Effort.High] : []) });
	return scope;
}

type NativeApi = "anthropic-messages" | "google-generative-ai" | "google-gemini-cli" | "google-vertex";
function nativeTransport(api: NativeApi, effortMap?: Partial<Record<Effort, string>>) {
	const requests: { path: string; body: Record<string, unknown> }[] = [];
	const googleChunk = {
		candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
	};
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			requests.push({
				path: new URL(request.url).pathname,
				body: (await request.json()) as Record<string, unknown>,
			});
			const body =
				api === "anthropic-messages"
					? 'event: message_start\ndata: {"type":"message_start","message":{"id":"request","type":"message","role":"assistant","model":"good","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"ok"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
					: `data: ${JSON.stringify(api === "google-gemini-cli" ? { response: googleChunk } : googleChunk)}\n\n`;
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		},
	});
	const baseUrl = `http://127.0.0.1:${server.port}`;
	const built = buildModel({
		provider: api === "anthropic-messages" ? "Anthropic" : "Google",
		api,
		id: "good",
		name: "good",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 65536,
	});
	const model = {
		...built,
		reasoning: true,
		thinking: {
			mode: api === "anthropic-messages" ? "anthropic-adaptive" : "google-level",
			efforts: [Effort.Low, Effort.High],
			effortMap,
		},
		compat: {
			...built.compat,
			supportsOutputEffort: true,
			disableAdaptiveThinking: false,
			disabledThinking: "disabled",
		},
	} as Model<NativeApi>;
	const options: SimpleStreamOptions = {
		apiKey: api === "google-gemini-cli" ? JSON.stringify({ token: "test", projectId: "test-project" }) : "test",
		reasoning: Effort.High,
		...(api === "google-vertex"
			? {
					fetch: ((input, init) => {
						const url = new URL(input instanceof Request ? input.url : input);
						return fetch(`${baseUrl}${url.pathname}${url.search}`, init);
					}) satisfies FetchImpl,
				}
			: {}),
	};
	return { server, requests, model, options };
}

describe("session model policy transport admission", () => {
	test("concurrent scopes isolate actual requests, including raw streams", async () => {
		const { server, requests, model } = transport();
		try {
			const deny = new ModelPolicyScope();
			deny.register({ id: "deny", allowedEfforts: () => [] });
			await Promise.all([
				withModelPolicyScope(policy(), async () => {
					await Promise.resolve();
					const result = await streamSimple(model, context, { apiKey: "test", reasoning: Effort.High }).result();
					expect(result.stopReason).toBe("stop");
				}),
				withModelPolicyScope(deny, async () => {
					await Promise.resolve();
					expect(() => stream(model, context, { apiKey: "test", reasoning: Effort.High })).toThrow(
						"Model policy denied",
					);
				}),
			]);
			expect(requests).toHaveLength(1);
			expect(requests[0]?.reasoning_effort).toBe("high");
		} finally {
			server.stop(true);
		}
	});

	test("stale catalog objects and raw disallowed effort cannot bypass live policy", async () => {
		const { server, requests, model } = transport();
		let allowed = true;
		const scope = new ModelPolicyScope();
		scope.register({ id: "live", allowedEfforts: () => (allowed ? [Effort.High] : []) });
		try {
			await withModelPolicyScope(scope, async () => {
				expect(() => stream(model, context, { apiKey: "test", reasoning: Effort.Low })).toThrow("denied");
				allowed = false;
				expect(() => streamSimple(model, context, { apiKey: "test", reasoning: Effort.High })).toThrow("denied");
				expect(() => stream({ ...model }, context, { apiKey: "test", reasoning: Effort.High })).toThrow("denied");
			});
			expect(requests).toHaveLength(0);
		} finally {
			server.stop(true);
		}
	});

	test("native clamping and mandatory-off normalization use the admitted wire effort", async () => {
		const { server, requests, model } = transport();
		const mandatory = { ...model, thinking: { ...model.thinking!, requiresEffort: true } };
		try {
			await withModelPolicyScope(policy(), async () => {
				await streamSimple(model, context, { apiKey: "test", reasoning: Effort.Max }).result();
				await streamSimple(mandatory, context, { apiKey: "test", disableReasoning: true }).result();
			});
			expect(requests.map(request => request.reasoning_effort)).toEqual(["high", "high"]);
			expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High]);
		} finally {
			server.stop(true);
		}
	});

	test("custom adapters require explicit canonical-effort capability, including after re-registration", async () => {
		const { server, requests, model } = transport();
		const api = "policy-capable-custom";
		const source = "policy-capability-test";
		const custom = { ...model, api } as Model;
		const adapter = (_model: Model, ctx: Context, options?: SimpleStreamOptions) => streamSimple(model, ctx, options);
		try {
			registerCustomApi(api, adapter, source);
			await withModelPolicyScope(policy(), async () => {
				expect(() => streamSimple(custom, context, { apiKey: "test", reasoning: Effort.High })).toThrow("denied");
				expect(requests).toHaveLength(0);
				registerCustomApi(api, adapter, source, undefined, { modelPolicyEffort: true });
				const result = await streamSimple(custom, context, { apiKey: "test", reasoning: Effort.High }).result();
				expect(result.stopReason).toBe("stop");
				expect(requests).toHaveLength(1);
				expect(requests[0]?.reasoning_effort).toBe("high");
				registerCustomApi(api, adapter, source);
				expect(() => stream(custom, context, { apiKey: "test", reasoning: Effort.High })).toThrow("denied");
				expect(requests).toHaveLength(1);
			});
		} finally {
			unregisterCustomApis(source);
			server.stop(true);
		}
	});

	test("compatibility shaping and payload hooks cannot silently drop or change scored effort", async () => {
		const { server, requests, model } = transport();
		try {
			await withModelPolicyScope(policy(), async () => {
				const unsupported = { ...model, compat: { ...model.compat, supportsReasoningParams: false } };
				expect(getModelPolicyCandidates([unsupported])).toEqual([]);
				expect(() => streamSimple(unsupported, context, { apiKey: "test", reasoning: Effort.High })).toThrow(
					"denied",
				);
				const omitted = await streamSimple(model, context, {
					apiKey: "test",
					reasoning: Effort.High,
					onPayload(payload) {
						if (payload && typeof payload === "object" && "reasoning_effort" in payload)
							Reflect.deleteProperty(payload, "reasoning_effort");
						else throw new Error("Fixture omitted reasoning_effort");
					},
				}).result();
				expect(omitted.stopReason).toBe("error");
				expect(omitted.errorMessage).toContain("admitted reasoning effort");
				const changed = await streamSimple(model, context, {
					apiKey: "test",
					reasoning: Effort.High,
					onPayload(payload) {
						if (payload && typeof payload === "object" && "reasoning_effort" in payload)
							payload.reasoning_effort = "low";
						else throw new Error("Fixture omitted reasoning_effort");
					},
				}).result();
				expect(changed.stopReason).toBe("error");
				expect(changed.errorMessage).toContain("admitted reasoning effort");
				const switched = await streamSimple(model, context, {
					apiKey: "test",
					reasoning: Effort.High,
					onPayload(payload) {
						if (payload && typeof payload === "object" && "model" in payload) payload.model = "below-floor";
						else throw new Error("Fixture omitted model");
					},
				}).result();
				expect(switched.stopReason).toBe("error");
				expect(switched.errorMessage).toContain("admitted model identity");
			});
			expect(requests).toHaveLength(0);
		} finally {
			server.stop(true);
		}
	});

	test("errors, invalid callbacks, missing required policies, and unknown effort fail before I/O", () => {
		const { server, requests, model } = transport();
		try {
			const scopes = [new ModelPolicyScope(), new ModelPolicyScope(), new ModelPolicyScope()];
			scopes[0]!.register({
				id: "throws",
				allowedEfforts() {
					throw new Error("broken feed");
				},
			});
			scopes[1]!.register({ id: "invalid", allowedEfforts: () => undefined as never });
			scopes[2]!.required.add("missing");
			for (const scope of scopes)
				withModelPolicyScope(scope, () =>
					expect(() => streamSimple(model, context, { apiKey: "test", reasoning: Effort.High })).toThrow(),
				);
			withModelPolicyScope(policy(), () => {
				expect(() => streamSimple(model, context, { apiKey: "test", reasoning: "unknown" as Effort })).toThrow(
					"Unsupported",
				);
				expect(() =>
					streamSimple({ ...model, thinking: undefined }, context, { apiKey: "test", reasoning: Effort.High }),
				).toThrow("denied");
			});
			expect(requests).toHaveLength(0);
		} finally {
			server.stop(true);
		}
	});

	test("inherited policies intersect rather than being replaced by a child", () => {
		const model = fixture("http://localhost.invalid");
		withModelPolicyScope(policy(), () => {
			const child = new ModelPolicyScope();
			child.register({ id: "child", allowedEfforts: () => [Effort.Low] });
			expect(getModelPolicyCandidates([model], undefined, child)).toEqual([]);
			withModelPolicyScope(child, () =>
				expect(() => streamSimple(model, context, { apiKey: "test" })).toThrow("denied"),
			);
		});
	});

	test.each(["anthropic-messages", "google-generative-ai", "google-gemini-cli", "google-vertex"] as const)(
		"%s admits named user providers but blocks post-hook model and effort substitutions",
		async api => {
			const { server, requests, model, options } = nativeTransport(api);
			try {
				await withModelPolicyScope(policy(), async () => {
					const valid = await streamSimple(model, context, options).result();
					expect(valid.stopReason).toBe("stop");
					const admitted = requests.length;
					for (const substitution of ["effort", "model", "serialized-effort"] as const) {
						const rejected = await streamSimple(model, context, {
							...options,
							onPayload(payload) {
								const body = payload as {
									model: string;
									output_config: { effort: string };
									config: { thinkingConfig: { thinkingLevel: string } };
									request: { generationConfig: { thinkingConfig: { thinkingLevel: string } } };
								};
								if (substitution === "serialized-effort") {
									const target =
										api === "anthropic-messages"
											? body.output_config
											: api === "google-gemini-cli"
												? body.request.generationConfig.thinkingConfig
												: body.config.thinkingConfig;
									Object.defineProperty(target, "toJSON", {
										value: () =>
											api === "anthropic-messages" ? { effort: "low" } : { thinkingLevel: "LOW" },
									});
								} else if (substitution === "model") body.model = "below-floor";
								else if (api === "anthropic-messages") body.output_config.effort = "low";
								else if (api === "google-gemini-cli")
									body.request.generationConfig.thinkingConfig.thinkingLevel = "LOW";
								else body.config.thinkingConfig.thinkingLevel = "LOW";
								return body;
							},
						}).result();
						expect(rejected.stopReason).toBe("error");
						expect(rejected.errorMessage).toContain(
							substitution === "model" ? "admitted model identity" : "admitted reasoning effort",
						);
						expect(requests).toHaveLength(admitted);
					}
				});
				const sent = requests[0]!;
				if (api === "anthropic-messages") expect(sent.body.output_config).toMatchObject({ effort: "high" });
				else if (api === "google-gemini-cli")
					expect(sent.body.request).toMatchObject({
						generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } },
					});
				else {
					expect(sent.path).toContain("/models/good:streamGenerateContent");
					expect(sent.body.generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: "HIGH" } });
				}
			} finally {
				server.stop(true);
			}
		},
	);

	test.each(["max", "adaptive"] as const)(
		"Anthropic canonical high admits its distinct %s wire vocabulary",
		async wireEffort => {
			const { server, requests, model, options } = nativeTransport("anthropic-messages", {
				high: wireEffort,
				low: wireEffort,
			});
			try {
				await withModelPolicyScope(policy(), async () => {
					const result = await streamSimple(model, context, options).result();
					expect(result.stopReason).toBe("stop");
				});
				expect(requests.length).toBeGreaterThanOrEqual(1);
				expect(requests[0]!.body.thinking).toMatchObject({ type: "adaptive" });
				if (wireEffort === "adaptive") expect(requests[0]!.body.output_config).toBeUndefined();
				else expect(requests[0]!.body.output_config).toMatchObject({ effort: "max" });
			} finally {
				server.stop(true);
			}
		},
	);

	test.each(["OpenAI", "Meta"])(
		"%s canonical medium is checked against the forward-mapped high wire effort",
		async provider => {
			const { server, requests, model } = transport();
			const mapped = {
				...model,
				provider,
				thinking: { ...model.thinking!, efforts: [Effort.Medium, Effort.High] },
				compat: { ...model.compat, reasoningEffortMap: { medium: "high" } },
			};
			const scope = new ModelPolicyScope();
			scope.register({ id: "medium-only", allowedEfforts: () => [Effort.Medium] });
			try {
				await withModelPolicyScope(scope, async () => {
					const result = await streamSimple(mapped, context, {
						apiKey: "test",
						reasoning: Effort.Medium,
					}).result();
					expect(result.stopReason).toBe("stop");
					const rejected = await streamSimple(mapped, context, {
						apiKey: "test",
						reasoning: Effort.Medium,
						onPayload(payload) {
							(payload as Record<string, unknown>).reasoning_effort = "medium";
						},
					}).result();
					expect(rejected.stopReason).toBe("error");
				});
				expect(requests).toHaveLength(1);
				expect(requests[0]!.reasoning_effort).toBe("high");
			} finally {
				server.stop(true);
			}
		},
	);

	test("unverifiable built-in transports fail closed before opening a request", () => {
		const { server, requests, model } = transport();
		try {
			withModelPolicyScope(policy(), () => {
				for (const api of [
					"bedrock-converse-stream",
					"ollama-chat",
					"cursor-agent",
					"factory-droid-agent",
					"gitlab-duo-agent",
					"devin-agent",
					"apple-foundation-models",
				] as const) {
					expect(() =>
						streamSimple({ ...model, api } as Model, context, { apiKey: "test", reasoning: Effort.High }),
					).toThrow("denied");
				}
			});
			expect(requests).toHaveLength(0);
		} finally {
			server.stop(true);
		}
	});

	test("without a policy native payload hooks retain their public override behavior", async () => {
		const { server, requests, model, options } = nativeTransport("anthropic-messages");
		try {
			const result = await streamSimple(model, context, {
				...options,
				onPayload(payload) {
					const body = payload as { model: string; output_config: { effort: string } };
					body.model = "hook-selected";
					body.output_config.effort = "low";
				},
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(requests.length).toBeGreaterThanOrEqual(1);
			expect(requests[0]!.body.model).toBe("hook-selected");
			expect(requests[0]!.body.output_config).toMatchObject({ effort: "low" });
		} finally {
			server.stop(true);
		}
	});
});

describe("native budget policy wire admission", () => {
	test.each(["anthropic-messages", "google-generative-ai", "google-gemini-cli", "google-vertex"] as const)(
		"%s verifies the serialized budget against canonical effort",
		async api => {
			const { server, requests, model, options } = nativeTransport(api);
			const budgetModel = {
				...model,
				thinking: { mode: "budget", efforts: [Effort.Low, Effort.High], effortBudgets: { low: 4096, high: 16384 } },
			} as Model<NativeApi>;
			try {
				await withModelPolicyScope(policy(), async () => {
					const valid = await streamSimple(budgetModel, context, options).result();
					expect(valid.stopReason).toBe("stop");
					const admitted = requests.length;
					const rejected = await streamSimple(budgetModel, context, {
						...options,
						onPayload(payload) {
							const body = payload as {
								thinking: { budget_tokens: number };
								config: { thinkingConfig: { thinkingBudget: number } };
								request: { generationConfig: { thinkingConfig: { thinkingBudget: number } } };
							};
							if (api === "anthropic-messages") body.thinking.budget_tokens = 4096;
							else if (api === "google-gemini-cli")
								body.request.generationConfig.thinkingConfig.thinkingBudget = 4096;
							else body.config.thinkingConfig.thinkingBudget = 4096;
						},
					}).result();
					expect(rejected.stopReason).toBe("error");
					expect(rejected.errorMessage).toContain("admitted reasoning effort");
					expect(requests).toHaveLength(admitted);
				});
				if (api === "anthropic-messages")
					expect(requests[0]!.body.thinking).toMatchObject({ budget_tokens: 16384 });
				else if (api === "google-gemini-cli")
					expect(requests[0]!.body.request).toMatchObject({
						generationConfig: { thinkingConfig: { thinkingBudget: 16384 } },
					});
				else
					expect(requests[0]!.body.generationConfig).toMatchObject({ thinkingConfig: { thinkingBudget: 16384 } });
			} finally {
				server.stop(true);
			}
		},
	);
});

describe("Anthropic policy effort transitions", () => {
	test("checks the persistent system-control tail instead of confusing historical effort with current effort", async () => {
		const { server, requests, model, options } = nativeTransport("anthropic-messages");
		try {
			await withModelPolicyScope(policy(), async () => {
				for (const [top, role, tail, accepted] of [
					["low", "system", "high", true],
					["high", "system", "low", false],
					["low", "user", "high", false],
				] as const) {
					const result = await streamSimple(model, context, {
						...options,
						onPayload(payload) {
							const body = payload as { output_config: { effort: string }; messages: object[] };
							body.output_config.effort = top;
							body.messages.push({ role, content: [], output_config: { effort: tail } });
						},
					}).result();
					expect(result.stopReason).toBe(accepted ? "stop" : "error");
				}
			});
			expect(requests.length).toBeGreaterThanOrEqual(1);
			expect(requests[0]!.body.output_config).toMatchObject({ effort: "low" });
			expect((requests[0]!.body.messages as object[]).at(-1)).toMatchObject({
				role: "system",
				output_config: { effort: "high" },
			});
		} finally {
			server.stop(true);
		}
	});
});
