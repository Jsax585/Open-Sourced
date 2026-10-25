import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getImportedContext } from "@oh-my-pi/pi-agent-core/compaction";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const sourceId = `sha256:${"a".repeat(64)}`;
const sourceReference = `deepseek-attachment:${sourceId}`;
const attachmentBytes = new Uint8Array([0, 255, 13, 10, 128, 65, 0, 240, 159, 167, 160]);
const managers: SessionManager[] = [];
const directories: TempDir[] = [];

function keep(manager: SessionManager): SessionManager {
	managers.push(manager);
	return manager;
}

function tempDir(): TempDir {
	const dir = TempDir.createSync("@deepseek-staging-");
	directories.push(dir);
	return dir;
}

afterEach(async () => {
	for (const manager of new Set(managers.splice(0))) await manager.close();
	await Promise.all(directories.splice(0).map(dir => dir.remove()));
});

function detached(cwd: string) {
	const manager = keep(SessionManager.inMemory(cwd));
	const historical = manager.appendMessage({ role: "user", content: sourceReference, timestamp: 1 });
	const boundary = manager.appendCompaction("DeepSeek import", undefined, "", 0, {
		preserveData: {
			importedContext: {
				version: 1,
				messages: [{ role: "user", content: sourceReference, timestamp: 2 }],
			},
		},
	});
	const tail = manager.appendMessage({ role: "user", content: "native tail", timestamp: 3 });
	return { manager, historical, boundary, tail };
}

function sessionFile(manager: SessionManager): string {
	const file = manager.getSessionFile();
	if (!file) throw new Error("Expected persisted session path");
	return file;
}

function artifactsDir(manager: SessionManager): string {
	const dir = manager.getArtifactsDir();
	if (!dir) throw new Error("Expected destination artifact storage");
	return dir;
}

function boundaryEntry(manager: SessionManager): CompactionEntry {
	const entry = manager.getEntries().find(entry => entry.type === "compaction");
	if (!entry || entry.type !== "compaction") throw new Error("Expected import boundary");
	return entry;
}

function messageText(message: AgentMessage | undefined): string | undefined {
	if (!message || !("content" in message)) return undefined;
	return typeof message.content === "string" ? message.content : undefined;
}

async function stageAttachment(target: SessionManager): Promise<string> {
	const allocated = await target.allocateArtifactPath("deepseek-attachment");
	if (allocated.id === undefined || !allocated.path) throw new Error("Expected staged artifact path");
	await Bun.write(allocated.path, attachmentBytes);
	const reference = `artifact://${allocated.id}`;
	for (const entry of target.getEntries()) {
		if (entry.type === "message" && entry.message.role === "user" && entry.message.content === sourceReference) {
			entry.message.content = reference;
		}
	}
	const boundary = boundaryEntry(target);
	const context = getImportedContext(boundary.preserveData);
	if (!context) throw new Error("Expected import context");
	for (const message of context.messages) {
		if (message.role === "user" && message.content === sourceReference) message.content = reference;
	}
	boundary.preserveData = {
		...boundary.preserveData,
		importedAttachments: [
			{
				id: allocated.id,
				sourceId,
				kind: "file",
				mediaType: "application/octet-stream",
				size: attachmentBytes.byteLength,
				name: "historical.bin",
			},
		],
	};
	return allocated.id;
}

async function imported(dir: TempDir) {
	const fixture = detached(dir.path());
	let artifactId = "";
	const manager = keep(
		await fixture.manager.persistCopy({
			sessionDir: path.join(dir.path(), "sessions"),
			suppressBreadcrumb: true,
			beforePublish: async (_source, target) => {
				artifactId = await stageAttachment(target);
			},
		}),
	);
	return { ...fixture, manager, artifactId };
}

const guardedNavigation: Array<{ name: string; run: (manager: SessionManager, historical: string) => unknown }> = [
	{ name: "branch", run: (manager, historical) => manager.branch(historical) },
	{ name: "branchWithSummary", run: (manager, historical) => manager.branchWithSummary(historical, "abandoned") },
	{ name: "root branchWithSummary", run: manager => manager.branchWithSummary(null, "abandoned") },
	{ name: "resetLeaf", run: manager => manager.resetLeaf() },
	{ name: "createBranchedSession", run: (manager, historical) => manager.createBranchedSession(historical) },
	{
		name: "appendMessageToBranch",
		run: (manager, historical) =>
			manager.appendMessageToBranch({ role: "user", content: "must not append", timestamp: 4 }, historical),
	},
	{
		name: "root appendMessageToBranch",
		run: manager => manager.appendMessageToBranch({ role: "user", content: "must not append", timestamp: 4 }, null),
	},
];

function expectHistoricalNavigationBlocked(manager: SessionManager, historical: string): void {
	const state = structuredClone(manager.captureState());
	const leaf = manager.getLeafId();
	for (const action of guardedNavigation) {
		expect(() => action.run(manager, historical)).toThrow(/before the import boundary/);
		expect(manager.captureState()).toEqual(state);
		expect(manager.getLeafId()).toBe(leaf);
	}
}

class FailingPublishStorage extends FileSessionStorage {
	override async writeTextAtomic(_file: string, _content: string, _options?: WriteTextAtomicOptions): Promise<void> {
		throw new Error("destination publish failed");
	}
}

class ConflictingPublishStorage extends FileSessionStorage {
	readonly unrelated = `${JSON.stringify({ type: "session", version: 3, id: "unrelated-session", timestamp: new Date(0).toISOString(), cwd: "/unrelated" })}\n`;

	override async writeTextAtomic(file: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		await Bun.write(file, this.unrelated);
		await super.writeTextAtomic(file, content, options);
	}
}

class OccupiedArtifactStorage extends FileSessionStorage {
	journal = "";

	override async exists(file: string): Promise<boolean> {
		this.journal = file;
		await Bun.write(path.join(file.slice(0, -".jsonl".length), "unrelated.bin"), attachmentBytes);
		return super.exists(file);
	}
}

describe("DeepSeek import destination staging", () => {
	it("publishes hook rewrites under fresh identity without changing detached source or exposing an early journal", async () => {
		const dir = tempDir();
		const source = detached(dir.path());
		const before = structuredClone(source.manager.captureState());
		let artifactId = "";
		let rewrittenHistory = "";
		const copy = keep(
			await source.manager.persistCopy({
				sessionDir: path.join(dir.path(), "sessions"),
				suppressBreadcrumb: true,
				beforePublish: async (original, target) => {
					expect(original).toBe(source.manager);
					expect(target.getSessionId()).not.toBe(original.getSessionId());
					expect(target.getArtifactManager()?.dir).toBe(artifactsDir(target));
					expect(target.getArtifactManager()).not.toBe(original.getArtifactManager());
					expect(await Bun.file(sessionFile(target)).exists()).toBe(false);
					artifactId = await stageAttachment(target);
					const history = target.getEntries().find(entry => entry.id === source.historical);
					if (!history) throw new Error("Expected cloned history");
					rewrittenHistory = `${history.id}-rewritten`;
					history.id = rewrittenHistory;
					boundaryEntry(target).parentId = rewrittenHistory;
					await target.ensureOnDisk();
					expect(await Bun.file(sessionFile(target)).exists()).toBe(false);
				},
			}),
		);
		expect(source.manager.captureState()).toEqual(before);
		expect(copy.getEntry(source.historical)).toBeUndefined();
		expect(copy.getEntry(rewrittenHistory)?.id).toBe(rewrittenHistory);
		const reopened = keep(await SessionManager.open(sessionFile(copy)));
		expect(reopened.buildSessionContext().messages.map(messageText)).toEqual([
			`artifact://${artifactId}`,
			"native tail",
		]);
		expect(messageText(reopened.buildSessionContext({ transcript: true }).messages[0])).toBe(
			`artifact://${artifactId}`,
		);
		const artifact = await reopened.getArtifactPath(artifactId);
		if (!artifact) throw new Error("Expected reopened imported artifact");
		expect(new Uint8Array(await Bun.file(artifact).arrayBuffer())).toEqual(attachmentBytes);
	});

	it("removes partial hook copies without publishing or changing active source identity and journal", async () => {
		const dir = tempDir();
		const source = await imported(dir);
		const before = structuredClone(source.manager.captureState());
		const originalBytes = await Bun.file(sessionFile(source.manager)).text();
		let targetFile = "";
		let targetArtifacts = "";
		await expect(
			source.manager.persistCopy({
				sessionDir: path.join(dir.path(), "sessions"),
				suppressBreadcrumb: true,
				beforePublish: async (_source, target) => {
					targetFile = sessionFile(target);
					targetArtifacts = artifactsDir(target);
					await target.saveArtifact("partially copied", "deepseek-attachment");
					const entry = target.getEntries().find(entry => entry.type === "message");
					if (entry?.type === "message" && entry.message.role === "user") entry.message.content = "target only";
					throw new Error("required attachment copy failed");
				},
			}),
		).rejects.toThrow("required attachment copy failed");
		expect(await Bun.file(targetFile).exists()).toBe(false);
		await expect(fs.stat(targetArtifacts)).rejects.toMatchObject({ code: "ENOENT" });
		expect(source.manager.captureState()).toEqual(before);
		expect(await Bun.file(sessionFile(source.manager)).text()).toBe(originalBytes);
		source.manager.appendMessage({ role: "user", content: "active session still usable", timestamp: 4 });
		await source.manager.flush();
		expect(messageText(source.manager.buildSessionContext().messages.at(-1))).toBe("active session still usable");
	});

	it("removes owned artifacts when journal publication fails, leaving unrelated files and detached source intact", async () => {
		const dir = tempDir();
		const source = detached(dir.path());
		const before = structuredClone(source.manager.captureState());
		const unrelated = path.join(dir.path(), "sessions", "unrelated", "keep.bin");
		await Bun.write(unrelated, attachmentBytes);
		let targetFile = "";
		let targetArtifacts = "";
		await expect(
			source.manager.persistCopy(
				{
					sessionDir: path.join(dir.path(), "sessions"),
					suppressBreadcrumb: true,
					beforePublish: async (_source, target) => {
						targetFile = sessionFile(target);
						targetArtifacts = artifactsDir(target);
						await stageAttachment(target);
					},
				},
				new FailingPublishStorage(),
			),
		).rejects.toThrow("destination publish failed");
		expect(await Bun.file(targetFile).exists()).toBe(false);
		await expect(fs.stat(targetArtifacts)).rejects.toMatchObject({ code: "ENOENT" });
		expect(new Uint8Array(await Bun.file(unrelated).arrayBuffer())).toEqual(attachmentBytes);
		expect(source.manager.captureState()).toEqual(before);
	});

	it("does not adopt or delete unrelated journal created between staging and exclusive publication", async () => {
		const dir = tempDir();
		const source = detached(dir.path());
		const before = structuredClone(source.manager.captureState());
		const storage = new ConflictingPublishStorage();
		let targetFile = "";
		let targetArtifacts = "";
		await expect(
			source.manager.persistCopy(
				{
					sessionDir: path.join(dir.path(), "sessions"),
					suppressBreadcrumb: true,
					beforePublish: async (_source, target) => {
						targetFile = sessionFile(target);
						targetArtifacts = artifactsDir(target);
						await stageAttachment(target);
					},
				},
				storage,
			),
		).rejects.toThrow(/changed before rewrite/);
		expect(await Bun.file(targetFile).text()).toBe(storage.unrelated);
		await expect(fs.stat(targetArtifacts)).rejects.toMatchObject({ code: "ENOENT" });
		expect(source.manager.captureState()).toEqual(before);
		expect((await fs.readdir(path.join(dir.path(), "sessions"))).filter(file => file.endsWith(".jsonl"))).toEqual([
			path.basename(targetFile),
		]);
	});

	it("refuses an occupied artifact destination before hook and preserves storage it did not create", async () => {
		const dir = tempDir();
		const source = detached(dir.path());
		const storage = new OccupiedArtifactStorage();
		let hookCalled = false;
		await expect(
			source.manager.persistCopy(
				{
					sessionDir: path.join(dir.path(), "sessions"),
					suppressBreadcrumb: true,
					beforePublish: async () => {
						hookCalled = true;
					},
				},
				storage,
			),
		).rejects.toMatchObject({ code: "EEXIST" });
		expect(hookCalled).toBe(false);
		expect(await Bun.file(storage.journal).exists()).toBe(false);
		const unrelated = path.join(storage.journal.slice(0, -".jsonl".length), "unrelated.bin");
		expect(new Uint8Array(await Bun.file(unrelated).arrayBuffer())).toEqual(attachmentBytes);
	});
});

describe("DeepSeek import native navigation and required artifacts", () => {
	it("rejects every historical/root navigation without moving active identity, leaf or entries", () => {
		const fixture = detached(tempDir().path());
		expectHistoricalNavigationBlocked(fixture.manager, fixture.historical);
	});

	it.each(["boundary", "tail"] as const)(
		"allows native branches and appends at %s without losing interpreted context",
		position => {
			for (const action of [
				"branch",
				"branchWithSummary",
				"appendMessageToBranch",
				"createBranchedSession",
			] as const) {
				const fixture = detached(tempDir().path());
				const entryId = fixture[position];
				if (action === "branch") fixture.manager.branch(entryId);
				else if (action === "branchWithSummary") fixture.manager.branchWithSummary(entryId, "native summary");
				else if (action === "createBranchedSession") fixture.manager.createBranchedSession(entryId);
				else {
					const leaf = fixture.manager.getLeafId();
					const appended = fixture.manager.appendMessageToBranch(
						{ role: "user", content: "off-branch native turn", timestamp: 4 },
						entryId,
					);
					expect(fixture.manager.getEntry(appended)?.parentId).toBe(entryId);
					expect(fixture.manager.getLeafId()).toBe(leaf);
				}
				expect(fixture.manager.getBranch().some(entry => entry.id === fixture.boundary)).toBe(true);
				expect(JSON.stringify(fixture.manager.buildSessionContext().messages)).toContain(sourceReference);
			}
		},
	);

	it("keeps historical guards after later native compaction, clear and reopen", async () => {
		const dir = tempDir();
		const fixture = await imported(dir);
		fixture.manager.appendCompaction("native summary", undefined, fixture.tail, 10);
		expectHistoricalNavigationBlocked(fixture.manager, fixture.historical);
		fixture.manager.appendResetBoundary();
		expect(fixture.manager.buildSessionContext().messages).toEqual([]);
		expectHistoricalNavigationBlocked(fixture.manager, fixture.historical);
		await fixture.manager.flush();
		const reopened = keep(await SessionManager.open(sessionFile(fixture.manager)));
		expect(reopened.buildSessionContext().messages).toEqual([]);
		expectHistoricalNavigationBlocked(reopened, fixture.historical);
	});

	it.each(["fork", "branch", "forkFrom"] as const)(
		"%s preserves required artifact bytes after original journal and artifacts are removed",
		async operation => {
			const dir = tempDir();
			const fixture = await imported(dir);
			const originalFile = sessionFile(fixture.manager);
			const originalArtifacts = artifactsDir(fixture.manager);
			const expected = fixture.manager.buildSessionContext().messages;
			let copy = fixture.manager;
			if (operation === "fork") await copy.fork();
			else if (operation === "branch") {
				copy.appendMessage({ role: "user", content: "discarded post-boundary tail", timestamp: 4 });
				copy.createBranchedSession(fixture.tail, { copyArtifacts: false });
			} else {
				copy = keep(
					await SessionManager.forkFrom(originalFile, dir.path(), path.join(dir.path(), "sessions"), undefined, {
						copyArtifacts: false,
						suppressBreadcrumb: true,
					}),
				);
			}
			const copiedFile = sessionFile(copy);
			expect(copiedFile).not.toBe(originalFile);
			expect(artifactsDir(copy)).not.toBe(originalArtifacts);
			expect(copy.buildSessionContext().messages).toEqual(expected);
			await copy.close();
			if (copy !== fixture.manager) await fixture.manager.close();
			await fs.rm(originalFile);
			await fs.rm(originalArtifacts, { recursive: true });
			const reopened = keep(await SessionManager.open(copiedFile));
			expect(reopened.buildSessionContext().messages).toEqual(expected);
			const copiedArtifact = await reopened.getArtifactPath(fixture.artifactId);
			if (!copiedArtifact) throw new Error("Expected portable imported artifact");
			expect(new Uint8Array(await Bun.file(copiedArtifact).arrayBuffer())).toEqual(attachmentBytes);
			const newId = await reopened.saveArtifact("new native output", "bash");
			expect(newId).not.toBe(fixture.artifactId);
			expect(new Uint8Array(await Bun.file(copiedArtifact).arrayBuffer())).toEqual(attachmentBytes);
		},
	);

	it.each(["fork", "branch", "forkFrom"] as const)(
		"%s refuses missing required bytes before publishing or changing active identity",
		async operation => {
			const dir = tempDir();
			const fixture = await imported(dir);
			const file = sessionFile(fixture.manager);
			const artifact = await fixture.manager.getArtifactPath(fixture.artifactId);
			if (!artifact) throw new Error("Expected required imported artifact");
			await fs.rm(artifact);
			const state = structuredClone(fixture.manager.captureState());
			const leaf = fixture.manager.getLeafId();
			const originalBytes = await Bun.file(file).text();
			const originalFiles = (await fs.readdir(path.join(dir.path(), "sessions"))).sort();
			if (operation === "fork")
				await expect(fixture.manager.fork()).rejects.toThrow(/required artifact .* unavailable/);
			else if (operation === "branch") {
				expect(() => fixture.manager.createBranchedSession(fixture.tail)).toThrow(
					/required artifact .* unavailable/,
				);
			} else {
				await expect(
					SessionManager.forkFrom(file, dir.path(), path.join(dir.path(), "sessions"), undefined, {
						suppressBreadcrumb: true,
					}),
				).rejects.toThrow(/required artifact .* unavailable/);
			}
			expect(fixture.manager.captureState()).toEqual(state);
			expect(fixture.manager.getLeafId()).toBe(leaf);
			expect(await Bun.file(file).text()).toBe(originalBytes);
			expect((await fs.readdir(path.join(dir.path(), "sessions"))).sort()).toEqual(originalFiles);
		},
	);
});
