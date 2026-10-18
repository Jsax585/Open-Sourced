import { describe, expect, it } from "bun:test";
import { streamGoogleVertex, type GoogleVertexOptions } from "@oh-my-pi/pi-ai/providers/google-vertex";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * API-key Vertex requests with a project must name that project and location in
 * the path. The project-less publisher URL is what Google serves from
 * us-central1, so a global-only model 404s even when the host is already global.
 * With no project, that publisher URL stays so existing express-mode callers
 * are unchanged.
 */

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const MODEL_ID = "gemini-4-argon";
const API_KEY = "vertex-express-key";

const VERTEX_ENV = [
	"GOOGLE_CLOUD_API_KEY",
	"GOOGLE_CLOUD_PROJECT",
	"GCP_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_VERTEX_LOCATION",
	"GOOGLE_CLOUD_LOCATION",
	"VERTEX_LOCATION",
	"GOOGLE_APPLICATION_CREDENTIALS",
] as const;

type VertexEnvName = (typeof VERTEX_ENV)[number];

const context = {
	messages: [{ role: "user" as const, content: "hello", timestamp: 0 }],
};

const model: Model<"google-vertex"> = buildModel({
	id: MODEL_ID,
	name: "Gemini 4 Argon",
	api: "google-vertex",
	provider: "google-vertex",
	baseUrl: "https://{location}-aiplatform.googleapis.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
});

function scopedUrl(host: string, project: string, location: string): string {
	return `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${MODEL_ID}:streamGenerateContent?alt=sse`;
}

function publisherUrl(host: string): string {
	return `https://${host}/v1/publishers/google/models/${MODEL_ID}:streamGenerateContent?alt=sse`;
}

function sseStop(): Response {
	const chunk = {
		candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function notFound(): Response {
	return new Response(JSON.stringify({ error: { message: "Publisher model was not found", status: "NOT_FOUND" } }), {
		status: 404,
		headers: { "content-type": "application/json" },
	});
}

interface CapturedCall {
	url: string;
	apiKey: string | null;
	authorization: string | null;
}

async function withVertexEnv(values: Partial<Record<VertexEnvName, string>>, run: () => Promise<void>): Promise<void> {
	const saved = VERTEX_ENV.map(name => [name, Bun.env[name]] as const);
	for (const name of VERTEX_ENV) delete Bun.env[name];
	for (const [name, value] of Object.entries(values)) {
		if (value !== undefined) Bun.env[name] = value;
	}
	try {
		await run();
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete Bun.env[name];
			else Bun.env[name] = value;
		}
	}
}

async function capture(
	options: GoogleVertexOptions | undefined,
	respond: (callIndex: number) => Response,
): Promise<{ calls: CapturedCall[]; errorMessage: string | undefined; stopReason: string }> {
	const calls: CapturedCall[] = [];
	const stream = streamGoogleVertex(model, context, {
		...options,
		fetch: async (input, init) => {
			const url = input instanceof Request ? input.url : input.toString();
			const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
			// A mistaken ADC fall-through exchanges a token before the model call.
			// Answer it so the test fails on the model URL instead of hanging.
			if (url === METADATA_TOKEN_URL || url === OAUTH_TOKEN_URL) {
				calls.push({ url, apiKey: headers.get("x-goog-api-key"), authorization: headers.get("authorization") });
				return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }));
			}
			calls.push({ url, apiKey: headers.get("x-goog-api-key"), authorization: headers.get("authorization") });
			return respond(calls.length - 1);
		},
	});
	const result = await stream.result();
	return { calls, errorMessage: result.errorMessage, stopReason: result.stopReason };
}

function expectApiKeyCall(call: CapturedCall | undefined, url: string): void {
	expect(call?.url).toBe(url);
	expect(call?.apiKey).toBe(API_KEY);
	expect(call?.authorization).toBeNull();
}

describe("Vertex API-key GenerateContent URL", () => {
	it("scopes a project and global location so Google does not serve the call from us-central1", async () => {
		await withVertexEnv(
			{
				GOOGLE_CLOUD_API_KEY: API_KEY,
				GOOGLE_CLOUD_PROJECT: "vertex-project",
				GOOGLE_VERTEX_LOCATION: "global",
			},
			async () => {
				const { calls, stopReason } = await capture(undefined, () => sseStop());
				expect(calls).toHaveLength(1);
				expectApiKeyCall(calls[0], scopedUrl("aiplatform.googleapis.com", "vertex-project", "global"));
				expect(stopReason).toBe("stop");
			},
		);
	});

	it.each([
		{
			projectEnv: "GCP_PROJECT",
			project: "alias-gcp",
			locationEnv: "GOOGLE_VERTEX_LOCATION",
			location: "eu",
			host: "aiplatform.eu.rep.googleapis.com",
		},
		{
			projectEnv: "GCLOUD_PROJECT",
			project: "alias-gcloud",
			locationEnv: "VERTEX_LOCATION",
			location: "us",
			host: "aiplatform.us.rep.googleapis.com",
		},
		{
			projectEnv: "GOOGLE_CLOUD_PROJECT",
			project: "primary-project",
			locationEnv: "GOOGLE_CLOUD_LOCATION",
			location: "europe-west4",
			host: "europe-west4-aiplatform.googleapis.com",
		},
	] as const)(
		"scopes $projectEnv and $locationEnv ($location) onto $host",
		async ({ projectEnv, project, locationEnv, location, host }) => {
			// eu/us must use the REP host. The regional `{location}-aiplatform` host 404s for those codes.
			await withVertexEnv(
				{
					GOOGLE_CLOUD_API_KEY: API_KEY,
					[projectEnv]: project,
					[locationEnv]: location,
				},
				async () => {
					const { calls, stopReason } = await capture(undefined, () => sseStop());
					expect(calls).toHaveLength(1);
					expectApiKeyCall(calls[0], scopedUrl(host, project, location));
					expect(stopReason).toBe("stop");
				},
			);
		},
	);

	it("scopes a configured project to locations/global when location is unset", async () => {
		await withVertexEnv({ GOOGLE_CLOUD_API_KEY: API_KEY, GOOGLE_CLOUD_PROJECT: "vertex-project" }, async () => {
			const { calls, stopReason } = await capture(undefined, () => sseStop());
			expect(calls).toHaveLength(1);
			expectApiKeyCall(calls[0], scopedUrl("aiplatform.googleapis.com", "vertex-project", "global"));
			expect(stopReason).toBe("stop");
		});
	});

	it("keeps the project-less publisher URL when no project is configured", async () => {
		await withVertexEnv({ GOOGLE_CLOUD_API_KEY: API_KEY, GOOGLE_CLOUD_LOCATION: "global" }, async () => {
			const { calls, stopReason } = await capture(undefined, () => sseStop());
			expect(calls).toHaveLength(1);
			expectApiKeyCall(calls[0], publisherUrl("aiplatform.googleapis.com"));
			expect(stopReason).toBe("stop");
		});
	});

	it("falls back to the project-less global publisher URL when an ambient region 404s and no project is set", async () => {
		await withVertexEnv({ GOOGLE_CLOUD_API_KEY: API_KEY, GOOGLE_CLOUD_LOCATION: "us-central1" }, async () => {
			const { calls, stopReason } = await capture(undefined, index => (index === 0 ? notFound() : sseStop()));
			expect(calls).toHaveLength(2);
			expectApiKeyCall(calls[0], publisherUrl("us-central1-aiplatform.googleapis.com"));
			expectApiKeyCall(calls[1], publisherUrl("aiplatform.googleapis.com"));
			expect(stopReason).toBe("stop");
		});
	});

	it("falls back to the project-scoped global URL when an ambient region 404s and a project is set", async () => {
		await withVertexEnv(
			{
				GOOGLE_CLOUD_API_KEY: API_KEY,
				GOOGLE_CLOUD_PROJECT: "vertex-project",
				GOOGLE_CLOUD_LOCATION: "us-central1",
			},
			async () => {
				const { calls, stopReason } = await capture(undefined, index => (index === 0 ? notFound() : sseStop()));
				expect(calls).toHaveLength(2);
				expectApiKeyCall(
					calls[0],
					scopedUrl("us-central1-aiplatform.googleapis.com", "vertex-project", "us-central1"),
				);
				expectApiKeyCall(calls[1], scopedUrl("aiplatform.googleapis.com", "vertex-project", "global"));
				expect(stopReason).toBe("stop");
			},
		);
	});

	it("does not fall back when an explicit location 404s", async () => {
		await withVertexEnv({}, async () => {
			const { calls, errorMessage, stopReason } = await capture(
				{ apiKey: API_KEY, project: "vertex-project", location: "us-central1" },
				() => notFound(),
			);
			expect(calls).toHaveLength(1);
			expectApiKeyCall(
				calls[0],
				scopedUrl("us-central1-aiplatform.googleapis.com", "vertex-project", "us-central1"),
			);
			expect(stopReason).toBe("error");
			expect(errorMessage).toContain("Google API error (404)");
		});
	});

	it("lets options.project and options.location override the environment", async () => {
		await withVertexEnv(
			{
				GOOGLE_CLOUD_PROJECT: "env-project",
				GOOGLE_CLOUD_LOCATION: "us-central1",
			},
			async () => {
				const { calls, stopReason } = await capture(
					{ apiKey: API_KEY, project: "option-project", location: "eu" },
					() => sseStop(),
				);
				expect(calls).toHaveLength(1);
				expectApiKeyCall(calls[0], scopedUrl("aiplatform.eu.rep.googleapis.com", "option-project", "eu"));
				expect(stopReason).toBe("stop");
			},
		);
	});
});
