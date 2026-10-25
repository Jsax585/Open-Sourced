import { describe, expect, test } from "bun:test";
import {
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	getDeepSeekImportContext,
	prepareCompaction,
	type CompactionEntry,
	type SessionMessageEntry,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createAssistantMessage, createUserMessage } from "./helpers";

function entry(id: string, message: AgentMessage): SessionMessageEntry {
	return { type: "message", id, parentId: null, timestamp: new Date(1).toISOString(), message };
}
function carrier(messages: AgentMessage[]): CompactionEntry {
	return {
		type: "compaction",
		id: "import",
		parentId: "source",
		timestamp: new Date(1).toISOString(),
		summary: "transcript-only import divider",
		firstKeptEntryId: "source",
		tokensBefore: 0,
		preserveData: { deepseekImportContext: { version: 1, messages }, other: "preserved" },
	};
}
const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1, remoteEnabled: false };

describe("DeepSeek import compaction", () => {
	test("summarizes exact replacement snapshot once and retains only journal-backed tail", () => {
		const snapshot = [createUserMessage("replacement"), createAssistantMessage([{ type: "text", text: "surface" }])];
		const boundary = carrier(snapshot);
		const tail = [
			entry("native-user", createUserMessage("new request")),
			entry("native-answer", createAssistantMessage([{ type: "text", text: "new answer" }])),
		];
		const prep = prepareCompaction([entry("source", createUserMessage("obsolete")), boundary, ...tail], settings)!;
		expect([...prep.messagesToSummarize, ...prep.turnPrefixMessages, ...prep.recentMessages]).toEqual([
			...snapshot,
			...tail.map(e => e.message),
		]);
		expect(prep.messagesToSummarize.slice(0, snapshot.length)).toEqual(snapshot);
		expect(prep.previousSummary).toBeUndefined();
		expect(prep.recentEntryIds).toEqual(tail.filter(e => prep.recentMessages.includes(e.message)).map(e => e.id));
		expect(tail.some(e => e.id === prep.firstKeptEntryId)).toBe(true);
	});

	test("provider switch reconstructs import snapshot and native tail behind unreadable remote successor", () => {
		const snapshot = [createUserMessage("replacement surface")];
		const native = [
			entry("native-user", createUserMessage("native before remote")),
			entry("native-answer", createAssistantMessage([{ type: "text", text: "native answer" }])),
		];
		const remote: CompactionEntry = {
			...carrier([]),
			id: "remote",
			parentId: "native-answer",
			summary: "opaque remote divider",
			firstKeptEntryId: "native-user",
			preserveData: {
				openaiRemoteCompaction: {
					provider: "openai",
					replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
					compactionItem: { type: "compaction", encrypted_content: "opaque" },
				},
			},
		};
		const after = entry("after-remote", createUserMessage("native after remote"));
		const entries = [
			entry("source", createUserMessage("obsolete source")),
			carrier(snapshot),
			...native,
			remote,
			after,
		];
		const prep = prepareCompaction(entries, settings, createMockModel())!;
		expect([...prep.messagesToSummarize, ...prep.turnPrefixMessages, ...prep.recentMessages]).toEqual([
			...snapshot,
			...native.map(item => item.message),
			after.message,
		]);
		expect(prep.previousSummary).toBeUndefined();
		expect(JSON.stringify(prep)).not.toContain("obsolete source");
		expect(JSON.stringify(prep)).not.toContain("opaque remote divider");
	});

	test("readable local successor wins over original import snapshot", () => {
		const kept = entry("kept", createUserMessage("kept native tail"));
		const local: CompactionEntry = {
			...carrier([]),
			id: "local",
			parentId: "kept",
			summary: "new local summary",
			firstKeptEntryId: kept.id,
			preserveData: undefined,
		};
		const prep = prepareCompaction(
			[
				entry("source", createUserMessage("obsolete source")),
				carrier([createUserMessage("replaced snapshot")]),
				kept,
				local,
				entry("later", createUserMessage("later native turn")),
			],
			settings,
			createMockModel(),
		)!;
		expect(prep.previousSummary).toBe("new local summary");
		expect(JSON.stringify(prep)).not.toContain("replaced snapshot");
		expect(JSON.stringify(prep)).not.toContain("obsolete source");
	});

	test("snapshot without native tail compacts with empty keep boundary and strips carrier only on success", async () => {
		const boundary = carrier([createUserMessage("current replacement")]);
		const original = structuredClone(boundary.preserveData);
		const prep = prepareCompaction([entry("source", createUserMessage("obsolete")), boundary], settings)!;
		expect(prep.firstKeptEntryId).toBe("");
		expect(prep.recentMessages).toEqual([]);
		const result = await compact(prep, createMockModel(), "test-key", undefined, undefined, {
			completeImpl: async (_model, context) => {
				expect(JSON.stringify(context.messages)).not.toContain("obsolete");
				expect(JSON.stringify(context.messages)).not.toContain("transcript-only import divider");
				return createAssistantMessage([{ type: "text", text: "new summary" }]);
			},
		});
		expect(result.preserveData).toEqual({ other: "preserved" });
		expect(boundary.preserveData).toEqual(original);
	});

	test("failed or cancelled summary leaves carrier resumable", async () => {
		for (const cancelled of [false, true]) {
			const boundary = carrier([createUserMessage("current replacement")]);
			const original = structuredClone(boundary);
			const prep = prepareCompaction([boundary], settings)!;
			const controller = new AbortController();
			if (cancelled) controller.abort();
			await expect(
				compact(prep, createMockModel(), "test-key", undefined, controller.signal, {
					oneshotRetry: false,
					completeImpl: async () => {
						throw new Error("summary failed");
					},
				}),
			).rejects.toThrow();
			expect(boundary).toEqual(original);
			expect(getDeepSeekImportContext(boundary.preserveData)?.messages).toEqual(
				getDeepSeekImportContext(original.preserveData)?.messages,
			);
		}
	});

	test("clear supersedes import snapshot and its metadata", () => {
		const prep = prepareCompaction(
			[
				carrier([createUserMessage("obsolete snapshot")]),
				{ type: "reset_boundary", id: "clear", parentId: "import", timestamp: new Date(2).toISOString() },
				entry("one", createUserMessage("after clear")),
				entry("two", createAssistantMessage([{ type: "text", text: "answer" }])),
				entry("three", createUserMessage("latest")),
			],
			settings,
		)!;
		expect(JSON.stringify(prep)).not.toContain("obsolete snapshot");
		expect(prep.previousPreserveData).toBeUndefined();
	});

	test("rejects future versions, executable malformed arguments and incompatible message blocks", () => {
		const assistant = createAssistantMessage([{ type: "toolCall", id: "call", name: "bash", arguments: {} }]);
		const invalid: unknown[] = [
			{ version: 2, messages: [] },
			{ version: 1, messages: "not an array" },
			{ version: 1, messages: [{ role: "system", content: "old instructions", timestamp: 1 }] },
			{
				version: 1,
				messages: [{ ...createUserMessage("user"), content: [{ type: "thinking", thinking: "bad role" }] }],
			},
			{
				version: 1,
				messages: [{ ...assistant, content: [{ type: "toolCall", id: "call", name: "bash", arguments: [] }] }],
			},
			{ version: 1, messages: [{ ...assistant, usage: {} }] },
			{
				version: 1,
				messages: [
					{
						role: "toolResult",
						toolCallId: "call",
						toolName: "bash",
						content: "bad",
						isError: false,
						timestamp: 1,
					},
				],
			},
		];
		for (const context of invalid)
			expect(() => getDeepSeekImportContext({ deepseekImportContext: context })).toThrow();
	});
});
