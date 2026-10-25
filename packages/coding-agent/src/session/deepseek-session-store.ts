import * as os from "node:os";
import * as path from "node:path";
import type { AssistantStreamRecord } from "@deepseek-ai/dsh-llm/assistant-stream";
import type { Message as DeepSeekMessage } from "@deepseek-ai/dsh-llm/message";
import type { StreamChunk } from "@deepseek-ai/dsh-llm/types";
import { expandAssistantStream } from "@deepseek-ai/dsh-llm/assistant-stream";
// ponytail: dsh-llm's main entry runs createRequire("../package.json") at module
// top level (vendor bug), which breaks `bun build --compile`. Subpath imports
// reach the same API without loading the broken modules. Upgrade: import from
// the main entry once dsh-llm inlines its version.
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session";
import { deriveEventMessage, foldSurface, isAppendSurfaceEvent } from "@deepseek-ai/dsh-session/surface";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session/types";
import { currentSessionMessageProjections } from "@deepseek-ai/dsh-session-format-catalog/message-projections";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { getDeepSeekImportContext } from "@oh-my-pi/pi-agent-core/compaction";
import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { DeepSeekAttachments } from "./deepseek-attachments";
import { interpretDeepSeekEvents } from "./deepseek-compat";
import { DeepSeekSources } from "./deepseek-sources";
import type { ForeignSessionInfo, ForeignSessionStore } from "./foreign-session-store";
import type {
	CustomMessageEntry,
	ModelChangeEntry,
	ModelUsageEntry,
	SessionEntry,
	SessionMessageEntry,
} from "./session-entries";
import { SessionManager } from "./session-manager";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type ImportedMessage = UserMessage | AssistantMessage | ToolResultMessage;
type NativeBlock = TextContent | ImageContent | ToolCall | { type: "thinking"; thinking: string };

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function count(value: unknown, field: string): number {
	if (value === undefined) return 0;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`invalid ${field} token count`);
	}
	return value;
}

function usage(value: unknown): Usage {
	if (value === undefined) return structuredClone(EMPTY_USAGE);
	if (!isRecord(value)) throw new Error("invalid assistant usage");
	const input = count(value.inputTokens, "input");
	const output = count(value.outputTokens, "output");
	const cacheRead = count(value.cacheReadTokens, "cache-read");
	const cacheWrite = count(value.cacheWriteTokens, "cache-write");
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens:
			value.totalTokens === undefined ? input + output + cacheRead + cacheWrite : count(value.totalTokens, "total"),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function terminalReason(
	event: SessionEvent,
	turnEnd?: Record<string, unknown>,
): { stopReason: AssistantMessage["stopReason"]; errorMessage?: string } {
	const data: unknown = event.data;
	if (!isRecord(data)) throw new Error(`invalid assistant payload at event ${event.seq}`);
	if (data.interrupted === true) return { stopReason: "aborted" };
	if (Array.isArray(data.stream)) {
		for (let index = data.stream.length - 1; index >= 0; index--) {
			const record: unknown = data.stream[index];
			if (!isRecord(record) || record.type !== "chunk" || !isRecord(record.chunk) || record.chunk.type !== "finish")
				continue;
			const reason = record.chunk.reason;
			if (!isRecord(reason)) throw new Error(`invalid finish reason at event ${event.seq}`);
			if (reason.kind === "stop") return { stopReason: "stop" };
			if (reason.kind === "tool-calls") return { stopReason: "toolUse" };
			if (reason.kind === "max-tokens") return { stopReason: "length" };
			if (reason.kind === "aborted" || reason.kind === "error") {
				return {
					stopReason: reason.kind === "error" ? "error" : "aborted",
					errorMessage: isRecord(reason.failure) ? text(reason.failure.message) : undefined,
				};
			}
			throw new Error(`unsupported finish reason at event ${event.seq}`);
		}
	}
	if (turnEnd?.kind === "error")
		return { stopReason: "error", errorMessage: isRecord(turnEnd.error) ? text(turnEnd.error.message) : undefined };
	if (turnEnd?.kind === "aborted" || turnEnd?.kind === "interrupted" || turnEnd?.kind === "forked")
		return { stopReason: "aborted" };
	if (turnEnd?.kind === "max-tokens") return { stopReason: "length" };
	return { stopReason: "stop" };
}

function diagnostic(error: unknown): string {
	// Decoder diagnostics can contain source values. Keep only location/category words,
	// never JSON parser excerpts or payload strings at this trust boundary.
	const message = error instanceof Error ? error.message : "unknown conversion error";
	if (
		/^(invalid (?:assistant|input|output|cache-read|cache-write|total|finish|tool)|unsupported (?:finish|user content|assistant content|tool content)|missing historical tool call|unknown required event|missing folded event|Missing required DeepSeek attachment)/.test(
			message,
		) &&
		!/[\n\r]/.test(message) &&
		message.length < 300
	)
		return message;
	return error instanceof SyntaxError
		? "invalid JSON record or tool arguments"
		: "source validation failed; check the selected session format and required attachments";
}

/** Read-only DeepSeek Harness conversion; native sessions never need DeepSeek packages after import. */
export class DeepSeekSessionStore implements ForeignSessionStore {
	readonly source = "deepseek";
	readonly #home: string;
	readonly #sources: DeepSeekSources;
	readonly #attachments = new WeakMap<SessionManager, DeepSeekAttachments>();

	/** Root is DSH_HOME (not its sessions subdirectory); override supports fixtures/nondefault local stores. */
	constructor(root = process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh")) {
		this.#home = path.resolve(root);
		this.#sources = new DeepSeekSources(this.#home);
	}

	async list(): Promise<ForeignSessionInfo[]> {
		return this.#sources.list();
	}

	async preparePersist(source: SessionManager, target: SessionManager): Promise<void> {
		await this.#attachments.get(source)?.preparePersist(source, target);
	}

	async load(info: ForeignSessionInfo): Promise<SessionManager> {
		if (info.source !== this.source) throw new Error(`Cannot load ${info.source} session with DeepSeekSessionStore`);
		const snapshot = await this.#sources.read(info);
		let stage = "compatibility interpretation";
		try {
			const interpreted =
				snapshot.kind === "sqlite"
					? interpretDeepSeekEvents(snapshot.events)
					: { events: structuredClone(snapshot.events) as unknown as SessionEvent[], repairs: {} };
			const events = interpreted.events;
			stage = "canonical validation";
			for (const event of events) {
				if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) {
					throw new Error(`unknown required event at sequence ${event.seq}`);
				}
			}
			Session.fromRestore(
				SessionId(snapshot.header.id),
				events,
				snapshot.header as unknown as SessionHeader,
				SessionLogOffset(snapshot.inheritedEventCount),
				"detached",
				currentSessionMessageProjections,
			);
			const surface = foldSurface(events, currentSessionMessageProjections);
			const manager = SessionManager.inMemory(snapshot.header.cwd ?? info.cwd);
			const attachments = new DeepSeekAttachments(this.#home);
			const names = new Map<string, string>();
			const resultNames = new Map<number, string>();
			const streams = new Map<number, readonly { time: number; chunk: StreamChunk }[]>();
			const turnEnds = new Map<number, Record<string, unknown>>();
			const lastAssistant = new Map<number, number>();
			const openedTurns = new Set<number>();
			const eventCounts: Record<string, number> = Object.create(null);
			for (const event of events) {
				eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
				if (event.type === "turn/start") openedTurns.add(event.data.turn);
				if (event.type === "assistant/message" || event.type === "assistant/attempt") {
					streams.set(event.seq, expandAssistantStream(event.data.stream as AssistantStreamRecord[]));
				}
				if (event.type === "assistant/message") lastAssistant.set(event.data.turn, event.seq);
				if (
					event.type === "turn/end" &&
					isRecord(event.data) &&
					typeof event.data.turn === "number" &&
					isRecord(event.data.reason)
				) {
					turnEnds.set(event.data.turn, event.data.reason);
				}
				const message = deriveEventMessage(event);
				if (message?.role === "assistant") {
					for (const block of message.content) {
						if (block.type === "tool-call") {
							if (!block.id || !block.name)
								throw new Error(`invalid historical tool call at event ${event.seq}`);
							names.set(block.id, block.name);
						}
					}
				}
				if (message?.role === "tool") {
					const name = names.get(message.toolCallId);
					if (!name) throw new Error(`missing historical tool call for result at event ${event.seq}`);
					resultNames.set(event.seq, name);
				}
			}
			for (const turn of openedTurns) if (!turnEnds.has(turn)) turnEnds.set(turn, { kind: "interrupted" });
			let parentId: string | null = null;
			let ordinal = 0;
			const append = (
				entry:
					| Omit<SessionMessageEntry, "id" | "parentId" | "timestamp">
					| Omit<CustomMessageEntry, "id" | "parentId" | "timestamp">
					| Omit<ModelChangeEntry, "id" | "parentId" | "timestamp">
					| Omit<ModelUsageEntry, "id" | "parentId" | "timestamp">,
				time: number,
			): void => {
				const id = `deepseek-${ordinal++}`;
				manager.ingestReplicatedEntry({
					...entry,
					id,
					parentId,
					timestamp: new Date(time).toISOString(),
				} as SessionEntry);
				parentId = id;
			};
			const inert = (customType: string, content: string, details: unknown, time: number): void => {
				append(
					{ type: "custom_message", customType, content, details, display: true } as Omit<
						CustomMessageEntry,
						"id" | "parentId" | "timestamp"
					>,
					time,
				);
			};
			const convert = async (
				message: DeepSeekMessage,
				event: SessionEvent,
			): Promise<ImportedMessage | undefined> => {
				if (message.role === "system" || message.role === "developer") return undefined;
				const content: NativeBlock[] = [];
				for (const block of message.content) {
					if (block.type === "text") content.push({ type: "text", text: block.text });
					else if (block.type === "reasoning" && message.role === "assistant")
						content.push({ type: "thinking", thinking: block.text });
					else if (block.type === "image" || block.type === "file") content.push(await attachments.content(block));
					else if (block.type === "tool-call" && message.role === "assistant") {
						const rawArguments = block.arguments;
						let argumentsValue: unknown;
						// dsh harnesses record empty argument strings for no-argument calls (e.g. job_list).
						if (typeof rawArguments === "string" && rawArguments.trim().length === 0) argumentsValue = {};
						else if (typeof rawArguments === "string") {
							try {
								argumentsValue = JSON.parse(rawArguments);
							} catch {
								throw new Error(`invalid tool arguments at event ${event.seq}`);
							}
						} else throw new Error(`invalid tool arguments at event ${event.seq}`);
						if (!isRecord(argumentsValue)) throw new Error(`invalid tool argument object at event ${event.seq}`);
						content.push({ type: "toolCall", id: block.id, name: block.name, arguments: argumentsValue });
					} else throw new Error(`unsupported ${message.role} content block at event ${event.seq}`);
				}
				if (message.role === "assistant") {
					const data: unknown = event.data;
					if (!isRecord(data)) throw new Error(`invalid assistant payload at event ${event.seq}`);
					const turn = typeof data.turn === "number" ? data.turn : -1;
					return {
						role: "assistant",
						content,
						api: "deepseek-import",
						provider: message.source.provider,
						model: message.source.model,
						usage: usage(data.usage),
						timestamp: event.time,
						...terminalReason(event, lastAssistant.get(turn) === event.seq ? turnEnds.get(turn) : undefined),
					};
				}
				const readable = content as (TextContent | ImageContent)[];
				if (message.role === "user")
					return {
						role: "user",
						content: readable,
						timestamp: event.time,
						attribution: message.source.kind === "user" ? "user" : "agent",
					};
				const name = resultNames.get(event.seq);
				if (!name) throw new Error(`missing historical tool call for result at event ${event.seq}`);
				return {
					role: "toolResult",
					toolCallId: message.toolCallId,
					toolName: name,
					content: readable,
					isError: message.isError === true,
					timestamp: event.time,
				};
			};
			stage = "transcript conversion and attachment reads";
			let title = info.title;
			let lastModel: string | undefined;
			for (const event of events) {
				const message = deriveEventMessage(event);
				if (isAppendSurfaceEvent(event) && message) {
					if (message.role === "system" || message.role === "developer") {
						inert(
							`deepseek_${message.role}`,
							message.content
								.map(block =>
									block.type === "text"
										? block.text
										: block.type === "tool-addition" || block.type === "tool-removal"
											? `${block.type}: ${block.toolName}`
											: `[${block.type}]`,
								)
								.join("\n"),
							{ source: message.source, message },
							event.time,
						);
					} else {
						const converted = await convert(message, event);
						if (converted) {
							if (converted.role === "assistant") {
								const model = `${converted.provider}/${converted.model}`;
								if (model !== lastModel) {
									append({ type: "model_change", model }, event.time);
									lastModel = model;
								}
							}
							append(
								{ type: "message", message: converted } as Omit<
									SessionMessageEntry,
									"id" | "parentId" | "timestamp"
								>,
								event.time,
							);
							manager.appendCustomEntry("deepseek_message_source", { seq: event.seq, source: message.source });
							parentId = manager.getLeafId();
						}
					}
				} else if (
					event.type === "assistant/message" &&
					event.data.message.content.length === 0 &&
					event.data.usage !== undefined
				) {
					append(
						{
							type: "model_usage",
							purpose: "deepseek_historical_empty_message",
							api: "deepseek-import",
							provider: event.data.message.source.provider,
							model: event.data.message.source.model,
							usage: usage(event.data.usage),
							...terminalReason(event, turnEnds.get(event.data.turn)),
						},
						event.time,
					);
				} else if (event.type === "assistant/attempt") {
					const details: unknown = event.data;
					const parts: string[] = [];
					for (const { chunk } of streams.get(event.seq) ?? []) {
						if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") parts.push(chunk.text);
						else if (chunk.type === "finish") parts.push(`Attempt status: ${chunk.reason.kind}`);
					}
					inert(
						"deepseek_attempt",
						parts.join("\n") || "Historical assistant attempt (not active context)",
						details,
						event.time,
					);
				} else if (event.type === "request/header") {
					inert(
						"deepseek_request_header",
						"Historical DeepSeek request configuration and tool schemas (inactive)",
						event.data,
						event.time,
					);
					const config = event.data.header.config;
					const model = `${config.provider}/${config.model}`;
					if (model !== lastModel) {
						append({ type: "model_change", model }, event.time);
						lastModel = model;
					}
				} else if ((event.type as string) === "session/title") {
					const data = event.data as Record<string, unknown>;
					title = isRecord(data) ? (text(data.title) ?? title) : title;
				} else if (typeof event.surfaceOp === "object") {
					const previous = events[event.seq - 1];
					const rendered =
						(previous?.type as string) === "compaction/summary"
							? ""
							: message?.content
									.map(block =>
										block.type === "text" || block.type === "reasoning" ? block.text : `[${block.type}]`,
									)
									.join("\n");
					inert(
						"deepseek_surface_replacement",
						rendered || "Historical DeepSeek context replacement",
						{ seq: event.seq, surfaceOp: event.surfaceOp, sourceEventSeqs: event.sourceEventSeqs, message },
						event.time,
					);
				} else if ((event.type as string) === "compaction/summary") {
					const data = event.data as Record<string, unknown>;
					const summary = Array.isArray(data.summary)
						? data.summary
								.map(block =>
									isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : "",
								)
								.join("\n")
						: "";
					inert("deepseek_compaction", summary || "Historical DeepSeek compaction", data, event.time);
				}
			}
			stage = "current context conversion";
			const messages: AgentMessage[] = [];
			for (const seq of surface.nodes) {
				const event = events[seq];
				if (!event || event.seq !== seq) throw new Error(`missing folded event at sequence ${seq}`);
				const message = deriveEventMessage(event, surface.projectedMessages);
				if (!message) continue;
				const converted = await convert(message, event);
				if (converted) messages.push(converted);
			}
			const shapeRepairs = isRecord(snapshot.metadata.shapeRepairs) ? snapshot.metadata.shapeRepairs : {};
			const repairs: Record<string, number> = { ...interpreted.repairs };
			for (const [key, value] of Object.entries(shapeRepairs))
				if (typeof value === "number") repairs[key] = (repairs[key] ?? 0) + value;
			manager.appendCustomEntry("deepseek_import", {
				sourceKind: snapshot.kind,
				sourceId: snapshot.header.id,
				sourcePath: info.path,
				sourceCwd: snapshot.header.cwd,
				storedVersion: snapshot.storedVersion,
				migratedVersion: snapshot.header.version,
				sourceCreatedAt: snapshot.header.createdAt,
				sourceModifiedAt: info.modified.getTime(),
				parentSession: snapshot.header.parentSession,
				inheritedEventCount: snapshot.inheritedEventCount,
				origin: snapshot.header.origin,
				delegationDepth: snapshot.header.delegationDepth,
				eventCounts,
				...snapshot.metadata,
				repairs,
				policy: {
					sourceAuthority: "transcript-only",
					providerPrivateReplayState: "inert",
					historicalRecovery: "disabled-before-import-boundary",
				},
			});
			const preserveData = { deepseekImportContext: { version: 1, messages } };
			getDeepSeekImportContext(preserveData);
			manager.appendCompaction("", undefined, "", 0, { preserveData });
			if (title) await manager.setSessionName(title, "auto");
			this.#attachments.set(manager, attachments);
			return manager;
		} catch (error) {
			throw new Error(`Unable to import DeepSeek session ${info.id} during ${stage}: ${diagnostic(error)}`);
		}
	}
}
