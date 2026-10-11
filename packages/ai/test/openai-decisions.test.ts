import { describe, expect, it } from "bun:test";
import {
	type ApiKeyResolveContext,
	isJudgmentApi,
	isSystemOneJudgmentApi,
	OpenAIDecisionsApiError,
	OpenAIDecisionsJudge,
} from "@oh-my-pi/pi-ai";

const COST = { input: 0.042, output: 0, cacheRead: 0.021, cacheWrite: 0.0525 };

const REQUEST = {
	state: { event: "deployment", exitCode: 1 },
	questions: {
		urgent: {
			type: "noul",
			instructions: "Does this indicate an urgent outage?",
			criteria: { true: "Customer impact is immediate", false: "No immediate impact" },
		},
		owner: {
			type: "choice",
			instructions: "Which team owns the incident?",
			criteria: { platform: "Deployment infrastructure", product: null },
		},
		severity: {
			type: "score",
			instructions: "Rate the severity.",
			criteria: ["low", "medium", "high"],
		},
	},
} as const;

const ANSWERS = [
	{ name: "urgent", type: "predicate", probability: 0.93 },
	{
		name: "owner",
		type: "choice",
		choice: "platform",
		confidence: 0.88,
		probabilities: [
			{ value: "platform", probability: 0.82 },
			{ value: "product", probability: 0.18 },
		],
	},
	{
		name: "severity",
		type: "score",
		score: 1.25,
		confidence: 0.74,
		probabilities: [
			{ value: 0, label: "low", probability: 0.25 },
			{ value: 1, label: "medium", probability: 0.25 },
			{ value: 2, label: "high", probability: 0.5 },
		],
	},
];

const USAGE = {
	input_tokens: 120,
	input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
	output_tokens: 12,
	output_tokens_details: { reasoning_tokens: 4 },
	total_tokens: 132,
};

function response(overrides: Record<string, unknown> = {}): Response {
	return Response.json({ model: "gpt-6-luna", answers: ANSWERS, usage: USAGE, ...overrides });
}

describe("OpenAIDecisionsJudge", () => {
	it("keeps native Decisions distinct from System One routes", () => {
		expect(isJudgmentApi("openai-decisions")).toBe(true);
		expect(isSystemOneJudgmentApi("openai-decisions")).toBe(false);
		expect(isSystemOneJudgmentApi("typesafe")).toBe(true);
	});

	it("maps shared questions, typed answers, weighted scores, usage details, and catalog pricing", async () => {
		const calls: { url: string; init: RequestInit | undefined }[] = [];
		const judge = new OpenAIDecisionsJudge({
			apiKey: "openai-secret",
			model: "gpt-6-luna",
			cost: COST,
			baseUrl: "https://openai.example/v1/",
			headers: { "x-omp-route": "judgment" },
			fetch: async (url, init) => {
				calls.push({ url: String(url), init });
				return response();
			},
		});

		const result = await judge.judge(REQUEST);

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://openai.example/v1/decisions");
		const headers = new Headers(calls[0].init?.headers);
		expect(headers.get("authorization")).toBe("Bearer openai-secret");
		expect(headers.get("x-omp-route")).toBe("judgment");
		const wire = JSON.parse(String(calls[0].init?.body));
		expect(wire).toMatchObject({
			model: "gpt-6-luna",
			input: JSON.stringify(REQUEST.state),
			questions: [
				{ type: "predicate", name: "urgent" },
				{
					type: "choice",
					name: "owner",
					instructions: "Which team owns the incident?",
					choices: [{ value: "platform", description: "Deployment infrastructure" }, { value: "product" }],
				},
				{
					type: "score",
					name: "severity",
					instructions: "Rate the severity.",
					levels: [{ label: "low" }, { label: "medium" }, { label: "high" }],
				},
			],
		});
		expect(wire.questions[0].instructions).toContain("Does this indicate an urgent outage?");
		expect(wire.questions[0].instructions).toContain("Customer impact is immediate");
		expect(wire.questions[0].instructions).toContain("No immediate impact");
		expect(result).toMatchObject({
			api: "openai-decisions",
			provider: "openai",
			model: "gpt-6-luna",
			answers: {
				urgent: { type: "noul", noul: 0.93 },
				owner: {
					type: "choice",
					choice: "platform",
					probabilities: { platform: 0.82, product: 0.18 },
					confidence: 0.88,
				},
				severity: {
					type: "score",
					score: 1.25,
					probabilities: { "0": 0.25, "1": 0.25, "2": 0.5 },
					confidence: 0.74,
				},
			},
			usage: {
				input: 90,
				output: 12,
				cacheRead: 20,
				cacheWrite: 10,
				totalTokens: 132,
				reasoningTokens: 4,
			},
		});
		expect(result.usage.cost.input).toBeCloseTo((90 * COST.input) / 1_000_000);
		expect(result.usage.cost.cacheRead).toBeCloseTo((20 * COST.cacheRead) / 1_000_000);
		expect(result.usage.cost.cacheWrite).toBeCloseTo((10 * COST.cacheWrite) / 1_000_000);
		expect(result.usage.cost.output).toBe(0);
	});

	it("rotates credentials on authentication failure and retries transient statuses", async () => {
		const keys: string[] = [];
		const statuses = [401, 529, 200];
		const resolver = (ctx: ApiKeyResolveContext) => (ctx.error === undefined ? "stale" : "fresh");
		const judge = new OpenAIDecisionsJudge({
			apiKey: resolver,
			model: "gpt-6-luna",
			cost: COST,
			fetch: async (_url, init) => {
				keys.push(new Headers(init?.headers).get("authorization") ?? "");
				const status = statuses.shift() ?? 200;
				if (status === 200) return response();
				return new Response("busy", { status, headers: { "retry-after-ms": "1" } });
			},
		});

		const result = await judge.judge(REQUEST);

		expect(result.answers.urgent.noul).toBe(0.93);
		expect(keys).toEqual(["Bearer stale", "Bearer fresh", "Bearer fresh"]);
	});

	it("rejects refusals, malformed answers, wrong types, and missing results", async () => {
		const urgent = { state: "x", questions: { urgent: { type: "noul", instructions: "Urgent?" } } } as const;
		const judgeFor = (answers: unknown[]) =>
			new OpenAIDecisionsJudge({
				apiKey: "key",
				model: "gpt-6-luna",
				cost: COST,
				fetch: async () => response({ answers }),
			});

		await expect(judgeFor([{ name: "urgent", type: "refusal" }]).judge(urgent)).rejects.toMatchObject({
			name: "ProviderResponseError",
			kind: "output",
		});
		await expect(judgeFor([{ name: "urgent", type: "choice", choice: "yes" }]).judge(urgent)).rejects.toThrow(
			/returned a "choice" answer/,
		);
		await expect(judgeFor([]).judge(urgent)).rejects.toThrow(/is missing an answer/);
		await expect(judgeFor([{ name: "urgent", type: "predicate", probability: 2 }]).judge(urgent)).rejects.toThrow(
			/invalid probability/,
		);
		await expect(judgeFor([{ name: "other", type: "predicate", probability: 0.5 }]).judge(urgent)).rejects.toThrow(
			/unknown question/,
		);
		await expect(
			judgeFor([
				{ name: "urgent", type: "predicate", probability: 0.5 },
				{ name: "urgent", type: "predicate", probability: 0.5 },
			]).judge(urgent),
		).rejects.toThrow(/duplicate answers/);
		const malformed = new OpenAIDecisionsJudge({
			apiKey: "key",
			model: "gpt-6-luna",
			cost: COST,
			fetch: async () => Response.json({ model: "gpt-6-luna", answers: { urgent: 0.5 }, usage: USAGE }),
		});
		await expect(malformed.judge(urgent)).rejects.toThrow(/malformed answer envelope/);
	});

	it("honors a pre-aborted caller signal without dispatching", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		const judge = new OpenAIDecisionsJudge({
			apiKey: "key",
			model: "gpt-6-luna",
			cost: COST,
			fetch: async () => {
				calls++;
				return response();
			},
		});

		await expect(judge.judge(REQUEST, { signal: controller.signal })).rejects.toThrow();
		expect(calls).toBe(0);
	});

	it("does not retry non-transient request errors", async () => {
		let calls = 0;
		const judge = new OpenAIDecisionsJudge({
			apiKey: "key",
			model: "gpt-6-luna",
			cost: COST,
			fetch: async () => {
				calls++;
				return new Response("invalid request", { status: 422 });
			},
		});

		await expect(judge.judge(REQUEST)).rejects.toBeInstanceOf(OpenAIDecisionsApiError);
		expect(calls).toBe(1);
	});
});
