import { describe, expect, test } from "bun:test";
import type { AuthGatewayUpstreamAttempt } from "@oh-my-pi/pi-ai/auth-gateway";
import { createAttemptHookClient } from "../../src/cli/auth-gateway-cli";

const attempt = (n: number): AuthGatewayUpstreamAttempt => ({
	requestId: "req-1",
	attempt: n,
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	method: "POST",
	url: "https://api.anthropic.com/v1/messages",
});

describe("auth-gateway --attempt-hook client", () => {
	test("posts each attempt with the bearer and refuses whatever the hook does not approve", async () => {
		const received: Array<{ authorization: string | null; body: unknown }> = [];
		using meter = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async req => {
				received.push({ authorization: req.headers.get("authorization"), body: await req.json() });
				return received.length === 1
					? new Response(null, { status: 204 })
					: new Response("budget exhausted", { status: 429 });
			},
		});
		const hook = createAttemptHookClient(`http://127.0.0.1:${meter.port}/attempts`, "meter-token");

		await hook(attempt(1), undefined);
		await expect(hook(attempt(2), undefined)).rejects.toThrow("attempt hook answered 429: budget exhausted");
		expect(received).toEqual([
			{ authorization: "Bearer meter-token", body: attempt(1) },
			{ authorization: "Bearer meter-token", body: attempt(2) },
		]);

		// An unreachable hook refuses too, so a meter outage stops traffic.
		meter.stop(true);
		await expect(hook(attempt(3), undefined)).rejects.toThrow();
	});
});
