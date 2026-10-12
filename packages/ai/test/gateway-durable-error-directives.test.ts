import { expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { classifyGatewayError } from "../src/error/gateway";
import { streamAnthropic } from "../src/providers/anthropic";
import { streamOpenAICompletions } from "../src/providers/openai-completions";

it("retains parenthesized provider failure statuses through the gateway classifier", () => {
	expect(classifyGatewayError("Factory Gemini generate failed (400): Unknown error")).toMatchObject({
		status: 400,
		owner: "request",
		disposition: "request_terminal",
	});
	expect(classifyGatewayError("Factory Gemini generate failed (503): Unknown error")).toMatchObject({
		status: 503,
		owner: "provider",
	});
});

it("rotates a structured 402 quota response even when its message is generic", async () => {
	const model = buildModel({
		id: "fixture",
		name: "Fixture",
		api: "openai-completions",
		provider: "unit-quota",
		baseUrl: "https://quota.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	});
	const result = await streamOpenAICompletions(
		model,
		{ messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
		{
			apiKey: "fixture-key",
			fetch: async () =>
				Response.json(
					{ error: { code: "insufficient-account-funds", message: "Upstream request failed", type: "api_error" } },
					{ status: 402 },
				),
		},
	).result();
	expect(classifyGatewayError(JSON.parse(JSON.stringify(result)))).toMatchObject({
		status: 402,
		owner: "quota",
		disposition: "credential_quota",
	});
});

for (const [status, directive, disposition] of [
	[400, "true", "provider_transient"],
	[503, "false", "request_terminal"],
	[409, undefined, "provider_transient"],
] as const) {
	it(`preserves ${status}/${directive ?? "default"} retry intent after a real provider stream is finalized and serialized`, async () => {
		const model = buildModel({
			id: "claude-sonnet-4-6",
			name: "Fixture",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		});
		const result = await streamAnthropic(
			model,
			{ messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
			{
				apiKey: "fixture-key",
				providerRetryWait: async () => {},
				fetch: async () =>
					Response.json(
						{ type: "error", error: { type: "api_error", message: "fixture upstream failure" } },
						{
							status,
							headers: {
								"retry-after-ms": "0",
								...(directive === undefined ? {} : { "x-should-retry": directive }),
							},
						},
					),
			},
		).result();
		const durable: unknown = JSON.parse(JSON.stringify(result));
		expect(result.stopReason).toBe("error");
		expect(classifyGatewayError(durable)).toMatchObject({ status, disposition });
	});
}
