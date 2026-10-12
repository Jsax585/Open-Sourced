import type { Api, Model } from "../types";

export interface GatewayResponseOwner {
	sessionId: string;
	target: string;
	provider: string;
	api: Api;
	endpoint: string;
	account: string;
}

/** Private, bounded ownership of upstream response IDs returned by this server. */
export class GatewayResponseOwnership {
	#owners = new Map<string, Readonly<GatewayResponseOwner>>();
	get(responseId: string): Readonly<GatewayResponseOwner> | undefined {
		return this.#owners.get(responseId);
	}
	record(responseId: string | undefined, owner: GatewayResponseOwner): void {
		if (!responseId) return;
		this.#owners.delete(responseId);
		if (this.#owners.size >= 4096) this.#owners.delete(this.#owners.keys().next().value!);
		this.#owners.set(responseId, Object.freeze({ ...owner }));
	}
}

/** Deployment configuration and standard OpenAI account/project headers own stored state. */
export function responseEndpointIdentity(model: Model<Api>, requestHeaders?: Record<string, string>): string {
	const modelHeaders = new Headers(model.headers);
	const headers = new Headers(requestHeaders);
	return Bun.SHA256.hash(
		JSON.stringify({
			baseUrl: model.baseUrl,
			modelHeaders: [...modelHeaders.entries()].sort(([a], [b]) => a.localeCompare(b)),
			project: headers.get("openai-project") ?? modelHeaders.get("openai-project"),
			organization: headers.get("openai-organization") ?? modelHeaders.get("openai-organization"),
		}),
		"hex",
	);
}
