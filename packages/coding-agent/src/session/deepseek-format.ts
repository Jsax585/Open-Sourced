import { isRecord } from "@oh-my-pi/pi-utils";

/**
 * Dependency-free reader for DeepSeek Harness session logs, logical formats v0 and v4.
 *
 * Only what an import needs is decoded: message-bearing events, the context
 * replacements that decide current model input, and turn/usage metadata. Runtime
 * bookkeeping events (permissions, sandbox, approvals, inbox splices) stay opaque.
 * v1–v3 are refused rather than guessed at.
 */

export interface DeepSeekHeader {
	readonly version: number;
	readonly id: string;
	readonly createdAt: number;
	readonly cwd?: string;
	readonly parentSession?: string;
	readonly origin?: string;
	readonly delegationDepth: number;
	readonly agentPreset?: string;
}

export type DeepSeekSurfaceOp = "append" | { readonly startSeq: number; readonly endSeq: number };

export interface DeepSeekEvent {
	readonly type: string;
	readonly seq: number;
	readonly time: number;
	readonly data: Record<string, unknown>;
	readonly surfaceOp?: DeepSeekSurfaceOp;
	readonly ignorable?: true;
}

export type DeepSeekBlock = Record<string, unknown> & { readonly type: string };
export type DeepSeekRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface DeepSeekMessage {
	readonly role: DeepSeekRole;
	readonly content: readonly DeepSeekBlock[];
	readonly source: Record<string, unknown>;
	readonly toolCallId?: string;
	readonly isError?: boolean;
}

export interface DeepSeekStreamChunk {
	readonly time: number;
	readonly chunk: Record<string, unknown> & { readonly type: string };
}

export class DeepSeekFormatError extends Error {}

function fail(detail: string): never {
	throw new DeepSeekFormatError(detail);
}

function seqValue(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function headerText(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.includes("\0")) fail(`invalid header ${field}`);
	return value;
}

/** Classify a header line; any version other than v0/v4 is reported as unsupported, not malformed. */
export function readDeepSeekHeader(value: unknown): DeepSeekHeader {
	if (!isRecord(value) || value.type !== "session") fail("malformed session header");
	const version = value.version;
	if (typeof version !== "number" || !Number.isSafeInteger(version)) fail("malformed session header version");
	if (version !== 0 && version !== 4) fail(`unsupported logical format v${version}; supported formats are v0 and v4`);
	const id = value.id;
	if (typeof id !== "string" || id.length === 0 || id.includes("\0")) fail("session ID must be nonempty");
	const createdAt = value.createdAt;
	if (!seqValue(createdAt) || !Number.isFinite(new Date(createdAt).getTime())) fail("invalid header createdAt");
	const delegationDepth = value.delegationDepth ?? 0;
	if (!seqValue(delegationDepth)) fail("invalid header delegationDepth");
	const cwd = headerText(value.cwd, "cwd");
	const parentSession = headerText(value.parentSession, "parentSession");
	const origin = headerText(value.origin, "origin");
	const agentPreset = headerText(value.agentPreset, "agentPreset");
	return {
		version,
		id,
		createdAt,
		delegationDepth,
		...(cwd === undefined ? {} : { cwd }),
		...(parentSession === undefined ? {} : { parentSession }),
		...(origin === undefined ? {} : { origin }),
		...(agentPreset === undefined ? {} : { agentPreset }),
	};
}

/** Released log filenames: v0 `session.jsonl`, later `session.vN.jsonl` (N ≥ 1). */
export function deepseekLogGeneration(filename: string): number | undefined {
	const base = filename.endsWith(".zstd") ? filename.slice(0, -5) : filename;
	if (base === "session.jsonl") return 0;
	const match = /^session\.v([1-9][0-9]*)\.jsonl$/.exec(base);
	return match ? Number(match[1]) : undefined;
}

const RUN_TYPES: Record<string, true> = { "text-chunks": true, "reasoning-chunks": true, "tool-call-chunks": true };
const SURFACE_TYPES: Record<string, true> = {
	"system/message": true,
	"developer/message": true,
	"user/message": true,
	"assistant/message": true,
	"tool/result": true,
};
const METERING_TYPES: Record<string, true> = { "compaction/summary": true, "compaction/prune": true };

function surfaceOp(value: unknown, type: string): DeepSeekSurfaceOp | undefined {
	if (SURFACE_TYPES[type] !== true) return undefined;
	if (value === undefined || value === "append") return "append";
	if (!isRecord(value) || value.op !== "replace") fail(`invalid surface operation on ${type}`);
	// v0 writes {start, end}; v4 and the SQLite backend write {startSeq, endSeq}.
	const startSeq = value.startSeq ?? value.start;
	const endSeq = value.endSeq ?? value.end;
	if (!seqValue(startSeq) || !seqValue(endSeq)) fail(`invalid replace range on ${type}`);
	return { startSeq, endSeq };
}

/** v0 tool results nest call ID, content and error state in one `tool-result` block. */
function toolResultMessage(message: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown> {
	if (message.role === "tool" && typeof message.toolCallId === "string") return message;
	const block = Array.isArray(message.content) && isRecord(message.content[0]) ? message.content[0] : undefined;
	const source = isRecord(message.source) ? message.source : undefined;
	const callId = block?.toolCallId ?? source?.callId;
	if (block?.type !== "tool-result" || typeof callId !== "string" || callId.length === 0) {
		fail("tool result without a tool call ID");
	}
	if (!Array.isArray(block.content)) fail("tool result content must be a block array");
	return {
		...message,
		role: "tool",
		toolCallId: callId,
		content: block.content,
		isError: block.isError === true || data.error !== undefined,
		source: { kind: "tool", callId },
	};
}

/**
 * Decode physical rows into logical events. A chunk run (`seq0`) occupies one sequence
 * number per packed chunk, so its successor starts at `seq0 + length`; runs and loose
 * `assistant/chunk` rows are live-stream noise and are dropped after accounting.
 */
export function decodeDeepSeekRows(rows: readonly unknown[]): DeepSeekEvent[] {
	const events: DeepSeekEvent[] = [];
	let expected = 0;
	for (const row of rows) {
		if (!isRecord(row) || typeof row.type !== "string" || row.type.length === 0) {
			fail(`malformed event record at sequence ${expected}`);
		}
		const type = row.type;
		const data = row.data;
		if (!isRecord(data)) fail(`event without a data object at sequence ${expected}`);
		if (RUN_TYPES[type] === true) {
			const members = type === "tool-call-chunks" ? data.args : data.texts;
			if (row.seq0 !== expected) fail(`event sequence gap at ${expected}`);
			if (!Array.isArray(members) || members.length === 0) fail(`empty ${type} run`);
			expected += members.length;
			continue;
		}
		const seq = expected;
		const time = row.time;
		if (row.seq !== seq) fail(`event sequence gap at ${seq}`);
		if (typeof time !== "number" || !Number.isFinite(time)) fail(`invalid event time at ${seq}`);
		expected++;
		if (type === "assistant/chunk") continue;
		let eventData = data;
		if (type === "tool/result") {
			if (!isRecord(data.message)) fail("tool result without a message");
			eventData = { ...data, message: toolResultMessage(data.message, data) };
		}
		const op = surfaceOp(row.surfaceOp, type);
		events.push({
			type,
			seq,
			time,
			data: eventData,
			...(op === undefined ? {} : { surfaceOp: op }),
			...(row.ignorable === true ? { ignorable: true as const } : {}),
		});
	}
	return events;
}

// Full released dsh-session 0.2.0-rc.2 vocabulary plus legacy v0 names (chunk runs,
// code-dispatch, branch/mode records). Content lives only in surface events; the rest
// is bookkeeping kept as opaque metadata.
const KNOWN_TYPES: Record<string, true> = {
	"agent-preset/selected": true,
	"agent/inbox/spliced": true,
	"approval/asked": true,
	"approval/decided": true,
	"approval/policy": true,
	"assistant/attempt": true,
	"assistant/message": true,
	"command/done": true,
	"command/run": true,
	"compaction/end": true,
	"compaction/prune": true,
	"compaction/start": true,
	"compaction/summary": true,
	"deliverables/presented": true,
	"developer/message": true,
	"feedback/message-delete": true,
	"feedback/message-put": true,
	"feedback/record": true,
	"goal/change": true,
	"hook/invoked": true,
	"hook/result": true,
	"image/offload": true,
	"llm/retry": true,
	"llm/retry-started": true,
	"model/selection": true,
	"permission/preset": true,
	"plan/mode": true,
	"request/context": true,
	"request/header": true,
	"sandbox/mode": true,
	"schedule/change": true,
	"session-branch/version": true,
	"session-log-deepseek/delivery-accepted": true,
	"session-mode/selected": true,
	"session/end-seed": true,
	"session/title": true,
	"session/title-llm-request": true,
	"step/end": true,
	"step/start": true,
	"subagent/catalog": true,
	"subagent/descriptor": true,
	"subagent/model-selection-policy": true,
	"system/message": true,
	"team/member": true,
	"team/message/delivered": true,
	"team/message/queued": true,
	"team/task": true,
	"todo/write": true,
	"tool-workflow/agent-end": true,
	"tool-workflow/agent-start": true,
	"tool-workflow/run-end": true,
	"tool-workflow/run-start": true,
	"tool/call": true,
	"tool/code-dispatch": true,
	"tool/code-dispatch-start": true,
	"tool/ptc-dispatch": true,
	"tool/ptc-dispatch-start": true,
	"tool/result": true,
	"turn/end": true,
	"turn/start": true,
	"user/message": true,
	"web/deepseek-search-llm-request": true,
	"workspace/changes": true,
};

/** An unknown event may change how the rest of the log reads, so it fails unless marked ignorable. */
export function assertKnownDeepSeekEvents(events: readonly DeepSeekEvent[]): void {
	for (const event of events) {
		if (KNOWN_TYPES[event.type] !== true && event.ignorable !== true) {
			fail(`unknown required event at sequence ${event.seq}`);
		}
	}
}

const ROLES: Record<string, DeepSeekRole> = {
	system: "system",
	developer: "developer",
	user: "user",
	assistant: "assistant",
	tool: "tool",
};

function isBlockArray(value: unknown): value is DeepSeekBlock[] {
	return Array.isArray(value) && value.every(block => isRecord(block) && typeof block.type === "string");
}

function asMessage(value: unknown, fallbackRole: DeepSeekRole, seq: number): DeepSeekMessage {
	if (!isRecord(value)) fail(`message payload missing at event ${seq}`);
	const role =
		value.role === undefined ? fallbackRole : typeof value.role === "string" ? ROLES[value.role] : undefined;
	if (role === undefined) fail(`invalid message role at event ${seq}`);
	if (!isBlockArray(value.content)) fail(`message content must be a block array at event ${seq}`);
	if (!isRecord(value.source)) fail(`message source missing at event ${seq}`);
	return {
		role,
		content: value.content,
		source: value.source,
		...(typeof value.toolCallId === "string" ? { toolCallId: value.toolCallId } : {}),
		...(value.isError === true ? { isError: true } : {}),
	};
}

/** Project one event to its model message; empty system/developer/assistant nodes produce none. */
export function deepseekEventMessage(
	event: DeepSeekEvent,
	projected?: ReadonlyMap<number, DeepSeekMessage>,
): DeepSeekMessage | undefined {
	const replaced = projected?.get(event.seq);
	if (replaced) return replaced;
	switch (event.type) {
		case "user/message":
			return asMessage(event.data, "user", event.seq);
		case "system/message":
		case "developer/message":
		case "assistant/message": {
			const role =
				event.type === "assistant/message" ? "assistant" : event.type === "system/message" ? "system" : "developer";
			const message = asMessage(event.data.message, role, event.seq);
			return message.content.length === 0 ? undefined : message;
		}
		case "tool/result":
			return asMessage(event.data.message, "tool", event.seq);
		default:
			return undefined;
	}
}

export interface DeepSeekSurface {
	/** Event sequence numbers forming current model input, in order. */
	readonly nodes: readonly number[];
	/** Messages rewritten by `image/offload` after their original event. */
	readonly projected: ReadonlyMap<number, DeepSeekMessage>;
}

function offloadImages(message: DeepSeekMessage, indexes: readonly number[]): DeepSeekMessage {
	let imageIndex = 0;
	let selected = 0;
	const content = message.content.map(block => {
		if (block.type !== "image") return block;
		const hit = imageIndex === indexes[selected];
		imageIndex++;
		if (!hit) return block;
		selected++;
		return { ...block, offloaded: true };
	});
	if (selected !== indexes.length) fail("image/offload names a missing image");
	return { ...message, content };
}

/**
 * Fold the log into the current model surface. Appends extend it; a replacement swaps a
 * contiguous node range for itself. Replacements that no longer line up (ranges already
 * shadowed, assistant rewrites) degrade to appends, matching the dsh backend's read view
 * instead of refusing otherwise readable history.
 */
export function foldDeepSeekSurface(events: readonly DeepSeekEvent[]): DeepSeekSurface {
	const nodes: number[] = [];
	const projected = new Map<number, DeepSeekMessage>();
	const bySeq = new Map(events.map(event => [event.seq, event]));
	for (let index = 0; index < events.length; index++) {
		const event = events[index]!;
		if (event.type === "image/offload") {
			const targets = event.data.targets;
			if (!Array.isArray(targets) || targets.length === 0) fail("image/offload without targets");
			for (const target of targets) {
				if (!isRecord(target) || !seqValue(target.seq) || !Array.isArray(target.imageIndexes)) {
					fail("image/offload target is malformed");
				}
				const indexes = target.imageIndexes;
				if (!indexes.every(seqValue)) fail("image/offload image indexes are malformed");
				const source = bySeq.get(target.seq);
				const message = source ? deepseekEventMessage(source, projected) : undefined;
				if (!message || !nodes.includes(target.seq)) fail("image/offload targets a non-current message");
				projected.set(target.seq, offloadImages(message, indexes));
			}
			continue;
		}
		const op = event.surfaceOp;
		if (op === undefined) continue;
		if (op === "append") {
			nodes.push(event.seq);
			continue;
		}
		const start = nodes.indexOf(op.startSeq);
		let end = nodes.indexOf(op.endSeq);
		// The backend may record an end that was itself shadowed; adjacent metering says how many nodes it covered.
		if (start !== -1 && end === -1) {
			const previous = events[index - 1];
			const shadowed = previous && METERING_TYPES[previous.type] === true ? previous.data.shadowedSeqs : undefined;
			if (Array.isArray(shadowed) && shadowed.length > 0)
				end = Math.min(start + shadowed.length - 1, nodes.length - 1);
		}
		if (start === -1 || end === -1 || start > end || event.type === "assistant/message") {
			nodes.push(event.seq);
			continue;
		}
		nodes.splice(start, end - start + 1, event.seq);
	}
	return { nodes, projected };
}

/** Expand an assistant stream's packed chunk runs into timed chunks. */
export function expandDeepSeekStream(stream: unknown): DeepSeekStreamChunk[] {
	if (stream === undefined) return [];
	if (!Array.isArray(stream)) fail("assistant stream must be an array");
	const chunks: DeepSeekStreamChunk[] = [];
	for (const record of stream) {
		if (!isRecord(record)) fail("malformed assistant stream record");
		if (record.type === "chunk") {
			const chunk = record.chunk;
			if (!isRecord(chunk) || typeof chunk.type !== "string" || typeof record.time !== "number") {
				fail("malformed assistant stream chunk");
			}
			chunks.push({ time: record.time, chunk: { ...chunk, type: chunk.type } });
			continue;
		}
		const runType = record.type;
		const members = runType === "tool-call-chunks" ? record.args : record.texts;
		const time0 = record.time0;
		if (
			typeof runType !== "string" ||
			RUN_TYPES[runType] !== true ||
			!Array.isArray(members) ||
			typeof time0 !== "number"
		) {
			fail("malformed assistant stream run");
		}
		const deltas = Array.isArray(record.dt) ? record.dt : [];
		const deltaType =
			runType === "text-chunks"
				? "text-delta"
				: runType === "reasoning-chunks"
					? "reasoning-delta"
					: "tool-call-delta";
		let time = time0;
		for (let index = 0; index < members.length; index++) {
			const step = index > 0 ? deltas[index - 1] : 0;
			if (typeof step === "number") time += step;
			const member = members[index];
			if (typeof member !== "string") fail("assistant stream run members must be strings");
			chunks.push({
				time,
				chunk:
					deltaType === "tool-call-delta"
						? { type: deltaType, argumentsDelta: member }
						: { type: deltaType, text: member },
			});
		}
	}
	return chunks;
}
