import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getImportedContext } from "@oh-my-pi/pi-agent-core/compaction";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { BlobStore, isBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { CompactionEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	loadEntriesFromFileStream,
	parseSessionEntries,
	resolveBlobRefsInEntries,
} from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { prepareEntryForPersistence } from "@oh-my-pi/pi-coding-agent/session/session-persistence";
import { TempDir } from "@oh-my-pi/pi-utils";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "deepseek",
		model: "historical",
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 7,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function messageText(message: AgentMessage | undefined): string | undefined {
	if (!message || !("content" in message)) return undefined;
	return typeof message.content === "string" ? message.content : undefined;
}

function fixture(): SessionEntry[] {
	return [
		{
			type: "message",
			id: "old",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: assistant("obsolete source"),
		},
		{
			type: "compaction",
			id: "boundary",
			parentId: "old",
			timestamp: new Date(1).toISOString(),
			summary: "display marker",
			firstKeptEntryId: "",
			tokensBefore: 10,
			preserveData: {
				importedContext: { version: 1, messages: [{ role: "user", content: "replacement", timestamp: 1 }] },
			},
		},
		{
			type: "message",
			id: "tail",
			parentId: "boundary",
			timestamp: new Date(2).toISOString(),
			message: { role: "user", content: "native tail", timestamp: 2 },
		},
	];
}

describe("native DeepSeek import context", () => {
	it("replays replacement and native tail once, while both transcripts retain history without snapshot rows", () => {
		const entries = fixture();
		expect(buildSessionContext(entries).messages.map(messageText)).toEqual(["replacement", "native tail"]);
		for (const collapseCompactedHistory of [false, true]) {
			const messages = buildSessionContext(entries, undefined, undefined, {
				transcript: true,
				collapseCompactedHistory,
			}).messages;
			expect(messages.filter(message => message.role === "assistant")).toEqual([assistant("obsolete source")]);
			expect(messages.some(message => message.role === "user" && message.content === "replacement")).toBe(false);
			expect(messages.filter(message => message.role === "user" && message.content === "native tail")).toHaveLength(
				1,
			);
		}
		entries.push({ type: "reset_boundary", id: "clear", parentId: "tail", timestamp: new Date(3).toISOString() });
		expect(buildSessionContext(entries).messages).toEqual([]);
		expect(
			buildSessionContext(entries, undefined, undefined, { transcript: true, collapseCompactedHistory: true })
				.messages,
		).toEqual([]);
	});

	it("supersedes import context with local or OpenAI successor summaries without restoring obsolete rows", () => {
		for (const preserveData of [
			undefined,
			{
				openaiRemoteCompaction: {
					provider: "openai",
					replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
				},
			},
		]) {
			const entries = fixture();
			entries.push({
				type: "compaction",
				id: "successor",
				parentId: "tail",
				timestamp: new Date(3).toISOString(),
				summary: "new native summary",
				firstKeptEntryId: "",
				tokensBefore: 12,
				preserveData,
			});
			entries.push({
				type: "model_change",
				id: "switch",
				parentId: "successor",
				timestamp: new Date(4).toISOString(),
				model: "anthropic/other",
			});
			entries.push({
				type: "message",
				id: "later",
				parentId: "switch",
				timestamp: new Date(5).toISOString(),
				message: { role: "user", content: "later native turn", timestamp: 5 },
			});
			const context = buildSessionContext(entries);
			expect(context.models.default).toBe("anthropic/other");
			expect(context.messages).toHaveLength(2);
			expect(context.messages[0].role).toBe("compactionSummary");
			expect(messageText(context.messages[1])).toBe("later native turn");
			expect(JSON.stringify(context.messages)).not.toContain("obsolete source");
			expect(JSON.stringify(context.messages)).not.toContain("replacement");
		}
	});

	it("loads malformed carriers leniently and rejects them only when the active context consumes them", async () => {
		using dir = TempDir.createSync("@deepseek-invalid-");
		for (const carrier of [
			{ version: 2, messages: [] },
			{ version: 1, messages: [null] },
			{ version: 1, messages: "bad" },
		]) {
			const entries = fixture();
			(entries[1] as CompactionEntry).preserveData = { importedContext: carrier };
			const content = entries.map(entry => JSON.stringify(entry)).join("\n");
			expect(parseSessionEntries(content)).toHaveLength(entries.length);
			expect(() => buildSessionContext(entries)).toThrow();
			expect(() => buildSessionContext(entries, "old")).not.toThrow();
			const file = path.join(dir.path(), "invalid.jsonl");
			await Bun.write(file, content);
			expect((await loadEntriesFromFileStream(file)).entries).toHaveLength(entries.length);
		}
	});

	it("persists oversized transcript and snapshot text, thinking, arguments and images losslessly on native reopen", async () => {
		using dir = TempDir.createSync("@deepseek-lossless-");
		const huge = "source🧠".repeat(80_000);
		const message = assistant(huge);
		message.content.push(
			{ type: "thinking", thinking: huge },
			{ type: "toolCall", id: "call", name: "historical", arguments: { input: huge } },
		);
		const result = {
			role: "toolResult" as const,
			toolCallId: "call",
			toolName: "historical",
			content: [{ type: "text" as const, text: huge }],
			isError: false,
			timestamp: 2,
		};
		const source = SessionManager.inMemory(dir.path());
		source.appendMessage(message);
		source.appendMessage(result);
		source.appendCompaction("import boundary", undefined, "", 10, {
			preserveData: { importedContext: { version: 1, messages: [message, result] } },
		});
		source.appendMessage({ role: "user", content: "native tail", timestamp: 3 });
		const expected = source.buildSessionContext().messages;
		const persisted = await source.persistCopy({ sessionDir: path.join(dir.path(), "sessions") });
		const file = persisted.getSessionFile();
		if (!file) throw new Error("Expected persisted import");
		const reopened = await SessionManager.open(file);
		expect(reopened.buildSessionContext().messages).toEqual(expected);
		for (const manager of [source, reopened]) {
			const transcript = manager.buildSessionContext({ transcript: true }).messages;
			expect(transcript.filter(turn => turn.role === "assistant")).toEqual([message]);
			expect(
				transcript.reduce((total, turn) => total + (turn.role === "assistant" ? turn.usage.totalTokens : 0), 0),
			).toBe(10);
		}
		reopened.appendResetBoundary();
		const cleared = await SessionManager.open(file);
		expect(cleared.buildSessionContext().messages).toEqual([]);
		const blobs = new BlobStore(path.join(dir.path(), "blobs"));
		const data = Buffer.alloc(1500, 1).toString("base64");
		const entry = fixture()[1] as CompactionEntry;
		entry.preserveData = {
			importedContext: {
				version: 1,
				messages: [
					{
						role: "user",
						content: [
							{ type: "image", data, mimeType: "image/png" },
							{ type: "text", text: huge },
						],
						timestamp: 1,
					},
				],
			},
		};
		const stored = prepareEntryForPersistence(entry, blobs);
		expect(JSON.stringify(stored)).not.toContain(data);
		if (stored.type !== "compaction") throw new Error("Expected compaction entry");
		const snapshot = getImportedContext(stored.preserveData);
		const imageMessage = snapshot?.messages[0];
		const image =
			imageMessage && "content" in imageMessage && Array.isArray(imageMessage.content)
				? imageMessage.content[0]
				: undefined;
		expect(image?.type === "image" && isBlobRef(image.data)).toBe(true);
		const loaded = [JSON.parse(JSON.stringify(stored)) as CompactionEntry];
		await resolveBlobRefsInEntries(loaded, blobs);
		expect(loaded[0]).toEqual(entry);
	});
});
