/**
 * Turns keep reaching the journal while full rewrites fail (a full disk or a
 * read-only directory where O_APPEND still works), and an entry that missed
 * the journal is restored by appending it before its successors, never by a
 * republish that cannot succeed. Every test reopens the session, because a
 * restart sees only what the journal holds.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorageWriteOptions,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Fails full-journal publishes on demand and can park the next atomic one; appends are untouched. */
class ControlledRewriteStorage extends FileSessionStorage {
	/** Every full rewrite fails while set. */
	failRewrites = false;
	/** The next full rewrite fails. */
	failNextRewrite = false;
	#parked: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;

	/** Park the next atomic publish until `release()`; `started` resolves once it waits. */
	parkNextAtomicRewrite(): { started: Promise<void>; release: () => void } {
		const parked = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
		this.#parked = parked;
		return { started: parked.started.promise, release: () => parked.release.resolve() };
	}

	#rewriteFailure(): Error | undefined {
		if (this.failNextRewrite) {
			this.failNextRewrite = false;
			return new Error("EROFS: synthetic full rewrite failure");
		}
		return this.failRewrites ? new Error("EROFS: synthetic full rewrite failure") : undefined;
	}

	override writeLinesSync(fpath: string, lines: Iterable<string>, options?: SessionStorageWriteOptions): void {
		const failure = this.#rewriteFailure();
		if (failure) throw failure;
		super.writeLinesSync(fpath, lines, options);
	}

	override async writeLinesAtomic(
		fpath: string,
		lines: Iterable<string>,
		options?: WriteTextAtomicOptions,
	): Promise<void> {
		const parked = this.#parked;
		if (parked) {
			this.#parked = undefined;
			parked.started.resolve();
			await parked.release.promise;
		}
		const failure = this.#rewriteFailure();
		if (failure) throw failure;
		await super.writeLinesAtomic(fpath, lines, options);
	}
}

const tempDirs: TempDir[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close().catch(() => undefined);
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function assistantMessage(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

const userTurn = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });
const userTurnsOf = (entries: readonly SessionEntry[]) =>
	entries.flatMap(entry => (entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : []));

/** A file-backed session whose journal holds an assistant turn and the user turn "before". */
async function fileSession(): Promise<{
	storage: ControlledRewriteStorage;
	manager: SessionManager;
	sessionDir: string;
	sessionFile: string;
}> {
	const root = TempDir.createSync("@pi-durable-frontier-");
	tempDirs.push(root);
	const sessionDir = path.join(root.path(), "sessions");
	const storage = new ControlledRewriteStorage();
	const manager = SessionManager.create(root.path(), sessionDir, storage);
	managers.push(manager);
	manager.appendMessage(assistantMessage("seed"));
	manager.appendMessage(userTurn("before"));
	await manager.flush();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	return { storage, manager, sessionDir, sessionFile };
}

async function reopen(sessionFile: string, sessionDir: string): Promise<SessionManager> {
	const reopened = await SessionManager.open(sessionFile, sessionDir, new FileSessionStorage(), {
		suppressBreadcrumb: true,
	});
	managers.push(reopened);
	return reopened;
}

/** Make the next raw file write fail, as a full disk fails an append. */
function failNextFileWrite(): void {
	spyOn(fs, "writeSync").mockImplementationOnce(() => {
		throw Object.assign(new Error("ENOSPC: synthetic append failure"), { code: "ENOSPC" });
	});
}

function firstUserEntry(manager: SessionManager): SessionEntry & { type: "message" } {
	const entry = manager
		.getEntries()
		.find(candidate => candidate.type === "message" && candidate.message.role === "user");
	if (!entry || entry.type !== "message") throw new Error("Expected a user entry");
	return entry;
}

describe("session turns while every full rewrite fails", () => {
	it.each([
		{
			change: "an in-place entry edit followed by rewriteEntries()",
			apply: async (manager: SessionManager) => {
				const entry = firstUserEntry(manager);
				if (entry.message.role !== "user") throw new Error("Expected a user message");
				entry.message.content = "edited in place";
				await manager.rewriteEntries().catch(() => undefined);
			},
		},
		{
			change: "a header change",
			apply: async (manager: SessionManager) => {
				await manager.setTaskPromptCacheKey("task-cache-key").catch(() => undefined);
			},
		},
	])("saves the next turns after $change, reports the failure, and lets flush() resolve", async ({ apply }) => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		storage.failRewrites = true;
		await apply(manager);

		for (const turn of ["t1", "t2", "t3"]) manager.appendMessage(userTurn(turn));

		// Every turn reached the journal, so nothing waits on the failed rewrite.
		await expect(manager.flush()).resolves.toBeUndefined();
		expect(manager.hasPersistenceFailure()).toBe(true);
		const reopened = await reopen(sessionFile, sessionDir);
		expect(userTurnsOf(reopened.getBranch()).slice(-3)).toEqual(["t1", "t2", "t3"]);
	});
});

describe("an entry that missed the journal while full rewrites fail", () => {
	it("is appended before the next turn after a hot append failed once", async () => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		storage.failRewrites = true;
		failNextFileWrite();
		manager.appendMessage(userTurn("missing"));
		manager.appendMessage(userTurn("after"));

		const reopened = await reopen(sessionFile, sessionDir);
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "missing", "after"]);
	});

	it("is appended before the next turn after a fenced append's synchronous rewrite failed", async () => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		const parked = storage.parkNextAtomicRewrite();
		const rewrite = manager.rewriteEntries();
		await parked.started;
		storage.failRewrites = true;
		// The parked maintenance rewrite holds the fence, so this append is
		// persisted only by a synchronous full rewrite, which fails.
		manager.appendMessage(userTurn("fenced"));
		parked.release();
		await rewrite.catch(() => undefined);
		manager.appendMessage(userTurn("after"));

		const reopened = await reopen(sessionFile, sessionDir);
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "fenced", "after"]);
	});

	it("keeps a title change on the branch after its append and fallback rewrite both failed", async () => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		storage.failRewrites = true;
		failNextFileWrite();
		await manager.setSessionName("new title", "user").catch(() => false);
		manager.appendMessage(userTurn("after"));

		const reopened = await reopen(sessionFile, sessionDir);
		const branch = reopened.getBranch();
		expect(userTurnsOf(branch)).toEqual(["before", "after"]);
		const after = branch.findIndex(
			entry => entry.type === "message" && entry.message.role === "user" && entry.message.content === "after",
		);
		expect(branch[after - 1]).toMatchObject({ type: "title_change", title: "new title" });
	});
});

describe("a turn appended after another writer's entries", () => {
	/** A second manager resumes the journal while the first is still live; the first then appends its tail and closes. */
	async function resumedBehindAnotherWriter(storage = new ControlledRewriteStorage()) {
		const first = await fileSession();
		const resumed = await SessionManager.open(first.sessionFile, first.sessionDir, storage, {
			suppressBreadcrumb: true,
		});
		managers.push(resumed);
		first.manager.appendCustomEntry("previous-writer-tail", { n: 1 });
		await first.manager.flush();
		await first.manager.close();
		return { ...first, storage, resumed };
	}

	it("is the leaf a resume restores, and the other writer's entry is kept", async () => {
		const { resumed, sessionDir, sessionFile } = await resumedBehindAnotherWriter();
		resumed.appendMessage(userTurn("latest turn"));
		await resumed.flush();

		const reopened = await reopen(sessionFile, sessionDir);
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "latest turn"]);
		expect(reopened.getBranch().at(-1)).toMatchObject({ type: "message", message: { content: "latest turn" } });
		expect(reopened.getEntries()).toContainEqual(
			expect.objectContaining({ type: "custom", customType: "previous-writer-tail" }),
		);
	});

	it("reaches the journal while every full rewrite fails", async () => {
		const storage = new ControlledRewriteStorage();
		storage.failRewrites = true;
		const { resumed, sessionDir, sessionFile } = await resumedBehindAnotherWriter(storage);
		resumed.appendMessage(userTurn("latest turn"));

		await expect(resumed.flush()).resolves.toBeUndefined();
		const reopened = await reopen(sessionFile, sessionDir);
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "latest turn"]);
	});
});

describe("a durably discarded entry", () => {
	/** A session whose branch ends in an assistant turn to discard and its service-tier child. */
	async function sessionWithDiscardableTurn() {
		const session = await fileSession();
		const discardedId = session.manager.appendMessage(assistantMessage("discarded turn"));
		session.manager.appendServiceTierChange({ openai: "priority" });
		return { ...session, discardedId };
	}

	function expectDiscardSurvivesRestart(branch: readonly SessionEntry[], discardedId: string): void {
		expect(branch.some(entry => entry.id === discardedId)).toBe(false);
		expect(branch.flatMap(entry => (entry.type === "service_tier_change" ? [entry.serviceTier] : []))).toContainEqual(
			{
				openai: "priority",
			},
		);
		expect(userTurnsOf(branch)).toEqual(["before", "after", "after2"]);
	}

	it("stays discarded after its rewrite failed once and storage healed", async () => {
		const { storage, manager, sessionDir, sessionFile, discardedId } = await sessionWithDiscardableTurn();
		storage.failNextRewrite = true;
		await manager.discardEntryDurably(discardedId).catch(() => undefined);
		manager.appendMessage(userTurn("after"));
		manager.appendMessage(userTurn("after2"));

		expectDiscardSurvivesRestart((await reopen(sessionFile, sessionDir)).getBranch(), discardedId);
	});

	it("stays discarded when it was queued behind a parked rewrite and its own publish failed", async () => {
		const { storage, manager, sessionDir, sessionFile, discardedId } = await sessionWithDiscardableTurn();
		const parked = storage.parkNextAtomicRewrite();
		const unrelated = manager.rewriteEntries();
		await parked.started;
		storage.failRewrites = true;
		const discard = manager.discardEntryDurably(discardedId);
		parked.release();
		await unrelated.catch(() => undefined);
		await discard.catch(() => undefined);
		storage.failRewrites = false;
		manager.appendMessage(userTurn("after"));
		manager.appendMessage(userTurn("after2"));

		expectDiscardSurvivesRestart((await reopen(sessionFile, sessionDir)).getBranch(), discardedId);
	});
});
