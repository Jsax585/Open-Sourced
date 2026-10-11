import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { groqModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("Groq provider discovery", () => {
	test("the live /models list replaces the bundled one, dropping retired models", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
			return Response.json({
				object: "list",
				data: [
					{ id: "openai/gpt-oss-120b", object: "model", active: true, context_window: 131072 },
					{ id: "qwen/qwen3.8-27b", object: "model", active: true, context_window: 131072 },
				],
			});
		};
		expect(getBundledModels("groq").some(model => model.id === "llama3-70b-8192")).toBe(true);

		const options = groqModelManagerOptions({ apiKey: "gsk-test", fetch: fetchMock });
		expect(options.dynamicModelsAuthoritative).toBe(true);
		const dbPath = path.join(os.tmpdir(), `groq-discovery-${Bun.randomUUIDv7()}.db`);
		const result = await createModelManager({ ...options, cacheDbPath: dbPath }).refresh("online");

		expect(calls).toEqual([{ url: "https://api.groq.com/openai/v1/models", authorization: "Bearer gsk-test" }]);
		expect(result.models.map(model => model.id).sort()).toEqual(["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]);
	});

	test("without a key, the bundled catalog stays", () => {
		const options = groqModelManagerOptions();
		expect(options.fetchDynamicModels).toBeUndefined();
	});
});
