import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthGatewayUpstreamAttempt } from "@oh-my-pi/pi-ai/auth-gateway";
import { __resetExtraCaCache } from "@oh-my-pi/pi-utils";
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
	test("posts each attempt with the bearer and refuses whatever the hook itself does not approve", async () => {
		const received: Array<{ authorization: string | null; body: unknown }> = [];
		let redirectsFollowed = 0;
		using meter = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async req => {
				if (new URL(req.url).pathname === "/approved") {
					redirectsFollowed++;
					return new Response(null, { status: 204 });
				}
				received.push({ authorization: req.headers.get("authorization"), body: await req.json() });
				switch (received.length) {
					case 1:
						return new Response(null, { status: 204 });
					case 2:
						return new Response("budget exhausted", { status: 429 });
					case 3:
						return new Response(null, { status: 302, headers: { location: "/approved" } });
					default: {
						// A refusal body that never ends: only its start may be read.
						const chunk = new TextEncoder().encode("x".repeat(1024));
						return new Response(new ReadableStream({ pull: controller => controller.enqueue(chunk) }), {
							status: 500,
						});
					}
				}
			},
		});
		const hook = createAttemptHookClient(`http://127.0.0.1:${meter.port}/attempts`, "meter-token");

		await hook(attempt(1), undefined);
		await expect(hook(attempt(2), undefined)).rejects.toThrow("attempt hook answered 429: budget exhausted");
		// A redirect is the hook's answer, not a reason to ask somewhere else.
		await expect(hook(attempt(3), undefined)).rejects.toThrow("attempt hook answered 302");
		expect(redirectsFollowed).toBe(0);
		const endless = await hook(attempt(4), undefined).catch((error: Error) => error.message);
		expect(endless).toStartWith("attempt hook answered 500: xxx");
		expect(endless?.length).toBeLessThan(300);
		expect(received).toEqual([1, 2, 3, 4].map(n => ({ authorization: "Bearer meter-token", body: attempt(n) })));

		// An unreachable hook refuses too, so a meter outage stops traffic.
		meter.stop(true);
		await expect(hook(attempt(5), undefined)).rejects.toThrow();
	});

	test("trusts the CAs in NODE_EXTRA_CA_CERTS for an https hook", async () => {
		const pem =
			"-----BEGIN CERTIFICATE-----\nMIIBkTCCATegAwIBAgIUF/sample/extra/ca/for/attempt/hook=\n-----END CERTIFICATE-----\n";
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-attempt-hook-ca-"));
		const originalEnv = Bun.env.NODE_EXTRA_CA_CERTS;
		const originalFetch = globalThis.fetch;
		const trusted: unknown[] = [];
		try {
			__resetExtraCaCache();
			const caPath = path.join(dir, "meter-ca.pem");
			await Bun.write(caPath, pem);
			Bun.env.NODE_EXTRA_CA_CERTS = caPath;
			globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
				trusted.push((init as { tls?: { ca?: unknown } } | undefined)?.tls?.ca);
				return new Response(null, { status: 204 });
			}) as typeof globalThis.fetch;

			await createAttemptHookClient("https://meter.corp.example/attempts", undefined)(attempt(1), undefined);

			expect(trusted).toHaveLength(1);
			expect(trusted[0]).toContain(pem);
		} finally {
			__resetExtraCaCache();
			globalThis.fetch = originalFetch;
			if (originalEnv === undefined) delete Bun.env.NODE_EXTRA_CA_CERTS;
			else Bun.env.NODE_EXTRA_CA_CERTS = originalEnv;
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
