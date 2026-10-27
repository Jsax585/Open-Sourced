import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	AnnotationDraftStore,
	annotationDraftKey,
	hasAnnotationDraftsSync,
	type AnnotationDraftRecord,
	type AnnotationDraftSource,
} from "../../../src/extensibility/custom-commands/bundled/annotate/draft-store";

function textSource(text: string, id = "prompt"): AnnotationDraftSource {
	return {
		kind: "text",
		cwd: "/workspace/project",
		source: { id, kind: "prompt", label: "Prompt", text, provenance: { kind: "prompt" } },
	};
}

function record(
	sessionId: string,
	source: AnnotationDraftSource,
	state?: AnnotationDraftRecord["state"],
): AnnotationDraftRecord {
	const now = Date.now();
	return {
		version: 1,
		sessionId,
		key: annotationDraftKey(source),
		createdAt: now,
		updatedAt: now,
		source,
		state: state ?? {
			kind: "text",
			annotations: [],
			editor: { sourceIndex: -1, scope: "text", text: "unfinished note" },
		},
	};
}

describe("AnnotationDraftStore", () => {
	it("recovers source-isolated snapshots and matches edited effective text", async () => {
		using tempDir = TempDir.createSync("@pi-annotation-draft-store-");
		const original = textSource("alpha\nbeta");
		const edited = record("session-a", original, {
			kind: "text",
			annotations: [{ sourceIndex: 1, annotation: { scope: "line", line: 2, quote: "changed", note: "keep this" } }],
			editedText: "alpha\nchanged",
		});
		const otherPrompt = record("session-a", textSource("different text"));
		const store = await AnnotationDraftStore.open(tempDir.path(), "session-a");
		await store.claim(edited.key);
		store.checkpoint(edited);
		await store.flush();
		await store.dispose();

		const reopened = await AnnotationDraftStore.open(tempDir.path(), "session-a");
		expect(reopened.list().map(item => item.key)).toEqual([edited.key]);
		expect(reopened.find(textSource("alpha\nchanged"))?.state).toEqual(edited.state);
		expect(reopened.find(otherPrompt.source)).toBeUndefined();
		await reopened.dispose();
	});

	it("isolates sessions sharing an artifacts root and refuses a second active claim", async () => {
		using tempDir = TempDir.createSync("@pi-annotation-draft-isolation-");
		const source = textSource("same source");
		const saved = record("owner-a", source);
		const first = await AnnotationDraftStore.open(tempDir.path(), "owner-a");
		const contender = await AnnotationDraftStore.open(tempDir.path(), "owner-a");
		const otherSession = await AnnotationDraftStore.open(tempDir.path(), "owner-b");
		await first.claim(saved.key);
		first.checkpoint(saved);
		await first.flush();
		await expect(contender.claim(saved.key)).rejects.toThrow();
		await contender.dispose();
		await otherSession.dispose();
		await first.dispose();

		const ownerA = await AnnotationDraftStore.open(tempDir.path(), "owner-a");
		const ownerB = await AnnotationDraftStore.open(tempDir.path(), "owner-b");
		expect(ownerA.list()).toHaveLength(1);
		expect(ownerB.list()).toHaveLength(0);
		await ownerA.dispose();
		await ownerB.dispose();
	});

	it("retains unreadable drafts until explicit discard and keeps valid siblings", async () => {
		using tempDir = TempDir.createSync("@pi-annotation-draft-invalid-");
		const source = textSource("valid sibling");
		const saved = record("session-a", source);
		const valid = await AnnotationDraftStore.open(tempDir.path(), "session-a");
		await valid.claim(saved.key);
		valid.checkpoint(saved);
		await valid.flush();
		await valid.dispose();

		const invalidKey = "a".repeat(64);
		const invalidDirectory = path.join(tempDir.path(), "annotation-drafts", "sessions", "session-a");
		await fs.writeFile(path.join(invalidDirectory, `draft-${invalidKey}.json`), "not-json");
		expect(hasAnnotationDraftsSync(tempDir.path(), "session-a")).toBe(true);
		const store = await AnnotationDraftStore.open(tempDir.path(), "session-a");
		expect(store.list()).toHaveLength(1);
		expect(store.listInvalid().map(item => item.key)).toEqual([invalidKey]);
		await expect(store.claim(invalidKey)).rejects.toThrow();
		await store.discard(invalidKey);
		expect(store.listInvalid()).toHaveLength(0);
		expect(store.list()).toHaveLength(1);
		expect(
			await fs.stat(path.join(invalidDirectory, `draft-${invalidKey}.json`)).catch(() => undefined),
		).toBeUndefined();
		await store.dispose();
	});

	it("compares revisions before removal and retries snapshots on explicit flush", async () => {
		using tempDir = TempDir.createSync("@pi-annotation-draft-revision-");
		const source = textSource("CAS source");
		const saved = record("session-a", source);
		const store = await AnnotationDraftStore.open(tempDir.path(), "session-a");
		await store.claim(saved.key);
		store.checkpoint(saved);
		await store.flush();
		const revision = store.revision(saved.key);
		expect(revision).toBeDefined();
		expect(await store.remove(saved.key, "0".repeat(64))).toBe(false);
		expect(hasAnnotationDraftsSync(tempDir.path(), "session-a")).toBe(true);
		expect(await store.remove(saved.key, revision!)).toBe(true);
		expect(hasAnnotationDraftsSync(tempDir.path(), "session-a")).toBe(false);
		await store.dispose();
	});
	it("validates CRLF and bare-CR line anchors using overlay line splitting", async () => {
		using tempDir = TempDir.createSync("@pi-annotation-draft-newlines-");
		const source = textSource("first\r\nsecond\rthird");
		const saved = record("session-a", source, {
			kind: "text",
			annotations: [
				{ sourceIndex: 1, annotation: { scope: "line", line: 2, quote: "second", note: "CRLF" } },
				{ sourceIndex: 2, annotation: { scope: "line", line: 3, quote: "third", note: "bare CR" } },
			],
		});
		const store = await AnnotationDraftStore.open(tempDir.path(), "session-a");
		await store.claim(saved.key);
		store.checkpoint(saved);
		await store.flush();
		await store.dispose();
		const reopened = await AnnotationDraftStore.open(tempDir.path(), "session-a");
		expect(reopened.list()).toHaveLength(1);
		expect(reopened.listInvalid()).toHaveLength(0);
		await reopened.dispose();
	});

	it("reports failed atomic writes from flush and retries the retained snapshot", async () => {
		using tempDir = TempDir.createSync("@pi-annotation-draft-write-retry-");
		const saved = record("session-a", textSource("retry"));
		const directory = path.join(tempDir.path(), "annotation-drafts", "sessions", "session-a");
		await fs.mkdir(directory, { recursive: true });
		const target = path.join(directory, `draft-${saved.key}.json`);
		const store = await AnnotationDraftStore.open(tempDir.path(), "session-a");
		await store.claim(saved.key);
		await fs.mkdir(target);
		store.checkpoint(saved);
		await expect(store.flush()).rejects.toThrow();
		await fs.rmdir(target);
		await store.flush();
		await store.dispose();
		const reopened = await AnnotationDraftStore.open(tempDir.path(), "session-a");
		expect(reopened.list()).toHaveLength(1);
		expect(reopened.list()[0]?.state).toEqual(saved.state);
		await reopened.dispose();
	});

	it("prevents a stale memory store from removing a newer claim", async () => {
		const source = textSource("memory revision");
		const saved = record("memory-owner", source);
		const oldStore = await AnnotationDraftStore.open(null, "memory-owner");
		await oldStore.claim(saved.key);
		oldStore.checkpoint(saved);
		const oldRevision = oldStore.revision(saved.key)!;
		await oldStore.dispose();

		const currentStore = await AnnotationDraftStore.open(null, "memory-owner");
		await currentStore.claim(saved.key);
		const newer = { ...saved, updatedAt: saved.updatedAt + 1 };
		currentStore.checkpoint(newer);
		await expect(oldStore.remove(saved.key, oldRevision)).rejects.toThrow("already open");
		const contender = await AnnotationDraftStore.open(null, "memory-owner");
		await expect(contender.claim(saved.key)).rejects.toThrow("already open");
		await contender.dispose();
		expect(currentStore.find(source)).toEqual(newer);
		await currentStore.dispose();
		expect(await oldStore.remove(saved.key, oldRevision)).toBe(false);
		const latest = await AnnotationDraftStore.open(null, "memory-owner");
		expect(latest.find(source)).toEqual(newer);
		expect(await latest.remove(saved.key, latest.revision(saved.key)!)).toBe(true);
		expect(latest.find(source)).toBeUndefined();
		await latest.dispose();
	});

	it("keeps null-artifacts sessions in process memory only", async () => {
		const source = textSource("memory only");
		const saved = record("ephemeral", source);
		const first = await AnnotationDraftStore.open(null, "ephemeral");
		await first.claim(saved.key);
		first.checkpoint(saved);
		await first.dispose();
		const reopened = await AnnotationDraftStore.open(null, "ephemeral");
		expect(reopened.find(source)).toEqual(saved);
		// Management discard acquires its own lease without mounting an overlay.
		await reopened.discard(saved.key);
		await reopened.dispose();
	});
});
