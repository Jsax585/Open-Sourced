import { type } from "@oh-my-pi/omptype";
import * as AIError from "../error";

const requestSchema = type({
	model: "string > 0",
	input: type("string").or("object[]"),
	questions: "object[]",
});

export class OpenAIDecisionsWireError extends AIError.ValidationError {
	readonly status = 400;

	override readonly name = "OpenAIDecisionsWireError";
}

export interface OpenAIDecisionsParsedRequest {
	modelId: string;
	body: Record<string, unknown>;
}

/** Parse the routing fields and retain the complete native Decisions request body. */
export async function parseRequest(req: Request): Promise<OpenAIDecisionsParsedRequest> {
	if (!(req.headers.get("content-type")?.toLowerCase() ?? "").startsWith("application/json")) {
		throw new OpenAIDecisionsWireError("decisions: Content-Type must be application/json");
	}
	let body: unknown;
	try {
		body = await req.json();
	} catch (cause) {
		throw new OpenAIDecisionsWireError("decisions: Invalid JSON body", { cause });
	}
	const parsed = requestSchema(body);
	if (parsed instanceof type.errors) throw new OpenAIDecisionsWireError(`decisions: ${parsed.summary}`);
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw new OpenAIDecisionsWireError("decisions: request body must be an object");
	}
	return { modelId: parsed.model, body: body as Record<string, unknown> };
}

/** OpenAI-compatible Decisions error envelope. */
export function formatError(status: number, type: string, message: string): Response {
	return new Response(JSON.stringify({ error: { type, message } }), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}
