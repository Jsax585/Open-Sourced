/**
 * Contracts: AdvisorTranscriptRecorder persists the advisor agent's turns to a
 * subagent-style JSONL (`<session>/__advisor.jsonl`) so the advisor model's usage
 * is attributed in stats and its transcript shows in the Agent Hub.
 *
 * - Assistant turns land as `{type:"message", message:{role:"assistant", usage}}`
 *   entries — exactly the shape the stats parser reads for usage.
 * - User deltas are persisted but flagged `synthetic`/agent-attributed so stats'
 *   user-message metrics skip them.
 * - Non-conversational message kinds are not persisted.
 * - The target follows the session file: a switch routes later turns to the new
 *   session's `__advisor.jsonl`, leaving the prior file intact.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	ADVISOR_TRANSCRIPT_FILENAME,
	AdvisorTranscriptRecorder,
	advisorTranscriptFilename,
	loadAdvisorTranscriptCosts,
} from "@oh-my-pi/pi-coding-agent/advisor/transcript-recorder";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getBlobsDir, getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

interface AdvisorEntry {
	type?: string;
	id?: unknown;
	parentId?: unknown;
	message?: {
		role?: string;
		model?: string;
		usage?: { input?: number; totalTokens?: number; cost?: { total?: number } };
		synthetic?: boolean;
		attribution?: string;
		content?: unknown;
		customType?: string;
	};
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "advisor-recorder-"));
	try {
		return await fn(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

/** Parse the message entries (skipping the session header) from an advisor JSONL. */
async function readMessageEntries(file: string): Promise<AdvisorEntry[]> {
	const text = await Bun.file(file).text();
	// JSON.parse returns `any`; assigning to the typed array narrows reads below.
	const entries: AdvisorEntry[] = text
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
	return entries.filter(entry => entry.type === "message");
}

function assistantMessage(text: string, inputTokens: number, cost = 0, provider = "anthropic"): AgentMessage {
	const message = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages",
		provider,
		model: "test-advisor-model",
		usage: {
			input: inputTokens,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + 3,
			cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
		},
		stopReason: "stop" as const,
		timestamp: 1,
	};
	return message as unknown as AgentMessage;
}

function userMessage(text: string): AgentMessage {
	const message = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 };
	return message as unknown as AgentMessage;
}

function developerMessage(text: string): AgentMessage {
	const message = { role: "developer" as const, content: [{ type: "text" as const, text }], timestamp: 1 };
	return message as unknown as AgentMessage;
}

describe("AdvisorTranscriptRecorder", () => {
	it("persists assistant turns with usage to <session>/__advisor.jsonl", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("reviewing", 42));
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages).toHaveLength(1);
			expect(messages[0].message?.role).toBe("assistant");
			expect(messages[0].message?.model).toBe("test-advisor-model");
			expect(messages[0].message?.usage?.input).toBe(42);
			// Stats keys on a non-empty entry id; SessionManager must assign one.
			expect(typeof messages[0].id).toBe("string");
			expect(String(messages[0].id).length).toBeGreaterThan(0);
		});
	});

	it("marks advisor user deltas synthetic and agent-attributed", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(userMessage("### Session update"));
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages).toHaveLength(1);
			expect(messages[0].message?.role).toBe("user");
			expect(messages[0].message?.synthetic).toBe(true);
			expect(messages[0].message?.attribution).toBe("agent");
		});
	});

	it("skips non-conversational message kinds", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(developerMessage("noise"));
			recorder.record(assistantMessage("kept", 1));
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages.map(m => m.message?.role)).toEqual(["assistant"]);
		});
	});

	it("routes later turns to the new session file after a switch", async () => {
		await withTempDir(async dir => {
			let sessionFile = path.join(dir, "first.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("before switch", 1));
			sessionFile = path.join(dir, "second.jsonl");
			recorder.record(assistantMessage("after switch", 2));
			await recorder.close();

			const first = await readMessageEntries(path.join(dir, "first", ADVISOR_TRANSCRIPT_FILENAME));
			const second = await readMessageEntries(path.join(dir, "second", ADVISOR_TRANSCRIPT_FILENAME));
			expect(first).toHaveLength(1);
			expect(first[0].message?.usage?.input).toBe(1);
			expect(second).toHaveLength(1);
			expect(second[0].message?.usage?.input).toBe(2);
		});
	});

	it("skips a retried batch but keeps every billed assistant turn", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			// A failing advisor re-sends the identical batch each attempt; the turn
			// only commits once it finally succeeds (issue #9553).
			for (let attempt = 0; attempt < 5; attempt++) {
				recorder.beginTurn();
				recorder.record({ ...userMessage("### Session update"), timestamp: attempt + 1 } as AgentMessage);
				recorder.record(assistantMessage(`attempt ${attempt}`, 1, 0.1));
			}
			recorder.commitTurn();
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages.filter(m => m.message?.role === "user")).toHaveLength(1);
			expect(messages.filter(m => m.message?.role === "assistant")).toHaveLength(5);
			expect((await loadAdvisorTranscriptCosts(sessionFile)).get("")).toBeCloseTo(0.5, 8);
		});
	});

	it("keeps identical deltas that belong to distinct committed turns", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			// The user re-submits the same prompt across three separate turns: each
			// renders an identical "Session update" yet is genuinely new content.
			for (let turn = 0; turn < 3; turn++) {
				recorder.beginTurn();
				recorder.record(userMessage("### Session update"));
				recorder.record(assistantMessage(`review ${turn}`, 1, 0.1));
				recorder.commitTurn();
			}
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages.filter(m => m.message?.role === "user")).toHaveLength(3);
		});
	});

	it("keeps a repeated delta after the prior batch is abandoned", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.beginTurn();
			recorder.record(userMessage("### Session update"));
			recorder.abandonTurn();
			recorder.beginTurn();
			recorder.record(userMessage("### Session update"));
			recorder.commitTurn();
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages.filter(m => m.message?.role === "user")).toHaveLength(2);
		});
	});

	it("holds post-snapshot records behind a byte boundary", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("before", 1, 0.25));
			const gate = Promise.withResolvers<void>();
			const ready = recorder.blockWritesUntil(gate.promise);
			recorder.record(assistantMessage("after", 1, 0.5));
			await ready;

			const transcript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			const beforeRelease = await readMessageEntries(transcript);
			expect(beforeRelease.filter(m => m.message?.role === "assistant")).toHaveLength(1);

			gate.resolve();
			await recorder.close();
			const afterRelease = await readMessageEntries(transcript);
			expect(afterRelease.filter(m => m.message?.role === "assistant")).toHaveLength(2);
		});
	});

	it("keeps identical deltas delivered within one turn", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			// Two tool runs with byte-identical output render two identical chunks in
			// one delivery; both must persist (they are distinct positions, not a replay).
			recorder.beginTurn();
			recorder.record(userMessage("### Session update"));
			recorder.record(userMessage("### Session update"));
			recorder.record(assistantMessage("review", 1, 0.1));
			recorder.commitTurn();
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages.filter(m => m.message?.role === "user")).toHaveLength(2);
		});
	});

	it("loads cumulative costs by advisor slug", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const primary = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			const security = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
				advisorTranscriptFilename("security"),
			);
			primary.record(assistantMessage("primary", 1, 0.25));
			security.record(assistantMessage("first", 1, 0.25));
			security.record(assistantMessage("second", 1, 0.5));
			await Promise.all([primary.close(), security.close()]);

			expect(Object.fromEntries(await loadAdvisorTranscriptCosts(sessionFile))).toEqual({
				"": 0.25,
				security: 0.75,
			});
		});
	});

	it("excludes providers that only produced zero-cost turns from subscription attribution", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("paid", 1, 0.25, "openai"));
			recorder.record(assistantMessage("failed subscription fallback", 1, 0, "anthropic"));
			await recorder.close();

			const providersBySlug = new Map<string, Set<string>>();
			await loadAdvisorTranscriptCosts(sessionFile, { providersBySlug });
			expect([...(providersBySlug.get("") ?? [])]).toEqual(["openai"]);
		});
	});

	it("yields before snapshotting transcript metadata", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("persisted", 1, 0.25));
			await recorder.close();

			let snapshotTaken = false;
			const costs = loadAdvisorTranscriptCosts(sessionFile, {
				onSnapshot: () => {
					snapshotTaken = true;
				},
			});
			expect(snapshotTaken).toBe(false);
			expect((await costs).get("")).toBeCloseTo(0.25, 8);
			expect(snapshotTaken).toBe(true);
		});
	});

	it("excludes transcript entries appended after the cost snapshot", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("persisted before snapshot", 1, 0.25));
			await recorder.close();

			const transcript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			const appended = Promise.withResolvers<void>();
			const costs = loadAdvisorTranscriptCosts(sessionFile, {
				onSnapshot: () => {
					const entry = JSON.stringify({
						type: "message",
						message: assistantMessage("billed after snapshot", 1, 0.5),
					});
					void fs.appendFile(transcript, `${entry}\n`).then(appended.resolve, appended.reject);
				},
			});
			await appended.promise;

			expect((await costs).get("")).toBeCloseTo(0.25, 8);
			expect((await loadAdvisorTranscriptCosts(sessionFile)).get("")).toBeCloseTo(0.75, 8);
		});
	});

	it("keeps valid costs when persisted entries are malformed", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("valid", 1, 0.25));
			await recorder.close();
			const transcript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			const lines = (await fs.readFile(transcript, "utf8")).trimEnd().split("\n");
			lines.splice(
				-1,
				0,
				JSON.stringify({ type: "message", message: { role: "assistant" } }),
				"{ this is not valid json",
				JSON.stringify({ type: "message" }),
				"null",
			);
			await fs.writeFile(transcript, `${lines.join("\n")}\n`);

			expect((await loadAdvisorTranscriptCosts(sessionFile)).get("")).toBe(0.25);
		});
	});

	it("continues the parent chain and appends after the existing bytes when a transcript is reopened", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const transcript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			const first = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			first.record(assistantMessage("one", 1, 0.25));
			first.record(userMessage("### Session update"));
			await first.close();
			const before = await Bun.file(transcript).text();
			const beforeEntries = await readMessageEntries(transcript);

			const second = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			second.record(assistantMessage("two", 2, 0.5));
			await second.close();

			const after = await Bun.file(transcript).text();
			expect(after.startsWith(before)).toBe(true);
			const entries = await readMessageEntries(transcript);
			expect(entries.map(entry => entry.message?.role)).toEqual(["assistant", "user", "assistant"]);
			expect(entries[0].parentId).toBeNull();
			expect(entries[1].parentId).toBe(entries[0].id);
			expect(entries[2].parentId).toBe(beforeEntries[1].id);
			expect(new Set(entries.map(entry => entry.id)).size).toBe(3);
			// Exactly one session header: a reopen must not mint a second one.
			expect(after.split("\n").filter(line => line.includes('"type":"session"'))).toHaveLength(1);
			expect((await loadAdvisorTranscriptCosts(sessionFile)).get("")).toBeCloseTo(0.75, 8);
		});
	});

	it("returns to an earlier session's transcript after a switch and continues its chain", async () => {
		await withTempDir(async dir => {
			let sessionFile = path.join(dir, "first.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("first a", 1));
			sessionFile = path.join(dir, "second.jsonl");
			recorder.record(assistantMessage("second a", 2));
			sessionFile = path.join(dir, "first.jsonl");
			recorder.record(assistantMessage("first b", 3));
			await recorder.close();

			const first = await readMessageEntries(path.join(dir, "first", ADVISOR_TRANSCRIPT_FILENAME));
			const second = await readMessageEntries(path.join(dir, "second", ADVISOR_TRANSCRIPT_FILENAME));
			expect(first.map(entry => entry.message?.usage?.input)).toEqual([1, 3]);
			expect(first[1].parentId).toBe(first[0].id);
			expect(second.map(entry => entry.message?.usage?.input)).toEqual([2]);
			expect(second[0].parentId).toBeNull();
		});
	});

	it("externalizes images to blob references and completes partial assistant usage", async () => {
		await withTempDir(async dir => {
			const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
			setAgentDir(path.join(dir, "agent"));
			try {
				const sessionFile = path.join(dir, "sess.jsonl");
				const recorder = new AdvisorTranscriptRecorder(
					() => sessionFile,
					() => dir,
				);
				const imageData = Buffer.alloc(1500, 1).toString("base64");
				recorder.record({
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [
						{ type: "text", text: "screenshot" },
						{ type: "image", data: imageData, mimeType: "image/png" },
					],
					isError: false,
					timestamp: 1,
				} as AgentMessage);
				recorder.record({ ...assistantMessage("partial", 5), usage: { input: 5, output: 1 } } as AgentMessage);
				await recorder.close();

				const transcript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
				const raw = await Bun.file(transcript).text();
				expect(raw).not.toContain(imageData);
				expect(raw).toContain("blob:sha256:");
				const messages = await readMessageEntries(transcript);
				expect(messages.map(entry => entry.message?.role)).toEqual(["toolResult", "assistant"]);
				expect(messages[1].message?.usage?.totalTokens).toBe(6);
				expect(messages[1].message?.usage?.cost?.total).toBe(0);
			} finally {
				if (originalAgentDir) {
					setAgentDir(originalAgentDir);
				} else {
					setAgentDir(path.join(getConfigRootDir(), "agent"));
					delete process.env.PI_CODING_AGENT_DIR;
				}
			}
		});
	});

	describe("reopening a legacy transcript", () => {
		const legacyUser = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
		const legacyAssistant = (text: string, cost: number) => ({
			...(assistantMessage(text, 1, cost) as AgentMessage & { content: unknown }),
		});
		const legacyHeader = (version: number, cwd: string) => ({
			type: "session",
			version,
			id: "legacy-session",
			timestamp: "2024-01-01T00:00:00.000Z",
			cwd,
		});

		interface LegacyLine {
			type: string;
			message?: { content: unknown; customType?: string };
			[field: string]: unknown;
		}
		const rows: {
			name: string;
			lines: (cwd: string) => LegacyLine[];
			expectedRoles: string[];
			expectedIds: string[] | undefined;
			expectedCost: number;
		}[] = [
			{
				name: "v1 transcript without entry ids or parent ids",
				lines: (cwd: string) => [
					legacyHeader(1, cwd),
					{ type: "message", timestamp: "2024-01-01T00:00:01.000Z", message: legacyUser("legacy prompt") },
					{ type: "message", timestamp: "2024-01-01T00:00:02.000Z", message: legacyAssistant("legacy a", 0.25) },
					{ type: "message", timestamp: "2024-01-01T00:00:03.000Z", message: legacyAssistant("legacy b", 0.5) },
				],
				expectedRoles: ["user", "assistant", "assistant", "assistant"],
				expectedIds: undefined,
				// Two billed legacy assistants ($0.25 + $0.5) plus the appended $0.125.
				expectedCost: 0.875,
			},
			{
				name: "v2 transcript with hookMessage entries",
				lines: (cwd: string) => [
					legacyHeader(2, cwd),
					{
						type: "message",
						id: "legacy-1",
						parentId: null,
						timestamp: "2024-01-01T00:00:01.000Z",
						message: legacyUser("legacy prompt"),
					},
					{
						type: "message",
						id: "legacy-2",
						parentId: "legacy-1",
						timestamp: "2024-01-01T00:00:02.000Z",
						message: {
							role: "hookMessage",
							customType: "note",
							content: "hook note",
							display: true,
							timestamp: 1,
						},
					},
					{
						type: "message",
						id: "legacy-3",
						parentId: "legacy-2",
						timestamp: "2024-01-01T00:00:03.000Z",
						message: legacyAssistant("legacy a", 0.25),
					},
				],
				expectedRoles: ["user", "custom", "assistant", "assistant"],
				expectedIds: ["legacy-1", "legacy-2", "legacy-3"],
				// One billed legacy assistant ($0.25) plus the appended $0.125.
				expectedCost: 0.375,
			},
		];

		for (const row of rows) {
			it(`appends to a ${row.name} without losing messages or breaking the chain`, async () => {
				await withTempDir(async dir => {
					const sessionFile = path.join(dir, "sess.jsonl");
					const transcript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
					const legacy = row.lines(dir);
					await fs.mkdir(path.dirname(transcript), { recursive: true });
					await Bun.write(transcript, `${legacy.map(line => JSON.stringify(line)).join("\n")}\n`);
					const legacyMessages = legacy.flatMap(line => (line.message ? [line.message] : []));

					const recorder = new AdvisorTranscriptRecorder(
						() => sessionFile,
						() => dir,
					);
					recorder.record(assistantMessage("appended", 7, 0.125));
					await recorder.close();

					const lines = (await Bun.file(transcript).text())
						.split("\n")
						.filter(line => line.trim() !== "")
						.map(line => JSON.parse(line) as { type?: string; version?: number });
					const headers = lines.filter(line => line.type === "session");
					expect(headers).toHaveLength(1);
					expect(headers[0].version).toBe(CURRENT_SESSION_VERSION);

					const entries = await readMessageEntries(transcript);
					expect(entries.map(entry => entry.message?.role)).toEqual(row.expectedRoles);
					// Every legacy message survives, in order, with its payload intact.
					for (let i = 0; i < legacyMessages.length; i++) {
						const original = legacyMessages[i];
						expect(entries[i].message?.content).toEqual(original.content);
						expect(entries[i].message?.customType).toBe(original.customType);
					}
					expect(entries[legacyMessages.length].message?.usage?.input).toBe(7);

					// One linear chain: a null root, each entry parented on its predecessor.
					for (const entry of entries) {
						expect(typeof entry.id).toBe("string");
						expect(String(entry.id).length).toBeGreaterThan(0);
					}
					expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
					expect(entries[0].parentId).toBeNull();
					for (let i = 1; i < entries.length; i++) expect(entries[i].parentId).toBe(entries[i - 1].id);
					if (row.expectedIds)
						expect(entries.slice(0, row.expectedIds.length).map(entry => entry.id)).toEqual(row.expectedIds);

					expect((await loadAdvisorTranscriptCosts(sessionFile)).get("")).toBeCloseTo(row.expectedCost, 8);
				});
			});
		}
	});

	it("keeps the parent chain intact when serializing an entry fails", async () => {
		await withTempDir(async dir => {
			const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
			setAgentDir(path.join(dir, "agent"));
			try {
				// An image tool result is externalized to the blob store while the entry is
				// serialized; a blob directory that cannot be created (here: a regular file
				// in its place) fails that step deterministically.
				const blobsDir = getBlobsDir();
				await fs.mkdir(path.dirname(blobsDir), { recursive: true });
				await Bun.write(blobsDir, "not a directory");

				const sessionFile = path.join(dir, "sess.jsonl");
				const transcript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
				const recorder = new AdvisorTranscriptRecorder(
					() => sessionFile,
					() => dir,
				);
				recorder.record(assistantMessage("before", 1));
				recorder.record({
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "image", data: Buffer.alloc(1500, 1).toString("base64"), mimeType: "image/png" }],
					isError: false,
					timestamp: 1,
				} as AgentMessage);
				recorder.record(assistantMessage("after", 2));
				await recorder.close();

				const entries = await readMessageEntries(transcript);
				const before = entries.find(entry => entry.message?.usage?.input === 1);
				const after = entries.find(entry => entry.message?.usage?.input === 2);
				expect(before).toBeDefined();
				expect(after).toBeDefined();
				// No entry may name a parent that never reached the file.
				const seen = new Set<unknown>();
				for (const entry of entries) {
					if (entry.parentId !== null) expect(seen.has(entry.parentId)).toBe(true);
					seen.add(entry.id);
				}
				expect(entries[0].parentId).toBeNull();
			} finally {
				if (originalAgentDir) {
					setAgentDir(originalAgentDir);
				} else {
					setAgentDir(path.join(getConfigRootDir(), "agent"));
					delete process.env.PI_CODING_AGENT_DIR;
				}
			}
		});
	});

	it("starts the next entry on its own line after a torn final record", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const transcript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			const first = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			first.record(assistantMessage("complete", 1, 0.25));
			await first.close();
			const complete = await readMessageEntries(transcript);
			// A crash mid-append leaves an unterminated fragment.
			await fs.appendFile(transcript, '{"type":"message","id":"torn');

			const second = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			second.record(assistantMessage("after crash", 2, 0.5));
			await second.close();

			const lines = (await Bun.file(transcript).text()).trimEnd().split("\n");
			const parseable = lines.flatMap(line => {
				try {
					return [JSON.parse(line) as AdvisorEntry];
				} catch {
					return [];
				}
			});
			// Slot + header + first entry + new entry parse; only the fragment is skipped.
			expect(lines).toHaveLength(parseable.length + 1);
			const last = parseable.at(-1);
			expect(last?.message?.usage?.input).toBe(2);
			expect(last?.parentId).toBe(complete[0].id);
			expect((await loadAdvisorTranscriptCosts(sessionFile)).get("")).toBeCloseTo(0.75, 8);
		});
	});

	it("leaves a transcript without a valid session header untouched", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const transcript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			await fs.mkdir(path.dirname(transcript), { recursive: true });
			const foreign = '{"not":"a session header"}\n';
			await Bun.write(transcript, foreign);
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("must not land", 1, 0.25));
			await recorder.flush();
			await recorder.close();

			expect(await Bun.file(transcript).text()).toBe(foreign);
		});
	});

	it.skipIf(process.platform === "win32")(
		"retries lines it could not append, in order, and rejects flush while the transcript is unwritable",
		async () => {
			await withTempDir(async dir => {
				const sessionFile = path.join(dir, "sess.jsonl");
				const transcript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
				const recorder = new AdvisorTranscriptRecorder(
					() => sessionFile,
					() => dir,
				);
				recorder.record(assistantMessage("first", 1));
				await recorder.flush();

				// A directory at the transcript path makes the writer's re-open fail.
				const parked = `${transcript}.parked`;
				await fs.rename(transcript, parked);
				await fs.mkdir(transcript);
				recorder.record(assistantMessage("second", 2));
				await expect(recorder.flush()).rejects.toThrow();

				await fs.rmdir(transcript);
				await fs.rename(parked, transcript);
				recorder.record(assistantMessage("third", 3));
				await recorder.close();

				const entries = await readMessageEntries(transcript);
				expect(entries.map(entry => entry.message?.usage?.input)).toEqual([1, 2, 3]);
				expect(entries[1].parentId).toBe(entries[0].id);
				expect(entries[2].parentId).toBe(entries[1].id);
			});
		},
	);

	it("does not duplicate an entry whose bytes landed before the append reported failure", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const transcript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			const realOpenWriter = FileSessionStorage.prototype.openWriter;
			let injected = false;
			const spy = spyOn(FileSessionStorage.prototype, "openWriter").mockImplementation(function (
				this: FileSessionStorage,
				...args: Parameters<FileSessionStorage["openWriter"]>
			) {
				const writer = realOpenWriter.apply(this, args);
				const realAppend = writer.append.bind(writer);
				writer.append = async (line: string) => {
					await realAppend(line);
					if (!injected && line.includes('"type":"message"')) {
						injected = true;
						throw new Error("injected post-write failure");
					}
				};
				return writer;
			});
			try {
				const recorder = new AdvisorTranscriptRecorder(
					() => sessionFile,
					() => dir,
				);
				// Multibyte text: UTF-8 byte length differs from UTF-16 string length.
				recorder.record(assistantMessage("первый ответ — 日本語 😀", 1, 0.25));
				await recorder.flush();
				recorder.record(assistantMessage("second", 2, 0.5));
				await recorder.close();

				expect(injected).toBe(true);
				const entries = await readMessageEntries(transcript);
				expect(entries).toHaveLength(2);
				expect(new Set(entries.map(entry => entry.id)).size).toBe(2);
				expect(entries[1].parentId).toBe(entries[0].id);
				expect((await loadAdvisorTranscriptCosts(sessionFile)).get("")).toBeCloseTo(0.75, 8);
			} finally {
				spy.mockRestore();
			}
		});
	});
});
