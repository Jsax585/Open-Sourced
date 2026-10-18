/**
 * Factory Web Search Provider
 *
 * Searches through Factory's hosted web-search tool with the Factory Droid
 * login (`omp /login factory-droid`), the same route the `droid` CLI's
 * WebSearch tool calls. Factory picks the upstream vendor (You.com, Parallel
 * or Exa) server-side, so the response is one of three shapes.
 * Endpoint: POST {api host}/api/tools/web-search
 *
 * An organization can turn the tool off with the managed setting
 * `webSearchDisabled`; the provider checks it before sending the query, and
 * the backend enforces it too.
 */
import { type AuthStorage, type FetchImpl, type OAuthAccess, withOAuthAccess } from "@oh-my-pi/pi-ai";
import { factoryDroidApiBaseUrl, factoryDroidClientHeaders } from "@oh-my-pi/pi-catalog/wire/factory-droid";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../types";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, normalizeSearchText, withHardTimeout } from "./utils";

const FACTORY_PROVIDER = "factory-droid";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
/** How long an organization's `webSearchDisabled` answer is reused. */
const ORG_POLICY_TTL_MS = 5 * 60_000;
/** `fetch` rejects header values that are not Latin-1; droid sends optional headers only when printable ASCII. */
const HEADER_SAFE_VALUE = /^[\x20-\x7e]+$/;

const orgPolicyCache = new Map<string, { disabled: boolean; expiresAt: number }>();

/** Whether the organization's managed settings turn Factory web search off. Unknown policy allows. */
async function isWebSearchDisabledForOrg(
	access: OAuthAccess,
	fetchImpl: FetchImpl,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	const key = `${access.region ?? ""}\u0000${access.orgId ?? ""}`;
	const cached = orgPolicyCache.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached.disabled;

	const response = await fetchImpl(`${factoryDroidApiBaseUrl(access.region)}/api/organization/managed-settings`, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${access.accessToken}`,
			...factoryDroidClientHeaders(access.orgId),
		},
		signal,
	});
	if (response.status === 401) {
		throw new SearchProviderError("factory", "factory: 401 unauthorized", 401);
	}
	if (!response.ok) return false;
	const body: unknown = await response.json().catch(() => null);
	if (!isRecord(body) || !isRecord(body.settings)) return false;
	const disabled = body.settings.webSearchDisabled === true;
	orgPolicyCache.set(key, { disabled, expiresAt: Date.now() + ORG_POLICY_TTL_MS });
	return disabled;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	return normalizeSearchText(record[key]);
}

function firstString(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	for (const item of value) {
		const text = normalizeSearchText(item);
		if (text) return text;
	}
	return undefined;
}

function joinStrings(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	return normalizeSearchText(value.filter(item => typeof item === "string").join(" … "));
}

function toSource(
	item: unknown,
	fields: (record: Record<string, unknown>) => Omit<SearchSource, "title" | "url" | "ageSeconds">,
): SearchSource | undefined {
	if (!isRecord(item)) return undefined;
	const url = stringField(item, "url");
	if (!url) return undefined;
	const rest = fields(item);
	return {
		title: stringField(item, "title") ?? url,
		url,
		...rest,
		ageSeconds: dateToAgeSeconds(rest.publishedDate),
	};
}

/**
 * Normalize Factory's vendor-dependent response: Parallel
 * (`results[]` with `excerpts`), Exa (`results[]` with `publishedDate`), or
 * You.com (`results.web[]` / `results.news[]`).
 */
export function parseFactorySearchResults(body: unknown): SearchSource[] {
	if (!isRecord(body)) return [];
	const { results } = body;
	const sources: (SearchSource | undefined)[] = [];
	if (Array.isArray(results)) {
		for (const item of results) {
			if (isRecord(item) && Array.isArray(item.excerpts)) {
				sources.push(
					toSource(item, r => ({
						snippet: joinStrings(r.excerpts),
						publishedDate: stringField(r, "publish_date"),
					})),
				);
			} else {
				sources.push(
					toSource(item, r => ({
						snippet: joinStrings(r.highlights) ?? stringField(r, "summary") ?? stringField(r, "text"),
						publishedDate: stringField(r, "publishedDate"),
						author: stringField(r, "author"),
					})),
				);
			}
		}
	} else if (isRecord(results)) {
		for (const group of [results.web, results.news]) {
			if (!Array.isArray(group)) continue;
			for (const item of group) {
				sources.push(
					toSource(item, r => ({
						snippet: stringField(r, "description") ?? firstString(r.snippets),
						publishedDate: stringField(r, "page_age"),
						author: firstString(r.authors),
					})),
				);
			}
		}
	}
	return sources.filter((source): source is SearchSource => source !== undefined);
}

async function callFactorySearch(
	access: OAuthAccess,
	params: {
		query: string;
		numResults: number;
		sessionId?: string;
		signal?: AbortSignal;
		timeoutMs?: number;
		fetch: FetchImpl;
	},
): Promise<{ sources: SearchSource[]; requestId?: string }> {
	const signal = withHardTimeout(params.signal, params.timeoutMs);
	if (await isWebSearchDisabledForOrg(access, params.fetch, signal)) {
		throw new SearchProviderError("factory", "Factory web search is disabled by your organization's settings.", 403);
	}

	const response = await params.fetch(`${factoryDroidApiBaseUrl(access.region)}/api/tools/web-search`, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			Authorization: `Bearer ${access.accessToken}`,
			...factoryDroidClientHeaders(access.orgId),
			...(params.sessionId && HEADER_SAFE_VALUE.test(params.sessionId) ? { "x-session-id": params.sessionId } : {}),
		},
		body: JSON.stringify({ query: params.query, numResults: params.numResults }),
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("factory", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"factory",
			`Factory web search error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	const sources = parseFactorySearchResults(await response.json());
	return { sources, requestId: response.headers.get("x-request-id") ?? undefined };
}

/** Execute a Factory-hosted web search with the stored Factory Droid login. */
export async function searchFactory(
	params: Pick<SearchParams, "query" | "limit" | "numSearchResults" | "signal" | "timeoutMs" | "sessionId"> & {
		authStorage: AuthStorage;
		fetch?: FetchImpl;
	},
): Promise<SearchResponse> {
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const { sources, requestId } = await withOAuthAccess(
		params.authStorage,
		FACTORY_PROVIDER,
		access =>
			callFactorySearch(access, {
				query: params.query,
				numResults,
				sessionId: params.sessionId,
				signal: params.signal,
				timeoutMs: params.timeoutMs,
				fetch: params.fetch ?? fetch,
			}),
		{
			sessionId: params.sessionId,
			signal: params.signal,
			missingAccessMessage: "Factory web search needs a Factory login: run 'omp /login factory-droid'.",
		},
	);
	return { provider: "factory", sources: sources.slice(0, numResults), requestId, authMode: "oauth" };
}

/** Search provider for Factory-hosted web search. */
export class FactoryProvider extends SearchProvider {
	readonly id = "factory";
	readonly label = "Factory";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.keys.source(FACTORY_PROVIDER)?.kind === "oauth";
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchFactory(params);
	}
}
