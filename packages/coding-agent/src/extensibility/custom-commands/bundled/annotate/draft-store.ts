import type { Dirent } from "node:fs";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type {
	AnnotationOverlayDraft,
	ReviewDiffFile,
	TextReviewSource,
} from "@oh-my-pi/pi-tui/overlays/annotation-types";
import { acquireFileLock, type FileLockHandle, isEnoent, logger, toError } from "@oh-my-pi/pi-utils";
import { acquireSessionArtifactGate } from "../../../../session/session-storage";
import { writeFileAtomically } from "../../../../utils/atomic-file";
import { parseReviewDiffSnapshot } from "../review/diff";
import type { ResolvedReviewTarget } from "../review/target";

export type AnnotationDraftSource =
	| { kind: "text"; cwd: string; source: TextReviewSource }
	| { kind: "diff"; cwd: string; target: ResolvedReviewTarget; focus?: string };

export interface AnnotationDraftRecord {
	version: 1;
	sessionId: string;
	key: string;
	createdAt: number;
	updatedAt: number;
	source: AnnotationDraftSource;
	state: AnnotationOverlayDraft;
}

export interface InvalidAnnotationDraft {
	key: string;
	filename: string;
	error: string;
}

const FILE_PATTERN = /^draft-([0-9a-f]{64})\.json$/;
const MEMORY_RECORDS = new Map<string, Map<string, string>>();
const MEMORY_CLAIMS = new Map<string, Map<string, AnnotationDraftStore>>();
let warnedMemoryOnly = false;

function hash(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function sessionSegment(sessionId: string): string {
	return /^[\w-]+$/.test(sessionId) ? sessionId : hash(sessionId);
}

function textProvenance(source: TextReviewSource): unknown {
	const provenance = source.provenance;
	if (!provenance) return null;
	switch (provenance.kind) {
		case "file":
			return ["file", path.resolve(provenance.path)];
		case "prompt":
			return ["prompt"];
		default:
			return [provenance.kind, provenance.entryId];
	}
}

function sourceTuple(source: AnnotationDraftSource): unknown[] {
	if (source.kind === "text") {
		const { source: text } = source;
		return ["text", source.cwd, text.kind, text.id, textProvenance(text), text.text];
	}
	const { target } = source;
	const tuple = [
		"diff",
		source.cwd,
		target.kind,
		target.mode,
		target.rawDiff,
		target.emptyMessage,
		target.filteredMessage ?? null,
		target.diffInstruction ?? null,
		target.contextInstruction ?? null,
		target.prDiffUrl ?? null,
		source.focus ?? null,
	];
	if (target.prDiffQuery !== undefined) tuple.push(target.prDiffQuery);
	return tuple;
}

export function annotationDraftKey(source: AnnotationDraftSource): string {
	return hash(JSON.stringify(sourceTuple(source)));
}

function recordDirectory(artifactsDir: string, sessionId: string): string {
	return path.join(artifactsDir, "annotation-drafts", "sessions", sessionSegment(sessionId));
}

async function ensurePrivateDirectory(artifactsDir: string, sessionId: string): Promise<string> {
	const root = path.join(artifactsDir, "annotation-drafts");
	const sessions = path.join(root, "sessions");
	const directory = path.join(sessions, sessionSegment(sessionId));
	for (const part of [root, sessions, directory]) {
		await fs.mkdir(part, { recursive: true, mode: 0o700 });
		if (process.platform !== "win32") await fs.chmod(part, 0o700);
	}
	return directory;
}

function recordPath(artifactsDir: string, sessionId: string, key: string): string {
	return path.join(recordDirectory(artifactsDir, sessionId), `draft-${key}.json`);
}

const schemas = type
	.scope({
		nonnegative: type("number >= 0").narrow(Number.isFinite),
		provenance: "provEntry | provFile | provPrompt",
		provEntry: { kind: "'latest-assistant' | 'session'", entryId: "string" },
		provFile: { kind: "'file'", path: "string" },
		provPrompt: { kind: "'prompt'" },
		textSource: {
			id: "string",
			kind: "'message' | 'code' | 'quote' | 'command' | 'file' | 'prompt'",
			label: "string",
			text: "string",
			"provenance?": "provenance",
			"sessionId?": "string",
		},
		source: [
			{ kind: "'text'", cwd: "string", source: "textSource" },
			"|",
			{
				kind: "'diff'",
				cwd: "string",
				"focus?": "string",
				target: {
					kind: "'base-branch' | 'uncommitted' | 'commit' | 'pr' | 'patch'",
					mode: "string",
					rawDiff: "string",
					snapshot: "unknown",
					emptyMessage: "string",
					"filteredMessage?": "string",
					"diffInstruction?": "string",
					"contextInstruction?": "string",
					"prDiffUrl?": "string",
					"prDiffQuery?": "string",
				},
			},
		],
		textAnnotation: [
			{ scope: "'text'", note: "string" },
			"|",
			{ scope: "'line'", line: "number.integer >= 1", quote: "string", note: "string" },
		],
		codeAnnotation: [
			{
				scope: "'file'",
				path: "string",
				"oldPath?": "string",
				"newPath?": "string",
				occurrence: "nonnegative",
				note: "string",
			},
			"|",
			{
				scope: "'line'",
				path: "string",
				"oldPath?": "string",
				"newPath?": "string",
				occurrence: "nonnegative",
				note: "string",
				hunkHeader: "string",
				rawLine: "string",
				"oldLine?": "nonnegative",
				"newLine?": "nonnegative",
			},
		],
		textEntry: { sourceIndex: "number.integer", annotation: "textAnnotation" },
		diffEntry: {
			fileIndex: "number.integer",
			sourceIndex: "number.integer",
			annotation: "codeAnnotation",
		},
		textState: {
			kind: "'text'",
			annotations: "textEntry[]",
			"editedText?": "string",
			"editor?": {
				sourceIndex: "number.integer",
				scope: "'text' | 'line'",
				"editingAnnotationIndex?": "number.integer >= 0",
				text: "string",
			},
		},
		diffState: {
			kind: "'diff'",
			annotations: "diffEntry[]",
			"editor?": {
				fileIndex: "number.integer",
				sourceIndex: "number.integer",
				scope: "'file' | 'line'",
				"editingAnnotationIndex?": "number.integer >= 0",
				text: "string",
			},
		},
		record: {
			version: "1",
			sessionId: "string",
			key: "string",
			createdAt: "nonnegative",
			updatedAt: "nonnegative",
			source: "source",
			state: "textState | diffState",
		},
	})
	.export();
const recordSchema = schemas.record.onDeepUndeclaredKey("reject");

function diffSourceRows(file: ReviewDiffFile) {
	return file.isBinary
		? []
		: file.rows.filter(row => row.kind === "context" || row.kind === "added" || row.kind === "removed");
}

function validateRecord(value: unknown, sessionId: string, filenameKey: string): AnnotationDraftRecord {
	const record = recordSchema.assert(value) as AnnotationDraftRecord;
	const { source, state } = record;
	if (record.sessionId !== sessionId || record.key !== filenameKey) throw new Error("Invalid annotation draft header");
	if (record.updatedAt < record.createdAt) throw new Error("Invalid annotation draft metadata");
	if (source.kind === "text" && state.kind === "text") {
		const lines = (state.editedText ?? source.source.text).split(/\r\n|\n|\r/);
		for (const { sourceIndex, annotation } of state.annotations) {
			if (annotation.scope === "text") {
				if (sourceIndex !== -1) throw new Error("Invalid whole-text annotation anchor");
			} else if (
				sourceIndex < 0 ||
				sourceIndex >= lines.length ||
				annotation.line !== sourceIndex + 1 ||
				lines[sourceIndex] !== annotation.quote
			) {
				throw new Error("Text annotation anchor does not match its source");
			}
		}
		const editor = state.editor;
		if (
			editor &&
			(editor.scope === "text"
				? editor.sourceIndex !== -1
				: editor.sourceIndex < 0 || editor.sourceIndex >= lines.length)
		) {
			throw new Error("Text editor anchor does not match its source");
		}
	} else if (source.kind === "diff" && state.kind === "diff") {
		const snapshot = parseReviewDiffSnapshot(source.target.rawDiff);
		// The wire format retains snapshots; the parser owns their structure and anchors.
		if (!Bun.deepEquals(source.target.snapshot, snapshot)) throw new Error("Diff snapshot does not match its source");
		source.target.snapshot = snapshot;
		const files = snapshot.files;
		for (const { fileIndex, sourceIndex, annotation } of state.annotations) {
			const file = files[fileIndex];
			const row = file && diffSourceRows(file)[sourceIndex];
			if (!file || (annotation.scope === "file" ? sourceIndex !== -1 : !row))
				throw new Error("Diff annotation anchor does not match its source");
			if (annotation.path !== file.path || annotation.occurrence !== file.occurrence)
				throw new Error("Diff annotation file does not match its source");
			if (
				annotation.scope === "line" &&
				(annotation.rawLine !== row!.raw || annotation.hunkHeader !== row!.hunkHeader)
			) {
				throw new Error("Diff annotation line does not match its source");
			}
		}
		const editor = state.editor;
		if (editor) {
			const file = files[editor.fileIndex];
			if (
				!file ||
				(editor.scope === "file" ? editor.sourceIndex !== -1 : !diffSourceRows(file)[editor.sourceIndex])
			) {
				throw new Error("Diff editor anchor does not match its source");
			}
		}
	} else throw new Error("Invalid annotation draft source kind");
	if (
		state.editor?.editingAnnotationIndex !== undefined &&
		state.editor.editingAnnotationIndex >= state.annotations.length
	) {
		throw new Error("Invalid annotation edit index");
	}
	if (annotationDraftKey(source) !== filenameKey) throw new Error("Annotation draft key does not match its source");
	return record;
}

interface StoredDraft {
	record: AnnotationDraftRecord;
	revision?: string;
}

function decodeRecord(content: string, sessionId: string, key: string): StoredDraft {
	return { record: validateRecord(JSON.parse(content), sessionId, key), revision: hash(content) };
}

async function readRecord(filePath: string, sessionId: string, key: string): Promise<StoredDraft | undefined> {
	try {
		if (!(await fs.lstat(filePath)).isFile()) throw new Error("Expected a regular file");
		return decodeRecord(await fs.readFile(filePath, "utf8"), sessionId, key);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/** Session-local recoverable annotation state. */
export class AnnotationDraftStore {
	readonly #artifactsDir: string | null;
	readonly #sessionId: string;
	readonly #beforeWrite?: () => Promise<void>;
	readonly #records = new Map<string, StoredDraft>();
	readonly #leases = new Map<string, FileLockHandle | undefined>();
	readonly #invalid = new Map<string, InvalidAnnotationDraft>();
	readonly #sealed = new Set<string>();
	readonly #dirty = new Set<string>();
	#artifactGate: FileLockHandle | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#writing: Promise<void> | undefined;
	#disposed = false;

	private constructor(artifactsDir: string | null, sessionId: string, beforeWrite?: () => Promise<void>) {
		this.#artifactsDir = artifactsDir;
		this.#sessionId = sessionId;
		this.#beforeWrite = beforeWrite;
	}

	static async open(
		artifactsDir: string | null,
		sessionId: string,
		beforeWrite?: () => Promise<void>,
	): Promise<AnnotationDraftStore> {
		const store = new AnnotationDraftStore(artifactsDir, sessionId, beforeWrite);
		if (artifactsDir === null) {
			if (!warnedMemoryOnly) {
				warnedMemoryOnly = true;
				logger.warn("Annotation drafts in this session cannot be recovered after restart");
			}
			for (const [key, content] of MEMORY_RECORDS.get(sessionId) ?? []) {
				try {
					store.#records.set(key, decodeRecord(content, sessionId, key));
				} catch (error) {
					logger.warn("Ignoring unreadable annotation draft", { filename: key, error: toError(error).message });
				}
			}
			return store;
		}
		const directory = recordDirectory(artifactsDir, sessionId);
		let entries: Dirent[];
		try {
			entries = await fs.readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (isEnoent(error)) return store;
			throw error;
		}
		for (const entry of entries) {
			const match = FILE_PATTERN.exec(entry.name);
			if (!match || !entry.isFile()) continue;
			const key = match[1]!;
			try {
				const loaded = await readRecord(path.join(directory, entry.name), sessionId, key);
				if (loaded) store.#records.set(key, loaded);
			} catch (error) {
				const message = toError(error).message;
				logger.warn("Ignoring unreadable annotation draft", { filename: entry.name, error: message });
				store.#invalid.set(key, { key, filename: entry.name, error: message });
			}
		}
		return store;
	}

	list(): readonly AnnotationDraftRecord[] {
		return [...this.#records.values()]
			.map(entry => entry.record)
			.sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
	}

	listInvalid(): readonly InvalidAnnotationDraft[] {
		return [...this.#invalid.values()].sort((a, b) => a.filename.localeCompare(b.filename));
	}

	find(source: AnnotationDraftSource): AnnotationDraftRecord | undefined {
		const exactKey = annotationDraftKey(source);
		const exact = this.#records.get(exactKey);
		if (exact) return exact.record;
		if (source.kind !== "text") return undefined;
		for (const { record } of this.#records.values()) {
			const saved = record.source;
			if (
				saved.kind === "text" &&
				record.state.kind === "text" &&
				source.cwd === saved.cwd &&
				source.source.kind === saved.source.kind &&
				source.source.id === saved.source.id &&
				Bun.deepEquals(textProvenance(source.source), textProvenance(saved.source)) &&
				source.source.text === (record.state.editedText ?? saved.source.text)
			)
				return record;
		}
		return undefined;
	}

	async claim(key: string): Promise<void> {
		if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Invalid annotation draft key");
		if (this.#leases.has(key)) throw new Error("This annotation draft is already open");
		if (this.#artifactsDir !== null && !this.#artifactGate)
			this.#artifactGate = await acquireSessionArtifactGate(this.#sessionId);
		let lock: FileLockHandle | undefined;
		try {
			lock = await this.#lockFor(key);
			const invalid = this.#invalid.get(key);
			if (invalid) throw new Error(`Unreadable annotation draft ${invalid.filename} must be explicitly discarded`);
			const memory = MEMORY_RECORDS.get(this.#sessionId)?.get(key);
			const loaded =
				this.#artifactsDir === null
					? memory === undefined
						? undefined
						: decodeRecord(memory, this.#sessionId, key)
					: await readRecord(recordPath(this.#artifactsDir, this.#sessionId, key), this.#sessionId, key);
			if (loaded) this.#records.set(key, loaded);
			else this.#records.delete(key);
			this.#leases.set(key, lock);
		} catch (error) {
			this.#release(key, lock);
			if (this.#leases.size === 0) {
				this.#artifactGate?.release();
				this.#artifactGate = undefined;
			}
			throw error;
		}
	}

	revision(key: string): string | undefined {
		return this.#records.get(key)?.revision;
	}

	checkpoint(record: AnnotationDraftRecord): void {
		if (this.#disposed || this.#sealed.has(record.key)) return;
		// Overlay draft events already contain detached snapshots.
		const entry = { record, revision: this.revision(record.key) };
		this.#records.set(record.key, entry);
		if (this.#artifactsDir === null) {
			if (!this.#leases.has(record.key))
				throw new Error(`Annotation draft ${record.key} must be claimed before checkpointing`);
			const content = `${JSON.stringify(record)}\n`;
			const memory = MEMORY_RECORDS.get(this.#sessionId) ?? new Map<string, string>();
			MEMORY_RECORDS.set(this.#sessionId, memory);
			memory.set(record.key, content);
			entry.revision = hash(content);
			return;
		}
		this.#dirty.add(record.key);
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.flush().catch(error =>
				logger.warn("Failed to save annotation draft", { error: toError(error).message }),
			);
		}, 150);
	}

	async flush(): Promise<void> {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		while (this.#dirty.size > 0 || this.#writing) {
			this.#writing ??= this.#save().finally(() => {
				this.#writing = undefined;
			});
			await this.#writing;
		}
	}

	async #save(): Promise<void> {
		if (this.#dirty.size === 0) return;
		await this.#beforeWrite?.();
		for (const key of this.#dirty) {
			if (!this.#dirty.has(key)) continue;
			if (!this.#leases.has(key)) throw new Error(`Annotation draft ${key} must be claimed before checkpointing`);
			const entry = this.#records.get(key)!;
			const content = `${JSON.stringify(entry.record)}\n`;
			await writeFileAtomically(recordPath(this.#artifactsDir!, this.#sessionId, key), content);
			const current = this.#records.get(key);
			if (current) current.revision = hash(content);
			if (current === entry) this.#dirty.delete(key);
			this.#invalid.delete(key);
		}
	}

	remove(key: string, expectedRevision: string): Promise<boolean> {
		return this.#delete(key, expectedRevision);
	}

	async discard(key: string): Promise<void> {
		await this.#delete(key);
	}

	async #delete(key: string, expectedRevision?: string): Promise<boolean> {
		if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Invalid annotation draft key");
		if (expectedRevision !== undefined && (this.#sealed.has(key) || this.#dirty.has(key))) return false;
		this.#sealed.add(key);
		this.#dirty.delete(key);
		let lock: FileLockHandle | undefined;
		let removed = false;
		let preserveLease = false;
		try {
			await this.#writing;
			lock = await this.#lockFor(key);
			if (this.#artifactsDir !== null) {
				const filePath = recordPath(this.#artifactsDir, this.#sessionId, key);
				try {
					const content = await fs.readFile(filePath, "utf8");
					if (expectedRevision !== undefined && hash(content) !== expectedRevision) return false;
					await fs.unlink(filePath);
				} catch (error) {
					if (!isEnoent(error)) throw error;
				}
			} else {
				const memory = MEMORY_RECORDS.get(this.#sessionId);
				const content = memory?.get(key);
				if (expectedRevision !== undefined && (content === undefined || hash(content) !== expectedRevision))
					return false;
				memory?.delete(key);
			}
			this.#records.delete(key);
			this.#invalid.delete(key);
			removed = true;
			return true;
		} catch (error) {
			preserveLease = this.#leases.has(key);
			if (preserveLease && this.#records.has(key) && this.#artifactsDir !== null) this.#dirty.add(key);
			throw error;
		} finally {
			if (!removed) this.#sealed.delete(key);
			if (!preserveLease) this.#release(key, lock);
		}
	}


	async #lockFor(key: string): Promise<FileLockHandle | undefined> {
		if (this.#leases.has(key)) return undefined;
		if (this.#artifactsDir === null) {
			const claims = MEMORY_CLAIMS.get(this.#sessionId) ?? new Map<string, AnnotationDraftStore>();
			const owner = claims.get(key);
			if (owner && owner !== this) throw new Error("This annotation draft is already open");
			claims.set(key, this);
			MEMORY_CLAIMS.set(this.#sessionId, claims);
			this.#leases.set(key, undefined);
			return undefined;
		}
		const directory = await ensurePrivateDirectory(this.#artifactsDir, this.#sessionId);
		return acquireFileLock(path.join(directory, `draft-${key}.json`), { retries: 1 });
	}

	#release(key: string, temporary?: FileLockHandle): void {
		if (temporary) {
			temporary.release();
			return;
		}
		this.#leases.get(key)?.release();
		this.#leases.delete(key);
		if (this.#artifactsDir === null) {
			const claims = MEMORY_CLAIMS.get(this.#sessionId);
			if (claims?.get(key) === this) claims.delete(key);
			if (claims?.size === 0) MEMORY_CLAIMS.delete(this.#sessionId);
		}
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		try {
			await this.flush();
		} finally {
			this.#disposed = true;
			for (const key of this.#leases.keys()) this.#release(key);
			this.#artifactGate?.release();
			this.#artifactGate = undefined;
		}
	}
}

export function hasAnnotationDraftsSync(artifactsDir: string, sessionId: string): boolean {
	try {
		return fsSync
			.readdirSync(recordDirectory(artifactsDir, sessionId), { withFileTypes: true })
			.some(entry => FILE_PATTERN.test(entry.name) && entry.isFile());
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}
