import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { JudgmentParseError } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { JudgeQuestionPayload, TinyWorkerRequest } from "@oh-my-pi/pi-coding-agent/tiny/title-protocol";
import { LocalJudge } from "@oh-my-pi/pi-coding-agent/judgment/local-judge";
import { tinyModelClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { getTinyLocalModelSpec } from "@oh-my-pi/pi-coding-agent/tiny/models";
import { isRequestScopedError } from "@oh-my-pi/pi-coding-agent/tiny/worker-server";
import { JuliaJudgeModel } from "@oh-my-pi/pi-coding-agent/tiny/worker";
import { JUDGE_MAX_BATCH_QUESTIONS } from "@oh-my-pi/pi-coding-agent/tiny/judge-serialize";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("LocalJudge", () => {
	it("maps argmax logits to the winning choice label (wrong winner surfaced to callers)", async () => {
		spyOn(tinyModelClient, "judge").mockResolvedValue({ logits: { q: [0, 3, 1] } });
		const judge = new LocalJudge("julia-1");

		const result = await judge.judge({
			state: "refactor the scheduler",
			questions: {
				q: {
					type: "choice",
					instructions: "pick a bucket",
					criteria: { low: "minor issue", mid: "moderate issue", high: "critical issue" },
				},
			},
		});

		const answer = result.answers.q;
		expect(answer.choice).toBe("mid");
		const probabilities = Object.values(answer.probabilities);
		expect(probabilities.reduce((sum, probability) => sum + probability, 0)).toBeCloseTo(1, 10);
		expect(answer.confidence).toBe(Math.max(...probabilities));
	});

	it("reports noul as softmax(logits)[1] (inverted yes/no)", async () => {
		spyOn(tinyModelClient, "judge").mockResolvedValue({ logits: { q: [0.5, 1.5] } });
		const judge = new LocalJudge("julia-1");

		const result = await judge.judge({
			state: "refactor the scheduler",
			questions: { q: { type: "noul", instructions: "does it hold?" } },
		});

		// softmax([0.5, 1.5])[1] = 1 / (1 + e^-1) ≈ 0.731.
		expect(result.answers.q.noul).toBeCloseTo(0.731, 3);
		expect(result.answers.q.noul).toBeGreaterThan(0.5);
	});

	it("scores the probability-weighted level index with string keys (wrong expected index)", async () => {
		spyOn(tinyModelClient, "judge").mockResolvedValue({ logits: { q: [0, 0, 10, 0] } });
		const judge = new LocalJudge("julia-1");

		const result = await judge.judge({
			state: "refactor the scheduler",
			questions: {
				q: {
					type: "score",
					instructions: "rate severity",
					criteria: ["none", "low", "high", "critical"],
				},
			},
		});

		const answer = result.answers.q;
		expect(answer.score).toBeCloseTo(2, 3);
		expect(Object.keys(answer.probabilities).sort()).toEqual(["0", "1", "2", "3"]);
	});

	it("sends rubric-suffixed choice options and [false, true] noul order (model scores wrong option strings)", async () => {
		const seen: Array<Record<string, JudgeQuestionPayload>> = [];
		spyOn(tinyModelClient, "judge").mockImplementation(async (_model, _state, questions) => {
			seen.push(questions);
			return { logits: { q: [5, 0] } };
		});
		const judge = new LocalJudge("julia-1");

		await judge.judge({
			state: "refactor the scheduler",
			questions: {
				q: {
					type: "choice",
					instructions: "pick a bucket",
					criteria: { fast: "finishes in ms", slow: null },
				},
			},
		});
		await judge.judge({
			state: "refactor the scheduler",
			questions: {
				q: {
					type: "noul",
					instructions: "does it hold?",
					criteria: { true: "means yes", false: "means no" },
				},
			},
		});

		expect(seen[0].q).toEqual({
			type: "choice",
			instructions: "pick a bucket",
			options: ["fast: finishes in ms", "slow"],
		});
		expect(seen[1].q).toEqual({
			type: "noul",
			instructions: "does it hold?",
			options: ["means no", "means yes"],
		});
	});

	it("throws JudgmentParseError on logit-count mismatch (silent mis-mapping)", async () => {
		spyOn(tinyModelClient, "judge").mockResolvedValue({ logits: { q: [1, 2, 3] } });
		const judge = new LocalJudge("julia-1");

		let error: unknown;
		try {
			await judge.judge({
				state: "refactor the scheduler",
				questions: {
					q: {
						type: "choice",
						instructions: "pick a tier",
						criteria: { low: null, high: null },
					},
				},
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(JudgmentParseError);
	});

	it("propagates the abort reason instead of masking it as no-output", async () => {
		spyOn(tinyModelClient, "judge").mockResolvedValue({ logits: null });
		const judge = new LocalJudge("julia-1");
		const controller = new AbortController();
		controller.abort();

		let error: unknown;
		try {
			await judge.judge(
				{
					state: "refactor the scheduler",
					questions: {
						q: {
							type: "choice",
							instructions: "pick a tier",
							criteria: { low: null, high: null },
						},
					},
				},
				{ signal: controller.signal },
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(DOMException);
		expect((error as DOMException).name).toBe("AbortError");
		expect(String((error as Error)?.message ?? error)).not.toMatch(/returned no output/);
	});

	it("rejects a 21-label choice pre-dispatch without calling the worker", async () => {
		const mock = spyOn(tinyModelClient, "judge").mockResolvedValue({ logits: { q: [] } });
		const judge = new LocalJudge("julia-1");
		const criteria: Record<string, null> = {};
		for (let index = 0; index < 21; index++) criteria[`opt${index}`] = null;

		let error: unknown;
		try {
			await judge.judge({
				state: "refactor the scheduler",
				questions: {
					q: {
						type: "choice",
						instructions: "pick a tier",
						criteria,
					},
				},
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(JudgmentParseError);
		expect(mock.mock.calls.length).toBe(0);
	});

	it("rejects a 1-label choice pre-dispatch without calling the worker", async () => {
		const mock = spyOn(tinyModelClient, "judge").mockResolvedValue({ logits: { q: [1] } });
		const judge = new LocalJudge("julia-1");

		let error: unknown;
		try {
			await judge.judge({
				state: "refactor the scheduler",
				questions: {
					q: {
						type: "choice",
						instructions: "pick a tier",
						criteria: { only: null },
					},
				},
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(JudgmentParseError);
		expect(mock.mock.calls.length).toBe(0);
	});
	it("rejects choice with empty or whitespace-only options pre-dispatch without calling the worker", async () => {
		const mock = spyOn(tinyModelClient, "judge").mockResolvedValue({ logits: { q: [1, 2] } });
		const judge = new LocalJudge("julia-1");

		const testCases: Record<string, string | null>[] = [
			{ "": null, opt: null },
			{ "  ": null, opt: null },
		];
		for (const criteria of testCases) {
			mock.mockClear();
			let error: unknown;
			try {
				await judge.judge({
					state: "test",
					questions: {
						q: { type: "choice", instructions: "pick", criteria },
					},
				});
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(JudgmentParseError);
			expect(mock.mock.calls.length).toBe(0);
		}
	});

	it("rejects noul with empty or whitespace-only false/true labels pre-dispatch without calling the worker", async () => {
		const mock = spyOn(tinyModelClient, "judge").mockResolvedValue({ logits: { q: [1, 2] } });
		const judge = new LocalJudge("julia-1");

		const invalidLabels = [
			{ false: "", true: "yes" },
			{ false: "   ", true: "yes" },
			{ false: "no", true: "" },
			{ false: "no", true: "   " },
		];
		for (const criteria of invalidLabels) {
			mock.mockClear();
			let error: unknown;
			try {
				await judge.judge({
					state: "test",
					questions: {
						q: { type: "noul", instructions: "verify", criteria },
					},
				});
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(JudgmentParseError);
			expect(mock.mock.calls.length).toBe(0);
		}
	});

	it("rejects score with empty or whitespace-only options pre-dispatch without calling the worker", async () => {
		const mock = spyOn(tinyModelClient, "judge").mockResolvedValue({ logits: { q: [1, 2] } });
		const judge = new LocalJudge("julia-1");

		const testCases: [string, string][] = [
			["good", ""],
			["good", "   "],
		];
		for (const criteria of testCases) {
			mock.mockClear();
			let error: unknown;
			try {
				await judge.judge({
					state: "test",
					questions: {
						q: { type: "score", instructions: "rate", criteria },
					},
				});
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(JudgmentParseError);
			expect(mock.mock.calls.length).toBe(0);
		}
	});

	it("rejects non-finite logits with JudgmentParseError instead of returning NaN probabilities", async () => {
		spyOn(tinyModelClient, "judge").mockResolvedValue({ logits: { q: [NaN, 1] } });
		const judge = new LocalJudge("julia-1");

		await expect(
			judge.judge({
				state: "refactor the scheduler",
				questions: {
					q: {
						type: "choice",
						instructions: "pick a tier",
						criteria: { low: null, high: null },
					},
				},
			}),
		).rejects.toThrow(JudgmentParseError);

		spyOn(tinyModelClient, "judge").mockResolvedValue({ logits: { q: [Infinity, 1] } });
		await expect(
			judge.judge({
				state: "refactor the scheduler",
				questions: {
					q: {
						type: "choice",
						instructions: "pick a tier",
						criteria: { low: null, high: null },
					},
				},
			}),
		).rejects.toThrow(JudgmentParseError);
	});

	it("rejects box questions with ValidationError", async () => {
		const judge = new LocalJudge("julia-1");
		await expect(
			judge.judge({
				state: "find target",
				questions: {
					q: { type: "box", instructions: "find target", image: 0 },
				},
			}),
		).rejects.toThrow(AIError.ValidationError);
	});

	it("rejects image-bearing requests with ValidationError instead of scoring text-only", async () => {
		const mock = spyOn(tinyModelClient, "judge");
		const judge = new LocalJudge("julia-1");
		await expect(
			judge.judge({
				state: "rate the screenshot",
				images: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
				questions: {
					q: { type: "choice", instructions: "pick", criteria: { a: "first", b: "second" } },
				},
			}),
		).rejects.toThrow(AIError.ValidationError);
		expect(mock.mock.calls.length).toBe(0);
	});

	it("rejects the '__proto__' id with ValidationError without calling the worker", async () => {
		const mock = spyOn(tinyModelClient, "judge");
		const judge = new LocalJudge("julia-1");
		await expect(
			judge.judge({
				state: "pick one",
				questions: {
					["__proto__"]: { type: "choice", instructions: "pick", criteria: { a: "first", b: "second" } },
				},
			}),
		).rejects.toThrow(AIError.ValidationError);
		expect(mock.mock.calls.length).toBe(0);
	});
});

describe("JuliaJudgeModel", () => {
	const spec = getTinyLocalModelSpec("julia-1")!;
	const fakeReply = { send: vi.fn() };

	it("rejects questions that are not a non-null object server-side with request-scoped error", async () => {
		const model = new JuliaJudgeModel("julia-1", spec);
		let error1: unknown;
		try {
			await model.judge(
				{
					type: "judge",
					id: "1",
					state: "test state",
					questions: null as unknown as Record<string, JudgeQuestionPayload>,
				},
				fakeReply,
			);
		} catch (caught) {
			error1 = caught;
		}
		expect(error1).toBeInstanceOf(Error);
		expect((error1 as Error).message).toBe("judge request: questions must be a non-null object");
		expect(isRequestScopedError(error1)).toBe(true);

		let error2: unknown;
		try {
			await model.judge(
				{
					type: "judge",
					id: "2",
					state: "test state",
					questions: [] as unknown as Record<string, JudgeQuestionPayload>,
				},
				fakeReply,
			);
		} catch (caught) {
			error2 = caught;
		}
		expect(error2).toBeInstanceOf(Error);
		expect((error2 as Error).message).toBe("judge request: questions must be a non-null object");
		expect(isRequestScopedError(error2)).toBe(true);
	});

	it("rejects state that is not a string server-side with request-scoped error", async () => {
		const model = new JuliaJudgeModel("julia-1", spec);
		let error: unknown;
		try {
			await model.judge(
				{
					type: "judge",
					id: "1",
					state: 123 as unknown as string,
					questions: {},
				},
				fakeReply,
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("judge request: state must be a string");
		expect(isRequestScopedError(error)).toBe(true);
	});

	it("rejects question instructions that are not a string server-side with request-scoped error", async () => {
		const model = new JuliaJudgeModel("julia-1", spec);
		let error: unknown;
		try {
			await model.judge(
				{
					type: "judge",
					id: "1",
					state: "test state",
					questions: {
						q: {
							type: "choice",
							instructions: 456 as unknown as string,
							options: ["a", "b"],
						},
					},
				},
				fakeReply,
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe('judge question "q": instructions must be a string');
		expect(isRequestScopedError(error)).toBe(true);
	});
	it("marks all question validation errors as request-scoped", async () => {
		const model = new JuliaJudgeModel("julia-1", spec);
		const testCases: Extract<TinyWorkerRequest, { type: "judge" }>[] = [
			{
				type: "judge",
				id: "1",
				state: "s",
				questions: { q: { type: "unknown" as any, instructions: "i", options: ["a", "b"] } },
			},
			{
				type: "judge",
				id: "2",
				state: "s",
				questions: { q: { type: "noul", instructions: "i", options: ["a"] as any } },
			},
			{
				type: "judge",
				id: "3",
				state: "s",
				// Two options so the count guard passes and the empty-string guard fires.
				questions: { q: { type: "choice", instructions: "i", options: ["ok", ""] } },
			},
		];
		for (const req of testCases) {
			let error: unknown;
			try {
				await model.judge(req, fakeReply);
			} catch (caught) {
				error = caught;
			}
			expect(isRequestScopedError(error)).toBe(true);
		}
	});

	it("rejects unknown question.type server-side", async () => {
		const model = new JuliaJudgeModel("julia-1", spec);
		await expect(
			model.judge(
				{
					type: "judge",
					id: "1",
					state: "test state",
					questions: {
						q: { type: "unknown" as unknown as "choice", instructions: "i", options: ["a", "b"] },
					},
				},
				fakeReply,
			),
		).rejects.toThrow('judge question "q": unknown question type "unknown"');
	});

	it("rejects noul with options.length !== 2 server-side", async () => {
		const model = new JuliaJudgeModel("julia-1", spec);
		await expect(
			model.judge(
				{
					type: "judge",
					id: "1",
					state: "test state",
					questions: {
						q: { type: "noul", instructions: "i", options: ["only_one"] as unknown as [string, string] },
					},
				},
				fakeReply,
			),
		).rejects.toThrow('judge question "q": noul needs 2 options, got 1');

		await expect(
			model.judge(
				{
					type: "judge",
					id: "2",
					state: "test state",
					questions: {
						q: {
							type: "noul",
							instructions: "i",
							options: ["no", "yes", "extra"] as unknown as [string, string],
						},
					},
				},
				fakeReply,
			),
		).rejects.toThrow('judge question "q": noul needs 2 options, got 3');
	});

	it("rejects empty option strings server-side", async () => {
		const model = new JuliaJudgeModel("julia-1", spec);
		await expect(
			model.judge(
				{
					type: "judge",
					id: "1",
					state: "test state",
					questions: {
						q: { type: "choice", instructions: "i", options: ["valid", ""] },
					},
				},
				fakeReply,
			),
		).rejects.toThrow('judge question "q": empty option string at index 1');

		await expect(
			model.judge(
				{
					type: "judge",
					id: "2",
					state: "test state",
					questions: {
						q: { type: "choice", instructions: "i", options: ["   ", "valid"] },
					},
				},
				fakeReply,
			),
		).rejects.toThrow('judge question "q": empty option string at index 0');
	});

	it("rejects choice/score questions outside 2-20 options range", async () => {
		const model = new JuliaJudgeModel("julia-1", spec);
		await expect(
			model.judge(
				{
					type: "judge",
					id: "1",
					state: "test state",
					questions: {
						q: { type: "choice", instructions: "i", options: ["only_one"] },
					},
				},
				fakeReply,
			),
		).rejects.toThrow('judge question "q": needs 2-20 options, got 1');

		await expect(
			model.judge(
				{
					type: "judge",
					id: "2",
					state: "test state",
					questions: {
						q: {
							type: "score",
							instructions: "i",
							options: Array.from({ length: 21 }, (_, index) => `level_${index}`),
						},
					},
				},
				fakeReply,
			),
		).rejects.toThrow('judge question "q": needs 2-20 options, got 21');
	});
	it("rejects oversized batches request-scoped before loading the session", async () => {
		const model = new JuliaJudgeModel("julia-1", spec);
		const load = spyOn(model, "load");
		const questions: Record<string, JudgeQuestionPayload> = {};
		for (let i = 0; i < JUDGE_MAX_BATCH_QUESTIONS + 1; i++) {
			questions[`q${i}`] = { type: "choice", instructions: "i", options: ["a", "b"] };
		}
		let error: unknown;
		try {
			await model.judge({ type: "judge", id: "1", state: "s", questions }, fakeReply);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			`needs at most ${JUDGE_MAX_BATCH_QUESTIONS} questions, got ${JUDGE_MAX_BATCH_QUESTIONS + 1} — split into smaller batches`,
		);
		expect(isRequestScopedError(error)).toBe(true);
		expect(load.mock.calls.length).toBe(0);
	});

	it("throws clear error when session output lacks logits tensor naming actual output keys", async () => {
		const model = new JuliaJudgeModel("julia-1", spec);
		const mockSession = {
			run: vi.fn().mockResolvedValue({}),
		};
		const mockTokenizer = Object.assign(
			(text: string) => ({
				input_ids: { data: [...text].map(char => char.charCodeAt(0)) },
			}),
			{
				mask_token: "<extra_id_0>",
				mask_token_id: 4,
				cls_token_id: 2,
				sep_token_id: 1,
				bos_token_id: 2,
			},
		);
		spyOn(model, "load").mockResolvedValue({
			tokenizer: mockTokenizer as never,
			ort: {
				Tensor: class {
					constructor() {}
				},
			} as never,
			session: mockSession as never,
		});

		await expect(
			model.judge(
				{
					type: "judge",
					id: "1",
					state: "test state",
					questions: {
						q: { type: "choice", instructions: "i", options: ["a", "b"] },
					},
				},
				fakeReply,
			),
		).rejects.toThrow("judge session output lacks logits tensor (got: [])");

		mockSession.run.mockResolvedValue({ other_output: {} });
		await expect(
			model.judge(
				{
					type: "judge",
					id: "2",
					state: "test state",
					questions: {
						q: { type: "choice", instructions: "i", options: ["a", "b"] },
					},
				},
				fakeReply,
			),
		).rejects.toThrow("judge session output lacks logits tensor (got: [other_output])");
	});

	it("rejects the '__proto__' id request-scoped before loading the session", async () => {
		// Up-front check: a bad id fails fast without paying download/tokenize/
		// inference, and request-scoping keeps julia-1 usable afterwards.
		const model = new JuliaJudgeModel("julia-1", spec);
		const load = spyOn(model, "load");
		let error: unknown;
		try {
			await model.judge(
				{
					type: "judge",
					id: "1",
					state: "test state",
					questions: {
						["__proto__"]: { type: "choice", instructions: "i", options: ["a", "b"] },
					},
				},
				fakeReply,
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("__proto__");
		expect(isRequestScopedError(error)).toBe(true);
		expect(load.mock.calls.length).toBe(0);
	});
});
