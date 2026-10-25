import type { SessionFormatEvent } from "@deepseek-ai/dsh-session-format";
import type { SessionEvent } from "@deepseek-ai/dsh-session/types";

/*
 * Adapted from @morlay/session-rdb 0.1.5, src/log.ts and src/legacy.ts:
 * https://github.com/morlay/dsh-plugin
 * Shape adoption precedes the backend's read-view repairs. This is an isolated
 * interpretation copy, not a replacement for the original persisted snapshot.
 * Unlike the backend's broad plugin-source lift, only the released system-prompt
 * producer is adopted here; unknown producers remain subject to native admission.
 *
 * MIT License
 * Copyright (c) 2025 morlay
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

type RecordValue = Record<string, unknown>;
type ReadEvent = RecordValue & { type: string; seq: number; data: RecordValue };

const surfaceTypes: Record<string, true> = {
	"system/message": true,
	"developer/message": true,
	"user/message": true,
	"assistant/message": true,
	"tool/result": true,
};
const meteringTypes: Record<string, true> = { "compaction/summary": true, "compaction/prune": true };
const ownTypes: Record<string, true> = { "session-branch/version": true, "session-mode/selected": true };
const ptcRenames: Record<string, string> = {
	"tool/code-dispatch-start": "tool/ptc-dispatch-start",
	"tool/code-dispatch": "tool/ptc-dispatch",
};

function record(value: unknown): RecordValue | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

function eventSeq(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function equalJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => equalJson(item, b[i]))
		);
	}
	const left = record(a);
	const right = record(b);
	return (
		left !== undefined &&
		right !== undefined &&
		Object.keys(left).length === Object.keys(right).length &&
		Object.keys(left).every(key => Object.hasOwn(right, key) && equalJson(left[key], right[key]))
	);
}

function contentOnlyRewrite(original: ReadEvent | undefined, replacement: ReadEvent): boolean {
	if (original?.type !== "tool/result") return false;
	if (!record(original.data) || !record(replacement.data)) return false;
	const left = record(original.data.message);
	const right = record(replacement.data.message);
	if (!left || !right || !Array.isArray(left.content) || !Array.isArray(right.content)) return false;
	return equalJson(
		{ ...original.data, message: { ...left, content: null } },
		{ ...replacement.data, message: { ...right, content: null } },
	);
}

/** Adopt only known backend legacy shapes before strict physical decoding. */
export function adoptDeepSeekEventShapes(events: readonly SessionFormatEvent[]): {
	events: SessionFormatEvent[];
	repairs: Record<string, number>;
} {
	const view = structuredClone(events) as unknown as ReadEvent[];
	const repairs: Record<string, number> = {};
	const count = (category: string): void => {
		repairs[category] = (repairs[category] ?? 0) + 1;
	};

	// Narrow legacy adoption. Never grant ignorable status to arbitrary unknown events.
	for (const event of view) {
		if (Object.hasOwn(ownTypes, event.type) && event.ignorable !== true) {
			event.ignorable = true;
			count("plugin-envelope");
		}
		if (!record(event.data)) continue;
		const message = record(event.data.message);
		if (event.type === "system/message" && message) {
			const source = record(message.source);
			if (source?.kind === "plugin" && source.plugin === "@deepseek-ai/dsh-system-prompt") {
				message.source = { kind: "system-prompt" };
				count("system-source");
			}
		}
		if (event.type !== "tool/result" || !message) continue;
		if (message.role === "tool" && typeof message.toolCallId === "string") continue;
		const source = record(message.source);
		const block = Array.isArray(message.content) ? record(message.content[0]) : undefined;
		const callId = block?.toolCallId ?? source?.callId;
		if (!block || typeof callId !== "string") continue;
		message.role = "tool";
		message.toolCallId = callId;
		message.content = Array.isArray(block.content) ? block.content : [];
		if (typeof block.isError === "boolean") message.isError = block.isError;
		message.source = { kind: "tool", callId };
		count("tool-result-shape");
	}
	return { events: view as unknown as SessionFormatEvent[], repairs };
}

/** Build a backend-compatible read view; callers must run canonical admission/folding afterwards. */
export function interpretDeepSeekEvents(events: readonly SessionFormatEvent[]): {
	events: SessionEvent[];
	repairs: Record<string, number>;
} {
	const adopted = adoptDeepSeekEventShapes(events);
	const view = adopted.events as unknown as ReadEvent[];
	const repairs = adopted.repairs;
	const count = (category: string): void => {
		repairs[category] = (repairs[category] ?? 0) + 1;
	};

	function renameSource(value: unknown): void {
		const message = record(value);
		const source = record(message?.source);
		if (source?.kind === "plugin" && source.plugin === "tools-code-mode") {
			source.plugin = "tools-ptc";
			count("ptc-source");
		}
	}

	for (const event of view) {
		if (!record(event.data)) continue;
		if (
			(event.type === "assistant/message" || event.type === "assistant/attempt") &&
			!Array.isArray(event.data.stream)
		) {
			event.data.stream = [];
			count("assistant-settlement");
		}
		if (event.type === "request/header") {
			const header = record(event.data.header);
			if (header) {
				let changed = false;
				if (Object.hasOwn(header, "system")) {
					delete header.system;
					changed = true;
				}
				if (Array.isArray(header.tools) && header.tools.length === 0) {
					delete header.tools;
					changed = true;
				}
				const defaults = record(header.adapterDefaults);
				if (defaults && Object.keys(defaults).length === 0) {
					delete header.adapterDefaults;
					changed = true;
				}
				if (changed) count("request-header");
			}
		}
		if (Object.hasOwn(ptcRenames, event.type)) {
			event.type = ptcRenames[event.type]!;
			count("ptc-event");
		} else if (event.type === "agent-preset/selected" && event.data.agentPreset === "code") {
			event.data.agentPreset = "ptc";
			count("ptc-preset");
		} else if (event.type === "user/message") {
			renameSource(event.data);
		} else if (event.type === "agent/inbox/spliced" || event.type === "session/title-llm-request") {
			const messages = event.data[event.type === "agent/inbox/spliced" ? "inserted" : "messages"];
			if (Array.isArray(messages)) for (const message of messages) renameSource(message);
		}
	}

	// Track live surface nodes, not all historical surface events.
	const nodes: number[] = [];
	const bySeq = new Map(view.map(event => [event.seq, event]));
	for (let index = 0; index < view.length; index++) {
		const event = view[index]!;
		const op = event.surfaceOp;
		if (!Object.hasOwn(surfaceTypes, event.type)) {
			if (op !== undefined) {
				delete event.surfaceOp;
				count("surface-clear");
			}
			continue;
		}
		if (op === undefined || op === "append") {
			if (op === undefined) {
				event.surfaceOp = "append";
				count("surface-append");
			}
			nodes.push(event.seq);
			continue;
		}
		const replace = record(op);
		const shapeOk = replace?.op === "replace" && eventSeq(replace.startSeq) && eventSeq(replace.endSeq);
		const start = shapeOk ? nodes.indexOf(replace.startSeq as number) : -1;
		let end = shapeOk ? nodes.indexOf(replace.endSeq as number) : -1;
		let clamped: number | undefined;
		if (shapeOk && start !== -1 && end === -1) {
			const previous = view[index - 1];
			const shadowed =
				previous && Object.hasOwn(meteringTypes, previous.type) ? record(previous.data)?.shadowedSeqs : undefined;
			if (Array.isArray(shadowed) && shadowed.length > 0) {
				clamped = nodes[Math.min(start + shadowed.length - 1, nodes.length - 1)];
				end = clamped === undefined ? -1 : nodes.indexOf(clamped);
			}
		}
		const valid =
			shapeOk &&
			start !== -1 &&
			end !== -1 &&
			start <= end &&
			event.type !== "assistant/message" &&
			(event.type !== "tool/result" || (start === end && contentOnlyRewrite(bySeq.get(nodes[start]!), event)));
		if (!valid) {
			event.surfaceOp = "append";
			count("surface-degrade");
			nodes.push(event.seq);
			continue;
		}
		if (clamped !== undefined) {
			event.surfaceOp = { op: "replace", startSeq: replace!.startSeq, endSeq: clamped };
			count("surface-clamp");
		}
		nodes.splice(start, end - start + 1, event.seq);
	}

	const surfaceSeqs = view.filter(event => Object.hasOwn(surfaceTypes, event.type)).map(event => event.seq);
	// Preserve historical replacement provenance: adjacent metering wins, otherwise
	// cite every historical surface event in the range, not merely surviving nodes.
	for (let index = 0; index < view.length; index++) {
		const event = view[index]!;
		const op = record(event.surfaceOp);
		if (op?.op !== "replace") continue;
		const start = op.startSeq as number;
		const end = op.endSeq as number;
		const previous = view[index - 1];
		const metering = previous && Object.hasOwn(meteringTypes, previous.type) ? record(previous.data) : undefined;
		if (metering) {
			const range = record(metering.shadowedRange);
			if (range?.start !== start || range.end !== end) {
				metering.shadowedRange = { start, end };
				metering.shadowedSeqs = surfaceSeqs.filter(seq => seq >= start && seq <= end);
				count("metering-range");
			}
		}
		const provenance =
			metering?.shadowedSeqs !== undefined
				? metering.shadowedSeqs
				: surfaceSeqs.filter(seq => seq >= start && seq <= end);
		if (!equalJson(event.sourceEventSeqs, provenance)) count("replace-provenance");
		event.sourceEventSeqs = provenance;
	}

	const inbox = new Map<string, string[]>([
		["next-turn", []],
		["next-step", []],
	]);
	for (const event of view) {
		if (event.type !== "agent/inbox/spliced") continue;
		if (!record(event.data)) continue;
		const { target, start, removedCount, inserted } = event.data;
		const list = typeof target === "string" ? inbox.get(target) : undefined;
		const removed = removedCount ?? 0;
		// Malformed non-array inserts remain native validation errors, not repaired data.
		if (inserted !== undefined && !Array.isArray(inserted)) continue;
		const ids = ((inserted ?? []) as unknown[]).map(value => {
			const id = record(value)?.id;
			return typeof id === "string" ? id : "";
		});
		let candidate: string[] | undefined;
		if (
			list &&
			Number.isSafeInteger(start) &&
			(start as number) >= 0 &&
			(start as number) <= list.length &&
			Number.isSafeInteger(removed) &&
			(removed as number) >= 0 &&
			(start as number) + (removed as number) <= list.length
		) {
			candidate = [
				...list.slice(0, start as number),
				...ids,
				...list.slice((start as number) + (removed as number)),
			];
			const all = [...candidate, ...inbox.get(target === "next-turn" ? "next-step" : "next-turn")!].filter(Boolean);
			if (new Set(all).size !== all.length) candidate = undefined;
		}
		if (candidate && list) {
			inbox.set(target as string, candidate);
		} else {
			event.data = {
				target: typeof target === "string" ? target : "next-turn",
				start: 0,
				removedCount: 0,
				inserted: [],
			};
			count("inbox-orphan");
		}
	}
	return { events: view as unknown as SessionEvent[], repairs };
}
