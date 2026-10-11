import { logger } from "@oh-my-pi/pi-utils";
import {
	OPENAI_DECISIONS_API,
	OPENAI_DECISIONS_PROVIDER,
	openAIDecisionsUsageFromResponse,
} from "../../judgment/openai-decisions";
import { postOpenAIDecisions } from "../../judgment/openai-decisions-transport";
import { classifyGatewayError } from "../../error/gateway";
import * as decisions from "../../providers/openai-decisions-server";
import { deterministicUuid } from "../../utils/deterministic-id";
import {
	type AuthGatewayRouteOptions,
	buildGatewayApiKeyResolver,
	mirrorRequestAbort,
	recordGatewayUsage,
	resolveGatewayApiKey,
} from "../dispatch";
import { gatewayResponseHeaders, json, resolveClientIdentity } from "../http";

/** OpenAI's native `POST /v1/decisions` gateway route. */
export async function handleOpenAIDecisions(
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	const aborted = (): Response => decisions.formatError(499, "request_aborted", "client closed request");
	if (controller.signal.aborted) return aborted();

	let parsed: decisions.OpenAIDecisionsParsedRequest;
	try {
		parsed = await decisions.parseRequest(req);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const message = error instanceof Error ? error.message : String(error);
		const status = error instanceof decisions.OpenAIDecisionsWireError ? error.status : 400;
		return decisions.formatError(status, "invalid_request_error", message);
	}
	if (controller.signal.aborted) return aborted();

	const model = bootOpts.resolveModel(parsed.modelId);
	if (!model) return decisions.formatError(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	if (model.api !== OPENAI_DECISIONS_API && model.judgment?.api !== OPENAI_DECISIONS_API) {
		return decisions.formatError(
			400,
			"invalid_request_error",
			`Model ${parsed.modelId} does not support OpenAI Decisions`,
		);
	}

	const client = resolveClientIdentity(req.headers);
	const sessionId = deterministicUuid(`openai-decisions\u0000${model.provider}/${model.id}`);
	const apiKey = await resolveGatewayApiKey(bootOpts.storage, model, sessionId, controller.signal, peer);
	if (controller.signal.aborted) return aborted();
	if ("status" in apiKey) return decisions.formatError(apiKey.status, apiKey.type, apiKey.message);

	logger.info("auth-gateway request", {
		requestId,
		format: "openai-decisions",
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: false,
		peer,
	});

	try {
		const response = await postOpenAIDecisions(
			{
				apiKey: buildGatewayApiKeyResolver(
					bootOpts.storage,
					model,
					sessionId,
					apiKey,
					controller.signal,
					"openai-decisions",
					peer,
				),
				model: model.id,
				provider: model.provider || OPENAI_DECISIONS_PROVIDER,
				baseUrl: model.baseUrl,
				headers: model.headers,
				fetch: bootOpts.fetch,
			},
			JSON.stringify({ ...parsed.body, model: model.id }),
			controller.signal,
		);
		if (typeof response.model !== "string" || response.model.length === 0) {
			throw new Error("OpenAI Decisions response is missing the returned model name");
		}
		const cost = model.judgment?.api === OPENAI_DECISIONS_API ? model.judgment.cost : model.cost;
		const usage = openAIDecisionsUsageFromResponse(response.usage, cost, model.provider);
		recordGatewayUsage(bootOpts.storage, model, client, usage);
		return json(200, response, gatewayResponseHeaders(model, { requestId, costUsd: usage.cost.total, startedAt }));
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway Decisions request failed", { error: classified.message, peer });
		return decisions.formatError(classified.status, classified.type, classified.message);
	}
}
