/**
 * Perplexity Web Search Provider
 *
 * Single transport: the Perplexity **Search API** (`POST
 * https://api.perplexity.ai/search`) authenticated by `PERPLEXITY_API_KEY`,
 * returning ranked structured `results[]` from the Photon-backed
 * `search_type: "fast"` preset, extracted with `search_context_size: "medium"`.
 *
 * The Sonar chat-completions/Responses transports (`sonar-pro`, OpenRouter's
 * `perplexity/sonar-pro`) and the cookie/OAuth/anonymous `perplexity_ask`
 * fallbacks are intentionally gone: Perplexity either answers with Search API
 * results or steps aside so the chain advances to the next configured
 * provider.
 */
import { type AuthStorage, type FetchImpl } from "@oh-my-pi/pi-ai";
import { $env } from "@oh-my-pi/pi-utils";
import type { SearchResponse } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery, type QuerySyntax, type StructuredQuery } from "../query";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { getApiKeyConfig } from "./perplexity-auth";
import { classifyProviderHttpError, toSearchSources, withHardTimeout } from "./utils";

const PERPLEXITY_SEARCH_URL = "https://api.perplexity.ai/search";
const DEFAULT_NUM_RESULTS = 10;
/** `web` search accepts up to 20 results; more is people-search only. */
const MAX_NUM_RESULTS = 20;
/**
 * Fixed extraction budget per document. The Search API rejects
 * `search_context_size` combined with `max_tokens`/`max_tokens_per_page`, so
 * callers' token knobs are deliberately not forwarded.
 */
const SEARCH_CONTEXT_SIZE = "medium";
/**
 * Fast Search (Photon): ~160 ms median / 230 ms p95 and $1 per 1k requests
 * versus $5 for the default `web` preset, with comparable agent task quality
 * on Perplexity's six-benchmark run. The default preset retrieves better on
 * rare or ambiguous queries, but agents re-query cheaply at this latency.
 */
const SEARCH_TYPE = "fast";

/**
 * Query-string operators Perplexity's search backend tolerates as text signal.
 * `site:`/date/`lang:` directives are excluded: they map onto native request
 * fields (`search_domain_filter`, `search_*_date_filter`,
 * `search_language_filter`) and must be stripped from the query so the engine
 * is not double-constrained.
 */
const PERPLEXITY_QUERY_SYNTAX: QuerySyntax = {
	phrases: true,
	negation: true,
	or: true,
	inUrl: true,
	inTitle: true,
	filetype: true,
};

/** Native Perplexity search filters derived from parsed query directives. */
interface PerplexityNativeFilters {
	/** Query rebuilt without natively-mapped directives. */
	query: string;
	/** `search_domain_filter`: allow entries as bare hosts, deny entries as `-host`. */
	domainFilter?: string[];
	/** `search_after_date_filter`, `%m/%d/%Y`. */
	afterDate?: string;
	/** `search_before_date_filter`, `%m/%d/%Y`. */
	beforeDate?: string;
	/** `search_language_filter`: ISO 639-1 two-letter codes. */
	languageFilter?: string[];
}

/** `search_recency_filter` window; the API also accepts `hour`, which the tool schema does not expose. */
type PerplexityRecencyFilter = "hour" | "day" | "week" | "month" | "year";

/**
 * Bare host of a `site:` value (`github.com/anthropics` → `github.com`);
 * Perplexity's domain filter takes hosts only, the path part is enforced by
 * the central lenient post-filter.
 */
function siteHost(site: string): string {
	const slash = site.indexOf("/");
	return slash === -1 ? site : site.slice(0, slash);
}

/** ISO `YYYY-MM-DD` → Perplexity's documented `%m/%d/%Y` date-filter format (e.g. `3/1/2025`). */
function toPerplexityDate(iso: string): string {
	const [year, month, day] = iso.split("-");
	return `${Number(month)}/${Number(day)}/${year}`;
}

/** Map parsed query directives onto native Perplexity search filters. */
function buildNativeFilters(parsed: StructuredQuery, rawQuery: string): PerplexityNativeFilters {
	if (!parsed.hasDirectives) return { query: rawQuery };
	// Allow + deny share one array; the API caps it at 20 entries.
	const domains = [
		...new Set([...parsed.sites.map(siteHost), ...parsed.excludedSites.map(site => `-${siteHost(site)}`)]),
	].slice(0, 20);
	// search_language_filter takes ISO 639-1 two-letter codes; pass `en-us` as
	// `en`, and leave anything else to the central post-filter.
	const langCode = parsed.lang ? /^([a-z]{2})(?:[-_]|$)/.exec(parsed.lang)?.[1] : undefined;
	return {
		query: formatQuery(parsed, PERPLEXITY_QUERY_SYNTAX),
		domainFilter: domains.length > 0 ? domains : undefined,
		afterDate: parsed.after ? toPerplexityDate(parsed.after) : undefined,
		beforeDate: parsed.before ? toPerplexityDate(parsed.before) : undefined,
		languageFilter: langCode ? [langCode] : undefined,
	};
}

export interface PerplexitySearchParams {
	signal?: AbortSignal;
	timeoutMs?: number;
	query: string;
	/** Pre-parsed view of `query` from the search pipeline; parsed locally when absent. */
	parsedQuery?: StructuredQuery;
	recency?: SearchParams["recency"];
	/** Maximum results to request. Defaults to 10, clamped to 20. */
	num_results?: number;
	authStorage: AuthStorage;
	sessionId?: string;
	fetch?: FetchImpl;
}

interface PerplexitySearchRequest {
	query: string;
	max_results: number;
	search_type: string;
	search_context_size: string;
	search_domain_filter?: string[];
	search_after_date_filter?: string;
	search_before_date_filter?: string;
	search_language_filter?: string[];
	search_recency_filter?: PerplexityRecencyFilter;
}

interface PerplexitySearchResult {
	title?: string | null;
	url?: string | null;
	snippet?: string | null;
	date?: string | null;
	last_updated?: string | null;
}

interface PerplexitySearchApiResponse {
	results?: PerplexitySearchResult[] | null;
	id?: string | null;
}

/** Build the Search API body: one query, native filters, Fast Search, fixed extraction budget. */
function buildSearchRequest(
	filters: PerplexityNativeFilters,
	recency: SearchParams["recency"],
	maxResults: number,
): PerplexitySearchRequest {
	const request: PerplexitySearchRequest = {
		query: filters.query,
		max_results: maxResults,
		search_type: SEARCH_TYPE,
		search_context_size: SEARCH_CONTEXT_SIZE,
	};
	if (filters.domainFilter) request.search_domain_filter = filters.domainFilter;
	if (filters.afterDate) request.search_after_date_filter = filters.afterDate;
	if (filters.beforeDate) request.search_before_date_filter = filters.beforeDate;
	if (filters.languageFilter) request.search_language_filter = filters.languageFilter;
	// Explicit `before:`/`after:` bounds win over the relative window; sending
	// both would let the relative filter widen what the absolute bounds fixed.
	if (recency && !filters.afterDate && !filters.beforeDate) request.search_recency_filter = recency;
	return request;
}

/** Ranked results minus unusable entries, keeping first-seen URL order. */
function collectSearchResults(results: readonly PerplexitySearchResult[]): Array<{
	title: string;
	url: string;
	snippet?: string;
	publishedDate?: string;
}> {
	const collected: Array<{ title: string; url: string; snippet?: string; publishedDate?: string }> = [];
	const seenUrls = new Set<string>();
	for (const result of results) {
		const url = result.url?.trim();
		if (!url || seenUrls.has(url)) continue;
		seenUrls.add(url);
		collected.push({
			title: result.title?.trim() || url,
			url,
			snippet: result.snippet?.replace(/\s+/g, " ").trim() || undefined,
			publishedDate: result.date?.trim() || undefined,
		});
	}
	return collected;
}

async function callPerplexitySearch(
	apiKey: string,
	request: PerplexitySearchRequest,
	params: PerplexitySearchParams,
): Promise<SearchResponse> {
	const response = await (params.fetch ?? fetch)(PERPLEXITY_SEARCH_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(request),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("perplexity", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"perplexity",
			`Perplexity Search API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	const payload = (await response.json()) as PerplexitySearchApiResponse;
	if (!Array.isArray(payload.results)) {
		throw new SearchProviderError("perplexity", "Perplexity Search API returned an unexpected response shape", 204);
	}

	return {
		provider: "perplexity",
		sources: toSearchSources(collectSearchResults(payload.results), request.max_results),
		requestId: payload.id ?? undefined,
		authMode: "api_key",
	};
}

/** Execute Perplexity web search through the Search API. */
export async function searchPerplexity(params: PerplexitySearchParams): Promise<SearchResponse> {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const filters = buildNativeFilters(parsed, params.query);
	const request = buildSearchRequest(
		filters,
		params.recency,
		clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
	);

	const apiKey = (await getApiKeyConfig(params.authStorage, params.sessionId, { signal: params.signal }))?.apiKey;
	if (!apiKey) {
		throw new SearchProviderError(
			"perplexity",
			'Perplexity Search API key not found. Set PERPLEXITY_API_KEY or configure an API key for provider "perplexity".',
			401,
		);
	}

	return callPerplexitySearch(apiKey, request, params);
}

/** Search provider for the Perplexity Search API. */
export class PerplexityProvider extends SearchProvider {
	readonly id = "perplexity";
	readonly label = "Perplexity";

	/**
	 * Auto-chain admission requires a Perplexity API key. The provider has one
	 * transport, so without a key there is nothing to try — the chain skips it
	 * instead of shelling out to a Sonar-backed fallback.
	 */
	isAvailable(authStorage: AuthStorage): boolean {
		// The Search API is bearer-keyed and `keys.source` resolves the same
		// cascade (`--api-key`, config, stored key, env) the request will use.
		// An OAuth-origin credential is skipped: `getApiKeyConfig` refuses it, so
		// admitting the provider would only strand the chain on a guaranteed 401.
		const source = authStorage.keys.source("perplexity");
		return !!$env.PERPLEXITY_API_KEY?.trim() || (source !== undefined && source.kind !== "oauth");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchPerplexity({
			signal: params.signal,
			timeoutMs: params.timeoutMs,
			query: params.query,
			parsedQuery: params.parsedQuery,
			recency: params.recency,
			num_results: params.numSearchResults ?? params.limit,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
			fetch: params.fetch,
		});
	}
}
