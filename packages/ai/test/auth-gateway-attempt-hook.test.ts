import { afterEach, describe, expect, it } from "bun:test";
import { type AuthGatewayUpstreamAttempt, gatewayUpstreamFetch, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import type { AuthGatewayServerHandle } from "@oh-my-pi/pi-ai/auth-gateway/types";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const ANTHROPIC = buildModel({
	id: "claude-opus-4-7",
	name: "claude-opus-4-7",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: ZERO_COST,
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const CODEX = buildModel({
	id: "gpt-5.3-codex-spark",
	name: "GPT-5.3 Codex Spark",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	preferWebsockets: true,
	input: ["text"],
	cost: ZERO_COST,
	contextWindow: 128_000,
	maxTokens: 128_000,
});

const ANTHROPIC_SSE = [
	{
		type: "message_start",
		message: {
			id: "msg_attempt_hook",
			type: "message",
			role: "assistant",
			model: ANTHROPIC.id,
			content: [],
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
]
	.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
	.join("");

const CODEX_SSE = [
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: "ok" },
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "ok" }],
		},
	},
	{
		type: "response.completed",
		response: {
			status: "completed",
			usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
		},
	},
]
	.map(event => `data: ${JSON.stringify(event)}\n\n`)
	.join("");

/** A Codex OAuth access token: the provider reads the account id from its payload. */
const CODEX_TOKEN = `aaa.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
).toBase64()}.bbb`;

const sse = (body: string): Response =>
	new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

interface Harness {
	handle: AuthGatewayServerHandle;
	storage: AuthStorage;
	/** Hook calls and upstream requests, interleaved in the order they happened. */
	trace: string[];
	attempts: AuthGatewayUpstreamAttempt[];
}

const harnesses: Harness[] = [];
const originalWebSocket = globalThis.WebSocket;

afterEach(async () => {
	globalThis.WebSocket = originalWebSocket;
	for (const harness of harnesses.splice(0)) {
		await harness.handle.close();
		harness.storage.close();
	}
});

async function boot(
	model: Model<Api>,
	apiKeys: string[],
	upstream: (call: number) => Response,
	refuse: (hookCall: number) => boolean = () => false,
): Promise<Harness> {
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	await storage.credentials.set(
		model.provider,
		apiKeys.map(key => ({ type: "api_key", key })),
	);
	const trace: string[] = [];
	const attempts: AuthGatewayUpstreamAttempt[] = [];
	let calls = 0;
	const fetchImpl: FetchImpl = async () => {
		trace.push("upstream");
		return upstream(++calls);
	};
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["gw-token"],
		storage,
		resolveModel: id => (id === model.id ? model : undefined),
		version: "test",
		fetch: fetchImpl,
		onUpstreamAttempt: async attempt => {
			trace.push(`hook ${attempt.attempt}`);
			attempts.push(attempt);
			if (refuse(attempts.length)) throw new Error("budget exhausted");
		},
	});
	const harness = { handle, storage, trace, attempts };
	harnesses.push(harness);
	return harness;
}

function send(harness: Harness, route: string, body: unknown): Promise<Response> {
	return fetch(`${harness.handle.url}${route}`, {
		method: "POST",
		headers: { Authorization: "Bearer gw-token", "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

const MESSAGES_REQUEST = { model: ANTHROPIC.id, max_tokens: 16, messages: [{ role: "user", content: "hi" }] };
const CODEX_REQUEST = { model: CODEX.id, messages: [{ role: "user", content: "hi" }] };

describe("auth-gateway upstream attempt hook", () => {
	it("is awaited before every upstream request, including a credential-recovery resend", async () => {
		const harness = await boot(ANTHROPIC, ["sk-ant-api-first", "sk-ant-api-second"], call =>
			call === 1
				? Response.json(
						{ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
						{ status: 401 },
					)
				: sse(ANTHROPIC_SSE),
		);

		const response = await send(harness, "/v1/messages", MESSAGES_REQUEST);

		expect(response.status).toBe(200);
		expect(harness.trace).toEqual(["hook 1", "upstream", "hook 2", "upstream"]);
		expect(harness.attempts).toEqual(
			[1, 2].map(attempt => ({
				requestId: response.headers.get("x-request-id") ?? "",
				attempt,
				provider: "anthropic",
				model: ANTHROPIC.id,
				method: "POST",
				url: "https://api.anthropic.com/v1/messages",
			})),
		);
	});

	it.each([
		{
			model: ANTHROPIC,
			key: "sk-ant-api-only",
			body: ANTHROPIC_SSE,
			route: "/v1/messages",
			request: MESSAGES_REQUEST,
		},
		{ model: CODEX, key: CODEX_TOKEN, body: CODEX_SSE, route: "/v1/chat/completions", request: CODEX_REQUEST },
	])(
		"refuses $model.provider attempts without sending, resending or holding them against the credential",
		async ({ model, key, body, route, request }) => {
			const harness = await boot(
				model,
				[key],
				() => sse(body),
				hookCall => hookCall === 1,
			);

			const refused = await send(harness, route, request);
			expect(refused.status).toBe(403);
			expect(await refused.text()).toContain("refused by the gateway's attempt hook");
			expect(harness.trace).toEqual(["hook 1"]);

			// The only credential is still usable.
			const next = await send(harness, route, request);
			expect(next.status).toBe(200);
			expect(harness.trace).toEqual(["hook 1", "hook 1", "upstream"]);
		},
	);

	it("sends Codex over HTTP, where the hook sees it, instead of a WebSocket", async () => {
		const sockets: string[] = [];
		globalThis.WebSocket = class {
			constructor(url: string) {
				sockets.push(url);
				throw new Error("WebSocket transport is invisible to the attempt hook");
			}
		} as unknown as typeof WebSocket;
		const harness = await boot(CODEX, [CODEX_TOKEN], () => sse(CODEX_SSE));

		const response = await send(harness, "/v1/chat/completions", CODEX_REQUEST);

		expect(response.status).toBe(200);
		expect(sockets).toEqual([]);
		expect(harness.trace).toEqual(["hook 1", "upstream"]);
		expect(harness.attempts[0]?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
	});

	it("asks again for each redirect hop of a GET, and hands any other request its redirect", async () => {
		const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
		const redirects: Record<string, string> = {
			"https://api.example/start": "/next",
			"https://api.example/next": "https://cdn.example/file?sig=1",
			"https://api.example/blocked": "https://blocked.example/file",
		};
		const sent: Array<{ url: string; authorization: string | null }> = [];
		const transport: FetchImpl = async (input, init) => {
			const url = String(input);
			sent.push({ url, authorization: new Headers(init?.headers).get("authorization") });
			if (init?.redirect !== "manual") throw new Error("a hooked request must not follow redirects on its own");
			const location = redirects[url];
			return location ? new Response(null, { status: 302, headers: { location } }) : new Response("done");
		};
		const asked: string[] = [];
		const hooked = gatewayUpstreamFetch(
			{
				storage,
				resolveModel: () => undefined,
				fetch: transport,
				onUpstreamAttempt: async attempt => {
					asked.push(`${attempt.attempt} ${attempt.method} ${attempt.url}`);
					if (attempt.url.startsWith("https://blocked.example/")) throw new Error("not this host");
				},
			},
			"req-1",
			ANTHROPIC,
		);
		if (!hooked) throw new Error("expected a hooked fetch");

		const download = await hooked("https://api.example/start", { headers: { Authorization: "Bearer secret" } });
		expect(await download.text()).toBe("done");
		expect(asked).toEqual([
			"1 GET https://api.example/start",
			"2 GET https://api.example/next",
			"3 GET https://cdn.example/file",
		]);
		// The credential stays with its own origin, as when `fetch` follows a redirect itself.
		expect(sent.map(request => request.authorization)).toEqual(["Bearer secret", "Bearer secret", null]);

		const refused = await hooked("https://api.example/blocked");
		expect(refused.status).toBe(422);
		expect(sent.at(-1)?.url).toBe("https://api.example/blocked");

		const post = await hooked("https://api.example/start", { method: "POST", body: "{}" });
		expect(post.status).toBe(302);
		expect(asked.at(-1)).toBe("6 POST https://api.example/start");
		storage.close();
	});
});
