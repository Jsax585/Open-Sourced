import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { isRecord } from "@oh-my-pi/pi-utils";
import { type ApiKey, withAuth } from "../auth-retry";
import * as AIError from "../error";
import { getRetryAfterMsFromHeaders } from "../utils/retry-after";

export const OPENAI_DECISIONS_BASE_URL = "https://api.openai.com/v1";

const DECISIONS_ROUTE = "/decisions";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 5_000;

export class OpenAIDecisionsApiError extends AIError.ProviderHttpError {
	override readonly name = "OpenAIDecisionsApiError";
}

export interface OpenAIDecisionsTransportOptions {
	apiKey: ApiKey;
	model: string;
	provider: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	fetch?: FetchImpl;
	timeoutMs?: number;
}

function backoffMs(attempt: number, headers: Headers | undefined): number {
	const hinted = headers === undefined ? undefined : getRetryAfterMsFromHeaders(headers);
	if (hinted !== undefined) return Math.min(hinted, BACKOFF_MAX_MS);
	return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

function responseError(provider: string, detail: string, cause?: unknown): AIError.ProviderResponseError {
	return new AIError.ProviderResponseError(`OpenAI Decisions response ${detail}`, {
		provider,
		kind: "envelope",
		...(cause === undefined ? {} : { cause }),
	});
}

/** Send one Decisions request with the shared credential-rotation and retry policy. */
type OpenAIDecisionsWireResponse = Record<string, unknown> & { answers: unknown[] };

export async function postOpenAIDecisions(
	options: OpenAIDecisionsTransportOptions,
	body: string,
	signal?: AbortSignal,
): Promise<OpenAIDecisionsWireResponse> {
	const baseUrl = (options.baseUrl ?? OPENAI_DECISIONS_BASE_URL).replace(/\/+$/, "");
	const url = `${baseUrl}${DECISIONS_ROUTE}`;
	const label = `${options.provider}/${options.model}`;
	const headers: Record<string, string> = {
		...options.headers,
		Accept: "application/json",
		"Content-Type": "application/json",
	};
	const fetchImpl = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return withAuth(
		options.apiKey,
		async key => {
			headers.Authorization = `Bearer ${key}`;
			for (let attempt = 0; ; attempt++) {
				signal?.throwIfAborted();
				const timeout = AbortSignal.timeout(timeoutMs);
				let response: Response;
				try {
					response = await fetchImpl(url, {
						method: "POST",
						headers,
						body,
						signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
					});
				} catch (error) {
					if (signal?.aborted || attempt + 1 >= MAX_ATTEMPTS) throw error;
					await Bun.sleep(backoffMs(attempt, undefined));
					continue;
				}
				if (response.ok) {
					let parsed: unknown;
					try {
						parsed = await response.json();
					} catch (cause) {
						throw responseError(options.provider, "contains malformed JSON", cause);
					}
					if (!isRecord(parsed) || !Array.isArray(parsed.answers)) {
						throw responseError(options.provider, "has a malformed answer envelope");
					}
					return parsed as OpenAIDecisionsWireResponse;
				}
				const text = await response.text();
				const error = new OpenAIDecisionsApiError(
					`${label} API error (${response.status}): ${text}`,
					response.status,
					{ headers: response.headers },
				);
				const transient = response.status === 408 || response.status === 429 || response.status >= 500;
				if (!transient || attempt + 1 >= MAX_ATTEMPTS) throw error;
				await Bun.sleep(backoffMs(attempt, response.headers));
			}
		},
		{ signal },
	);
}
