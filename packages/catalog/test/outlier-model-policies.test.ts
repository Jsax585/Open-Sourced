import { describe, expect, test } from "bun:test";
import { buildModel } from "../src/build";
import { seedModels } from "../src/compat/providers";
import type { Api, ModelSpec } from "../src/types";

function chatSpec(provider: string, api: Api, id = "policy-probe"): ModelSpec<Api> {
	return {
		id,
		name: "Policy Probe",
		api,
		provider,
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_000,
	};
}

describe("outlier catalog policies", () => {
	test("seed rules distinguish local speech, dictation, and tiny role candidates", () => {
		const local = Object.fromEntries(seedModels("local").map(spec => [spec.id, buildModel(spec)]));
		expect(local.kokoro?.kind).toBe("tts");
		expect(local["parakeet-tdt-0.6b-v3"]?.kind).toBe("stt");
		expect(local["nemotron-streaming-en-0.6b"]?.kind).toBe("stt");
		expect(local["whisper-large-v3-turbo"]?.kind).toBe("stt");
		expect(local["lfm2.5-230m"]?.kind).toBe("tiny");
		expect(buildModel(chatSpec("typesafe", "typesafe")).kind).toBe("judge");
		expect(buildModel(chatSpec("web", "web-search")).kind).toBe("search");
	});

	test("hosted seeds retain the kinds required by their dedicated runners", () => {
		const cases = [
			["openai-codex", "gpt-image-2", "image"],
			["google-antigravity", "gemini-3-pro-image", "image"],
			["deepinfra", "black-forest-labs/FLUX-2-pro", "image"],
			["deepinfra", "hexgrad/Kokoro-82M", "tts"],
			["xai", "grok-tts", "tts"],
			["xai-oauth", "grok-imagine-image", "image"],
			["xai-oauth", "grok-tts", "tts"],
		] as const;
		for (const [provider, id, kind] of cases) {
			const spec = seedModels(provider).find(model => model.id === id);
			if (!spec) throw new Error(`Missing runner seed: ${provider}/${id}`);
			expect(buildModel(spec).kind).toBe(kind);
		}
	});

	test("discovered Antigravity image SKUs build as image models while sibling Flash SKUs stay chat", () => {
		// Antigravity discovery emits image SKUs as text-only rows without a kind.
		const image = buildModel(chatSpec("google-antigravity", "google-gemini-cli", "gemini-3.1-flash-image"));
		const chat = buildModel(chatSpec("google-antigravity", "google-gemini-cli", "gemini-3.1-flash-lite"));
		expect(image.kind).toBe("image");
		expect(chat.kind).toBeUndefined();
	});

	test("chat providers carry their grounding capability", () => {
		const cases = [
			["google", "google-generative-ai", "gemini"],
			["google-antigravity", "google-gemini-cli", "gemini"],
			["anthropic", "anthropic-messages", "anthropic"],
			["openai-codex", "openai-codex-responses", "codex"],
			["xai", "openai-responses", "xai"],
			["xai-oauth", "openai-responses", "xai"],
			["openrouter", "openrouter", "openrouter"],
		] as const;
		for (const [provider, api, grounding] of cases) {
			expect(buildModel(chatSpec(provider, api)).webSearch).toBe(grounding);
		}
	});

	test("OpenAI grounding excludes Realtime-only models from Responses web search", () => {
		expect(buildModel(chatSpec("openai", "openai-responses", "gpt-6-luna")).webSearch).toBe("openai");
		expect(buildModel(chatSpec("openai", "openai-responses", "gpt-realtime-2.1")).webSearch).toBeUndefined();
	});

	test("MiniMax M3.1 keeps its model-intrinsic rules on proxy providers", () => {
		const cases = [
			["litellm", "anthropic-messages", "MiniMax-M3.1-Flash"],
			["litellm", "anthropic-messages", "MiniMax-M3.1-Flash-Preview"],
			["ollama-cloud", "ollama-chat", "minimax-m3.1-flash"],
			["opencode-go", "openai-completions", "minimax-m3.1-flash-free"],
			["openrouter", "openrouter", "minimax/minimax-m3.1-flash:free"],
		] as const;
		for (const [provider, api, id] of cases) {
			const model = buildModel({ ...chatSpec(provider, api, id), reasoning: true });
			expect(model.thinking).toMatchObject({
				efforts: ["low", "medium", "high", "xhigh", "max"],
				requiresEffort: true,
			});
			if (api === "anthropic-messages") {
				expect(model.thinking?.mode).toBe("anthropic-adaptive");
			}
		}

		const neutral = buildModel(chatSpec("litellm", "anthropic-messages", "MiniMax-M3.1-Flash"));
		expect(neutral.reasoning).toBe(true);
		expect(neutral.thinking).toMatchObject({
			efforts: ["low", "medium", "high", "xhigh", "max"],
			requiresEffort: true,
		});

		// The sampling axis is not part of the Ollama compat record; Ollama's
		// native API owns that surface rather than the model-row declaration.
		const launch = buildModel({
			...chatSpec("litellm", "anthropic-messages", "MiniMax-M3.1-Flash"),
			reasoning: true,
		});
		expect(launch.compat).toMatchObject({ supportsSamplingParams: false });
	});
});
