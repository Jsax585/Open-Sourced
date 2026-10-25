import type { FetchImpl } from "../types";
import { getNativeFinishReasonError } from "./native-finish-reason";

/**
 * Responses can normalize upstream failures to completed without exposing the
 * native reason. When metadata is unavailable (404 lag) on a turn that billed
 * non-reasoning output tokens yet delivered zero output items, fall back to a
 * malformed-response error so the caller's malformed-call recovery and fallback
 * chain can intervene instead of spinning in a cache-pinned empty-stop loop.
 */
export async function readOpenRouterGenerationError(args: {
	baseUrl: string;
	headers: Record<string, string>;
	responseId: string;
	outputTokens?: number;
	reasoningTokens?: number;
	fetch?: FetchImpl;
	signal: AbortSignal;
}): Promise<string | undefined> {
	const timeout = AbortSignal.timeout(2_000);
	const signal = AbortSignal.any([args.signal, timeout]);
	try {
		const url = new URL(`${args.baseUrl.replace(/\/$/, "")}/generation`);
		url.searchParams.set("id", args.responseId);
		const response = await (args.fetch ?? fetch)(url.toString(), {
			method: "GET",
			headers: args.headers,
			signal,
		});
		if (!response.ok) {
			await response.body?.cancel();
			return fallbackDroppedOutputError(args);
		}
		const body: unknown = await response.json();
		if (!body || typeof body !== "object" || !("data" in body)) return undefined;
		const data = body.data;
		if (!data || typeof data !== "object" || !("id" in data) || data.id !== args.responseId) return undefined;
		if (!("native_finish_reason" in data)) return undefined;
		const error = getNativeFinishReasonError(data.native_finish_reason);
		return error ? `${error}; response ID: ${args.responseId}` : undefined;
	} catch {
		// Metadata can lag the completed stream or be unavailable on a gateway.
		// Cancellation is checked by the caller.
		return fallbackDroppedOutputError(args);
	}
}

function fallbackDroppedOutputError(args: {
	responseId: string;
	outputTokens?: number;
	reasoningTokens?: number;
}): string | undefined {
	const nonReasoningOutputTokens = Math.max(0, (args.outputTokens ?? 0) - (args.reasoningTokens ?? 0));
	if (nonReasoningOutputTokens <= 0) return undefined;
	const error = getNativeFinishReasonError("MALFORMED_RESPONSE");
	return error ? `${error}; response ID: ${args.responseId}` : undefined;
}
