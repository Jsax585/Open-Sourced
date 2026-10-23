import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	completeSimple,
	type Context,
	streamSimple,
	type Usage,
	type UserMessage,
} from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import * as settingsModule from "@oh-my-pi/pi-coding-agent/config/settings";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	buildLocalInferenceMessages,
	registerLocalInferenceApi,
} from "@oh-my-pi/pi-coding-agent/tiny/local-inference-api";
import { TINY_LOCAL_MODELS, isTinyJudgeLocalModelKey } from "@oh-my-pi/pi-coding-agent/tiny/models";
import {
	type TinyModelChatOptions,
	TinyTitleClient,
	modelEnvKey,
	onnxLaunch,
	tinyModelClient,
} from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import type {
	TinyChatMessage,
	TinyWorkerRequest,
	TinyWorkerResponse,
} from "@oh-my-pi/pi-coding-agent/tiny/title-protocol";
import {
	isRequestScopedError,
	markRequestScoped,
	REQUEST_SCOPED_ERROR,
} from "@oh-my-pi/pi-coding-agent/tiny/worker-server";

const SOURCE_ID = "omp/local-inference";
const model = getBundledModel("local", "lfm2.5-230m")!;

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "local-inference",
		provider: "local",
		model: model.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: 2,
	};
}

function userMessage(content: string, timestamp = 1): UserMessage {
	return { role: "user", content, timestamp };
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

class FakeTinyWorker {
	terminated = false;
	refCalls = 0;
	unrefCalls = 0;
	#messageHandlers = new Set<(message: TinyWorkerResponse) => void>();
	#errorHandlers = new Set<(error: Error) => void>();
	#onSend: (message: TinyWorkerRequest, worker: FakeTinyWorker) => void;

	constructor(onSend: (message: TinyWorkerRequest, worker: FakeTinyWorker) => void) {
		this.#onSend = onSend;
	}

	send(message: TinyWorkerRequest): void {
		this.#onSend(message, this);
	}

	onMessage(handler: (message: TinyWorkerResponse) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorHandlers.add(handler);
		return () => this.#errorHandlers.delete(handler);
	}

	async terminate(): Promise<void> {
		this.terminated = true;
	}

	ref(): void {
		this.refCalls += 1;
	}

	unref(): void {
		this.unrefCalls += 1;
	}

	emit(message: TinyWorkerResponse): void {
		for (const handler of this.#messageHandlers) handler(message);
	}
}

describe("local inference API", () => {
	beforeEach(() => registerLocalInferenceApi());

	afterEach(() => {
		vi.restoreAllMocks();
		unregisterCustomApis(SOURCE_ID);
	});

	it("flattens assistant context into following user turns and completes through the registered API", async () => {
		let requestedModel: string | undefined;
		let requestedMessages: readonly TinyChatMessage[] | undefined;
		let requestedOptions: TinyModelChatOptions | undefined;
		vi.spyOn(tinyModelClient, "chat").mockImplementation(async (modelKey, messages, options) => {
			requestedModel = modelKey;
			requestedMessages = messages;
			requestedOptions = options;
			return "local answer";
		});
		const context: Context = {
			systemPrompt: ["first system", "second system"],
			messages: [
				userMessage("first user"),
				assistantMessage("assistant context"),
				userMessage("next user", 3),
				assistantMessage("trailing assistant"),
			],
		};

		const result = await completeSimple(model, context, { maxTokens: 37 });

		expect(requestedModel).toBe("lfm2.5-230m");
		expect(requestedMessages).toEqual([
			{ role: "system", content: "first system" },
			{ role: "system", content: "second system" },
			{ role: "user", content: "first user" },
			{ role: "user", content: "assistant context\n\nnext user" },
			{ role: "user", content: "trailing assistant" },
		]);
		expect(requestedOptions).toMatchObject({ maxTokens: 37 });
		expect(result).toMatchObject({
			content: [{ type: "text", text: "local answer" }],
			stopReason: "stop",
			usage: zeroUsage(),
		});
	});

	it("emits the complete assistant text event sequence", async () => {
		vi.spyOn(tinyModelClient, "chat").mockResolvedValue("local answer");
		const stream = streamSimple(model, { messages: [userMessage("question")] });
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(events[2]).toMatchObject({ type: "text_delta", contentIndex: 0, delta: "local answer" });
		expect(result).toMatchObject({
			content: [{ type: "text", text: "local answer" }],
			stopReason: "stop",
			usage: zeroUsage(),
		});
	});

	it("emits an error instead of a successful empty completion when the worker produces no output", async () => {
		vi.spyOn(tinyModelClient, "chat").mockResolvedValue(null);
		const stream = streamSimple(model, { messages: [userMessage("question")] });
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(events.map(event => event.type)).toEqual(["start", "error"]);
		expect(events.at(-1)).toMatchObject({
			type: "error",
			reason: "error",
			error: { stopReason: "error", errorMessage: "Local inference returned no output." },
		});
		expect(result).toMatchObject({ stopReason: "error", content: [], usage: zeroUsage() });
	});

	it("keeps cancellation distinct from worker failure", async () => {
		vi.spyOn(tinyModelClient, "chat").mockImplementation(async (_modelKey, _messages, options) => {
			const signal = options?.signal;
			if (!signal) throw new Error("missing test signal");
			if (!signal.aborted) {
				await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
			}
			return null;
		});
		const controller = new AbortController();
		const stream = streamSimple(model, { messages: [userMessage("question")] }, { signal: controller.signal });
		controller.abort(new Error("cancelled locally"));
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(events.map(event => event.type)).toEqual(["start", "error"]);
		expect(events.at(-1)).toMatchObject({
			type: "error",
			reason: "aborted",
			error: { stopReason: "aborted", errorMessage: "cancelled locally" },
		});
		expect(result.stopReason).toBe("aborted");
	});

	it("rejects non-tiny local models before invoking the worker client", async () => {
		const chat = vi.spyOn(tinyModelClient, "chat").mockResolvedValue("should not run");
		const nonTinyModel = getBundledModel("local", "kokoro")!;
		const stream = streamSimple(nonTinyModel, { messages: [userMessage("question")] });
		const result = await stream.result();

		expect(chat).not.toHaveBeenCalled();
		expect(result).toMatchObject({ stopReason: "error", content: [] });
	});

	it("builds worker messages without dropping text-only structured content", () => {
		expect(
			buildLocalInferenceMessages({
				messages: [
					{ role: "developer", content: [{ type: "text", text: "developer instruction" }], timestamp: 1 },
					{ role: "user", content: [{ type: "text", text: "structured user" }], timestamp: 2 },
				],
			}),
		).toEqual([
			{ role: "system", content: "developer instruction" },
			{ role: "user", content: "structured user" },
		]);
	});
});

describe("tiny model chat client", () => {
	it("accepts every local tiny model key and clamps requested output tokens", async () => {
		const connected: string[] = [];
		const requests: TinyWorkerRequest[] = [];
		const client = new TinyTitleClient(async modelKey => {
			connected.push(modelKey);
			return new FakeTinyWorker((request, worker) => {
				requests.push(request);
				if (request.type === "chat") worker.emit({ type: "text", id: request.id, text: modelKey });
			});
		});

		try {
			const chatSpecs = TINY_LOCAL_MODELS.filter(spec => !isTinyJudgeLocalModelKey(spec.key));
			for (const [index, spec] of chatSpecs.entries()) {
				const maxTokens = index === 0 ? 0 : 100_000;
				expect(await client.chat(spec.key, [{ role: "user", content: "hello" }], { maxTokens })).toBe(spec.key);
			}
			expect(connected).toEqual(chatSpecs.map(spec => spec.key));
			expect(requests.map(request => (request.type === "chat" ? request.maxNewTokens : undefined))).toEqual([
				1,
				...chatSpecs.slice(1).map(() => 1024),
			]);
			expect(await client.chat("julia-1", [{ role: "user", content: "hi" }], {})).toBeNull();
			expect(connected).not.toContain("julia-1");
		} finally {
			await client.terminate();
		}
	});

	it("resolves an in-flight chat as null when its signal aborts", async () => {
		const worker = new FakeTinyWorker(() => {});
		const client = new TinyTitleClient(async () => worker);
		const controller = new AbortController();

		try {
			const completion = client.chat("lfm2.5-230m", [{ role: "user", content: "hello" }], {
				signal: controller.signal,
			});
			controller.abort();

			expect(await completion).toBeNull();
		} finally {
			await client.terminate();
		}
	});

	it("returns null from generate() for judge keys without connecting a worker", async () => {
		const connected: string[] = [];
		const client = new TinyTitleClient(async modelKey => {
			connected.push(modelKey);
			return new FakeTinyWorker(() => {});
		});

		try {
			expect(await client.generate("julia-1", "hi")).toBeNull();
			expect(connected).not.toContain("julia-1");
		} finally {
			await client.terminate();
		}
	});

	it("returns null from judge() for non-judge keys without connecting a worker", async () => {
		const connected: string[] = [];
		const client = new TinyTitleClient(async modelKey => {
			connected.push(modelKey);
			return new FakeTinyWorker(() => {});
		});

		try {
			expect(
				await client.judge("lfm2.5-230m", "s", {
					q: { type: "noul", instructions: "i", options: ["no", "yes"] },
				}),
			).toEqual({ logits: null });
			expect(connected).not.toContain("lfm2.5-230m");
		} finally {
			await client.terminate();
		}
	});

	it("prewarms and generates titles with memory-group tiny models", async () => {
		const firstRequest = Promise.withResolvers<TinyWorkerRequest>();
		const worker = new FakeTinyWorker((request, current) => {
			firstRequest.resolve(request);
			if (request.type === "chat")
				current.emit({ type: "text", id: request.id, text: "Memory Model Title</title>" });
		});
		const client = new TinyTitleClient(async () => worker);

		try {
			client.prewarm("qwen3-1.7b");
			expect(await firstRequest.promise).toMatchObject({ type: "ping" });
			expect(await client.generate("qwen3-1.7b", "title this session")).toBe("Memory Model Title");
		} finally {
			await client.terminate();
		}
	});
	it("returns error without poisoning model or dropping worker when fatal is false", async () => {
		let callCount = 0;
		const worker = new FakeTinyWorker((request, current) => {
			callCount += 1;
			if (request.type === "judge") {
				if (request.state === "invalid") {
					current.emit({
						type: "error",
						id: request.id,
						error: 'judge question "q": empty option string at index 0',
						fatal: false,
					});
				} else {
					current.emit({
						type: "judged",
						id: request.id,
						logits: { q: [0.2, 0.8] },
					});
				}
			}
		});
		const client = new TinyTitleClient(async () => worker);

		try {
			const result1 = await client.judge("julia-1", "invalid", {
				q: { type: "noul", instructions: "i", options: ["no", "yes"] },
			});
			expect(result1).toEqual({
				logits: null,
				error: 'judge question "q": empty option string at index 0',
			});
			expect(worker.terminated).toBe(false);

			const result2 = await client.judge("julia-1", "valid", {
				q: { type: "noul", instructions: "i", options: ["no", "yes"] },
			});
			expect(result2).toEqual({ logits: { q: [0.2, 0.8] } });
			expect(callCount).toBe(2);
			expect(worker.terminated).toBe(false);
		} finally {
			await client.terminate();
		}
	});

	it("preserves sibling in-flight requests when one request fails non-fatally", async () => {
		const requests: TinyWorkerRequest[] = [];
		let currentWorker: FakeTinyWorker;
		const worker = new FakeTinyWorker((request, current) => {
			currentWorker = current;
			requests.push(request);
		});
		const client = new TinyTitleClient(async () => worker);

		try {
			const req1 = client.judge("julia-1", "req1", {
				q: { type: "noul", instructions: "i", options: ["no", "yes"] },
			});
			const req2 = client.judge("julia-1", "req2", {
				q: { type: "noul", instructions: "i", options: ["no", "yes"] },
			});

			while (requests.length < 2) {
				await new Promise(r => setTimeout(r, 1));
			}
			expect(requests.length).toBe(2);

			currentWorker!.emit({
				type: "error",
				id: requests[0]!.id,
				error: "validation failure",
				fatal: false,
			});
			currentWorker!.emit({
				type: "judged",
				id: requests[1]!.id,
				logits: { q: [0.3, 0.7] },
			});

			const [res1, res2] = await Promise.all([req1, req2]);
			expect(res1).toEqual({ logits: null, error: "validation failure" });
			expect(res2).toEqual({ logits: { q: [0.3, 0.7] } });
			expect(worker.terminated).toBe(false);
		} finally {
			await client.terminate();
		}
	});

	it("poisons model and drops worker when fatal error occurs", async () => {
		let connectCount = 0;
		const worker = new FakeTinyWorker((request, current) => {
			if (request.type === "judge") {
				current.emit({
					type: "error",
					id: request.id,
					error: "CUDA out of memory",
				});
			}
		});
		const client = new TinyTitleClient(async () => {
			connectCount += 1;
			return worker;
		});

		try {
			const result1 = await client.judge("julia-1", "state1", {
				q: { type: "noul", instructions: "i", options: ["no", "yes"] },
			});
			expect(result1).toEqual({ logits: null, error: "CUDA out of memory" });
			expect(worker.terminated).toBe(true);

			// Subsequent request is poisoned - returns null logits immediately without reconnecting
			const result2 = await client.judge("julia-1", "state2", {
				q: { type: "noul", instructions: "i", options: ["no", "yes"] },
			});
			expect(result2).toEqual({ logits: null });
			expect(connectCount).toBe(1);
		} finally {
			await client.terminate();
		}
	});
});

describe("judge worker device independence", () => {
	it("proves judge launch tag ignores device/dtype env", () => {
		const judgeDefault = onnxLaunch("julia-1", {});
		const judgeWithDevice = onnxLaunch("julia-1", {
			PI_TINY_DEVICE: "webgpu",
			PI_TINY_DTYPE: "fp16",
		});
		expect(judgeWithDevice.tag).toBe(judgeDefault.tag);
		expect(judgeWithDevice.tag).toMatch(/\|onnx\|\|$/);

		const chatWithDevice = onnxLaunch("lfm2.5-230m", {
			PI_TINY_DEVICE: "webgpu",
			PI_TINY_DTYPE: "fp16",
		});
		expect(chatWithDevice.tag).toMatch(/\|onnx\|webgpu\|fp16$/);
	});

	it("keeps the judge env key stable across device flips that move chat keys", () => {
		// The judge key feeds #failedModels: stability means a fatal judge error
		// stays failed (no silent un-fail) and a healthy judge worker is never
		// dropped as stale when the user flips providers.tinyModelDevice.
		// Local restore: this describe has no afterEach(vi.restoreAllMocks),
		// so a leaked spy would poison every later test in the file.
		const spy = vi.spyOn(settingsModule, "isSettingsInitialized").mockReturnValue(false);
		const device = process.env.PI_TINY_DEVICE;
		const dtype = process.env.PI_TINY_DTYPE;
		try {
			process.env.PI_TINY_DEVICE = "cpu";
			process.env.PI_TINY_DTYPE = "q8";
			expect(modelEnvKey("julia-1")).toBe("judge");
			const chatBefore = modelEnvKey("lfm2.5-230m");
			process.env.PI_TINY_DEVICE = "webgpu";
			process.env.PI_TINY_DTYPE = "fp16";
			expect(modelEnvKey("julia-1")).toBe("judge");
			expect(modelEnvKey("lfm2.5-230m")).not.toBe(chatBefore);
		} finally {
			spy.mockRestore();
			if (device === undefined) delete process.env.PI_TINY_DEVICE;
			else process.env.PI_TINY_DEVICE = device;
			if (dtype === undefined) delete process.env.PI_TINY_DTYPE;
			else process.env.PI_TINY_DTYPE = dtype;
		}
	});
});

describe("worker request-scoped error marker", () => {
	it("recognizes errors marked with markRequestScoped", () => {
		const error = markRequestScoped(new Error("validation error"));
		expect(isRequestScopedError(error)).toBe(true);
		expect((error as unknown as Record<string, unknown>).requestScoped).toBe(true);
		expect(REQUEST_SCOPED_ERROR in error).toBe(true);
	});

	it("duck-types error with requestScoped boolean property", () => {
		expect(isRequestScopedError({ requestScoped: true })).toBe(true);
		expect(isRequestScopedError({ requestScoped: false })).toBe(false);
		expect(isRequestScopedError(new Error("plain error"))).toBe(false);
		expect(isRequestScopedError(null)).toBe(false);
		expect(isRequestScopedError(undefined)).toBe(false);
		expect(isRequestScopedError("string")).toBe(false);
	});
});
