import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { logger } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
	clearCustomApis();
});

const STREAM_ROUTES = [
	{
		format: "openai-chat",
		path: "/v1/chat/completions",
		body: { model: "mock/stream-log", messages: [{ role: "user", content: "hi" }], stream: true },
	},
	{
		format: "pi-native",
		path: "/v1/pi/stream",
		body: {
			modelId: "mock/stream-log",
			context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			stream: true,
		},
	},
];

describe("auth-gateway streamed reply settle log", () => {
	it("warns with the request id and upstream error when a streamed reply ends in an error", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-stream-log-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.keys.setRuntime("openrouter", "test-key");
		const mock = createMockModel({ provider: "openrouter", id: "mock/stream-log" });
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gw-test-token"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

		try {
			for (const route of STREAM_ROUTES) {
				// Text already reached the client when the upstream connection dropped.
				mock.push({
					content: ["partial answer"],
					stopReason: "error",
					errorMessage: "The socket connection was closed unexpectedly",
				});
				const res = await fetch(`${handle.url}${route.path}`, {
					method: "POST",
					headers: { Authorization: "Bearer gw-test-token", "Content-Type": "application/json" },
					body: JSON.stringify(route.body),
				});
				expect(res.status).toBe(200);
				await res.text();

				const requestId = res.headers.get("x-request-id");
				const ended = warn.mock.calls.filter(
					([message, fields]) => message === "auth-gateway stream ended early" && fields?.requestId === requestId,
				);
				expect(ended).toHaveLength(1);
				expect(ended[0]?.[1]).toMatchObject({
					format: route.format,
					resolvedProvider: "openrouter",
					resolvedModel: "mock/stream-log",
					stopReason: "error",
					errorMessage: "The socket connection was closed unexpectedly",
					durationMs: expect.any(Number),
				});
			}
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
