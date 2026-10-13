import { describe, expect, test, vi } from "bun:test";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/env-api-key";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { OAuthController } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { withEnv } from "./helpers";

const loginFriendli = getProviderDefinition("friendli")?.login;
if (!loginFriendli) throw new Error("FriendliAI login is not registered");

const CHAT_COMPLETIONS_URL = "https://api.friendli.ai/serverless/v1/chat/completions";

function createController(fetch: FetchImpl): OAuthController {
	return {
		fetch,
		onPrompt: async () => "invalid-friendli-key",
	};
}

describe("loginFriendli", () => {
	test("uses the documented token environment variable without changing API-key precedence", async () => {
		await withEnv({ FRIENDLI_API_KEY: undefined, FRIENDLI_TOKEN: "sdk-token" }, () => {
			expect(getEnvApiKey("friendli")).toBe("sdk-token");
		});
		await withEnv({ FRIENDLI_API_KEY: "existing-key", FRIENDLI_TOKEN: "sdk-token" }, () => {
			expect(getEnvApiKey("friendli")).toBe("existing-key");
		});
	});

	test("rejects an invalid key through the authenticated chat completions endpoint", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === CHAT_COMPLETIONS_URL) {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toEqual({
					"Content-Type": "application/json",
					Authorization: "Bearer invalid-friendli-key",
				});
				return new Response('{"detail":"Unauthorized"}', { status: 401 });
			}
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		});

		await expect(loginFriendli(createController(fetchMock))).rejects.toThrow(
			'FriendliAI API key validation failed (401): {"detail":"Unauthorized"}',
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
