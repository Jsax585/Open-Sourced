import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionFormatEvent } from "@deepseek-ai/dsh-session-format";
import { currentSessionMessageProjections } from "@deepseek-ai/dsh-session-format-catalog/message-projections";
import { deriveEventMessage, foldSurface } from "@deepseek-ai/dsh-session/surface";
import { interpretDeepSeekEvents } from "../src/session/deepseek-compat";
import { DeepSeekSessionStore } from "../src/session/deepseek-session-store";
import { persistForeignSession } from "../src/session/foreign-session-import";
import type { ForeignSessionInfo } from "../src/session/foreign-session-store";
import { buildSessionContext } from "../src/session/session-context";
import { SessionManager } from "../src/session/session-manager";
import { FileSessionStorage } from "../src/session/session-storage";
import {
	DEEPSEEK_FIXTURE_TIME,
	deepseekEvent,
	deepseekHeader,
	writeDeepSeekDatabase,
	writeDeepSeekLog,
} from "./helpers/deepseek-fixtures";

let root: string;
let originalHome: string | undefined;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-deepseek-store-"));
	originalHome = process.env.DSH_HOME;
	delete process.env.DSH_HOME;
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (originalHome === undefined) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = originalHome;
	await fs.rm(root, { recursive: true, force: true });
});

function user(seq: number, text: string, surfaceOp: unknown = "append"): Record<string, unknown> {
	return deepseekEvent(
		"user/message",
		{
			id: `user-${seq}`,
			role: "user",
			source: { kind: "user" },
			content: [{ type: "text", text }],
		},
		seq,
		surfaceOp,
	);
}

function assistantData(content: Record<string, unknown>[]): Record<string, unknown> {
	return {
		turn: 1,
		step: 1,
		message: {
			id: "assistant-1",
			role: "assistant",
			source: { kind: "model", provider: "fixture-provider", model: "fixture-model" },
			content,
		},
		stream: [],
	};
}

function conversation(
	options: { interrupted?: boolean; error?: boolean; arguments?: string; legacy?: boolean } = {},
): Record<string, unknown>[] {
	const call = {
		type: "tool-call",
		id: "call-1",
		name: "historical_read",
		arguments: options.arguments ?? '{"path":"fixture.txt"}',
	};
	const assistant = assistantData([
		{ type: "reasoning", text: "Read fixture first" },
		{ type: "text", text: "Inspecting fixture" },
		call,
	]);
	assistant.stream = [
		{ type: "text-chunks", time0: DEEPSEEK_FIXTURE_TIME + 4_000, index: 1, dt: [], texts: ["Inspecting fixture"] },
	];
	assistant.usage = { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2, totalTokens: 23 };
	if (options.interrupted) assistant.interrupted = true;
	const content = [{ type: "text", text: options.error ? "fixture denied" : "fixture bytes" }];
	const result = {
		id: "result-1",
		role: options.legacy ? "user" : "tool",
		source: { kind: "tool", callId: "call-1" },
		...(options.legacy ? {} : { toolCallId: "call-1", isError: options.error ?? false }),
		content: options.legacy
			? [{ type: "tool-result", toolCallId: "call-1", content, isError: options.error ?? false }]
			: content,
	};
	return [
		deepseekEvent("turn/start", { turn: 1 }, 0),
		user(1, "Read fixture"),
		deepseekEvent("step/start", { turn: 1, step: 1 }, 2),
		deepseekEvent(
			"request/header",
			{ header: { config: { provider: "fixture-provider", model: "fixture-model" } }, reason: "initial" },
			3,
		),
		deepseekEvent("assistant/message", assistant, 4, "append"),
		deepseekEvent(
			"tool/call",
			{ turn: 1, step: 1, callId: "call-1", name: "historical_read", arguments: call.arguments },
			5,
		),
		deepseekEvent("tool/result", { turn: 1, step: 1, message: result }, 6, "append"),
		deepseekEvent("step/end", { turn: 1, step: 1 }, 7),
		deepseekEvent(
			"turn/end",
			{
				turn: 1,
				reason: options.interrupted ? { kind: "aborted", reason: { kind: "user" } } : { kind: "completed" },
			},
			8,
		),
	];
}

async function selected(store: DeepSeekSessionStore, id: string): Promise<ForeignSessionInfo> {
	const info = (await store.list()).find(item => item.id === id);
	if (!info) throw new Error(`Fixture session ${id} was not discovered`);
	return info;
}

function contextText(manager: SessionManager, transcript = false): string[] {
	return buildSessionContext(manager.getEntries(), undefined, undefined, { transcript }).messages.flatMap(message => {
		if (!("content" in message)) return [];
		if (typeof message.content === "string") return [message.content];
		return message.content.flatMap(block => (block.type === "text" ? [block.text] : []));
	});
}

async function snapshot(directory: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			for (const [name, digest] of Object.entries(await snapshot(file))) result[`${entry.name}/${name}`] = digest;
		} else
			result[entry.name] = new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex");
	}
	return result;
}

async function rawLog(
	id: string,
	events: Record<string, unknown>[],
	version = 4,
	header?: Record<string, unknown>,
): Promise<string> {
	const file = path.join(
		root,
		"sessions",
		"opaque-project",
		id,
		version === 0 ? "session.jsonl" : `session.v${version}.jsonl`,
	);
	await Bun.write(
		file,
		`${[header ?? deepseekHeader(id, root, version), ...events].map(row => JSON.stringify(row)).join("\n")}\n`,
	);
	return file;
}

describe("DeepSeek discovery", () => {
	it("uses recorded header cwd rather than directory encoding and honors DSH_HOME", async () => {
		const cwd = path.join(root, "ambiguous-project.name_with-hyphens");
		await writeDeepSeekLog(root, { id: "header-cwd", cwd, events: [user(0, "Header prompt")] });
		process.env.DSH_HOME = `  ${root}  `;
		const info = await selected(new DeepSeekSessionStore(), "header-cwd");
		expect(info).toMatchObject({ source: "deepseek", cwd });
		expect(info.created.getTime()).toBe(DEEPSEEK_FIXTURE_TIME);
	});

	it("lists compressed logs and archived subagents using canonical SQLite metadata", async () => {
		await writeDeepSeekLog(root, {
			id: "compressed",
			cwd: root,
			compressed: true,
			events: [user(0, "Compressed prompt")],
		});
		const file = await writeDeepSeekDatabase(root, [
			{ id: "archived-child", cwd: root, events: [user(0, "Child prompt")], title: "Archived child" },
		]);
		const db = new Database(file);
		db.run(
			"UPDATE t_sessions SET f_origin = 'subagent', f_parent_session = 'parent', f_delegation_depth = 1, f_archived_at = ?",
			[DEEPSEEK_FIXTURE_TIME],
		);
		db.close();
		const store = new DeepSeekSessionStore(root);
		const infos = await store.list();
		expect(infos.map(info => info.id).sort()).toEqual(["archived-child", "compressed"]);
		expect(infos.find(info => info.id === "archived-child")).toMatchObject({ title: "Archived child", cwd: root });
		const loaded = await store.load(await selected(store, "compressed"));
		expect(contextText(loaded)).toEqual(["Compressed prompt"]);
		await loaded.close();
	});

	it("lists header metadata without parsing corrupt log bodies", async () => {
		const file = await writeDeepSeekLog(root, { id: "metadata-only", cwd: root, events: [user(0, "Preview")] });
		await Bun.write(file, `${await Bun.file(file).text()}${" ".repeat(160 * 1024)}\n{broken\n`);
		const store = new DeepSeekSessionStore(root);
		const info = await selected(store, "metadata-only");
		expect(info.cwd).toBe(root);
		await expect(store.load(info)).rejects.toThrow();
	});

	it("deduplicates IDs in favor of SQLite and never falls back to stale logs after SQL corruption", async () => {
		await writeDeepSeekLog(root, { id: "same-id", cwd: root, events: [user(0, "Stale file")] });
		const file = await writeDeepSeekDatabase(root, [
			{ id: "same-id", cwd: root, events: [user(0, "SQL authority")], title: "SQL title" },
		]);
		const store = new DeepSeekSessionStore(root);
		const infos = await store.list();
		expect(infos.filter(info => info.id === "same-id")).toHaveLength(1);
		const info = await selected(store, "same-id");
		expect(info.title).toBe("SQL title");
		const loaded = await store.load(info);
		expect(contextText(loaded)).toEqual(["SQL authority"]);
		await loaded.close();
		const db = new Database(file);
		db.run("UPDATE t_events SET f_encoding = 'unsupported-binary'");
		db.close();
		await expect(store.load(info)).rejects.toThrow(/encoding/i);
	});

	it("preserves colliding logical IDs in independent explicit roots", async () => {
		const left = path.join(root, "left");
		const right = path.join(root, "right");
		await writeDeepSeekLog(left, { id: "collision", cwd: left, events: [user(0, "Left context")] });
		await writeDeepSeekLog(right, { id: "collision", cwd: right, events: [user(0, "Right context")] });
		const leftStore = new DeepSeekSessionStore(left);
		const rightStore = new DeepSeekSessionStore(right);
		const leftInfo = await selected(leftStore, "collision");
		const rightInfo = await selected(rightStore, "collision");
		expect(leftInfo.path).not.toBe(rightInfo.path);
		const leftSession = await leftStore.load(leftInfo);
		const rightSession = await rightStore.load(rightInfo);
		expect(contextText(leftSession)).toEqual(["Left context"]);
		expect(contextText(rightSession)).toEqual(["Right context"]);
		await leftSession.close();
		await rightSession.close();
	});

	it("discovers the canonical database nested inside sessions/ (live harness layout)", async () => {
		await writeDeepSeekDatabase(path.join(root, "sessions"), [
			{ id: "nested-db", cwd: root, events: [user(0, "Nested database")], title: "Nested title" },
		]);
		await writeDeepSeekLog(root, { id: "file-sibling", cwd: root, events: [user(0, "File sibling")] });
		const store = new DeepSeekSessionStore(root);
		const infos = await store.list();
		expect(infos.map(info => info.id).sort()).toEqual(["file-sibling", "nested-db"]);
		expect(infos.find(info => info.id === "nested-db")).toMatchObject({
			title: "Nested title",
			firstMessage: "Nested database",
		});
		const loaded = await store.load(await selected(store, "nested-db"));
		expect(contextText(loaded)).toEqual(["Nested database"]);
		await loaded.close();
	});
});

describe("DeepSeek released migrations and strict admission", () => {
	it.each([0, 1, 2, 3, 4])("migrates released v%i without modifying physical source records", async version => {
		await writeDeepSeekLog(root, {
			id: `v${version}`,
			cwd: root,
			version,
			events: [
				deepseekEvent("turn/start", { turn: 1 }, 0),
				deepseekEvent("step/start", { turn: 1, step: 1 }, 1),
				user(2, `Version ${version}`),
				deepseekEvent("step/end", { turn: 1, step: 1 }, 3),
				deepseekEvent("turn/end", { turn: 1, reason: { kind: "completed" } }, 4),
			],
		});
		const before = await snapshot(root);
		const store = new DeepSeekSessionStore(root);
		const manager = await store.load(await selected(store, `v${version}`));
		expect(contextText(manager)).toEqual([`Version ${version}`]);
		expect(manager.getSessionFile()).toBeUndefined();
		expect(await snapshot(root)).toEqual(before);
		await manager.close();
	});

	it("repairs live-harness v0 sources carrying summary with non-notice form", async () => {
		const injected = deepseekEvent(
			"user/message",
			{
				id: "injected-1",
				role: "user",
				source: { kind: "plugin", plugin: "dsh-mnemon", form: "instructions", summary: "recall reminder" },
				content: [{ type: "text", text: "Injected memory note" }],
			},
			2,
			"append",
		);
		await writeDeepSeekLog(root, {
			id: "v0-summary",
			cwd: root,
			version: 0,
			events: [
				deepseekEvent("turn/start", { turn: 1 }, 0),
				deepseekEvent("step/start", { turn: 1, step: 1 }, 1),
				injected,
				deepseekEvent("step/end", { turn: 1, step: 1 }, 3),
				deepseekEvent("turn/end", { turn: 1, reason: { kind: "completed" } }, 4),
			],
		});
		const store = new DeepSeekSessionStore(root);
		const manager = await store.load(await selected(store, "v0-summary"));
		expect(contextText(manager)).toEqual(["Injected memory note"]);
		await manager.close();
	});

	it("migrates inherited v1 prefixes with child-owned seed marker and parent evidence", async () => {
		await writeDeepSeekLog(root, {
			id: "parent-v1",
			cwd: root,
			version: 1,
			events: [
				deepseekEvent("turn/start", { turn: 1 }, 0),
				deepseekEvent("step/start", { turn: 1, step: 1 }, 1),
				user(2, "Inherited prompt"),
				deepseekEvent("step/end", { turn: 1, step: 1 }, 3),
				deepseekEvent("turn/end", { turn: 1, reason: { kind: "completed" } }, 4),
			],
		});
		await rawLog(
			"child-v1",
			[
				deepseekEvent("turn/start", { turn: 1 }, 0),
				deepseekEvent("step/start", { turn: 1, step: 1 }, 1),
				user(2, "Inherited prompt"),
				deepseekEvent("session/end-seed", {}, 3),
				user(4, "Child prompt"),
				deepseekEvent("step/end", { turn: 1, step: 1 }, 5),
				deepseekEvent("turn/end", { turn: 1, reason: { kind: "completed" } }, 6),
			],
			1,
			{ ...deepseekHeader("child-v1", root, 1), seedLength: 3, parentSession: "parent-v1" },
		);
		const before = await snapshot(root);
		const store = new DeepSeekSessionStore(root);
		const manager = await store.load(await selected(store, "child-v1"));
		expect(contextText(manager)).toEqual(["Inherited prompt", "Child prompt"]);
		expect(await snapshot(root)).toEqual(before);
		await manager.close();
	});

	it("uses own historical subagent descriptor evidence to migrate parent catalogs", async () => {
		await writeDeepSeekLog(root, { id: "catalog-parent", cwd: root, version: 3, events: [user(0, "Parent prompt")] });
		await rawLog(
			"catalog-child",
			[
				user(0, "Parent prompt"),
				deepseekEvent("session/end-seed", { inherited: true }, 1),
				deepseekEvent(
					"subagent/descriptor",
					{ mode: "continuable", version: 3, provider: "fixture-provider", label: "Fixture child" },
					2,
				),
			],
			3,
			{
				...deepseekHeader("catalog-child", root, 3),
				isSeeded: true,
				parentSession: "catalog-parent",
				origin: "subagent",
				delegationDepth: 1,
			},
		);
		const before = await snapshot(root);
		const store = new DeepSeekSessionStore(root);
		const parent = await store.load(await selected(store, "catalog-parent"));
		expect(
			parent.getEntries().find(entry => entry.type === "custom" && entry.customType === "deepseek_import"),
		).toMatchObject({ data: { storedVersion: 3, migratedVersion: 4 } });
		expect(contextText(parent)).toEqual(["Parent prompt"]);
		const child = await store.load(await selected(store, "catalog-child"));
		expect(
			child.getEntries().find(entry => entry.type === "custom" && entry.customType === "deepseek_import"),
		).toMatchObject({
			data: { parentSession: "catalog-parent", inheritedEventCount: 1, origin: "subagent", delegationDepth: 1 },
		});
		expect(await snapshot(root)).toEqual(before);
		await parent.close();
		await child.close();
	});

	it.each([
		{ id: "gap", events: [user(1, "Gap")], error: /migration|decode|seq|sequence|gap/i },
		{ id: "unknown", events: [deepseekEvent("unknown/required", {}, 0)], error: /unknown|unsupported|event/i },
		{
			id: "malformed",
			events: [deepseekEvent("user/message", { role: "user", content: "not blocks" }, 0, "append")],
			error: /migration|validation|message|content|source|id/i,
		},
	])("rejects $id instead of silently importing a partial transcript", async ({ id, events, error }) => {
		const file = await rawLog(id, [...events]);
		const info: ForeignSessionInfo = {
			source: "deepseek",
			id,
			path: file,
			cwd: root,
			created: new Date(DEEPSEEK_FIXTURE_TIME),
			modified: new Date(DEEPSEEK_FIXTURE_TIME),
		};
		await expect(new DeepSeekSessionStore(root).load(info)).rejects.toThrow(error);
	});

	it("rejects torn final JSON, future versions, and explicitly selected flat layouts", async () => {
		const store = new DeepSeekSessionStore(root);
		const file = await writeDeepSeekLog(root, { id: "torn", cwd: root, events: [user(0, "Kept prefix")] });
		const info = await selected(store, "torn");
		await Bun.write(file, `${await Bun.file(file).text()}{"type":"user/message"`);
		await expect(store.load(info)).rejects.toThrow(/torn|JSON|record|line/i);
		const future = await rawLog("future", [], 99);
		await expect(store.load({ ...info, id: "future", path: future })).rejects.toThrow(/version|unsupported|format/i);
		const flat = path.join(root, "sessions", "flat.jsonl");
		await Bun.write(flat, `${JSON.stringify(deepseekHeader("flat", root))}\n`);
		await expect(store.load({ ...info, id: "flat", path: flat })).rejects.toThrow(/layout|unsupported/i);
	});

	it("keeps unknown explicitly ignorable bookkeeping inert", async () => {
		await rawLog("ignorable", [
			user(0, "Keep me"),
			{ ...deepseekEvent("fixture/bookkeeping", { arbitrary: true }, 1), ignorable: true },
		]);
		const store = new DeepSeekSessionStore(root);
		const manager = await store.load(await selected(store, "ignorable"));
		expect(contextText(manager)).toEqual(["Keep me"]);
		await manager.close();
	});
});

describe("DeepSeek transcript and continuation", () => {
	it("pairs historical tools once, preserves reasoning and usage, and does not replay settled streams twice", async () => {
		await writeDeepSeekLog(root, { id: "tools", cwd: root, events: conversation({ error: true }) });
		const store = new DeepSeekSessionStore(root);
		const manager = await store.load(await selected(store, "tools"));
		const entries = manager.getEntries().filter(entry => entry.type === "message");
		expect(entries.map(entry => entry.message.role)).toEqual(["user", "assistant", "toolResult"]);
		const assistant = entries.find(entry => entry.message.role === "assistant")?.message;
		if (assistant?.role !== "assistant") throw new Error("Missing assistant");
		expect(assistant.content).toEqual([
			{ type: "thinking", thinking: "Read fixture first" },
			{ type: "text", text: "Inspecting fixture" },
			{ type: "toolCall", id: "call-1", name: "historical_read", arguments: { path: "fixture.txt" } },
		]);
		expect(assistant.usage).toMatchObject({ input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23 });
		expect(assistant.usage.cost.total).toBe(0);
		expect(assistant.provider).toBe("fixture-provider");
		expect(assistant.model).toBe("fixture-model");
		expect(entries.find(entry => entry.message.role === "toolResult")?.message).toMatchObject({
			toolCallId: "call-1",
			toolName: "historical_read",
			isError: true,
			content: [{ type: "text", text: "fixture denied" }],
		});
		expect(contextText(manager, true).filter(text => text === "Inspecting fixture")).toHaveLength(1);
		await manager.close();
	});

	it("uses interruption evidence rather than tool-call presence to mark an aborted assistant", async () => {
		await writeDeepSeekLog(root, { id: "interrupted", cwd: root, events: conversation({ interrupted: true }) });
		const store = new DeepSeekSessionStore(root);
		const manager = await store.load(await selected(store, "interrupted"));
		const assistant = manager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "assistant");
		expect(assistant).toMatchObject({ message: { stopReason: "aborted" } });
		expect(contextText(manager, true)).toContain("Inspecting fixture");
		await manager.close();
	});

	it("imports no-argument tool calls recorded with blank argument strings", async () => {
		await writeDeepSeekLog(root, {
			id: "blank-args",
			cwd: root,
			events: [
				deepseekEvent("turn/start", { turn: 1 }, 0),
				user(1, "List jobs"),
				deepseekEvent("step/start", { turn: 1, step: 1 }, 2),
				deepseekEvent(
					"request/header",
					{ header: { config: { provider: "fixture-provider", model: "fixture-model" } }, reason: "initial" },
					3,
				),
				deepseekEvent(
					"assistant/message",
					{
						turn: 1,
						step: 1,
						message: {
							id: "assistant-blank",
							role: "assistant",
							source: { kind: "model", provider: "fixture-provider", model: "fixture-model" },
							content: [{ type: "tool-call", id: "call-blank", name: "job_list", arguments: "" }],
						},
						stream: [],
					},
					4,
					"append",
				),
				deepseekEvent("tool/call", { turn: 1, step: 1, callId: "call-blank", name: "job_list", arguments: "" }, 5),
				deepseekEvent(
					"tool/result",
					{
						turn: 1,
						step: 1,
						message: {
							id: "result-blank",
							role: "tool",
							toolCallId: "call-blank",
							isError: false,
							source: { kind: "tool", callId: "call-blank" },
							content: [{ type: "text", text: "no queued jobs" }],
						},
					},
					6,
					"append",
				),
				deepseekEvent("step/end", { turn: 1, step: 1 }, 7),
				deepseekEvent("turn/end", { turn: 1, reason: { kind: "completed" } }, 8),
			],
		});
		const store = new DeepSeekSessionStore(root);
		const manager = await store.load(await selected(store, "blank-args"));
		const messages = manager.getEntries().filter(entry => entry.type === "message");
		const assistant = messages.filter(message => message.message.role === "assistant").at(-1)?.message;
		if (assistant?.role !== "assistant") throw new Error("Missing assistant");
		expect(assistant.content).toEqual([{ type: "toolCall", id: "call-blank", name: "job_list", arguments: {} }]);
		await manager.close();
	});

	it("keeps failed durable assistant text and source error status without duplicating its stream", async () => {
		const events = conversation();
		events[8].data = {
			turn: 1,
			reason: { kind: "error", error: { message: "Fixture terminal failure", code: "UNKNOWN" } },
		};
		await writeDeepSeekLog(root, { id: "failed-turn", cwd: root, events });
		const store = new DeepSeekSessionStore(root);
		const manager = await store.load(await selected(store, "failed-turn"));
		expect(
			manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "assistant"),
		).toMatchObject({ message: { stopReason: "error", errorMessage: "Fixture terminal failure" } });
		expect(contextText(manager, true).filter(text => text === "Inspecting fixture")).toHaveLength(1);
		await manager.close();
	});

	it("retains abandoned historical calls for display without inventing a successful result", async () => {
		await writeDeepSeekLog(root, { id: "unfinished-tools", cwd: root, events: conversation().slice(0, 6) });
		const store = new DeepSeekSessionStore(root);
		const manager = await store.load(await selected(store, "unfinished-tools"));
		expect(
			manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "toolResult"),
		).toHaveLength(0);
		expect(contextText(manager, true)).toContain("Inspecting fixture");
		await manager.close();
	});

	it("rejects malformed historical tool arguments rather than inventing executable empty arguments", async () => {
		await writeDeepSeekLog(root, { id: "bad-arguments", cwd: root, events: conversation({ arguments: "{broken" }) });
		const store = new DeepSeekSessionStore(root);
		await expect(store.load(await selected(store, "bad-arguments"))).rejects.toThrow(/argument|JSON/i);
	});

	it("folds arbitrary successive replacements in surface order while retaining append-origin history", async () => {
		const events = [
			user(0, "First old"),
			user(1, "Middle old"),
			user(2, "Last stays"),
			{ ...user(3, "Middle replacement", { op: "replace", startSeq: 1, endSeq: 1 }), sourceEventSeqs: [1] },
			{ ...user(4, "First replacement", { op: "replace", startSeq: 0, endSeq: 0 }), sourceEventSeqs: [0] },
			{ ...user(5, "Middle final", { op: "replace", startSeq: 3, endSeq: 3 }), sourceEventSeqs: [3] },
		];
		const interpreted = interpretDeepSeekEvents(events as unknown as SessionFormatEvent[]).events;
		const fold = foldSurface(interpreted, currentSessionMessageProjections);
		expect(fold.nodes.map(Number)).toEqual([4, 5, 2]);
		const canonical = fold.nodes.flatMap(seq => {
			const message = deriveEventMessage(interpreted[seq], fold.projectedMessages);
			return message?.content.flatMap(block => (block.type === "text" ? [block.text] : [])) ?? [];
		});
		await writeDeepSeekLog(root, { id: "replacements", cwd: root, events });
		const store = new DeepSeekSessionStore(root);
		const manager = await store.load(await selected(store, "replacements"));
		expect(contextText(manager)).toEqual(canonical);
		expect(contextText(manager, true)).toEqual(expect.arrayContaining(["First old", "Middle old", "Last stays"]));
		expect(contextText(manager, true).filter(text => text === "Last stays")).toHaveLength(1);
		await manager.close();
	});

	it("applies pruning replacement without replaying shadowed text or duplicating retained nodes", async () => {
		const events = [
			user(0, "Keep beginning"),
			user(1, "Pruned middle"),
			user(2, "Keep ending"),
			deepseekEvent(
				"compaction/prune",
				{ shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 5 },
				3,
			),
			{ ...user(4, "Pruned context", { op: "replace", startSeq: 1, endSeq: 1 }), sourceEventSeqs: [1] },
		];
		await writeDeepSeekLog(root, { id: "pruned", cwd: root, events });
		const store = new DeepSeekSessionStore(root);
		const manager = await store.load(await selected(store, "pruned"));
		expect(contextText(manager)).toEqual(["Keep beginning", "Pruned context", "Keep ending"]);
		expect(contextText(manager, true)).toContain("Pruned middle");
		expect(contextText(manager, true).filter(text => text === "Keep ending")).toHaveLength(1);
		await manager.close();
	});

	it("keeps historical system authority and developer tool changes outside active context", async () => {
		const events = conversation();
		const prompt = events.splice(1, 1)[0];
		const header = events[2].data as { header: { tools?: unknown[] } };
		header.header.tools = [
			{ name: "source_only_tool", description: "Historical only", parameters: { type: "object", properties: {} } },
		];
		events.splice(
			3,
			0,
			deepseekEvent(
				"system/message",
				{
					turn: 1,
					step: 1,
					message: {
						id: "system-old",
						role: "system",
						source: { kind: "system-prompt" },
						content: [{ type: "text", text: "Source-only system authority" }],
					},
				},
				3,
				"append",
			),
			prompt,
			deepseekEvent(
				"developer/message",
				{
					turn: 1,
					step: 1,
					headerSeq: 2,
					message: {
						id: "developer-old",
						role: "developer",
						source: { kind: "fixture-capabilities" },
						content: [{ type: "tool-addition", toolName: "source_only_tool" }],
					},
				},
				5,
				"append",
			),
			deepseekEvent(
				"developer/message",
				{
					turn: 1,
					step: 1,
					message: {
						id: "developer-remove",
						role: "developer",
						source: { kind: "fixture-capabilities" },
						content: [{ type: "tool-removal", toolName: "source_only_tool" }],
					},
				},
				6,
				"append",
			),
		);
		for (const [seq, event] of events.entries()) {
			event.seq = seq;
			event.time = DEEPSEEK_FIXTURE_TIME + seq * 1_000;
		}
		await writeDeepSeekLog(root, { id: "capabilities", cwd: root, events });
		const store = new DeepSeekSessionStore(root);
		const manager = await store.load(await selected(store, "capabilities"));
		const active = JSON.stringify(buildSessionContext(manager.getEntries()).messages);
		expect(active).not.toContain("Source-only system authority");
		expect(active).not.toContain("source_only_tool");
		const inert = manager.getEntries().filter(entry => entry.type === "custom_message");
		expect(
			inert.some(
				entry =>
					entry.customType === "deepseek_system" && JSON.stringify(entry).includes("Source-only system authority"),
			),
		).toBe(true);
		expect(inert.filter(entry => entry.customType === "deepseek_developer")).toHaveLength(2);
		await manager.close();
	});

	it("renders source compaction summary once and activates replacement summary only once", async () => {
		const events = [
			user(0, "Before compaction"),
			deepseekEvent("compaction/start", { compactionId: "compact-1", turn: null }, 1),
			deepseekEvent(
				"compaction/summary",
				{
					compactionId: "compact-1",
					summary: [{ type: "text", text: "Exact source summary" }],
					shadowedRange: { start: 0, end: 0 },
					shadowedSeqs: [0],
					shadowedTokenCount: 9,
					provider: "fixture-provider",
					model: "fixture-model",
				},
				2,
			),
			{ ...user(3, "Exact source summary", { op: "replace", startSeq: 0, endSeq: 0 }), sourceEventSeqs: [0] },
			deepseekEvent("compaction/end", { compactionId: "compact-1", turn: null }, 4),
			user(5, "After compaction"),
		];
		await writeDeepSeekLog(root, { id: "compacted", cwd: root, events });
		const store = new DeepSeekSessionStore(root);
		const manager = await store.load(await selected(store, "compacted"));
		expect(contextText(manager)).toEqual(["Exact source summary", "After compaction"]);
		const rendered = manager
			.getEntries()
			.flatMap(entry =>
				entry.type === "custom_message" && typeof entry.content === "string" ? [entry.content] : [],
			);
		expect(rendered.filter(content => content === "Exact source summary")).toHaveLength(1);
		expect(contextText(manager, true)).toContain("Before compaction");
		await manager.close();
	});

	it("retains failed attempt streams as inert history without duplicating settled messages", async () => {
		const events = conversation();
		events.splice(
			4,
			0,
			deepseekEvent(
				"assistant/attempt",
				{
					turn: 1,
					step: 1,
					stream: [
						{
							type: "text-chunks",
							time0: DEEPSEEK_FIXTURE_TIME + 3_000,
							index: 0,
							dt: [],
							texts: ["Failed attempt prefix"],
						},
						{
							type: "chunk",
							time: DEEPSEEK_FIXTURE_TIME + 3_001,
							chunk: {
								type: "finish",
								reason: { kind: "error", failure: { message: "Fixture model failed", code: "UNKNOWN" } },
							},
						},
					],
				},
				4,
			),
		);
		for (const [seq, event] of events.entries()) {
			event.seq = seq;
			event.time = DEEPSEEK_FIXTURE_TIME + seq * 1_000;
		}
		await writeDeepSeekLog(root, { id: "attempts", cwd: root, events });
		const store = new DeepSeekSessionStore(root);
		const manager = await store.load(await selected(store, "attempts"));
		expect(contextText(manager)).not.toContain("Failed attempt prefix");
		const attempts = manager
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === "deepseek_attempt");
		expect(attempts).toHaveLength(1);
		expect(attempts[0]).toMatchObject({ content: "Failed attempt prefix\nAttempt status: error" });
		expect(contextText(manager, true).filter(text => text === "Inspecting fixture")).toHaveLength(1);
		await manager.close();
	});

	it("adopts backend legacy nested tool roles and repairs replacement provenance without source writes", async () => {
		const events = conversation({ legacy: true });
		const replacement = user(events.length, "Replacement prompt", { op: "replace", startSeq: 1, endSeq: 1 });
		events.push(replacement);
		const beforeEvents = structuredClone(events);
		const direct = events as unknown as SessionFormatEvent[];
		expect(() =>
			foldSurface(direct as unknown as Parameters<typeof foldSurface>[0], currentSessionMessageProjections),
		).toThrow();
		const repaired = interpretDeepSeekEvents(direct);
		expect(repaired.repairs).not.toEqual({});
		expect(events).toEqual(beforeEvents);
		expect(repaired.events.find(event => event.type === "tool/result")?.data).toMatchObject({
			message: { role: "tool", toolCallId: "call-1" },
		});
		await writeDeepSeekDatabase(root, [{ id: "legacy-backend", cwd: root, events }]);
		const before = await snapshot(root);
		const store = new DeepSeekSessionStore(root);
		const manager = await store.load(await selected(store, "legacy-backend"));
		expect(
			manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "toolResult"),
		).toHaveLength(1);
		expect(contextText(manager)).toContain("Replacement prompt");
		expect(contextText(manager)).not.toContain("Read fixture");
		expect(await snapshot(root)).toEqual(before);
		await manager.close();
	});

	it("reopens a fresh native identity with lossless context, provenance and historical usage counted once", async () => {
		const events = conversation();
		events.push({
			...user(events.length, "Updated user", { op: "replace", startSeq: 1, endSeq: 1 }),
			sourceEventSeqs: [1],
		});
		await writeDeepSeekLog(root, { id: "native-copy", cwd: root, events });
		const store = new DeepSeekSessionStore(root);
		const info = await selected(store, "native-copy");
		const before = await snapshot(root);
		const sessionDir = path.join(root, "native");
		const persisted = await persistForeignSession(store, info, { sessionDir, suppressBreadcrumb: true });
		const file = persisted.getSessionFile();
		if (!file) throw new Error("Native copy not published");
		const expected = buildSessionContext(persisted.getEntries()).messages;
		const usageBefore = persisted
			.getEntries()
			.flatMap(entry =>
				entry.type === "message" && entry.message.role === "assistant" ? [entry.message.usage.totalTokens] : [],
			);
		expect(usageBefore).toEqual([23]);
		await persisted.close();
		const reopened = await SessionManager.open(file, sessionDir, new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		try {
			expect(reopened.getSessionId()).not.toBe(info.id);
			expect(buildSessionContext(reopened.getEntries()).messages).toEqual(expected);
			expect(
				reopened
					.getEntries()
					.find(entry => entry.type === "custom" && entry.customType === "foreign_session_import"),
			).toMatchObject({ data: { source: "deepseek", sourceId: info.id, sourcePath: info.path } });
			expect(
				reopened
					.getEntries()
					.flatMap(entry =>
						entry.type === "message" && entry.message.role === "assistant"
							? [entry.message.usage.totalTokens]
							: [],
					),
			).toEqual([23]);
			const after = await snapshot(root);
			for (const [name, digest] of Object.entries(before)) expect(after[name]).toBe(digest);
		} finally {
			await reopened.close();
		}
	});
});

describe("DeepSeek SQLite snapshots", () => {
	it("imports pre-v4 SQLite rows whose seed_length is a legacy text length", async () => {
		await writeDeepSeekDatabase(root, [
			{
				id: "legacy-seed",
				cwd: root,
				version: 0,
				seedLength: 300_903,
				events: [
					deepseekEvent("turn/start", { turn: 1 }, 0),
					deepseekEvent("step/start", { turn: 1, step: 1 }, 1),
					user(2, "Legacy seed prompt"),
					deepseekEvent("step/end", { turn: 1, step: 1 }, 3),
					deepseekEvent("turn/end", { turn: 1, reason: { kind: "completed" } }, 4),
				],
			},
		]);
		const store = new DeepSeekSessionStore(root);
		const loaded = await store.load(await selected(store, "legacy-seed"));
		expect(contextText(loaded)).toEqual(["Legacy seed prompt"]);
		await loaded.close();
	});
	it("uses bridge order, sequence, operation and row time for payload-only and full-envelope rows", async () => {
		const file = await writeDeepSeekDatabase(root, [
			{ id: "bridges", cwd: root, events: [user(0, "First"), user(1, "Second")] },
		]);
		const db = new Database(file);
		const second = user(91, "Second");
		db.run("UPDATE t_events SET f_data = ? WHERE f_event_id = ?", [
			JSON.stringify(user(0, "First").data),
			"bridges:event:0",
		]);
		db.run("UPDATE t_events SET f_data = ?, f_parent_id = 'sibling-event', f_created_at = ? WHERE f_event_id = ?", [
			JSON.stringify(second),
			DEEPSEEK_FIXTURE_TIME + 1_000,
			"bridges:event:1",
		]);
		db.run("UPDATE t_session_events SET f_surface_op = ?", [JSON.stringify("append")]);
		db.close();
		const before = await snapshot(root);
		const store = new DeepSeekSessionStore(root);
		const manager = await store.load(await selected(store, "bridges"));
		expect(contextText(manager)).toEqual(["First", "Second"]);
		expect(
			manager
				.getEntries()
				.filter(entry => entry.type === "message")
				.map(entry => entry.timestamp),
		).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z"]);
		expect(await snapshot(root)).toEqual(before);
		await manager.close();
	});

	it.each(["head", "gap", "encoding", "schema"])(
		"rejects inconsistent SQLite %s without source writes",
		async fault => {
			const file = await writeDeepSeekDatabase(root, [{ id: "invalid-db", cwd: root, events: [user(0, "Prompt")] }]);
			const db = new Database(file);
			const store = new DeepSeekSessionStore(root);
			const info = await selected(store, "invalid-db");
			if (fault === "head") db.run("UPDATE t_sessions SET f_head_event_id = 'missing'");
			if (fault === "gap") db.run("UPDATE t_session_events SET f_sequence = 2");
			if (fault === "encoding") db.run("UPDATE t_events SET f_encoding = 'msgpack'");
			if (fault === "schema") db.exec("PRAGMA user_version = 999");
			db.close();
			const before = await snapshot(root);
			if (fault === "schema") await expect(store.list()).rejects.toThrow(/schema|version|unsupported/i);
			else await expect(store.load(info)).rejects.toThrow();
			expect(await snapshot(root)).toEqual(before);
		},
	);

	it("reads committed WAL-only rows without modifying source directory or sidecars", async () => {
		const file = await writeDeepSeekDatabase(root, [{ id: "wal", cwd: root, events: [user(0, "Before WAL")] }]);
		const writer = new Database(file);
		try {
			writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
			writer.run("UPDATE t_events SET f_data = ?", [JSON.stringify(user(0, "Committed in WAL"))]);
			const before = await snapshot(root);
			const store = new DeepSeekSessionStore(root);
			const manager = await store.load(await selected(store, "wal"));
			expect(contextText(manager)).toEqual(["Committed in WAL"]);
			expect(await snapshot(root)).toEqual(before);
			await manager.close();
		} finally {
			writer.close();
		}
	});

	it("reads committed missing-SHM WAL through a private snapshot without creating source sidecars", async () => {
		const source = path.join(root, "live");
		const detached = path.join(root, "detached");
		const file = await writeDeepSeekDatabase(source, [
			{ id: "missing-shm", cwd: root, events: [user(0, "Old page")] },
		]);
		const writer = new Database(file);
		try {
			writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
			writer.run("UPDATE t_events SET f_data = ?", [JSON.stringify(user(0, "Only committed WAL"))]);
			await fs.mkdir(detached);
			await fs.copyFile(file, path.join(detached, "sessions.sqlite"));
			await fs.copyFile(`${file}-wal`, path.join(detached, "sessions.sqlite-wal"));
			const before = await snapshot(detached);
			const store = new DeepSeekSessionStore(detached);
			const manager = await store.load(await selected(store, "missing-shm"));
			expect(contextText(manager)).toEqual(["Only committed WAL"]);
			await manager.close();
			expect(await snapshot(detached)).toEqual(before);
		} finally {
			writer.close();
		}
	});
});

describe("DeepSeek portable attachments", () => {
	async function attachmentFixture(
		offloaded = false,
	): Promise<{ store: DeepSeekSessionStore; info: ForeignSessionInfo; bytes: Uint8Array; fileBytes: Uint8Array }> {
		const bytes = Uint8Array.from(
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
				"base64",
			),
		);
		const fileBytes = new TextEncoder().encode("portable fixture file\n");
		const imageDigest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		const fileDigest = new Bun.CryptoHasher("sha256").update(fileBytes).digest("hex");
		await Bun.write(path.join(root, "attachments", "v1", "objects", imageDigest.slice(0, 2), imageDigest), bytes);
		await Bun.write(
			path.join(root, "attachments", "v1", "files", fileDigest.slice(0, 2), fileDigest, "fixture.txt"),
			fileBytes,
		);
		const event = user(0, "Read attachments");
		(event.data as Record<string, unknown>).content = [
			{ type: "text", text: "Read attachments" },
			{
				type: "image",
				attachment: {
					attachmentId: `sha256:${imageDigest}`,
					mediaType: "image/png",
					bytes: bytes.length,
					width: 1,
					height: 1,
					name: "fixture.png",
				},
			},
			{
				type: "file",
				attachment: { attachmentId: `sha256:${fileDigest}`, bytes: fileBytes.length, name: "fixture.txt" },
			},
		];
		const events = [event];
		if (offloaded) events.push(deepseekEvent("image/offload", { targets: [{ seq: 0, imageIndexes: [0] }] }, 1));
		await writeDeepSeekLog(root, { id: "attachments", cwd: root, events });
		const store = new DeepSeekSessionStore(root);
		return { store, info: await selected(store, "attachments"), bytes, fileBytes };
	}

	it.each([false, true])(
		"persists image and file bytes independently of source removal (offloaded=%s)",
		async offloaded => {
			const { store, info, bytes, fileBytes } = await attachmentFixture(offloaded);
			const before = await snapshot(root);
			const imported = await store.load(info);
			expect(await snapshot(root)).toEqual(before);
			expect(imported.getSessionFile()).toBeUndefined();
			await imported.close();
			const destination = await fs.mkdtemp(path.join(os.tmpdir(), "omp-deepseek-portable-"));
			try {
				const persisted = await persistForeignSession(store, info, {
					sessionDir: destination,
					suppressBreadcrumb: true,
				});
				const sessionFile = persisted.getSessionFile();
				if (!sessionFile) throw new Error("Missing native session file");
				expect(await snapshot(root)).toEqual(before);
				await persisted.close();
				await fs.rm(root, { recursive: true });
				const reopened = await SessionManager.open(sessionFile, destination, new FileSessionStorage(), {
					suppressBreadcrumb: true,
				});
				try {
					const active = buildSessionContext(reopened.getEntries()).messages;
					const transcript = buildSessionContext(reopened.getEntries(), undefined, undefined, {
						transcript: true,
					}).messages;
					const activeImages = active.flatMap(message =>
						"content" in message && Array.isArray(message.content)
							? message.content.filter(block => block.type === "image")
							: [],
					);
					expect(activeImages).toHaveLength(offloaded ? 0 : 1);
					const transcriptImages = transcript.flatMap(message =>
						"content" in message && Array.isArray(message.content)
							? message.content.filter(block => block.type === "image")
							: [],
					);
					expect(transcriptImages).toHaveLength(1);
					expect(transcriptImages[0]).toMatchObject({
						data: Buffer.from(bytes).toString("base64"),
						mimeType: "image/png",
					});
					expect(JSON.stringify(active)).toContain("artifact://");
					expect(JSON.stringify(active)).not.toContain("deepseek-attachment:");
					const files = await fs.readdir(destination, { recursive: true });
					const artifactContents: string[] = [];
					for (const file of files) {
						const full = path.join(destination, file);
						if ((await fs.stat(full)).isFile())
							artifactContents.push(Buffer.from(await Bun.file(full).arrayBuffer()).toString("base64"));
					}
					expect(artifactContents).toContain(Buffer.from(bytes).toString("base64"));
					expect(artifactContents).toContain(Buffer.from(fileBytes).toString("base64"));
				} finally {
					await reopened.close();
				}
			} finally {
				await fs.rm(destination, { recursive: true, force: true });
			}
		},
	);

	it.each(["missing", "traversal", "digest"])("rejects %s attachment bytes before publication", async fault => {
		const { store, info } = await attachmentFixture();
		if (fault === "missing") await fs.rm(path.join(root, "attachments"), { recursive: true });
		else {
			const rows = (await Bun.file(info.path).text())
				.trimEnd()
				.split("\n")
				.map(line => JSON.parse(line) as Record<string, unknown>);
			const data = rows[1].data as { content: { type: string; attachment?: { attachmentId: string } }[] };
			const image = data.content.find(block => block.type === "image");
			if (!image?.attachment) throw new Error("Missing image fixture");
			if (fault === "traversal") image.attachment.attachmentId = "sha256:../../outside";
			else {
				const digest = image.attachment.attachmentId.slice("sha256:".length);
				await Bun.write(
					path.join(root, "attachments", "v1", "objects", digest.slice(0, 2), digest),
					"wrong digest bytes",
				);
			}
			await Bun.write(info.path, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
		}
		const before = await snapshot(root);
		await expect(store.load(info)).rejects.toThrow(/attachment|digest|sha256|missing|reference/i);
		expect(await snapshot(root)).toEqual(before);
	});

	it("cleans only destination bytes created by a failed copy and keeps current session usable", async () => {
		const { store, info } = await attachmentFixture();
		const destination = path.join(root, "destination");
		await Bun.write(path.join(destination, "unrelated.keep"), "do not remove");
		const current = SessionManager.inMemory(root);
		current.appendMessage({ role: "user", content: "Current session stays", timestamp: DEEPSEEK_FIXTURE_TIME });
		const before = await snapshot(root);
		const allocate = SessionManager.prototype.allocateArtifactPath;
		let allocations = 0;
		vi.spyOn(SessionManager.prototype, "allocateArtifactPath").mockImplementation(async function (
			this: SessionManager,
			...args: Parameters<SessionManager["allocateArtifactPath"]>
		) {
			allocations += 1;
			if (allocations === 2) throw new Error("fixture destination copy failure");
			return allocate.apply(this, args);
		});
		await expect(
			persistForeignSession(store, info, { sessionDir: destination, suppressBreadcrumb: true }),
		).rejects.toThrow(/fixture destination copy failure/);
		expect(contextText(current)).toEqual(["Current session stays"]);
		expect(await snapshot(root)).toEqual(before);
		await current.close();
	});
});
