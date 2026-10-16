import { afterEach, describe, expect, test, vi } from "bun:test";
import { litellmModelManagerOptions } from "../src/provider-models/openai-compat";
import { isConcurrencyAdmissionRejection } from "../src/providers/openai-completions";

const originalLiteLLMApiKey = Bun.env.LITELLM_API_KEY;
const originalFetch = global.fetch;

afterEach(() => {
	if (originalLiteLLMApiKey === undefined) {
		delete Bun.env.LITELLM_API_KEY;
	} else {
		Bun.env.LITELLM_API_KEY = originalLiteLLMApiKey;
	}
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

function mockModelsResponse(data: Record<string, unknown>[]) {
	global.fetch = vi.fn(
		async () =>
			new Response(JSON.stringify({ data }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
	) as unknown as typeof fetch;
}

describe("litellm native provider routing", () => {
	test("routes anthropic-prefixed models to anthropic-messages with passthrough URL", async () => {
		mockModelsResponse([{ id: "anthropic/claude-sonnet-4-20250514", owned_by: "anthropic" }]);

		const options = litellmModelManagerOptions({ apiKey: "test-key" });
		const models = await options.fetchDynamicModels?.();

		const model = models?.find(m => m.id === "claude-sonnet-4-20250514");
		expect(model).toBeDefined();
		expect(model?.api).toBe("anthropic-messages");
		expect(model?.baseUrl).toBe("http://localhost:4000/anthropic");
		expect(model?.provider).toBe("litellm");
	});

	test("routes bare claude model IDs to anthropic-messages", async () => {
		mockModelsResponse([{ id: "claude-opus-4-20250514", owned_by: "openai" }]);

		const options = litellmModelManagerOptions({ apiKey: "test-key" });
		const models = await options.fetchDynamicModels?.();

		const model = models?.find(m => m.id === "claude-opus-4-20250514");
		expect(model).toBeDefined();
		expect(model?.api).toBe("anthropic-messages");
		expect(model?.baseUrl).toBe("http://localhost:4000/anthropic");
		expect(model?.provider).toBe("litellm");
	});

	test("routes owned_by=anthropic models without claude in name", async () => {
		mockModelsResponse([{ id: "some-custom-model", owned_by: "Anthropic" }]);

		const options = litellmModelManagerOptions({ apiKey: "test-key" });
		const models = await options.fetchDynamicModels?.();

		const model = models?.find(m => m.id === "some-custom-model");
		expect(model).toBeDefined();
		expect(model?.api).toBe("anthropic-messages");
		expect(model?.baseUrl).toBe("http://localhost:4000/anthropic");
	});

	test("routes google-prefixed models to google-generative-ai with passthrough URL", async () => {
		mockModelsResponse([{ id: "google/gemini-2.5-pro", owned_by: "google" }]);

		const options = litellmModelManagerOptions({ apiKey: "test-key" });
		const models = await options.fetchDynamicModels?.();

		const model = models?.find(m => m.id === "gemini-2.5-pro");
		expect(model).toBeDefined();
		expect(model?.api).toBe("google-generative-ai");
		expect(model?.baseUrl).toBe("http://localhost:4000/gemini");
		expect(model?.provider).toBe("litellm");
	});

	test("routes vertex_ai-prefixed models to google-generative-ai", async () => {
		mockModelsResponse([{ id: "vertex_ai/gemini-2.5-flash", owned_by: "google" }]);

		const options = litellmModelManagerOptions({ apiKey: "test-key" });
		const models = await options.fetchDynamicModels?.();

		const model = models?.find(m => m.id === "gemini-2.5-flash");
		expect(model).toBeDefined();
		expect(model?.api).toBe("google-generative-ai");
		expect(model?.baseUrl).toBe("http://localhost:4000/gemini");
	});

	test("routes bare gemini model IDs to google-generative-ai", async () => {
		mockModelsResponse([{ id: "gemini-2.0-flash", owned_by: "openai" }]);

		const options = litellmModelManagerOptions({ apiKey: "test-key" });
		const models = await options.fetchDynamicModels?.();

		const model = models?.find(m => m.id === "gemini-2.0-flash");
		expect(model).toBeDefined();
		expect(model?.api).toBe("google-generative-ai");
		expect(model?.baseUrl).toBe("http://localhost:4000/gemini");
	});

	test("keeps non-claude non-gemini models on openai-completions", async () => {
		mockModelsResponse([{ id: "gpt-4o", owned_by: "openai" }]);

		const options = litellmModelManagerOptions({ apiKey: "test-key" });
		const models = await options.fetchDynamicModels?.();

		const model = models?.find(m => m.id === "gpt-4o");
		expect(model).toBeDefined();
		expect(model?.api).toBe("openai-completions");
		expect(model?.baseUrl).toBe("http://localhost:4000/v1");
		expect(model?.provider).toBe("litellm");
	});

	test("strips bedrock/anthropic. prefix for bedrock claude models", async () => {
		mockModelsResponse([{ id: "bedrock/anthropic.claude-v2", owned_by: "anthropic" }]);

		const options = litellmModelManagerOptions({ apiKey: "test-key" });
		const models = await options.fetchDynamicModels?.();

		const model = models?.find(m => m.id === "claude-v2");
		expect(model).toBeDefined();
		expect(model?.api).toBe("anthropic-messages");
		expect(model?.baseUrl).toBe("http://localhost:4000/anthropic");
	});

	test("preserves original ID for openai-compat models (no prefix stripping)", async () => {
		mockModelsResponse([{ id: "deepseek/deepseek-chat", owned_by: "deepseek" }]);

		const options = litellmModelManagerOptions({ apiKey: "test-key" });
		const models = await options.fetchDynamicModels?.();

		const model = models?.find(m => m.id === "deepseek/deepseek-chat");
		expect(model).toBeDefined();
		expect(model?.api).toBe("openai-completions");
		expect(model?.baseUrl).toBe("http://localhost:4000/v1");
	});

	test("uses custom baseUrl and derives passthrough URLs from it", async () => {
		mockModelsResponse([
			{ id: "anthropic/claude-haiku-3-5", owned_by: "anthropic" },
			{ id: "gpt-4o-mini", owned_by: "openai" },
		]);

		const options = litellmModelManagerOptions({
			apiKey: "test-key",
			baseUrl: "https://my-proxy.example.com/v1",
		});
		const models = await options.fetchDynamicModels?.();

		const claude = models?.find(m => m.id === "claude-haiku-3-5");
		expect(claude?.baseUrl).toBe("https://my-proxy.example.com/anthropic");

		const gpt = models?.find(m => m.id === "gpt-4o-mini");
		expect(gpt?.baseUrl).toBe("https://my-proxy.example.com/v1");
	});

	test("handles mixed model list with correct routing for each", async () => {
		mockModelsResponse([
			{ id: "anthropic/claude-sonnet-4-20250514", owned_by: "anthropic" },
			{ id: "google/gemini-2.5-pro", owned_by: "google" },
			{ id: "gpt-4o", owned_by: "openai" },
			{ id: "mistral-large-latest", owned_by: "mistral" },
		]);

		const options = litellmModelManagerOptions({ apiKey: "test-key" });
		const models = await options.fetchDynamicModels?.();
		expect(models).toHaveLength(4);

		const claude = models?.find(m => m.id === "claude-sonnet-4-20250514");
		expect(claude?.api).toBe("anthropic-messages");

		const gemini = models?.find(m => m.id === "gemini-2.5-pro");
		expect(gemini?.api).toBe("google-generative-ai");

		const gpt = models?.find(m => m.id === "gpt-4o");
		expect(gpt?.api).toBe("openai-completions");

		const mistral = models?.find(m => m.id === "mistral-large-latest");
		expect(mistral?.api).toBe("openai-completions");
	});

	test("custom model aliases gracefully fall through to openai-completions", async () => {
		mockModelsResponse([{ id: "my-fast-model", owned_by: "system" }]);

		const options = litellmModelManagerOptions({ apiKey: "test-key" });
		const models = await options.fetchDynamicModels?.();

		const model = models?.find(m => m.id === "my-fast-model");
		expect(model).toBeDefined();
		expect(model?.api).toBe("openai-completions");
		expect(model?.baseUrl).toBe("http://localhost:4000/v1");
	});
});

describe("litellm concurrency-admission 429", () => {
	const rejection = (headers: Record<string, string>, body?: string) =>
		isConcurrencyAdmissionRejection(new Response(null, { status: 429, headers }), body);

	test("detects the marker in the rate_limit_type response header", () => {
		expect(rejection({ rate_limit_type: "max_parallel_requests" })).toBe(true);
		expect(rejection({ rate_limit_type: " max_parallel_requests " })).toBe(true);
	});

	test("detects the marker in a structured error body", () => {
		expect(rejection({}, '{"error":{"rate_limit_type":"max_parallel_requests"}}')).toBe(true);
		expect(rejection({}, '{"rate_limit_type": "max_parallel_requests"}')).toBe(true);
	});

	test("leaves genuine RPM/quota 429s to the transport retry loop", () => {
		expect(rejection({ "retry-after": "60" }, '{"error":{"message":"rate limit exceeded"}}')).toBe(false);
		expect(rejection({ rate_limit_type: "requests_per_minute" })).toBe(false);
		expect(rejection({})).toBe(false);
	});
});
