import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const COST = { input: 0.6, output: 0, cacheRead: 0.3, cacheWrite: 0 };
const UPSTREAM_ANSWER = {
	model: "gpt-6-luna",
	answers: [{ name: "urgent", type: "predicate", probability: 0.92 }],
	usage: {
		input_tokens: 100,
		input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 },
		output_tokens: 8,
		output_tokens_details: { reasoning_tokens: 3 },
		total_tokens: 108,
	},
};

interface Harness {
	url: string;
	upstream: { url: string; init: RequestInit | undefined }[];
	storage: AuthStorage;
	close: () => Promise<void>;
}

async function boot(respond: () => Response): Promise<Harness> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-openai-decisions-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime("openai", "openai-secret");
	const bundled = getBundledModel("openai", "gpt-6-luna");
	if (!bundled) throw new Error("expected bundled openai/gpt-6-luna");
	const luna = { ...bundled, judgment: { api: "openai-decisions" as const, cost: COST } };
	const upstream: Harness["upstream"] = [];
	const fetchStub: FetchImpl = async (input, init) => {
		upstream.push({ url: String(input), init });
		return respond();
	};
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["gw-token"],
		storage,
		resolveModel: id => (id === "gpt-6-luna" || id === "openai/gpt-6-luna" ? luna : undefined),
		version: "test",
		fetch: fetchStub,
	});
	return {
		url: handle.url,
		upstream,
		storage,
		close: async () => {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

function post(url: string, pathname: string, body: unknown): Promise<Response> {
	return fetch(`${url}${pathname}`, {
		method: "POST",
		headers: { Authorization: "Bearer gw-token", "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("auth-gateway POST /v1/decisions", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await harness?.close();
		harness = undefined;
	});

	it("forwards the native OpenAI request and preserves image input and response details", async () => {
		harness = await boot(() => Response.json(UPSTREAM_ANSWER));
		const input = [
			{
				role: "user",
				content: [
					{ type: "input_text", text: "Inspect the deployment screenshot." },
					{ type: "input_image", image_url: "https://example.test/screenshot.png" },
				],
			},
		];
		const questions = [{ type: "predicate", name: "urgent", instructions: "Does this show an outage?" }];
		const observed: { provider: string; model: string; costUsd?: number }[] = [];
		vi.spyOn(harness.storage.usage, "observe").mockImplementation(entry => observed.push(entry));

		const response = await post(harness.url, "/v1/decisions", {
			model: "openai/gpt-6-luna",
			input,
			questions,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(UPSTREAM_ANSWER);
		expect(harness.upstream).toHaveLength(1);
		expect(harness.upstream[0].url).toBe("https://api.openai.com/v1/decisions");
		expect(new Headers(harness.upstream[0].init?.headers).get("authorization")).toBe("Bearer openai-secret");
		expect(JSON.parse(String(harness.upstream[0].init?.body))).toEqual({
			model: "gpt-6-luna",
			input,
			questions,
		});
		const cost = Number(response.headers.get("x-litellm-response-cost"));
		expect(cost).toBeGreaterThan(0);
		expect(observed).toHaveLength(1);
		expect(observed[0]).toMatchObject({ provider: "openai", model: "gpt-6-luna", costUsd: cost });
	});

	it("keeps OpenAI Decisions off the System One route and rejects malformed requests before dispatch", async () => {
		harness = await boot(() => Response.json(UPSTREAM_ANSWER));
		const systemOne = await post(harness.url, "/v1/systemone", {
			model: "openai/gpt-6-luna",
			state: "x",
			questions: { urgent: { type: "noul", instructions: "Urgent?" } },
		});
		expect(systemOne.status).toBe(422);

		const missingQuestions = await post(harness.url, "/v1/decisions", { model: "openai/gpt-6-luna", input: "x" });
		expect(missingQuestions.status).toBe(400);
		expect(harness.upstream).toHaveLength(0);
	});
});
