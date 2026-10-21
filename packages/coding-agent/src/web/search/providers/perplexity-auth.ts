import type { AuthStorage, OAuthAccess } from "@oh-my-pi/pi-ai";
import { $env } from "@oh-my-pi/pi-utils";

export const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Credential a Perplexity request can authenticate with.
 *
 * The Search API (`api.perplexity.ai/search`) is bearer-keyed, so `api_key` is
 * the only search credential; `oauth` remains for `omp token perplexity`, which
 * prints the consumer subscription token.
 */
export interface ApiConfig {
	type: "api_key";
	apiKey: string;
}

export type PerplexityAuth =
	| ApiConfig
	| {
			type: "oauth";
			access: OAuthAccess;
	  };

export interface PerplexityAuthOptions {
	signal?: AbortSignal;
	forceRefresh?: boolean;
}

/** Resolve the direct `api.perplexity.ai` API key, if one is configured. */
export async function getApiKeyConfig(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	options?: PerplexityAuthOptions,
): Promise<ApiConfig | undefined> {
	// A Perplexity OAuth session and a real API key are mutually exclusive in
	// `keys.get`: when the active credential origin is OAuth it returns the
	// session JWT (OAuth wins in AuthStorage.keys.get), not an
	// `api.perplexity.ai` key. Emitting it as an api-key config would make
	// callers send the session token as a Bearer to the Search API, which
	// rejects it with 401 and masks the real (transport) failure — see #5315.
	// An explicit `PERPLEXITY_API_KEY` is still what the user asked for, so it
	// must win over a stored session instead of being shadowed by it.
	const source = authStorage.keys.source("perplexity");
	if (source?.kind === "oauth") {
		const envKey = $env.PERPLEXITY_API_KEY?.trim();
		return envKey ? { type: "api_key", apiKey: envKey } : undefined;
	}

	const apiKey = await authStorage.keys.get("perplexity", sessionId, options);
	return apiKey ? { type: "api_key", apiKey } : undefined;
}

/**
 * Decode a Perplexity JWT's `exp` claim, in ms. Returns `undefined` when the
 * token has no `exp` (which is the common case — Perplexity sessions are
 * server-side and effectively non-expiring from the client's POV).
 */
export function jwtExpiryMs(token: string): number | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	const payload = parts[1];
	if (!payload) return undefined;
	try {
		const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
		if (typeof decoded.exp !== "number" || !Number.isFinite(decoded.exp)) return undefined;
		return decoded.exp * 1000;
	} catch {
		return undefined;
	}
}

/** Collect credentials printable for `perplexity`, in priority order. */
export async function getAvailableAuthMethods(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	options?: PerplexityAuthOptions,
): Promise<PerplexityAuth[]> {
	const methods: PerplexityAuth[] = [];

	// 1. Perplexity OAuth (session bearer)
	try {
		const access = await authStorage.oauth.access("perplexity", sessionId, options);
		const token = access?.accessToken;
		if (access && token) {
			const jwtExpiry = jwtExpiryMs(token);
			if (jwtExpiry === undefined || jwtExpiry > Date.now() + OAUTH_EXPIRY_BUFFER_MS) {
				methods.push({ type: "oauth", access });
			}
		}
	} catch {
		// ignored
	}

	// 2. Direct API key
	const apiConfig = await getApiKeyConfig(authStorage, sessionId, options);
	if (apiConfig) methods.push(apiConfig);

	return methods;
}
