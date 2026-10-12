import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "../src/api-registry";
import { RouteDecisionTraceLog, startAuthGateway } from "../src/auth-gateway";
import { AuthStorage } from "../src/auth-storage";
import { createMockModel, registerMockApi } from "../src/providers/mock";

afterEach(() => {
	vi.restoreAllMocks();
	clearCustomApis();
});

for (const native of [false, true]) {
	for (const outcome of ["dispatched", "unavailable", "lookup-failed"] as const) {
		it(`returns a retrievable ${outcome} trace for ${native ? "pi-native" : "chat"} requests`, async () => {
			registerMockApi();
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-trace-contract-"));
			const storage = await AuthStorage.create(path.join(directory, "auth.db"));
			const target = createMockModel({ provider: "openrouter", id: "mock/trace-target" });
			target.push({ content: ["trace response"] });
			if (outcome === "dispatched") storage.keys.setRuntime("openrouter", "fixture-key");
			else
				vi.spyOn(storage.keys, "getWithCredential").mockImplementation(async () => {
					if (outcome === "lookup-failed") throw new Error("fixture credential lookup failure");
					return undefined;
				});
			const gateway = startAuthGateway({
				bind: "127.0.0.1:0",
				storage,
				bearerTokens: ["trace-fixture-client"],
				resolveModel: () => target,
			});
			try {
				const response = await fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/chat/completions"}`, {
					method: "POST",
					headers: { Authorization: "Bearer trace-fixture-client", "Content-Type": "application/json" },
					body: JSON.stringify(
						native
							? {
									modelId: target.id,
									context: { messages: [{ role: "user", content: "private fixture prompt", timestamp: 0 }] },
									stream: false,
								}
							: {
									model: target.id,
									messages: [{ role: "user", content: "private fixture prompt" }],
									stream: false,
								},
					),
				});
				await response.text();
				const requestId = response.headers.get("x-request-id");
				expect(requestId).not.toBeNull();
				const readback = await fetch(`${gateway.url}/v1/executions/${requestId}`, {
					headers: { Authorization: "Bearer trace-fixture-client" },
				});
				expect(readback.status).toBe(200);
				const payload = await readback.json();
				expect(payload).toMatchObject({
					requestId,
					selectedTarget: "openrouter/mock/trace-target",
					disposition: outcome === "dispatched" ? "dispatched" : "skipped",
					...(outcome === "dispatched"
						? {}
						: { reason: outcome === "unavailable" ? "credential_unavailable" : "credential_lookup_failed" }),
				});
				expect(JSON.stringify(payload)).not.toContain("private fixture prompt");
				expect(JSON.stringify(payload)).not.toContain("fixture-key");
				expect(target.calls).toHaveLength(outcome === "dispatched" ? 1 : 0);
			} finally {
				await gateway.close();
				storage.close();
				await fs.rm(directory, { recursive: true });
			}
		});
	}
}

it("execution responses omit injected non-allowlisted trace fields", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-trace-redaction-"));
	const storage = await AuthStorage.create(path.join(directory, "auth.db"));
	const log = new RouteDecisionTraceLog();
	const input = {
		requestId: "fixture-redaction",
		routeId: "fixture-route",
		generation: 1,
		selectedTarget: "fixture-target",
		disposition: "dispatched" as const,
		prompt: "private injected prompt",
		token: "private injected token",
		headers: { Authorization: "private injected authorization" },
	};
	log.record(input);
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		storage,
		bearerTokens: ["trace-fixture-client"],
		resolveModel: () => undefined,
		decisionTraces: log,
	});
	try {
		const response = await fetch(`${gateway.url}/v1/executions/fixture-redaction`, {
			headers: { Authorization: "Bearer trace-fixture-client" },
		});
		expect(response.status).toBe(200);
		const payload = await response.json();
		expect(payload).not.toHaveProperty("prompt");
		expect(payload).not.toHaveProperty("token");
		expect(payload).not.toHaveProperty("headers");
		expect(JSON.stringify(payload)).not.toContain("private injected");
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(directory, { recursive: true });
	}
});
