import { type FetchImpl, getEnvApiKey } from "@oh-my-pi/pi-ai";
import { fetchWithRetry } from "@oh-my-pi/pi-utils";
import type { AgentStorage } from "../session/agent-storage";
import { findCredential, withHardTimeout } from "./search/providers/utils";

const DEEPSEEK_FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";
/** Longer server waits should yield to the next reader backend. */
const RETRY_MAX_DELAY_MS = 2_000;

export class DeepSeekApiError extends Error {
	readonly statusCode?: number;

	constructor(message: string, statusCode?: number) {
		super(message);
		this.name = "DeepSeekApiError";
		this.statusCode = statusCode;
	}
}

export interface DeepSeekFetchOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
}

export function findDeepSeekApiKey(storage: AgentStorage | null | undefined): string | null {
	return findCredential(storage, getEnvApiKey("deepseek"), "deepseek");
}

function parseDeepSeekErrorResponse(statusCode: number, responseText: string): DeepSeekApiError {
	let detail = responseText.trim();
	try {
		const payload = JSON.parse(detail) as { error?: { message?: unknown } | null };
		if (typeof payload?.error?.message === "string") detail = payload.error.message.trim();
	} catch {}
	return new DeepSeekApiError(`DeepSeek API error (${statusCode})${detail ? `: ${detail}` : ""}`, statusCode);
}

/** Fetch a page as Markdown through DeepSeek's standalone tools API. */
export async function fetchWithDeepSeek(
	url: string,
	options: DeepSeekFetchOptions,
	storage: AgentStorage | null | undefined,
): Promise<string | null> {
	const apiKey = findDeepSeekApiKey(storage);
	if (!apiKey) {
		throw new DeepSeekApiError("DeepSeek fetch credentials not found. Use DEEPSEEK_API_KEY or /login deepseek.");
	}

	const signal = withHardTimeout(options.signal, options.timeoutMs);
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
	}).catch(error => {
		signal.throwIfAborted();
		throw error;
	});
	if (!response.ok) {
		throw parseDeepSeekErrorResponse(response.status, await response.text());
	}

	const payload = (await response.json()) as { title?: unknown; content?: unknown } | null;
	if (typeof payload?.content !== "string") return null;
	return payload.content.replace(/\r\n?/g, "\n").trim() || null;
}
