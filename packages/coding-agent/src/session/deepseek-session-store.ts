import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { getImportedContext } from "@oh-my-pi/pi-agent-core/compaction";
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
import {
	assertKnownDeepSeekEvents,
	type DeepSeekEvent,
	DeepSeekFormatError,
	type DeepSeekMessage,
	deepseekEventMessage,
	expandDeepSeekStream,
	foldDeepSeekSurface,
} from "./deepseek-format";
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
	event: DeepSeekEvent,
	turnEnd?: Record<string, unknown>,
): { stopReason: AssistantMessage["stopReason"]; errorMessage?: string } {
	const data = event.data;
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

/** Source and model attribution from an assistant message; both are required for a native assistant turn. */
function modelSource(message: DeepSeekMessage, seq: number): { provider: string; model: string } {
	const { provider, model } = message.source;
	if (typeof provider !== "string" || typeof model !== "string")
		throw new Error(`invalid assistant source at event ${seq}`);
	return { provider, model };
}

function diagnostic(error: unknown): string {
	// Decoder diagnostics can contain source values. Keep only location/category words,
	// never JSON parser excerpts or payload strings at this trust boundary.
	const message = error instanceof Error ? error.message : "unknown conversion error";
	// Format errors are built from fixed wording plus sequence numbers, never source payloads.
	if (error instanceof DeepSeekFormatError) return message;
	if (
		/^(invalid (?:assistant|input|output|cache-read|cache-write|total|finish|tool|historical)|unsupported (?:finish|user content|assistant content|tool content|user|assistant|tool)|missing historical tool call|missing folded event|Missing required DeepSeek attachment)/.test(
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

/** Read-only DeepSeek Harness conversion (v0 and v4 logs, SQLite archives); no source runtime is loaded. */
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
		let stage = "event admission";
		try {
			const events = snapshot.events;
			assertKnownDeepSeekEvents(events);
			const bySeq = new Map(events.map(event => [event.seq, event]));
			const surface = foldDeepSeekSurface(events);
			const manager = SessionManager.inMemory(snapshot.header.cwd ?? info.cwd);
			const attachments = new DeepSeekAttachments(this.#home);
			const names = new Map<string, string>();
			const resultNames = new Map<number, string>();
			const turnEnds = new Map<number, Record<string, unknown>>();
			const lastAssistant = new Map<number, number>();
			const openedTurns = new Set<number>();
			const eventCounts: Record<string, number> = Object.create(null);
			for (const event of events) {
				eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
				const turn = event.data.turn;
				if (event.type === "turn/start" && typeof turn === "number") openedTurns.add(turn);
				if (event.type === "assistant/message" && typeof turn === "number") lastAssistant.set(turn, event.seq);
				if (event.type === "turn/end" && typeof turn === "number" && isRecord(event.data.reason)) {
					turnEnds.set(turn, event.data.reason);
				}
				const message = deepseekEventMessage(event);
				if (message?.role === "assistant") {
					for (const block of message.content) {
						if (block.type !== "tool-call") continue;
						if (typeof block.id !== "string" || !block.id || typeof block.name !== "string" || !block.name)
							throw new Error(`invalid historical tool call at event ${event.seq}`);
						names.set(block.id, block.name);
					}
				}
				if (message?.role === "tool") {
					const name = message.toolCallId === undefined ? undefined : names.get(message.toolCallId);
					if (!name) throw new Error(`missing historical tool call for result at event ${event.seq}`);
					resultNames.set(event.seq, name);
				}
			}
			for (const turn of openedTurns) if (!turnEnds.has(turn)) turnEnds.set(turn, { kind: "interrupted" });
			let parentId: string | null = null;
			let ordinal = 0;
			const base = (time: number): { id: string; parentId: string | null; timestamp: string } => {
				const id = `deepseek-${ordinal++}`;
				const fields = { id, parentId, timestamp: new Date(time).toISOString() };
				parentId = id;
				return fields;
			};
			const ingest = (entry: SessionEntry): void => manager.ingestReplicatedEntry(entry);
			const inert = (customType: string, content: string, details: unknown, time: number): void => {
				const entry: CustomMessageEntry = {
					...base(time),
					type: "custom_message",
					customType,
					content,
					details,
					display: true,
				};
				ingest(entry);
			};
			const modelChange = (model: string, time: number): void => {
				const entry: ModelChangeEntry = { ...base(time), type: "model_change", model };
				ingest(entry);
			};
			const convert = async (
				message: DeepSeekMessage,
				event: DeepSeekEvent,
			): Promise<ImportedMessage | undefined> => {
				if (message.role === "system" || message.role === "developer") return undefined;
				const content: NativeBlock[] = [];
				const readable: (TextContent | ImageContent)[] = [];
				for (const block of message.content) {
					if (block.type === "text" && typeof block.text === "string") {
						content.push({ type: "text", text: block.text });
						readable.push({ type: "text", text: block.text });
					} else if (
						block.type === "reasoning" &&
						typeof block.text === "string" &&
						message.role === "assistant"
					) {
						content.push({ type: "thinking", thinking: block.text });
					} else if (block.type === "image" || block.type === "file") {
						const attached = await attachments.content(block);
						content.push(attached);
						readable.push(attached);
					} else if (block.type === "tool-call" && message.role === "assistant") {
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
						if (!isRecord(argumentsValue) || typeof block.id !== "string" || typeof block.name !== "string")
							throw new Error(`invalid tool argument object at event ${event.seq}`);
						content.push({ type: "toolCall", id: block.id, name: block.name, arguments: argumentsValue });
					} else if (message.role === "user" && (block.type === "reasoning" || block.type === "tool-call")) {
						// Background-subagent reports quote their reasoning and calls inside a user message; keep the text, drop the structure.
						if (typeof block.text === "string") readable.push({ type: "text", text: block.text });
					} else throw new Error(`unsupported ${message.role} content block at event ${event.seq}`);
				}
				if (message.role === "assistant") {
					const turn = typeof event.data.turn === "number" ? event.data.turn : -1;
					return {
						role: "assistant",
						content,
						api: "deepseek-import",
						...modelSource(message, event.seq),
						usage: usage(event.data.usage),
						timestamp: event.time,
						...terminalReason(event, lastAssistant.get(turn) === event.seq ? turnEnds.get(turn) : undefined),
					};
				}
				if (message.role === "user") {
					return {
						role: "user",
						content: readable,
						timestamp: event.time,
						attribution: message.source.kind === "user" ? "user" : "agent",
					};
				}
				const name = resultNames.get(event.seq);
				if (!name || message.toolCallId === undefined)
					throw new Error(`missing historical tool call for result at event ${event.seq}`);
				return {
					role: "toolResult",
					toolCallId: message.toolCallId,
					toolName: name,
					content: readable,
					isError: message.isError === true,
					timestamp: event.time,
				};
			};
			const blockText = (message: DeepSeekMessage | undefined, toolNames = false): string =>
				message?.content
					.map(block =>
						(block.type === "text" || block.type === "reasoning") && typeof block.text === "string"
							? block.text
							: toolNames && (block.type === "tool-addition" || block.type === "tool-removal")
								? `${block.type}: ${String(block.toolName)}`
								: `[${block.type}]`,
					)
					.join("\n") ?? "";
			stage = "transcript conversion and attachment reads";
			let title = info.title;
			let lastModel: string | undefined;
			for (const event of events) {
				const message = deepseekEventMessage(event);
				if (event.surfaceOp === "append" && message) {
					if (message.role === "system" || message.role === "developer") {
						inert(
							`deepseek_${message.role}`,
							blockText(message, true),
							{ source: message.source, message },
							event.time,
						);
						continue;
					}
					const converted = await convert(message, event);
					if (!converted) continue;
					if (converted.role === "assistant") {
						const model = `${converted.provider}/${converted.model}`;
						if (model !== lastModel) {
							modelChange(model, event.time);
							lastModel = model;
						}
					}
					const entry: SessionMessageEntry = { ...base(event.time), type: "message", message: converted };
					ingest(entry);
					manager.appendCustomEntry("deepseek_message_source", { seq: event.seq, source: message.source });
					parentId = manager.getLeafId();
				} else if (
					event.type === "assistant/message" &&
					event.surfaceOp === "append" &&
					event.data.usage !== undefined
				) {
					// Empty assistant node: a max-tokens step whose usage still counts.
					const source =
						isRecord(event.data.message) && isRecord(event.data.message.source) ? event.data.message.source : {};
					const turn = typeof event.data.turn === "number" ? event.data.turn : -1;
					const entry: ModelUsageEntry = {
						...base(event.time),
						type: "model_usage",
						purpose: "deepseek_historical_empty_message",
						api: "deepseek-import",
						provider: typeof source.provider === "string" ? source.provider : "deepseek",
						model: typeof source.model === "string" ? source.model : "unknown",
						usage: usage(event.data.usage),
						...terminalReason(event, turnEnds.get(turn)),
					};
					ingest(entry);
				} else if (event.type === "assistant/attempt") {
					const parts: string[] = [];
					for (const { chunk } of expandDeepSeekStream(event.data.stream)) {
						if (
							(chunk.type === "text-delta" || chunk.type === "reasoning-delta") &&
							typeof chunk.text === "string"
						)
							parts.push(chunk.text);
						else if (chunk.type === "finish" && isRecord(chunk.reason))
							parts.push(`Attempt status: ${String(chunk.reason.kind)}`);
					}
					inert(
						"deepseek_attempt",
						parts.join("\n") || "Historical assistant attempt (not active context)",
						event.data,
						event.time,
					);
				} else if (event.type === "request/header") {
					inert(
						"deepseek_request_header",
						"Historical DeepSeek request configuration and tool schemas (inactive)",
						event.data,
						event.time,
					);
					const config = isRecord(event.data.header) ? event.data.header.config : undefined;
					if (isRecord(config) && typeof config.provider === "string" && typeof config.model === "string") {
						const model = `${config.provider}/${config.model}`;
						if (model !== lastModel) {
							modelChange(model, event.time);
							lastModel = model;
						}
					}
				} else if (event.type === "session/title") {
					title = text(event.data.title) ?? title;
				} else if (typeof event.surfaceOp === "object") {
					const previous = bySeq.get(event.seq - 1);
					const rendered = previous?.type === "compaction/summary" ? "" : blockText(message);
					inert(
						"deepseek_surface_replacement",
						rendered || "Historical DeepSeek context replacement",
						{ seq: event.seq, surfaceOp: event.surfaceOp, message },
						event.time,
					);
				} else if (event.type === "compaction/summary") {
					const summary = Array.isArray(event.data.summary)
						? event.data.summary
								.map(block =>
									isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : "",
								)
								.join("\n")
						: "";
					inert("deepseek_compaction", summary || "Historical DeepSeek compaction", event.data, event.time);
				}
			}
			stage = "current context conversion";
			const messages: AgentMessage[] = [];
			for (const seq of surface.nodes) {
				const event = bySeq.get(seq);
				if (!event) throw new Error(`missing folded event at sequence ${seq}`);
				const message = deepseekEventMessage(event, surface.projected);
				if (!message) continue;
				const converted = await convert(message, event);
				if (converted) messages.push(converted);
			}
			manager.appendCustomEntry("deepseek_import", {
				sourceKind: snapshot.kind,
				sourceId: snapshot.header.id,
				sourcePath: info.path,
				sourceCwd: snapshot.header.cwd,
				storedVersion: snapshot.storedVersion,
				sourceCreatedAt: snapshot.header.createdAt,
				sourceModifiedAt: info.modified.getTime(),
				parentSession: snapshot.header.parentSession,
				inheritedEventCount: snapshot.inheritedEventCount,
				origin: snapshot.header.origin,
				delegationDepth: snapshot.header.delegationDepth,
				eventCounts,
				...snapshot.metadata,
				policy: {
					sourceAuthority: "transcript-only",
					providerPrivateReplayState: "inert",
					historicalRecovery: "disabled-before-import-boundary",
				},
			});
			const preserveData = { importedContext: { version: 1, messages } };
			getImportedContext(preserveData);
			manager.appendCompaction("", undefined, "", 0, { preserveData });
			if (title) await manager.setSessionName(title, "auto");
			this.#attachments.set(manager, attachments);
			return manager;
		} catch (error) {
			throw new Error(`Unable to import DeepSeek session ${info.id} during ${stage}: ${diagnostic(error)}`);
		}
	}
}
