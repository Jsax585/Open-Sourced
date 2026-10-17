import { describe, expect, test } from "bun:test";
import { Effort, ModelPolicyScope, withModelPolicyScope, type Model, type ModelPolicyEffort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { compact, DEFAULT_COMPACTION_SETTINGS, type CompactionPreparation } from "../src/compaction/compaction";
import { createFileOps } from "../src/compaction/utils";
import { requestOpenAiRemoteCompaction, requestRemoteCompaction } from "../src/compaction/openai";
import {
	buildCompactionV2Request,
	getCompactionV2PreserveData,
	requestCompactionV2Streaming,
} from "../src/compaction/compaction-v2-streaming";
import { ThinkingLevel } from "../src/thinking";

type Route = "responses" | "direct-codex" | "native-codex";
interface ObservedRequest {
	model: string;
	reasoning?: { effort?: string };
	input: Array<{ type: string }>;
}

function fixture(
	route: Route = "responses",
	effort: ModelPolicyEffort = Effort.High,
	expectedWireEffort = effort as string,
) {
	const requests: ObservedRequest[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const body = (await request.json()) as ObservedRequest;
			requests.push(body);
			if (
				body.model !== "gpt-5" ||
				body.reasoning?.effort !== expectedWireEffort ||
				body.input.at(-1)?.type !== "compaction_trigger"
			) {
				return Response.json({ error: { message: "wrong compaction tuple or missing trigger" } }, { status: 400 });
			}
			const events = [
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "compaction", encrypted_content: "policy-compacted-history" },
				},
				{
					type: "response.completed",
					response: { id: "policy-compaction", usage: { input_tokens: 100, output_tokens: 1, total_tokens: 101 } },
				},
			];
			return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	const origin = `http://127.0.0.1:${server.port}`;
	const api = route === "responses" ? "openai-responses" : "openai-codex-responses";
	const base = buildModel({
		provider: route === "responses" ? "openai" : "openai-codex",
		api,
		id: "gpt-5",
		name: "Policy test",
		baseUrl: `${origin}${route === "responses" ? "/v1" : "/backend-api"}`,
		preferWebsockets: false,
		reasoning: true,
		input: ["text"],
		compat: { supportsReasoningParams: true },
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 1024,
		remoteCompaction: {
			enabled: true,
			v2StreamingEnabled: true,
			...(route === "direct-codex" ? { v2Endpoint: `${origin}/backend-api/codex/responses` } : {}),
		},
	});
	const model = {
		...base,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
	} as Model;
	const scope = new ModelPolicyScope();
	scope.register({ id: "floor", allowedEfforts: () => [effort] });
	return { server, requests, model, scope };
}

function preparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [{ role: "user", content: "Remember the migration decision", timestamp: 1 }],
		turnPrefixMessages: [],
		recentMessages: [],
		isSplitTurn: false,
		tokensBefore: 1000,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: true, remoteStreamingV2Enabled: true },
	};
}

describe("direct remote compaction model policy admission", () => {
	test("V1 exposes no scored effort and cannot escape through its direct fetch", async () => {
		const f = fixture();
		try {
			await expect(
				withModelPolicyScope(f.scope, () => requestOpenAiRemoteCompaction(f.model, "test", [], "summarize")),
			).rejects.toThrow("Model policy denied");
			expect(f.requests).toHaveLength(0);
		} finally {
			f.server.stop(true);
		}
	});

	test("V2 cannot send an unadmitted canonical effort", async () => {
		const f = fixture();
		try {
			const request = buildCompactionV2Request(f.model, [], "summarize", {
				reasoning: { effort: "low", summary: "auto" },
				policyOptions: { reasoning: Effort.Low },
			});
			await expect(
				withModelPolicyScope(f.scope, () => requestCompactionV2Streaming(f.model, "test", request)),
			).rejects.toThrow("Model policy denied");
			expect(f.requests).toHaveLength(0);
		} finally {
			f.server.stop(true);
		}
	});

	for (const route of ["responses", "direct-codex", "native-codex"] as const) {
		for (const changed of ["model", "effort"] as const) {
			test(`${route} rejects a changed wire ${changed} before HTTP`, async () => {
				const f = fixture(route);
				try {
					const request = buildCompactionV2Request(f.model, [], "summarize", {
						reasoning: { effort: "high", summary: "auto" },
						policyOptions: { reasoning: Effort.High },
					});
					if (changed === "model") request.body.model = "unadmitted-model";
					else request.body.reasoning = { effort: "low" };
					await expect(
						withModelPolicyScope(f.scope, () => requestCompactionV2Streaming(f.model, "test", request)),
					).rejects.toThrow(
						changed === "model" ? "changed the admitted model identity" : "changed the admitted reasoning effort",
					);
					expect(f.requests).toHaveLength(0);
				} finally {
					f.server.stop(true);
				}
			});
		}

		for (const scenario of [
			{ name: "admitted high", effort: Effort.High, wire: "high" },
			{ name: "policy-selected off despite the original high selection", effort: "off" as const, wire: "none" },
			{ name: "canonical medium mapped to wire high", effort: Effort.Medium, wire: "high" },
		]) {
			test(`${route} actually compacts with ${scenario.name}`, async () => {
				const f = fixture(route, scenario.effort, scenario.wire);
				try {
					if (scenario.effort === Effort.Medium) {
						f.model.thinking = { ...f.model.thinking!, effortMap: { [Effort.Medium]: "high" } };
					}
					const result = await withModelPolicyScope(f.scope, () =>
						compact(preparation(), f.model, "test", undefined, undefined, {
							thinkingLevel: ThinkingLevel.High,
							preferWebsockets: false,
						}),
					);
					expect(f.requests).toHaveLength(1);
					expect(f.requests[0]?.reasoning?.effort).toBe(scenario.wire);
					const history = getCompactionV2PreserveData(result.preserveData);
					expect(history?.usedTokens).toBe(100);
					expect(history?.replacementHistory.at(-1)).toEqual({
						type: "compaction",
						encrypted_content: "policy-compacted-history",
					});
				} finally {
					f.server.stop(true);
				}
			});
		}

		test(`${route} does not treat omitted reasoning as proof of off`, async () => {
			const f = fixture(route, "off", "none");
			try {
				const request = buildCompactionV2Request(f.model, [], "summarize", {
					policyOptions: { disableReasoning: true, forceReasoningOff: true },
				});
				await expect(
					withModelPolicyScope(f.scope, () => requestCompactionV2Streaming(f.model, "test", request)),
				).rejects.toThrow();
				expect(f.requests).toHaveLength(0);
			} finally {
				f.server.stop(true);
			}
		});
	}

	test("wire effort alone cannot stand in for canonical admission", async () => {
		const f = fixture();
		try {
			const request = buildCompactionV2Request(f.model, [], "summarize", {
				reasoning: { effort: "high", summary: "auto" },
			});
			await expect(
				withModelPolicyScope(f.scope, () => requestCompactionV2Streaming(f.model, "test", request)),
			).rejects.toThrow("Unverifiable compaction thinking effort");
			expect(f.requests).toHaveLength(0);
		} finally {
			f.server.stop(true);
		}
	});

	test("serialized reasoning cannot change the admitted effort", async () => {
		const f = fixture();
		try {
			const reasoning = { effort: "high", summary: "auto", toJSON: () => ({ effort: "low" }) };
			const request = buildCompactionV2Request(f.model, [], "summarize", {
				reasoning,
				policyOptions: { reasoning: Effort.High },
			});
			await expect(
				withModelPolicyScope(f.scope, () => requestCompactionV2Streaming(f.model, "test", request)),
			).rejects.toThrow("changed the admitted reasoning effort");
			expect(f.requests).toHaveLength(0);
		} finally {
			f.server.stop(true);
		}
	});

	test("custom compaction endpoints cannot claim a catalog model's score", async () => {
		const f = fixture();
		try {
			await expect(
				withModelPolicyScope(f.scope, () =>
					requestRemoteCompaction(
						`http://127.0.0.1:${f.server.port}/compact`,
						{ systemPrompt: "summarize", prompt: "hello", maxTokens: 32 },
						undefined,
						{ model: f.model, apiKey: "test" },
					),
				),
			).rejects.toThrow("cannot attest");
			expect(f.requests).toHaveLength(0);
		} finally {
			f.server.stop(true);
		}
	});

	test("broken and missing required policies deny direct compaction before any request", async () => {
		const f = fixture();
		try {
			const broken = new ModelPolicyScope();
			broken.register({
				id: "broken",
				allowedEfforts() {
					throw new Error("broken");
				},
			});
			const missing = new ModelPolicyScope();
			missing.required.add("required");
			for (const scope of [broken, missing]) {
				const request = buildCompactionV2Request(f.model, [], "summarize", {
					reasoning: { effort: "high", summary: "auto" },
					policyOptions: { reasoning: Effort.High },
				});
				await expect(
					withModelPolicyScope(scope, () => requestCompactionV2Streaming(f.model, "test", request)),
				).rejects.toThrow();
			}
			expect(f.requests).toHaveLength(0);
		} finally {
			f.server.stop(true);
		}
	});
});
