/**
 * DeepSeek Web Search Provider
 *
 * Calls DeepSeek's in-house Search API (`POST /v1/tools/search`) and maps its
 * ranked results into the unified SearchResponse shape. This is a raw JSON
 * endpoint: it does not go through the Responses or Messages APIs, so any
 * DeepSeek API key can search without a chat-model grounding.
 */
import { type ApiKey, type AuthStorage, type FetchImpl, getEnvApiKey, withAuth } from "@oh-my-pi/pi-ai";
import { asRecord } from "@oh-my-pi/pi-utils";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import {
	classifyProviderHttpError,
	normalizeSearchText,
	normalizeUrl,
	readLimitedText,
	toSearchSources,
	withHardTimeout,
} from "./utils";

const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 50;
const MAX_QUERY_CHARACTERS = 128;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;

export interface DeepSeekSearchBody {
	query: string;
	count: number;
}

/**
 * DeepSeek forwards its query syntax intact (`site:`, `-site:`, quotes,
 * `OR`, `lang:`, `after:`/`before:`), so the raw query — including every
 * directive — is sent upstream without rebuilding. `recency` has no native
 * parameter and is deliberately ignored rather than rewritten into the query.
 */
export function buildRequestBody(params: { query: string; num_results?: number }): DeepSeekSearchBody {
	const requested = params.num_results;
	return {
		query: params.query,
		// `clampNumResults` treats a supplied 0 as "absent"; the API's floor is 1,
		// so an explicit 0 must clamp instead of widening to the default.
		count: Math.floor(requested === 0 ? 1 : clampNumResults(requested, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS)),
	};
}

function extractErrorMessage(raw: string): string {
	try {
		const error = asRecord(asRecord(JSON.parse(raw))?.error);
		const message = normalizeSearchText(error?.message);
		if (message) return message;
	} catch {
		// Fall through to the raw body.
	}
	return normalizeSearchText(raw) ?? "";
}

interface DeepSeekSearchResponse {
	results?: unknown;
}

async function callDeepSeekSearch(
	apiKey: string,
	body: DeepSeekSearchBody,
	options: { signal?: AbortSignal; timeoutMs?: number; fetch?: FetchImpl },
): Promise<DeepSeekSearchResponse> {
	const response = await (options.fetch ?? fetch)(DEEPSEEK_SEARCH_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: withHardTimeout(options.signal, options.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await readLimitedText(response, "deepseek", MAX_ERROR_BYTES, true);
		const classified = classifyProviderHttpError("deepseek", response.status, errorText);
		if (classified) throw classified;
		const message = extractErrorMessage(errorText) || response.statusText;
		throw new SearchProviderError("deepseek", `DeepSeek API error (${response.status}): ${message}`, response.status);
	}

	const raw = await readLimitedText(response, "deepseek", MAX_RESPONSE_BYTES);
	try {
		const parsed: unknown = JSON.parse(raw);
		return asRecord(parsed) ?? {};
	} catch {
		throw new SearchProviderError("deepseek", "DeepSeek API returned invalid JSON", 500);
	}
}

function toSources(body: DeepSeekSearchResponse, numResults: number): SearchSource[] {
	if (!Array.isArray(body.results)) return [];
	const sources: Array<{ title: string; url: string; snippet?: string; publishedDate?: string }> = [];
	for (const value of body.results) {
		const result = asRecord(value);
		if (!result) continue;
		const url = normalizeUrl(result.url);
		if (!url) continue;
		sources.push({
			title: normalizeSearchText(result.title) ?? url,
			url,
			// `summary` is the model-facing abstract (roughly 600–800 chars);
			// `snippet` is UI chrome (100–200 chars). Prefer the former.
			snippet: normalizeSearchText(result.summary) ?? normalizeSearchText(result.snippet),
			publishedDate: normalizeSearchText(result.date),
		});
	}
	return toSearchSources(sources, numResults);
}

/** Execute DeepSeek web search. */
export async function searchDeepSeek(params: SearchParams): Promise<SearchResponse> {
	const query = params.query;
	if (query.trim().length === 0) {
		throw new SearchProviderError("deepseek", "DeepSeek search query cannot be empty", 400);
	}
	if ([...query].length > MAX_QUERY_CHARACTERS) {
		throw new SearchProviderError(
			"deepseek",
			`DeepSeek search queries cannot exceed ${MAX_QUERY_CHARACTERS} characters`,
			400,
		);
	}

	const body = buildRequestBody({
		query,
		num_results: params.numSearchResults ?? params.limit,
	});
	const keyOrResolver: ApiKey = params.authStorage.keys.resolver("deepseek", {
		sessionId: params.sessionId,
	});

	const response = await withAuth(keyOrResolver, key => callDeepSeekSearch(key, body, params), {
		signal: params.signal,
		missingKeyMessage:
			'DeepSeek credentials not found. Set DEEPSEEK_API_KEY or configure an API key for provider "deepseek".',
	});

	return {
		provider: "deepseek",
		sources: toSources(response, body.count),
		authMode: "api_key",
	};
}

/** Search provider for DeepSeek's in-house search API. */
export class DeepSeekProvider extends SearchProvider {
	readonly id = "deepseek";
	readonly label = "DeepSeek";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.keys.source("deepseek") !== undefined || !!getEnvApiKey("deepseek");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchDeepSeek(params);
	}
}
