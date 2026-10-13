import { logger } from "@oh-my-pi/pi-utils";
import type { ResolvedApiKey } from "../auth-retry";
import { classifyGatewayError, type GatewayErrorClassification } from "../error/gateway";
import { providerRetryDirective } from "../error/retryable";
import { completeSimple, streamSimple } from "../stream";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "../types";
import type { ClientUsageIdentity } from "../usage";
import { hasBillableUsage } from "../utils/billable-usage";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { type RouteDecisionTraceInput, redactedDecisionSummary } from "./decision-trace";
import {
	type AuthGatewayRouteOptions,
	buildGatewayApiKeyResolver,
	buildGatewayContinuationApiKeyResolver,
	recordGatewayUsage,
	resolveGatewayAccount,
	resolveGatewayApiKey,
} from "./dispatch";
import { gatewayResponseHeaders, json } from "./http";
import {
	type GatewayResponseOwner,
	type GatewayResponseOwnership,
	responseEndpointIdentity,
} from "./response-ownership";
import { decideAttempt, type ExecutionState } from "./route-conductor";
import type { CompiledRoute, RouteRegistry } from "./route-graph";
import type { AuthGatewaySessionStateStore } from "./session-state";
import { withGatewayCredentialTurn } from "./turn-lifecycle";
import type { AuthGatewayStreamControl } from "./types";

const MAX_PRELUDE_BYTES = 4 * 1024 * 1024;
const PRELUDE_EVENTS = new Set<AssistantMessageEvent["type"]>([
	"start",
	"text_start",
	"thinking_start",
	"toolcall_start",
]);

async function nextEvent(
	iterator: AsyncIterator<AssistantMessageEvent>,
	signal: AbortSignal,
): Promise<IteratorResult<AssistantMessageEvent>> {
	if (signal.aborted) throw signal.reason;
	const aborted = Promise.withResolvers<never>();
	const onAbort = () => aborted.reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([iterator.next(), aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function forwardRemainingEvents(
	source: AssistantMessageEventStream,
	iterator: AsyncIterator<AssistantMessageEvent>,
	output: AssistantMessageEventStream,
	signal: AbortSignal,
): Promise<void> {
	try {
		while (!output.done) {
			const next = await nextEvent(iterator, signal);
			if (next.done) {
				output.end(await source.result());
				return;
			}
			output.push(next.value);
		}
	} catch (error) {
		output.fail(error);
	}
}

/** Hold canonical metadata, not transport-specific frames: every codec sees only the chosen attempt. */
async function probeStream(
	source: AssistantMessageEventStream,
	signal: AbortSignal,
): Promise<{
	events: AssistantMessageEventStream;
	failure?: AssistantMessage;
	committed: boolean;
}> {
	const iterator = source[Symbol.asyncIterator]();
	const held: AssistantMessageEvent[] = [];
	let bytes = 0;
	const output = new AssistantMessageEventStream();
	output.forwardLocalWorkFrom(source);
	while (true) {
		const next = await nextEvent(iterator, signal);
		if (next.done) {
			// Never infer success from EOF. This throws for a truncated canonical stream.
			const message = await source.result();
			for (const event of held) output.push(event);
			output.end(message);
			return {
				events: output,
				committed: false,
				failure: message.stopReason === "error" || message.stopReason === "aborted" ? message : undefined,
			};
		}
		const event = next.value;
		const terminal = event.type === "done" || event.type === "error";
		if (terminal || !PRELUDE_EVENTS.has(event.type)) {
			for (const metadata of held) output.push(metadata);
			output.push(event);
			if (terminal)
				return {
					events: output,
					committed: false,
					failure: event.type === "error" ? event.error : undefined,
				};
			void forwardRemainingEvents(source, iterator, output, signal);
			return { events: output, committed: true };
		}
		// Providers mutate partial messages in place; a held prelude must retain its original snapshot.
		const metadata = structuredClone(event);
		bytes += new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
		held.push(metadata);
		if (bytes >= MAX_PRELUDE_BYTES) {
			for (const item of held) output.push(item);
			void forwardRemainingEvents(source, iterator, output, signal);
			return { events: output, committed: true };
		}
	}
}

export interface GatewayChatExecutionOptions {
	boot: AuthGatewayRouteOptions;
	registry: RouteRegistry;
	compiled: CompiledRoute;
	requestId: string;
	controller: AbortController;
	peer: string;
	startedAt: number;
	label: string;
	requestedModelId: string;
	context: Context;
	stream: boolean;
	client: ClientUsageIdentity;
	sessionId: string;
	clientKey: string | undefined;
	toolsJson: string | undefined;
	previousId: string | undefined;
	previousOwner: Readonly<GatewayResponseOwner> | undefined;
	requestHeaders: Record<string, string> | undefined;
	sessionStates: AuthGatewaySessionStateStore;
	responseOwners: GatewayResponseOwnership;
	validateModel: (model: Model<Api>) => string | undefined;
	buildOptions: (model: Model<Api>, signal: AbortSignal) => SimpleStreamOptions;
	encodeResponse: (message: AssistantMessage) => unknown;
	encodeStream: (events: AssistantMessageEventStream, control: AuthGatewayStreamControl) => ReadableStream<Uint8Array>;
	formatError: (status: number, type: string, message: string) => Response;
}

/** A bounded, request-local consumer of the pure planner. Catalog snapshots and response owners never move mid-attempt. */
export async function runGatewayChatExecution(opts: GatewayChatExecutionOptions): Promise<Response> {
	const { boot, registry, compiled, requestId, controller, sessionId, previousId, previousOwner } = opts;
	return withGatewayCredentialTurn(boot.storage, requestId, controller, async turn => {
		const firstTarget = previousOwner?.target ?? compiled.targets[0];
		if (firstTarget === undefined || !compiled.targets.includes(firstTarget))
			return opts.formatError(
				400,
				"invalid_request_error",
				"previous_response_id belongs to another upstream deployment",
			);
		let target: string = firstTarget;
		const attemptedTargets = new Set<string>();
		const credentialCandidates = new Map(
			compiled.targets.map(id => {
				const model = registry.getModel(compiled, id);
				return [id, model ? boot.storage.credentials.list(model.provider).map(row => row.id) : []] as const;
			}),
		);
		let attemptedCredentials = new Set<number>();
		let retryCount = 0;
		let fallbackCount = 0;
		let siblingsExhausted = false;
		let selectedKey: ResolvedApiKey | undefined;
		let requestedCredential: number | undefined = previousOwner?.credentialId;
		let sameTargetRetries = 0;
		let siblingFailure: GatewayErrorClassification | undefined;
		const trace = (entry: Pick<RouteDecisionTraceInput, "disposition" | "reason">) => {
			if (boot.decisionTraces)
				logger.debug(
					"auth-gateway route decision",
					redactedDecisionSummary(
						boot.decisionTraces.record({
							requestId,
							routeId: compiled.id,
							generation: compiled.generation,
							selectedTarget: target,
							...entry,
						}),
					),
				);
		};
		const errorResponse = (error: unknown, model: Model<Api>, classified = classifyGatewayError(error)): Response => {
			const response = opts.formatError(
				classified.status,
				classified.type,
				typeof error === "object" &&
					error !== null &&
					"errorMessage" in error &&
					typeof error.errorMessage === "string"
					? error.errorMessage
					: classified.message,
			);
			const directive = providerRetryDirective(error);
			if (directive !== undefined) response.headers.set("x-should-retry", String(directive));
			for (const [name, value] of Object.entries(gatewayResponseHeaders(model, { requestId })))
				response.headers.set(name, value);
			return response;
		};
		const retry = (classified: GatewayErrorClassification, allowHeldRetry: boolean): boolean => {
			if (previousId || controller.signal.aborted) return false;
			const state: ExecutionState = {
				routeId: compiled.id,
				generation: compiled.generation,
				attemptedTargets,
				retryCount,
				fallbackCount,
				committed: false,
				currentTarget: target,
				siblingsExhausted,
			};
			let action = decideAttempt({
				route: compiled,
				state,
				classification: classified,
				commitState: "probing",
			});
			if (action.type === "sibling_credential") {
				// Exact-row selection still honors account restrictions and explicit pins; never retry a row already served by this target.
				const sibling =
					selectedKey?.credentialId === undefined
						? undefined
						: credentialCandidates.get(target)?.find(id => !attemptedCredentials.has(id));
				if (sibling !== undefined) {
					requestedCredential = sibling;
					siblingFailure = classified;
				} else {
					siblingsExhausted = true;
					state.siblingsExhausted = true;
					action = decideAttempt({
						route: compiled,
						state,
						classification: classified,
						commitState: "probing",
					});
				}
			}
			if (action.type === "fallback_target") {
				target = action.targetModelId;
				fallbackCount++;
				attemptedCredentials = new Set();
				siblingsExhausted = false;
				selectedKey = undefined;
				requestedCredential = undefined;
				siblingFailure = undefined;
				sameTargetRetries = 0;
			} else if (action.type !== "sibling_credential") {
				// Preserve the earlier held-Responses transport retry, without inventing cross-target edges.
				if (
					!allowHeldRetry ||
					sameTargetRetries >= 2 ||
					(classified.disposition !== "provider_transient" && classified.disposition !== "provider_unavailable")
				)
					return false;
				sameTargetRetries++;
			}
			retryCount++;
			boot.storage.coordination.releaseTurnReservation(requestId);
			return true;
		};
		while (true) {
			if (controller.signal.aborted) return opts.formatError(499, "request_aborted", "client closed request");
			attemptedTargets.add(target);
			const model = registry.getModel(compiled, target);
			if (!model) {
				const unavailable: GatewayErrorClassification = {
					status: 404,
					type: "invalid_request_error",
					message: `Unknown model: ${target}`,
					owner: "model",
					disposition: "model_unavailable",
				};
				trace({ disposition: "skipped", reason: "capability_mismatch" });
				if (retry(unavailable, false)) continue;
				return opts.formatError(unavailable.status, unavailable.type, unavailable.message);
			}
			const rejection = opts.validateModel(model);
			if (rejection) {
				trace({ disposition: "skipped", reason: "capability_mismatch" });
				return opts.formatError(400, "invalid_request_error", rejection);
			}
			const apiKey = await resolveGatewayApiKey(boot.storage, model, sessionId, controller.signal, opts.peer, {
				requestId,
				credentialId: requestedCredential ?? selectedKey?.credentialId,
			});
			if (controller.signal.aborted) return opts.formatError(499, "request_aborted", "client closed request");
			if ("status" in apiKey) {
				trace({
					disposition: "skipped",
					reason: apiKey.credentialLookupFailed ? "credential_lookup_failed" : "credential_unavailable",
				});
				if (requestedCredential !== undefined) {
					attemptedCredentials.add(requestedCredential);
					requestedCredential = undefined;
				}
				if (retry(apiKey.credentialLookupFailed ? apiKey : (siblingFailure ?? apiKey), false)) continue;
				return errorResponse(apiKey, model, apiKey);
			}
			selectedKey = apiKey;
			if (apiKey.credentialId !== undefined) attemptedCredentials.add(apiKey.credentialId);
			const owner: GatewayResponseOwner = {
				sessionId,
				target,
				provider: model.provider,
				api: model.api,
				endpoint: responseEndpointIdentity(model, opts.requestHeaders),
				account: resolveGatewayAccount(boot.storage, model.provider, sessionId, apiKey),
				credentialId: apiKey.credentialId,
			};
			if (previousOwner && previousOwner.account !== owner.account)
				return opts.formatError(400, "invalid_request_error", "previous_response_id belongs to another account");
			trace({ disposition: "dispatched" });
			const lease = opts.sessionStates.acquire({
				clientKey: opts.clientKey,
				model,
				context: opts.context,
				toolsJson: opts.toolsJson,
				account: owner.account,
			});
			const attempt = new AbortController();
			const onAbort = () => {
				attempt.abort(controller.signal.reason);
				release();
			};
			controller.signal.addEventListener("abort", onAbort, { once: true });
			let streamOwned = false;
			const release = () => {
				lease.release();
				controller.signal.removeEventListener("abort", onAbort);
			};
			let replayEligible = true;
			try {
				const streamOpts = opts.buildOptions(model, attempt.signal);
				if (boot.fetch) streamOpts.fetch = boot.fetch;
				streamOpts.providerSessionState = lease.states;
				const resolved = (key: ResolvedApiKey) => {
					if (attempt.signal.aborted) return;
					selectedKey = key;
					if (key.credentialId !== undefined) attemptedCredentials.add(key.credentialId);
					owner.account = resolveGatewayAccount(boot.storage, model.provider, sessionId, key);
					owner.credentialId = key.credentialId;
					lease.updateAccount(owner.account);
				};
				streamOpts.apiKey = previousId
					? buildGatewayContinuationApiKeyResolver(
							boot.storage,
							model,
							apiKey,
							attempt.signal,
							resolved,
							requestId,
						)
					: buildGatewayApiKeyResolver(
							boot.storage,
							model,
							sessionId,
							apiKey,
							attempt.signal,
							opts.label,
							opts.peer,
							resolved,
							requestId,
						);
				logger.info("auth-gateway request", {
					requestId,
					format: opts.label,
					model: opts.requestedModelId,
					resolvedProvider: model.provider,
					resolvedModel: model.id,
					stream: opts.stream,
					peer: opts.peer,
				});
				const observe = (message: AssistantMessage) => {
					recordGatewayUsage(boot.storage, model, opts.client, message.usage, message.timestamp || undefined);
					if (message.stopReason !== "error" && message.stopReason !== "aborted")
						opts.responseOwners.record(message.responseId, owner);
				};
				if (!opts.stream) {
					const message = await completeSimple(model, opts.context, streamOpts);
					replayEligible = false;
					observe(message);
					if (
						message.stopReason === "error" &&
						!hasBillableUsage(message.usage) &&
						retry(classifyGatewayError(message), false)
					)
						continue;
					turn.finish(message);
					if (message.stopReason === "aborted")
						return opts.formatError(499, "request_aborted", message.errorMessage ?? "Request was aborted");
					if (message.stopReason === "error") return errorResponse(message, model);
					return json(
						200,
						opts.encodeResponse(message),
						gatewayResponseHeaders(model, {
							requestId,
							costUsd: message.usage.cost.total,
							startedAt: opts.startedAt,
						}),
					);
				}
				const source = streamSimple(model, opts.context, streamOpts);
				void source
					.result()
					.then(observe)
					.catch(() => {});
				const probed = await probeStream(source, attempt.signal);
				replayEligible = false;
				if (
					!probed.committed &&
					probed.failure?.stopReason === "error" &&
					!hasBillableUsage(probed.failure.usage) &&
					retry(classifyGatewayError(probed.failure), opts.label === "openai-responses")
				)
					continue;
				const encoded = opts.encodeStream(probed.events, {
					signal: attempt.signal,
					onCancel: reason => {
						if (!controller.signal.aborted)
							controller.abort(reason instanceof Error ? reason : new Error("client closed request"));
					},
				});
				// Retain the source result and lease through downstream settlement/cancellation.
				const wrapped = turn.wrap(encoded, () => probed.events.result());
				void probed.events
					.result()
					.catch(() => {})
					.finally(release);
				streamOwned = true;
				return new Response(wrapped, {
					status: 200,
					headers: {
						...gatewayResponseHeaders(model, { requestId }),
						"Content-Type": "text/event-stream; charset=utf-8",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
						"X-Accel-Buffering": "no",
					},
				});
			} catch (error) {
				if (controller.signal.aborted) return opts.formatError(499, "request_aborted", "client closed request");
				if (replayEligible && retry(classifyGatewayError(error), false)) continue;
				return errorResponse(error, model);
			} finally {
				if (!streamOwned) {
					attempt.abort(new Error("gateway attempt settled"));
					release();
				}
			}
		}
	});
}
