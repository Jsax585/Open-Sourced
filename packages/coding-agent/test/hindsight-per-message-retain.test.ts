import { describe, expect, it } from "bun:test";
import type { HindsightApi, MemoryItemInput, RetainBatchOptions } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { HINDSIGHT_TIMESTAMP_UNSET } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HINDSIGHT_UI_RECEIPT_ROLE, type HindsightMessage } from "@oh-my-pi/pi-coding-agent/hindsight/content";
import {
	HINDSIGHT_RETAIN_CHECKPOINT_TYPE,
	hindsightRetainScope,
	HindsightSessionState,
} from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

const SESSION_ID = "sess-per-message";
const BANK_ID = "personal";

function makeConfig(overrides: Partial<HindsightConfig> = {}): HindsightConfig {
	return {
		hindsightApiUrl: "http://localhost:8888",
		hindsightApiToken: null,
		bankId: BANK_ID,
		bankIdPrefix: "",
		scoping: "global",
		bankMission: "",
		retainMission: null,
		autoRecall: false,
		autoRetain: true,
		retainMode: "per-message",
		retainEveryNTurns: 1,
		retainOverlapTurns: 2,
		retainContext: "omp",
		recallBudget: "mid",
		recallMaxTokens: 1024,
		recallTypes: ["world", "experience"],
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		recallPromptPreamble: "preamble",
		debug: false,
		requestTimeoutMs: 30_000,
		reflectTimeoutMs: 30_000,
		recallTimeoutMs: 30_000,
		retainTimeoutMs: 30_000,
		mentalModelsEnabled: false,
		mentalModelAutoSeed: false,
		mentalModelMaxRenderChars: 16_000,
		...overrides,
	};
}

function scope(): string {
	return hindsightRetainScope({
		apiUrl: "http://localhost:8888",
		apiToken: null,
		bankId: BANK_ID,
		retainTags: ["project:omp"],
		scoping: "global",
	});
}

function cutoverMarker(cutover: string[]): SessionEntry {
	return {
		type: "custom",
		customType: HINDSIGHT_RETAIN_CHECKPOINT_TYPE,
		id: `cutover-${cutover.length}`,
		parentId: null,
		timestamp: "2026-08-17T09:00:00.000Z",
		data: { version: 1, kind: "cutover", scope: scope(), cutover },
	} as SessionEntry;
}

function acceptedDelta(accepted: string[]): SessionEntry {
	return {
		type: "custom",
		customType: HINDSIGHT_RETAIN_CHECKPOINT_TYPE,
		id: `accepted-${accepted.length}`,
		parentId: null,
		timestamp: "2026-08-17T09:00:01.000Z",
		data: { version: 1, kind: "accepted", scope: scope(), accepted },
	} as SessionEntry;
}

function harness(
	options: {
		entries?: SessionEntry[];
		branch?: SessionEntry[];
		beforeCheckpoint?: () => void;
		retainBatch?: (items: MemoryItemInput[], batchOptions?: RetainBatchOptions) => Promise<void>;
	} = {},
) {
	const entries = options.entries ?? [];
	const branch = options.branch ?? entries;
	const batches: { items: MemoryItemInput[]; options?: RetainBatchOptions }[] = [];
	const notices: string[] = [];
	const client = {
		async createBank() {
			return {};
		},
		async retainBatch(_bankId: string, items: MemoryItemInput[], batchOptions?: RetainBatchOptions) {
			batches.push({ items, options: batchOptions });
			await options.retainBatch?.(items, batchOptions);
			return {};
		},
		async deleteDocument() {
			throw new Error("per-message retain must not delete history");
		},
	} as unknown as HindsightApi;
	const listeners = new Set<(event: { type: string }) => void>();
	const session = {
		sessionId: SESSION_ID,
		emitNotice: (_level: string, message: string) => {
			notices.push(message);
		},
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => branch,
			appendCustomEntry: (customType: string, data?: unknown) => {
				options.beforeCheckpoint?.();
				const entry = {
					type: "custom",
					customType,
					id: `written-${entries.length}`,
					parentId: null,
					timestamp: "2026-08-21T12:00:00.000Z",
					data,
				} as SessionEntry;
				entries.push(entry);
				if (branch !== entries) branch.push(entry);
				return entry.id;
			},
			getHeader: () => ({ timestamp: "2026-01-01T00:00:00.000Z" }),
		},
		subscribe: (listener: (event: { type: string }) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as AgentSession;
	const state = new HindsightSessionState({
		sessionId: SESSION_ID,
		client,
		bankId: BANK_ID,
		retainTags: ["project:omp"],
		config: makeConfig(),
		session,
		banksSet: new Set([BANK_ID]),
	});
	return { state, batches, notices, entries, branch, listeners };
}

function item(batches: { items: MemoryItemInput[] }[], index = 0): MemoryItemInput {
	const found = batches[index]?.items[0];
	if (!found) throw new Error(`missing retain item ${index}`);
	return found;
}

describe("Hindsight per-message retain", () => {
	it("retains each new journal entry with its real timestamp, stable id, and session metadata", async () => {
		const { state, batches } = harness();
		const userTs = "2026-08-17T10:00:00.000Z";
		const assistantTs = "2026-08-17T10:00:05.000Z";
		await state.retainSession([
			{ role: "user", content: "ship the date fix", timestamp: userTs, entryId: "u1" },
			{ role: "assistant", content: "landed the retain change", timestamp: assistantTs, entryId: "a1" },
		]);

		expect(batches).toHaveLength(1);
		expect(batches[0]?.options?.async).toBe(true);
		expect(batches[0]?.items).toHaveLength(2);
		expect(batches[0]?.items[0]).toMatchObject({
			documentId: `omp-msg:${SESSION_ID}:u1`,
			timestamp: userTs,
			tags: ["project:omp"],
			metadata: { session_id: SESSION_ID, entry_id: "u1", retain_mode: "per-message", source: "omp-transcript" },
		});
		expect(batches[0]?.items[0]?.content).toContain("ship the date fix");
		expect(batches[0]?.items[0]?.content).toContain("[role: user]");
		expect(batches[0]?.items[1]).toMatchObject({
			documentId: `omp-msg:${SESSION_ID}:a1`,
			timestamp: assistantTs,
		});
		expect(batches[0]?.items[1]?.content).toContain("landed the retain change");
		expect(batches[0]?.items[1]?.content).not.toContain("ship the date fix");
		expect(batches[0]?.items[1]?.timestamp).toBe(assistantTs);
		expect(batches[0]?.items[1]?.timestamp).not.toBe(userTs);
	});

	it("sends unset for a missing or invalid source date and does not borrow now or the session header", async () => {
		const { state, batches } = harness();
		await state.retainSession([
			{ role: "user", content: "no date on this turn", entryId: "u-missing" },
			{ role: "assistant", content: "also undated", timestamp: "not-a-date", entryId: "a-bad" },
		]);

		expect(item(batches, 0).timestamp).toBe(HINDSIGHT_TIMESTAMP_UNSET);
		expect(batches[0]?.items[1]?.timestamp).toBe(HINDSIGHT_TIMESTAMP_UNSET);
		expect(JSON.stringify(batches[0])).not.toContain("2026-01-01T00:00:00.000Z");
	});

	it("does not embed an earlier request in a later item", async () => {
		const { state, batches } = harness();
		await state.retainSession([
			{ role: "user", content: "stop the nightly export", timestamp: "2026-08-17T10:00:00.000Z", entryId: "u1" },
			{ role: "assistant", content: "stopped", timestamp: "2026-08-17T10:00:04.000Z", entryId: "a1" },
			{ role: "user", content: "yes do that", timestamp: "2026-08-18T11:00:00.000Z", entryId: "u2" },
		]);

		const followUp = batches[0]?.items.find(entry => entry.documentId === `omp-msg:${SESSION_ID}:u2`);
		expect(followUp?.timestamp).toBe("2026-08-18T11:00:00.000Z");
		expect(followUp?.content).toContain("yes do that");
		expect(followUp?.content).not.toContain("stop the nightly export");
		expect(followUp?.content).not.toContain("[timestamp: 2026-08-17T10:00:00.000Z]");
	});

	it("retains a UI participant receipt under entry id plus question id", async () => {
		const { state, batches } = harness();
		const receipt: HindsightMessage = {
			role: HINDSIGHT_UI_RECEIPT_ROLE,
			content: "selected ship it",
			timestamp: "2026-08-17T10:01:00.000Z",
			entryId: "tool-1",
			toolCallId: "call-1",
			questionId: "q-ship",
			conditions: {
				kind: "selection",
				selected: ["ship it"],
				custom: false,
				multi: false,
				questionIndex: 0,
				matchedOffered: true,
				notError: true,
				notTimeout: true,
				notCancelled: true,
				notMalformed: true,
				primary: true,
				authorUI: true,
				unselected: ["hold"],
				selectedScope: [{ label: "ship it", description: "cut a release today" }],
			},
		};
		await state.retainSession([
			{ role: "user", content: "which release?", timestamp: "2026-08-17T10:00:00.000Z", entryId: "u1" },
			receipt,
		]);

		const stored = batches[0]?.items.find(entry => entry.documentId === `omp-receipt:${SESSION_ID}:tool-1:q-ship`);
		expect(stored?.timestamp).toBe("2026-08-17T10:01:00.000Z");
		expect(stored?.metadata).toMatchObject({ question_id: "q-ship", tool_call_id: "call-1", session_id: SESSION_ID });
		expect(stored?.content).toContain("selected ship it");
		expect(stored?.content).toContain("[questionId: q-ship]");
		expect(stored?.content).not.toContain("Owner");
	});

	it("does not backfill a resumed checkpoint, and retries an unaccepted identity with the same document id", async () => {
		const retained = `omp-msg:${SESSION_ID}:u-old`;
		const { state, batches } = harness({
			branch: [cutoverMarker(["entry:u-history"]), acceptedDelta(["entry:u-old"])],
			entries: [cutoverMarker(["entry:u-history"]), acceptedDelta(["entry:u-old"])],
		});
		await state.retainSession([
			{ role: "user", content: "already in the old full-session document", entryId: "u-history" },
			{ role: "user", content: "accepted yesterday", entryId: "u-old" },
			{
				role: "user",
				content: "retry this failed turn",
				timestamp: "2026-08-20T08:00:00.000Z",
				entryId: "u-failed",
			},
		]);

		expect(batches[0]?.items.map(entry => entry.documentId)).toEqual([`omp-msg:${SESSION_ID}:u-failed`]);
		expect(batches[0]?.items[0]?.content).toContain("retry this failed turn");
		expect(batches[0]?.items.some(entry => entry.documentId === retained)).toBe(false);
	});

	it("does not reuse accepted identities from another endpoint, account or tag scope", async () => {
		for (const foreign of [
			{ apiUrl: "http://different.example" },
			{ apiToken: "different-synthetic-account" },
			{ retainTags: ["project:other"] },
		]) {
			const records = [cutoverMarker([]), acceptedDelta(["entry:u-live"])];
			const foreignScope = hindsightRetainScope({
				apiUrl: "http://localhost:8888",
				apiToken: null,
				bankId: BANK_ID,
				retainTags: ["project:omp"],
				scoping: "global",
				...foreign,
			});
			for (const record of records) {
				if (record.type === "custom") record.data = { ...(record.data as object), scope: foreignScope };
			}
			const { state, batches } = harness({ entries: records });
			await state.retainSession([{ role: "user", content: "retain in this scope", entryId: "u-live" }]);
			expect(batches.flatMap(batch => batch.items.map(entry => entry.documentId))).toEqual([
				`omp-msg:${SESSION_ID}:u-live`,
			]);
		}
	});

	it("pauses a failed cutover checkpoint and retries new entries without absorbing them into history", async () => {
		let writable = false;
		const history = {
			type: "message",
			id: "u-history",
			parentId: null,
			timestamp: "2026-08-17T09:00:00.000Z",
			message: { role: "user", content: "historical turn", timestamp: Date.parse("2026-08-17T09:00:00.000Z") },
		} as SessionEntry;
		const { state, batches, notices, entries } = harness({
			entries: [history],
			beforeCheckpoint: () => {
				if (!writable) throw new Error("journal unavailable");
			},
		});
		entries.push({
			type: "message",
			id: "u-live",
			parentId: "u-history",
			timestamp: "2026-08-18T09:00:00.000Z",
			message: {
				role: "user",
				content: "new after failed cutover",
				timestamp: Date.parse("2026-08-18T09:00:00.000Z"),
			},
		} as SessionEntry);
		await expect(
			state.retainSession([
				{ role: "user", content: "historical turn", entryId: "u-history" },
				{ role: "user", content: "new after failed cutover", entryId: "u-live" },
			]),
		).rejects.toThrow(/checkpoint/);
		expect(batches).toHaveLength(0);
		expect(notices.some(notice => notice.includes("checkpoint"))).toBe(true);
		writable = true;
		await state.retainSession([
			{ role: "user", content: "historical turn", entryId: "u-history" },
			{ role: "user", content: "new after failed cutover", entryId: "u-live" },
		]);
		expect(batches.flatMap(batch => batch.items.map(entry => entry.documentId))).toEqual([
			`omp-msg:${SESSION_ID}:u-live`,
		]);
	});

	it("keeps the same document id when a failed post is retried, and surfaces the failure", async () => {
		let fail = true;
		const { state, batches, notices } = harness({
			retainBatch: async () => {
				if (fail) throw new Error("slow bank refused");
			},
		});
		const messages: HindsightMessage[] = [
			{ role: "user", content: "remember the outage", timestamp: "2026-08-20T08:00:00.000Z", entryId: "u-retry" },
		];
		await expect(state.retainSession(messages)).rejects.toThrow(/slow bank refused/);
		expect(notices).toEqual([]);
		fail = false;
		await state.retainSession(messages);
		expect(batches).toHaveLength(2);
		expect(batches[0]?.items[0]?.documentId).toBe(batches[1]?.items[0]?.documentId);
	});

	it("notifies when automatic retain fails and retries the same document on the next agent end", async () => {
		let fail = true;
		const { state, batches, notices, entries, listeners } = harness({
			retainBatch: async () => {
				if (fail) throw new Error("bank down");
			},
		});
		const journal = [
			{
				type: "message",
				id: "u-live",
				parentId: null,
				timestamp: "2026-08-20T08:00:00.000Z",
				message: { role: "user", content: "turn one happened", timestamp: Date.parse("2026-08-20T08:00:00.000Z") },
			} as SessionEntry,
		];
		entries.push(...journal);
		state.attachSessionListeners();
		for (const listener of listeners) listener({ type: "agent_end" });
		await state.awaitPendingAutomaticRetain();
		expect(notices.some(notice => notice.includes("bank down"))).toBe(true);
		expect(batches).toHaveLength(1);

		fail = false;
		entries.push({
			type: "message",
			id: "u-live-2",
			parentId: "u-live",
			timestamp: "2026-08-20T09:00:00.000Z",
			message: { role: "user", content: "turn two happened", timestamp: Date.parse("2026-08-20T09:00:00.000Z") },
		} as SessionEntry);
		for (const listener of listeners) listener({ type: "agent_end" });
		await state.awaitPendingAutomaticRetain();
		const ids = batches.flatMap(batch => batch.items.map(entry => entry.documentId));
		expect(ids.filter(id => id === `omp-msg:${SESSION_ID}:u-live`)).toHaveLength(2);
		expect(ids).toContain(`omp-msg:${SESSION_ID}:u-live-2`);
	});

	it("does not re-cutover every startup entry when a checkpoint already records an unaccepted tail", async () => {
		const { state, batches } = harness({
			entries: [cutoverMarker([])],
			branch: [cutoverMarker([])],
		});
		await state.retainSession([{ role: "user", content: "below cadence yesterday", entryId: "u-tail" }]);
		expect(batches[0]?.items[0]?.documentId).toBe(`omp-msg:${SESSION_ID}:u-tail`);
	});

	it("waits for an already-started slow post and does not start another retain while draining", async () => {
		let releasePost: () => void = () => {};
		const postHeld = new Promise<void>(resolve => {
			releasePost = resolve;
		});
		let markStarted: () => void = () => {};
		const postStarted = new Promise<void>(resolve => {
			markStarted = resolve;
		});
		let posts = 0;
		const { state, entries, listeners } = harness({
			retainBatch: () => {
				posts += 1;
				markStarted();
				return postHeld;
			},
		});
		entries.push({
			type: "message",
			id: "u-slow",
			parentId: null,
			timestamp: "2026-08-20T08:00:00.000Z",
			message: { role: "user", content: "slow bank turn", timestamp: 1 },
		} as SessionEntry);
		state.attachSessionListeners();
		for (const listener of listeners) listener({ type: "agent_end" });
		const drained = state.drainAutomaticRetain();
		let finished = false;
		void drained.then(() => {
			finished = true;
		});
		await postStarted;
		expect(posts).toBe(1);
		expect(finished).toBe(false);
		for (const listener of listeners) listener({ type: "agent_end" });
		releasePost();
		await drained;
		expect(posts).toBe(1);
		expect(finished).toBe(true);
	});
});
