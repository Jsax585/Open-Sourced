import { calculateUsageCost } from "@oh-my-pi/pi-catalog/models";
import type { FetchImpl, ModelCost, Usage } from "@oh-my-pi/pi-catalog/types";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import type { ApiKey } from "../auth-retry";
import * as AIError from "../error";
import { OPENAI_DECISIONS_BASE_URL, postOpenAIDecisions } from "./openai-decisions-transport";
import type {
	Answer,
	ChoiceQuestion,
	Judge,
	JudgeOptions,
	JudgmentRequest,
	JudgmentResult,
	Question,
	Questions,
	ScoreQuestion,
} from "./types";
import openAIDecisionsPredicateTemplate from "./openai-decisions-predicate.md" with { type: "text" };

export { OpenAIDecisionsApiError, OPENAI_DECISIONS_BASE_URL } from "./openai-decisions-transport";

export const OPENAI_DECISIONS_API = "openai-decisions" as const;
export const OPENAI_DECISIONS_PROVIDER = "openai";

const PROBABILITY_SUM_TOLERANCE = 0.01;

type DecisionQuestion =
	| { type: "predicate"; name: string; instructions: string }
	| {
			type: "choice";
			name: string;
			instructions: string;
			choices: { value: string; description?: string }[];
	  }
	| {
			type: "score";
			name: string;
			instructions: string;
			levels: { label: string }[];
	  };

export interface OpenAIDecisionsJudgeOptions {
	apiKey: ApiKey;
	model: string;
	/** Rates come from the selected catalog model, including long-context pricing when present. */
	cost: ModelCost;
	provider?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	fetch?: FetchImpl;
	/** Per-attempt timeout; defaults to 10 seconds. */
	timeoutMs?: number;
}

function responseError(provider: string, detail: string, cause?: unknown): AIError.ProviderResponseError {
	return new AIError.ProviderResponseError(`OpenAI Decisions response ${detail}`, {
		provider,
		kind: "envelope",
		...(cause === undefined ? {} : { cause }),
	});
}

function decisionQuestion(name: string, question: Question): DecisionQuestion {
	switch (question.type) {
		case "noul": {
			const hasTrue = question.criteria?.true !== undefined;
			const hasFalse = question.criteria?.false !== undefined;
			const criteria =
				hasTrue || hasFalse
					? {
							hasTrue,
							true: question.criteria?.true,
							hasFalse,
							false: question.criteria?.false,
						}
					: undefined;
			return {
				type: "predicate",
				name,
				instructions: prompt.render(openAIDecisionsPredicateTemplate, {
					instructions: question.instructions,
					criteria,
				}),
			};
		}
		case "choice":
			return {
				type: "choice",
				name,
				instructions: question.instructions,
				choices: Object.entries(question.criteria).map(([value, description]) =>
					description === null ? { value } : { value, description },
				),
			};
		case "score":
			return {
				type: "score",
				name,
				instructions: question.instructions,
				levels: question.criteria.map(label => ({ label })),
			};
	}
}

function probability(value: unknown, detail: string, provider: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw responseError(provider, `contains an invalid probability for ${detail}`);
	}
	return value;
}

function confidence(value: unknown, questionId: string, provider: string): number {
	return probability(value, `question "${questionId}" confidence`, provider);
}

function parseProbabilityDistribution(
	value: unknown,
	expectedValues: readonly string[],
	questionId: string,
	provider: string,
): Record<string, number> {
	if (!Array.isArray(value) || value.length !== expectedValues.length) {
		throw responseError(provider, `contains an incomplete probability distribution for question "${questionId}"`);
	}
	const expected = new Set(expectedValues);
	const seen = new Set<string>();
	const pairs: [string, number][] = [];
	let sum = 0;
	for (const entry of value) {
		if (!isRecord(entry) || typeof entry.value !== "string" || !expected.has(entry.value) || seen.has(entry.value)) {
			throw responseError(
				provider,
				`contains an unexpected or duplicate probability value for question "${questionId}"`,
			);
		}
		const rate = probability(entry.probability, `question "${questionId}" distribution`, provider);
		seen.add(entry.value);
		pairs.push([entry.value, rate]);
		sum += rate;
	}
	if (seen.size !== expected.size || Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
		throw responseError(provider, `contains an invalid probability distribution for question "${questionId}"`);
	}
	return Object.fromEntries(pairs);
}

function choiceAnswer(
	question: ChoiceQuestion,
	value: Record<string, unknown>,
	questionId: string,
	provider: string,
): Answer {
	const options = Object.keys(question.criteria);
	if (typeof value.choice !== "string" || !options.includes(value.choice)) {
		throw responseError(provider, `contains an invalid choice for question "${questionId}"`);
	}
	return {
		type: "choice",
		choice: value.choice,
		probabilities: parseProbabilityDistribution(value.probabilities, options, questionId, provider),
		confidence: confidence(value.confidence, questionId, provider),
	};
}

function scoreAnswer(
	question: ScoreQuestion,
	value: Record<string, unknown>,
	questionId: string,
	provider: string,
): Answer {
	if (
		typeof value.score !== "number" ||
		!Number.isFinite(value.score) ||
		value.score < 0 ||
		value.score > question.criteria.length - 1
	) {
		throw responseError(provider, `contains an invalid score for question "${questionId}"`);
	}
	if (!Array.isArray(value.probabilities) || value.probabilities.length !== question.criteria.length) {
		throw responseError(provider, `contains an incomplete score distribution for question "${questionId}"`);
	}
	const seen = new Set<number>();
	const pairs: [string, number][] = [];
	let sum = 0;
	for (const entry of value.probabilities) {
		if (
			!isRecord(entry) ||
			typeof entry.value !== "number" ||
			!Number.isInteger(entry.value) ||
			entry.value < 0 ||
			entry.value >= question.criteria.length ||
			typeof entry.label !== "string" ||
			entry.label !== question.criteria[entry.value] ||
			seen.has(entry.value)
		) {
			throw responseError(provider, `contains an unexpected or duplicate score level for question "${questionId}"`);
		}
		const rate = probability(entry.probability, `question "${questionId}" distribution`, provider);
		seen.add(entry.value);
		pairs.push([String(entry.value), rate]);
		sum += rate;
	}
	if (seen.size !== question.criteria.length || Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
		throw responseError(provider, `contains an invalid score distribution for question "${questionId}"`);
	}
	return {
		type: "score",
		score: value.score,
		probabilities: Object.fromEntries(pairs),
		confidence: confidence(value.confidence, questionId, provider),
	};
}

function answerFor(question: Question, value: Record<string, unknown>, questionId: string, provider: string): Answer {
	if (value.type === "refusal") {
		throw new AIError.ProviderResponseError(`OpenAI Decisions refused question "${questionId}"`, {
			provider,
			kind: "output",
		});
	}
	const expectedType = question.type === "noul" ? "predicate" : question.type;
	if (value.type !== expectedType) {
		throw responseError(
			provider,
			`returned a "${String(value.type)}" answer for "${questionId}" instead of "${expectedType}"`,
		);
	}
	switch (question.type) {
		case "noul":
			return { type: "noul", noul: probability(value.probability, `question "${questionId}"`, provider) };
		case "choice":
			return choiceAnswer(question, value, questionId, provider);
		case "score":
			return scoreAnswer(question, value, questionId, provider);
	}
}

function tokenCount(value: unknown, detail: string, provider: string): number {
	if (value === undefined) return 0;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw responseError(provider, `contains an invalid ${detail} token count`);
	}
	return value;
}

/** Normalize detailed Decisions usage and price it with the catalog's decision-specific rates. */
export function openAIDecisionsUsageFromResponse(value: unknown, cost: ModelCost, provider: string): Usage {
	const wire = isRecord(value) ? value : {};
	const inputTokens = tokenCount(wire.input_tokens, "input", provider);
	const outputTokens = tokenCount(wire.output_tokens, "output", provider);
	const inputDetails = isRecord(wire.input_tokens_details) ? wire.input_tokens_details : {};
	const outputDetails = isRecord(wire.output_tokens_details) ? wire.output_tokens_details : {};
	const cacheRead = tokenCount(inputDetails.cached_tokens, "cached input", provider);
	const cacheWrite = tokenCount(inputDetails.cache_write_tokens, "cache-write", provider);
	if (cacheRead + cacheWrite > inputTokens) {
		throw responseError(provider, "reports cached input greater than total input tokens");
	}
	const reasoningTokens = tokenCount(outputDetails.reasoning_tokens, "reasoning", provider);
	if (reasoningTokens > outputTokens) {
		throw responseError(provider, "reports reasoning tokens greater than output tokens");
	}
	const totalTokens = tokenCount(wire.total_tokens, "total", provider) || inputTokens + outputTokens;
	const usage: Usage = {
		input: inputTokens - cacheRead - cacheWrite,
		output: outputTokens,
		cacheRead,
		cacheWrite,
		totalTokens,
		...(outputDetails.reasoning_tokens === undefined ? {} : { reasoningTokens }),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateUsageCost(cost, usage);
	return usage;
}

/** Native OpenAI Decisions client; its predicate/choice/score wire is not System One-compatible. */
export class OpenAIDecisionsJudge implements Judge {
	readonly api = OPENAI_DECISIONS_API;
	readonly label: string;
	readonly provider: string;
	readonly model: string;
	readonly baseUrl: string;
	readonly #apiKey: ApiKey;
	readonly #cost: ModelCost;
	readonly #headers: Record<string, string> | undefined;
	readonly #fetch: FetchImpl | undefined;
	readonly #timeoutMs: number | undefined;

	constructor(options: OpenAIDecisionsJudgeOptions) {
		this.#apiKey = options.apiKey;
		this.#cost = options.cost;
		this.provider = options.provider ?? OPENAI_DECISIONS_PROVIDER;
		this.model = options.model;
		this.baseUrl = (options.baseUrl ?? OPENAI_DECISIONS_BASE_URL).replace(/\/+$/, "");
		this.#headers = options.headers;
		this.#fetch = options.fetch;
		this.#timeoutMs = options.timeoutMs;
		this.label = `${this.provider}/${this.model}`;
	}

	async judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>> {
		const questions = Object.keys(request.questions).map(id => decisionQuestion(id, request.questions[id]));
		const input = typeof request.state === "string" ? request.state : (JSON.stringify(request.state) ?? "null");
		const body = JSON.stringify({ input, model: this.model, questions });
		const signal = options?.signal;
		const response = await postOpenAIDecisions(
			{
				apiKey: this.#apiKey,
				model: this.model,
				provider: this.provider,
				baseUrl: this.baseUrl,
				headers: this.#headers,
				fetch: this.#fetch,
				timeoutMs: this.#timeoutMs,
			},
			body,
			signal,
		);
		const answers = Object.create(null) as Record<string, Answer>;
		const requested = request.questions;
		const seen = new Set<string>();
		for (const raw of response.answers) {
			if (!isRecord(raw) || typeof raw.name !== "string") {
				throw responseError(this.provider, "contains an answer with no question name");
			}
			const id = raw.name;
			if (!Object.hasOwn(requested, id)) {
				throw responseError(this.provider, `contains an answer for unknown question "${id}"`);
			}
			if (seen.has(id)) throw responseError(this.provider, `contains duplicate answers for question "${id}"`);
			seen.add(id);
			answers[id] = answerFor(requested[id], raw, id, this.provider);
		}
		for (const id of Object.keys(requested)) {
			if (!seen.has(id)) throw responseError(this.provider, `is missing an answer for question "${id}"`);
		}
		if (typeof response.model !== "string" || response.model.length === 0) {
			throw responseError(this.provider, "is missing the returned model name");
		}
		return {
			api: this.api,
			provider: this.provider,
			model: response.model,
			answers: answers as JudgmentResult<Q>["answers"],
			usage: openAIDecisionsUsageFromResponse(response.usage, this.#cost, this.provider),
		};
	}
}
