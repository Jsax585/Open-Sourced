import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { groqModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

/** Groq's live /models rows on 2026-10-11, trimmed to the fields discovery reads. */
const LIVE = [
	{ id: "openai/gpt-oss-120b", output_modalities: ["text"], supported_features: ["tools", "json_mode", "reasoning"] },
	{ id: "openai/gpt-oss-20b", output_modalities: ["text"], supported_features: ["tools", "json_mode", "reasoning"] },
	{
		id: "openai/gpt-oss-safeguard-20b",
		output_modalities: ["text"],
		supported_features: ["tools", "json_mode", "reasoning"],
	},
	{ id: "qwen/qwen3.8-27b", output_modalities: ["text"], supported_features: ["tools", "json_mode", "reasoning"] },
	{ id: "allam-2-7b", output_modalities: ["text"], supported_features: ["json_mode"] },
	{ id: "meta-llama/llama-prompt-guard-2-22m", output_modalities: ["text"] },
	{ id: "meta-llama/llama-prompt-guard-2-86m", output_modalities: ["text"], supported_features: ["json_mode"] },
	{ id: "canopylabs/orpheus-v1-english", output_modalities: ["speech"] },
	{ id: "canopylabs/orpheus-arabic-saudi", output_modalities: ["speech"] },
	{ id: "whisper-large-v3", output_modalities: ["transcription"] },
	{ id: "whisper-large-v3-turbo", output_modalities: ["transcription"] },
];

describe("Groq provider discovery", () => {
	test("the live chat models replace the bundled list; retired, speech, transcription and classifier ids go", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
			return Response.json({
				object: "list",
				data: LIVE.map(row => ({ ...row, object: "model", active: true, context_window: 131072 })),
			});
		};
		expect(getBundledModels("groq").some(model => model.id === "llama3-70b-8192")).toBe(true);

		const options = groqModelManagerOptions({ apiKey: "gsk-test", fetch: fetchMock });
		expect(options.dynamicModelsAuthoritative).toBe(true);
		const dbPath = path.join(os.tmpdir(), `groq-discovery-${Bun.randomUUIDv7()}.db`);
		const result = await createModelManager({ ...options, cacheDbPath: dbPath }).refresh("online");

		expect(calls).toEqual([{ url: "https://api.groq.com/openai/v1/models", authorization: "Bearer gsk-test" }]);
		expect(result.models.map(model => model.id).sort()).toEqual([
			"openai/gpt-oss-120b",
			"openai/gpt-oss-20b",
			"openai/gpt-oss-safeguard-20b",
			"qwen/qwen3.8-27b",
		]);
	});

	test("without a key, the bundled catalog stays", () => {
		const options = groqModelManagerOptions();
		expect(options.fetchDynamicModels).toBeUndefined();
	});
});
