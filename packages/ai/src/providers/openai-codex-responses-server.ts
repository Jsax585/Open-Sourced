/**
 * Codex HTTP Responses dialect for POST /v1/codex/responses.
 * Reference: codex-rs v0.162.1 codex-api/src/{common.rs,sse/responses.rs}
 * and protocol/src/models.rs. In particular, output_item.done (not the
 * completed envelope) is authoritative for the client's replay history.
 */
import { type } from "@oh-my-pi/omptype";
import { structuredCloneJSON } from "@oh-my-pi/pi-utils";
import type { AuthGatewayParsedRequest, AuthGatewayStreamControl } from "../auth-gateway/types";
import * as AIError from "../error";
import { classifyGatewayError } from "../error/gateway";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type Tool,
	parseServiceTier,
} from "../types";
import * as responses from "./openai-responses-server";

const customToolSchema = type({
	type: "'custom'",
	name: "string >= 1",
	"description?": "string",
	format: { type: "'grammar'", syntax: "'lark' | 'regex'", definition: "string" },
});

interface CodexToolIdentity {
	name: string;
	namespace?: string;
	custom?: boolean;
	search?: boolean;
}

interface CodexRequest extends AuthGatewayParsedRequest {
	options: AuthGatewayParsedRequest["options"] & {
		codexTools: Record<string, CodexToolIdentity>;
		codexText?: Record<string, unknown>;
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolName(name: string, namespace: unknown): string {
	if (typeof namespace !== "string" || !namespace || namespace === "functions") return name;
	// Match codex-rs tools/src/code_mode.rs::code_mode_name_for_tool_name.
	return namespace.endsWith("_") || name.startsWith("_") ? `${namespace}${name}` : `${namespace}__${name}`;
}

/** Only this route accepts Codex's optional zstd request encoding. */
export async function readRequest(req: Request): Promise<unknown> {
	const encoding = req.headers.get("content-encoding")?.trim().toLowerCase();
	if (!encoding || encoding === "identity") return req.json();
	if (encoding !== "zstd") throw new AIError.ValidationError(`Unsupported Content-Encoding: ${encoding}`);
	return JSON.parse((await Bun.zstdDecompress(await req.arrayBuffer())).toString());
}

export function parseRequest(body: unknown, headers: Headers | undefined, model: Model): CodexRequest {
	if (!isObject(body)) throw new AIError.ValidationError("openai-codex-responses: expected a JSON object");
	// The shared parser may normalize message content in place. Never mutate a
	// caller's wire transcript while adapting this dialect.
	const normalized = structuredCloneJSON(body);
	if (normalized.reasoning === null) delete normalized.reasoning;
	if (isObject(normalized.reasoning) && typeof normalized.reasoning.effort === "number") {
		delete normalized.reasoning.effort;
	}
	const identities: Record<string, CodexToolIdentity> = Object.create(null);
	const customTools: Tool[] = [];
	const tools: Record<string, unknown>[] = [];
	const addTools = (entries: unknown, namespace?: string): void => {
		if (!Array.isArray(entries)) throw new AIError.ValidationError("Codex tools must be an array");
		if (namespace === "functions") namespace = undefined;
		for (const entry of entries) {
			if (!isObject(entry)) throw new AIError.ValidationError("Invalid Codex tool");
			if (entry.type === "namespace") {
				if (typeof entry.name !== "string" || !entry.name)
					throw new AIError.ValidationError("Invalid tool namespace");
				addTools(entry.tools, entry.name);
				continue;
			}
			if (entry.type === "tool_search") {
				if (entry.execution !== "client") throw new AIError.ValidationError("Only client tool_search is supported");
				identities.tool_search = { name: "tool_search", search: true };
				tools.push({ ...entry, type: "function", name: "tool_search" });
				continue;
			}
			if (entry.type !== "function" && entry.type !== "custom") {
				// Same hosted-tool policy as /v1/responses; these are not locally executed.
				tools.push(entry);
				continue;
			}
			if (typeof entry.name !== "string" || !entry.name) throw new AIError.ValidationError("Invalid tool name");
			const name = toolName(entry.name, namespace);
			const previous = identities[name];
			if (previous && (previous.name !== entry.name || previous.namespace !== namespace)) {
				throw new AIError.ValidationError(`Ambiguous flattened Codex tool name: ${name}`);
			}
			identities[name] = { name: entry.name, namespace, custom: entry.type === "custom" };
			if (entry.type === "custom") {
				const custom = customToolSchema(entry);
				if (custom instanceof type.errors) throw new AIError.ValidationError(custom.summary);
				customTools.push({
					name,
					description: custom.description ?? "",
					parameters: {
						type: "object",
						properties: { input: { type: "string" } },
						required: ["input"],
						additionalProperties: false,
					} as Tool["parameters"],
					customWireName: name,
					customFormat: { syntax: custom.format.syntax, definition: custom.format.definition },
				});
			} else {
				tools.push({ ...entry, name });
			}
		}
	};
	if (normalized.tools !== undefined) addTools(normalized.tools);
	const partialAnswerIds = new Set<string>();
	if (Array.isArray(normalized.input)) {
		const input: unknown[] = [];
		for (const item of normalized.input) {
			if (!isObject(item)) {
				input.push(item);
				continue;
			}
			if (item.type === "additional_tools") {
				addTools(item.tools);
				continue;
			}
			if (item.type === "tool_search_output") {
				addTools(item.tools);
				input.push({ type: "function_call_output", call_id: item.call_id, output: JSON.stringify(item.tools) });
				continue;
			}
			if (item.type === "tool_search_call") {
				input.push({
					type: "function_call",
					...(typeof item.id === "string" ? { id: item.id } : {}),
					call_id: item.call_id,
					name: "tool_search",
					arguments: JSON.stringify(item.arguments),
				});
				continue;
			}
			if (item.type === "function_call" || item.type === "custom_tool_call") {
				if (typeof item.name === "string") item.name = toolName(item.name, item.namespace);
			}
			if (item.type === "reasoning" && Array.isArray(item.content)) {
				item.content = item.content.map(part =>
					isObject(part) && part.type === "text" ? { ...part, type: "reasoning_text" } : part,
				);
			}
			if (item.role === "assistant" && item.phase === "partial_answer") {
				item.id ??= `msg_${crypto.randomUUID().replaceAll("-", "")}`;
				if (typeof item.id === "string") partialAnswerIds.add(item.id);
				item.phase = "commentary";
			}
			// Do not silently discard an opaque compacted transcript.
			if (
				["compaction", "compaction_summary", "context_compaction", "compaction_trigger"].includes(String(item.type))
			) {
				throw new AIError.ValidationError(
					"Remote Codex compaction requires a native Codex endpoint; use a custom Responses provider with local compaction",
				);
			}
			input.push(item);
		}
		normalized.input = input;
	}
	normalized.tools = tools;
	const parsed = responses.parseRequest(normalized, headers);
	// Discovery output may repeat definitions already present in additional_tools.
	parsed.context.tools = [
		...new Map([...(parsed.context.tools ?? []), ...customTools].map(tool => [tool.name, tool])).values(),
	];
	// Responses input items carry no source model. Treat them as replay for the
	// resolved Responses upstream; never relabel foreign signatures for other APIs.
	const replayModel =
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses"
			? model
			: undefined;
	for (const message of parsed.context.messages) {
		if (message.role !== "assistant") continue;
		if (replayModel) {
			message.api = replayModel.api;
			message.provider = replayModel.provider;
			message.model = replayModel.id;
		}
		message.stopReason = message.content.some(part => part.type === "toolCall") ? "toolUse" : "stop";
		let hasPartialAnswer = false;
		for (const part of message.content) {
			if (part.type !== "text" || !part.textSignature) continue;
			const signature = JSON.parse(part.textSignature) as { v: number; id: string; phase?: string };
			if (partialAnswerIds.has(signature.id)) {
				part.textSignature = JSON.stringify({ ...signature, phase: "partial_answer" });
				hasPartialAnswer = true;
			}
		}
		if (hasPartialAnswer) {
			const items = encodeResponse(message, parsed.modelId).output as Record<string, unknown>[];
			message.providerPayload = { type: "openaiResponsesHistory", provider: message.provider, dt: true, items };
		}
	}
	if (isObject(body.reasoning) && body.reasoning.effort === "none") parsed.options.forceReasoningOff = true;
	parsed.options.serviceTier = parseServiceTier(body.service_tier);
	parsed.options.promptCacheKey ??= headers?.get("session-id") ?? undefined;
	const options: CodexRequest["options"] = { ...parsed.options, codexTools: identities };
	if (isObject(body.text)) options.codexText = body.text;
	return { ...parsed, options };
}

/** Apply only explicitly supplied Codex controls, and only to a Responses upstream. */
export function configureOptions(parsed: AuthGatewayParsedRequest, options: SimpleStreamOptions): void {
	const codex = parsed.options as CodexRequest["options"];
	if (
		codex.codexText?.verbosity === "low" ||
		codex.codexText?.verbosity === "medium" ||
		codex.codexText?.verbosity === "high"
	) {
		options.textVerbosity = codex.codexText.verbosity;
	}
	options.onPayload = (payload, model) => {
		if (
			!isObject(payload) ||
			!model ||
			!["openai-responses", "azure-openai-responses", "openai-codex-responses"].includes(model.api)
		)
			return;
		if (parsed.options.parallelToolCalls !== undefined)
			payload.parallel_tool_calls = parsed.options.parallelToolCalls;
		if (codex.codexText) payload.text = { ...(isObject(payload.text) ? payload.text : {}), ...codex.codexText };
	};
}

function errorBody(type: string, message: string): Record<string, unknown> {
	const code = AIError.isContextOverflow({ stopReason: "error", errorMessage: message })
		? "context_length_exceeded"
		: type === "rate_limit_error"
			? "rate_limit_exceeded"
			: type;
	return { type, code, message };
}

export function formatError(status: number, type: string, message: string): Response {
	return Response.json({ error: errorBody(type, message) }, { status });
}

export function encodeResponse(
	message: AssistantMessage,
	requestedModelId: string,
	options?: AuthGatewayParsedRequest["options"],
): Record<string, unknown> {
	const identities = (options as CodexRequest["options"] | undefined)?.codexTools ?? {};
	const envelope = responses.encodeResponse(message, requestedModelId);
	envelope.output = message.content.flatMap((part, index) =>
		part.type === "text" || part.type === "thinking" || part.type === "toolCall"
			? [outputItem(message, index, requestedModelId, identities)]
			: [],
	);
	return envelope;
}

function outputItem(
	message: AssistantMessage,
	contentIndex: number,
	model: string,
	identities: Record<string, CodexToolIdentity>,
): Record<string, unknown> {
	const part = message.content[contentIndex];
	const envelope = responses.encodeResponse({ ...message, content: [part] }, model);
	const item = (envelope.output as Record<string, unknown>[])[0];
	if (!item) throw new Error(`Unsupported Codex output block: ${part.type}`);
	if (part.type === "text" && part.textSignature?.startsWith("{")) {
		try {
			const signature: unknown = JSON.parse(part.textSignature);
			if (isObject(signature) && signature.phase === "partial_answer") item.phase = "partial_answer";
		} catch {
			// Other providers may use an opaque text signature.
		}
	}
	if (part.type === "toolCall") {
		const identity = identities[part.name];
		if (identity?.search)
			return { ...item, type: "tool_search_call", execution: "client", arguments: part.arguments };
		if (identity) {
			item.name = identity.name;
			if (identity.namespace) item.namespace = identity.namespace;
			if (identity.custom) {
				item.type = "custom_tool_call";
				item.input = typeof part.arguments.input === "string" ? part.arguments.input : "";
				delete item.arguments;
			}
		}
	}
	return item;
}

export function encodeStream(
	events: AssistantMessageEventStream,
	requestedModelId: string,
	options?: AuthGatewayParsedRequest["options"],
	control?: AuthGatewayStreamControl,
): ReadableStream<Uint8Array> {
	const identities = (options as CodexRequest["options"] | undefined)?.codexTools ?? {};
	const encoder = new TextEncoder();
	const id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
	const created = Math.floor(Date.now() / 1000);
	let sequence = 0;
	let cancelled = control?.signal?.aborted === true;
	let bodyCancelled = false;
	const abort = () => {
		cancelled = true;
	};
	control?.signal?.addEventListener("abort", abort, { once: true });
	const snapshot = (status: string, output: Record<string, unknown>[] = []) => ({
		id,
		object: "response",
		created_at: created,
		model: requestedModelId,
		status,
		output,
	});
	return new ReadableStream({
		async start(controller) {
			const emit = (type: string, data: Record<string, unknown>) => {
				if (!cancelled)
					controller.enqueue(
						encoder.encode(
							`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`,
						),
					);
			};
			const open = new Map<number, { index: number; item: Record<string, unknown> }>();
			const finished: Record<string, unknown>[] = [];
			let outputIndex = 0;
			let terminal = false;
			const finish = (message: AssistantMessage, index: number) => {
				const state = open.get(index);
				if (!state) return;
				const item = outputItem(message, index, requestedModelId, identities);
				// Keep added/delta/done identity stable, retaining encrypted_content.
				item.id = state.item.id;
				finished[state.index] = item;
				if (item.type === "reasoning") {
					const summary = item.summary as Array<{ type: string; text: string }>;
					emit("response.reasoning_summary_text.done", {
						item_id: item.id,
						output_index: state.index,
						summary_index: 0,
						text: summary.map(part => part.text).join(""),
					});
				}
				emit("response.output_item.done", { output_index: state.index, item });
				open.delete(index);
			};
			try {
				emit("response.created", { response: snapshot("in_progress") });
				for await (const event of events) {
					if (cancelled) break;
					if (event.type === "text_start" || event.type === "thinking_start" || event.type === "toolcall_start") {
						const item = outputItem(event.partial, event.contentIndex, requestedModelId, identities);
						item.status = "in_progress";
						if (item.type === "message") item.content = [];
						if (item.type === "reasoning") item.summary = [];
						if (item.type === "function_call") item.arguments = "";
						if (item.type === "custom_tool_call") item.input = "";
						const index = outputIndex++;
						open.set(event.contentIndex, { index, item });
						emit("response.output_item.added", { output_index: index, item });
						if (event.type === "thinking_start")
							emit("response.reasoning_summary_part.added", {
								item_id: item.id,
								output_index: index,
								summary_index: 0,
								part: { type: "summary_text", text: "" },
							});
					} else if (
						event.type === "text_delta" ||
						event.type === "thinking_delta" ||
						event.type === "toolcall_delta"
					) {
						const state = open.get(event.contentIndex);
						if (!state) continue;
						// A custom tool on a function-only upstream streams JSON, not raw input.
						const block = event.partial.content[event.contentIndex];
						const nativeCustom = block?.type === "toolCall" && block.customWireName;
						if (event.type === "toolcall_delta" && state.item.type === "custom_tool_call" && !nativeCustom)
							continue;
						const type =
							event.type === "text_delta"
								? "response.output_text.delta"
								: event.type === "thinking_delta"
									? "response.reasoning_summary_text.delta"
									: nativeCustom
										? "response.custom_tool_call_input.delta"
										: "response.function_call_arguments.delta";
						emit(type, {
							item_id: state.item.id,
							output_index: state.index,
							content_index: 0,
							summary_index: 0,
							delta: event.delta,
						});
					} else if (event.type === "text_end" || event.type === "thinking_end" || event.type === "toolcall_end") {
						finish(event.partial, event.contentIndex);
					} else if (event.type === "done" || event.type === "error") {
						const message = event.type === "done" ? event.message : event.error;
						for (const index of open.keys()) finish(message, index);
						const envelope = responses.encodeResponse(message, requestedModelId);
						const status =
							message.stopReason === "length" ? "incomplete" : event.type === "error" ? "failed" : "completed";
						const response: Record<string, unknown> = { ...envelope, ...snapshot(status, finished) };
						if (status === "failed") {
							const error = classifyGatewayError(
								message.errorClassificationMessage ?? message.errorMessage ?? "Upstream request failed",
							);
							response.error = errorBody(error.type, message.errorMessage ?? error.message);
						}
						emit(`response.${status}`, { response });
						terminal = true;
						break;
					}
				}
				if (!terminal && !cancelled) throw new Error("Upstream stream ended without a terminal event");
			} catch (error) {
				const classified = classifyGatewayError(error);
				emit("response.failed", {
					response: { ...snapshot("failed", finished), error: errorBody(classified.type, classified.message) },
				});
			} finally {
				control?.signal?.removeEventListener("abort", abort);
				if (!bodyCancelled) controller.close();
			}
		},
		cancel(reason) {
			bodyCancelled = true;
			cancelled = true;
			control?.signal?.removeEventListener("abort", abort);
			control?.onCancel?.(reason);
		},
	});
}
