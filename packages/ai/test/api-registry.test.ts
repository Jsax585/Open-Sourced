import { afterEach, describe, expect, test } from "bun:test";
import {
	type CustomStreamSimpleFn,
	clearCustomApis,
	getCustomApi,
	registerCustomApi,
	unregisterCustomApis,
} from "@oh-my-pi/pi-ai/api-registry";
import { streamSimple as streamWithRegistry } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessageEventStream, Model, ModelSpec, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

afterEach(() => {
	clearCustomApis();
});

describe("custom API registry", () => {
	const streamSimple: CustomStreamSimpleFn = () => ({}) as unknown as AssistantMessageEventStream;

	test("rejects registrations that collide with built-in API names", () => {
		expect(() => registerCustomApi("openai-responses", streamSimple)).toThrow(
			'Cannot register custom API "openai-responses": built-in API names are reserved.',
		);
	});

	test("unregisterCustomApis removes only matching source registrations", () => {
		registerCustomApi("custom-a", streamSimple, "ext-a");
		registerCustomApi("custom-b", streamSimple, "ext-b");

		unregisterCustomApis("ext-a");

		expect(getCustomApi("custom-a")).toBeUndefined();
		expect(getCustomApi("custom-b")).toBeDefined();
	});

	test("clearCustomApis removes all custom APIs", () => {
		registerCustomApi("custom-a", streamSimple, "ext-a");
		registerCustomApi("custom-b", streamSimple, "ext-b");

		clearCustomApis();

		expect(getCustomApi("custom-a")).toBeUndefined();
		expect(getCustomApi("custom-b")).toBeUndefined();
	});

	test("drops the retained effort when a request turns thinking off", () => {
		const received: SimpleStreamOptions[] = [];
		registerCustomApi("custom-a", (_model, _context, options) => {
			if (options) received.push(options);
			return streamSimple(_model, _context, options);
		});
		const model = buildModel({
			id: "custom-model",
			name: "Custom",
			provider: "custom-provider",
			baseUrl: "https://example.com",
			api: "custom-a",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8_192,
			maxTokens: 1_024,
		} as ModelSpec<Api>) as Model<Api>;
		const context = { messages: [] };

		streamWithRegistry(model, context, { apiKey: "key", reasoning: Effort.High, disableReasoning: true });
		streamWithRegistry(model, context, { apiKey: "key", reasoning: Effort.High, thinkingMode: "off" });
		streamWithRegistry(model, context, { apiKey: "key", reasoning: Effort.High });

		expect(received.map(options => options.reasoning)).toEqual([undefined, undefined, Effort.High]);
		expect(received[0]?.disableReasoning).toBe(true);
	});
});
