import { type ApiKey, type FetchImpl, getEnvApiKey, withAuth } from "@oh-my-pi/pi-ai";
import { fetchWithRetry, untilAborted } from "@oh-my-pi/pi-utils";
import { readBodyCapped } from "./response-body";
import { withHardTimeout } from "./search/providers/utils";

const DEEPSEEK_FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";
/** Longer server waits should yield to the next reader backend. */
const RETRY_MAX_DELAY_MS = 2_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class DeepSeekApiError extends Error {
	readonly statusCode?: number;

	constructor(message: string, statusCode?: number) {
		super(message);
		this.name = "DeepSeekApiError";
		this.statusCode = statusCode;
	}
}

export interface DeepSeekFetchOptions {
	apiKey?: ApiKey;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
}

function parseDeepSeekErrorResponse(statusCode: number, responseText: string): DeepSeekApiError {
	let detail = responseText.trim();
	try {
		const payload: unknown = JSON.parse(detail);
		if (payload && typeof payload === "object" && "error" in payload) {
			const error = payload.error;
			if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
				detail = error.message.trim();
			}
		}
	} catch {}
	return new DeepSeekApiError(`DeepSeek API error (${statusCode})${detail ? `: ${detail}` : ""}`, statusCode);
}

/** Fetch a page as Markdown through DeepSeek's standalone tools API. */
export async function fetchWithDeepSeek(url: string, options: DeepSeekFetchOptions): Promise<string | null> {
	const signal = withHardTimeout(options.signal, options.timeoutMs);
	signal.throwIfAborted();
	try {
		return await untilAborted(signal, () =>
			withAuth(
				options.apiKey ?? getEnvApiKey("deepseek"),
				async apiKey => {
					signal.throwIfAborted();
					const response = await fetchWithRetry(DEEPSEEK_FETCH_URL, {
						method: "POST",
						headers: {
							Accept: "application/json",
							"Content-Type": "application/json",
							Authorization: `Bearer ${apiKey}`,
						},
						body: JSON.stringify({ url }),
						signal,
						fetch: options.fetch,
						maxAttempts: 2,
						maxDelayMs: RETRY_MAX_DELAY_MS,
					});
					// Bound both payloads before decoding; truncated JSON is never parsed.
					const body = await readBodyCapped(response, MAX_RESPONSE_BYTES);
					signal.throwIfAborted();
					if (!response.ok) {
						// Preserve the status even on overflow so withAuth can rotate credentials.
						throw body?.truncated
							? new DeepSeekApiError(
									`DeepSeek API error (${response.status}): response body too large`,
									response.status,
								)
							: parseDeepSeekErrorResponse(response.status, body?.bytes.toString("utf8") ?? "");
					}
					if (!body || body.truncated) return null;
					const payload: unknown = JSON.parse(body.bytes.toString("utf8"));
					if (
						!payload ||
						typeof payload !== "object" ||
						!("content" in payload) ||
						typeof payload.content !== "string"
					) {
						return null;
					}
					return payload.content.replace(/\r\n?/g, "\n").trim() || null;
				},
				{
					signal,
					missingKeyMessage:
						'DeepSeek credentials not found. Set DEEPSEEK_API_KEY or configure an API key for provider "deepseek".',
				},
			),
		);
	} catch (error) {
		signal.throwIfAborted();
		throw error;
	}
}
