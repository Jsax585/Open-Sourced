import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	AnnotationOverlayDraft,
	CodeReviewAnnotation,
	ReviewDiffFile,
	ReviewDiffRow,
	TextReviewAnnotation,
	TextReviewSource,
} from "@oh-my-pi/pi-tui/overlays/annotation-types";
import { acquireFileLock, type FileLockHandle, isEnoent, logger, toError } from "@oh-my-pi/pi-utils";
import { writeFileAtomically } from "../../../../utils/atomic-file";
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
const MEMORY_RECORDS = new Map<string, Map<string, AnnotationDraftRecord>>();
const MEMORY_CLAIMS = new Map<string, Map<string, AnnotationDraftStore>>();
let warnedMemoryOnly = false;

function hash(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function sessionSegment(sessionId: string): string {
	return /^[\w-]+$/.test(sessionId) ? sessionId : hash(sessionId);
}

function sourceTuple(source: AnnotationDraftSource): unknown[] {
	if (source.kind === "text") {
		const { source: text } = source;
		const provenance = text.provenance
			? text.provenance.kind === "latest-assistant" || text.provenance.kind === "session"
				? [text.provenance.kind, text.provenance.entryId]
				: text.provenance.kind === "file"
					? ["file", path.resolve(text.provenance.path)]
					: ["prompt"]
			: null;
		return ["text", source.cwd, text.kind, text.id, provenance, text.text];
	}
	const { target } = source;
	return [
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

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every(key => allowed.includes(key));
}


function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function integer(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}


function isSourceRow(row: ReviewDiffRow): boolean {
	return row.kind === "context" || row.kind === "added" || row.kind === "removed";
}

function diffSourceRows(file: ReviewDiffFile): ReviewDiffRow[] {
	return file.isBinary ? [] : file.rows.filter(isSourceRow);
}

function validateTarget(value: unknown): value is ResolvedReviewTarget {
	if (
		!isObject(value) ||
		!hasOnlyKeys(value, ["kind", "mode", "rawDiff", "snapshot", "emptyMessage", "filteredMessage", "diffInstruction", "contextInstruction", "prDiffUrl"]) ||
		!["base-branch", "uncommitted", "commit", "pr", "patch"].includes(String(value.kind)) ||
		typeof value.mode !== "string" ||
		typeof value.rawDiff !== "string" ||
		typeof value.emptyMessage !== "string" ||
		["filteredMessage", "diffInstruction", "contextInstruction", "prDiffUrl"].some(key => value[key] !== undefined && typeof value[key] !== "string") ||
		!isObject(value.snapshot) ||
		!hasOnlyKeys(value.snapshot, ["files", "excluded", "totalAdded", "totalRemoved"]) ||
		!Array.isArray(value.snapshot.files) ||
		!Array.isArray(value.snapshot.excluded) ||
		!finite(value.snapshot.totalAdded) ||
		!finite(value.snapshot.totalRemoved)
	) return false;
	if (!value.snapshot.excluded.every((excluded: unknown) => isObject(excluded) && hasOnlyKeys(excluded, ["path", "reason", "linesAdded", "linesRemoved"]) && typeof excluded.path === "string" && typeof excluded.reason === "string" && finite(excluded.linesAdded) && finite(excluded.linesRemoved))) return false;
	return value.snapshot.files.every((file: unknown) => {
		if (
			!isObject(file) ||
			!hasOnlyKeys(file, ["path", "oldPath", "newPath", "occurrence", "rawDiff", "rows", "linesAdded", "linesRemoved", "isBinary", "diffIndex"]) ||
			typeof file.path !== "string" ||
			(file.oldPath !== undefined && typeof file.oldPath !== "string") ||
			(file.newPath !== undefined && typeof file.newPath !== "string") ||
			!finite(file.occurrence) ||
			typeof file.rawDiff !== "string" ||
			!Array.isArray(file.rows) ||
			!finite(file.linesAdded) ||
			!finite(file.linesRemoved) ||
			typeof file.isBinary !== "boolean" ||
			!integer(file.diffIndex)
		) return false;
		return file.rows.every((row: unknown) => {
			if (!isObject(row) || typeof row.raw !== "string" || typeof row.hunkHeader !== "string") return false;
			if (row.kind === "hunk" || row.kind === "no-newline") return hasOnlyKeys(row, ["kind", "raw", "hunkHeader"]);
			return (
				["context", "added", "removed"].includes(String(row.kind)) &&
				hasOnlyKeys(row, ["kind", "raw", "content", "oldLine", "newLine", "hunkHeader"]) &&
				typeof row.content === "string" &&
				(row.oldLine === undefined || finite(row.oldLine)) &&
				(row.newLine === undefined || finite(row.newLine))
			);
		});
	});
}

function isTextSource(value: unknown): value is TextReviewSource {
	if (!isObject(value) || !hasOnlyKeys(value, ["id", "kind", "label", "text", "provenance", "sessionId"]) || typeof value.id !== "string" || !["message", "code", "quote", "command", "file", "prompt"].includes(String(value.kind)) || typeof value.label !== "string" || typeof value.text !== "string") return false;
	if (value.sessionId !== undefined && typeof value.sessionId !== "string") return false;
	if (value.provenance === undefined) return true;
	const p = value.provenance;
	if (!isObject(p)) return false;
	if (p.kind === "prompt") return hasOnlyKeys(p, ["kind"]);
	if (p.kind === "file") return hasOnlyKeys(p, ["kind", "path"]) && typeof p.path === "string";
	return (p.kind === "session" || p.kind === "latest-assistant") && hasOnlyKeys(p, ["kind", "entryId"]) && typeof p.entryId === "string";
}

function validTextAnnotation(value: unknown): value is TextReviewAnnotation {
	if (!isObject(value) || typeof value.note !== "string") return false;
	return value.scope === "text"
		? hasOnlyKeys(value, ["scope", "note"])
		: value.scope === "line" && hasOnlyKeys(value, ["scope", "line", "quote", "note"]) && integer(value.line) && value.line >= 1 && typeof value.quote === "string";
}

function validCodeAnnotation(value: unknown): value is CodeReviewAnnotation {
	if (!isObject(value) || typeof value.path !== "string" || typeof value.note !== "string" || !finite(value.occurrence)) return false;
	if (value.oldPath !== undefined && typeof value.oldPath !== "string") return false;
	if (value.newPath !== undefined && typeof value.newPath !== "string") return false;
	const baseKeys = ["scope", "path", "oldPath", "newPath", "occurrence", "note"];
	return value.scope === "file"
		? hasOnlyKeys(value, baseKeys)
		: value.scope === "line" && hasOnlyKeys(value, [...baseKeys, "hunkHeader", "oldLine", "newLine", "rawLine"]) && typeof value.hunkHeader === "string" && typeof value.rawLine === "string" && (value.oldLine === undefined || finite(value.oldLine)) && (value.newLine === undefined || finite(value.newLine));
}

function validateRecord(value: unknown, sessionId: string, filenameKey: string): AnnotationDraftRecord {
	if (
		!isObject(value) ||
		!hasOnlyKeys(value, ["version", "sessionId", "key", "createdAt", "updatedAt", "source", "state"]) ||
		value.version !== 1 ||
		value.sessionId !== sessionId ||
		value.key !== filenameKey
	) throw new Error("Invalid annotation draft header");
	if (!finite(value.createdAt) || !finite(value.updatedAt) || value.updatedAt < value.createdAt || !isObject(value.source) || !isObject(value.state)) throw new Error("Invalid annotation draft metadata");
	const source = value.source as AnnotationDraftSource;
	if (typeof source.cwd !== "string") throw new Error("Invalid annotation draft cwd");
	if (source.kind === "text") {
		if (!hasOnlyKeys(value.source, ["kind", "cwd", "source"]) || !isTextSource(source.source) || value.state.kind !== "text" || !hasOnlyKeys(value.state, ["kind", "annotations", "editedText", "editor"]) || !Array.isArray(value.state.annotations)) throw new Error("Invalid text annotation draft");
		if (value.state.editedText !== undefined && typeof value.state.editedText !== "string") throw new Error("Invalid edited annotation source");
		const state = value.state as Extract<AnnotationOverlayDraft, { kind: "text" }>;
		const effectiveText = state.editedText ?? source.source.text;
		const lines = effectiveText.split(/\r\n|\n|\r/);
		for (const entry of state.annotations) {
			if (!isObject(entry) || !hasOnlyKeys(entry, ["sourceIndex", "annotation"]) || !integer(entry.sourceIndex) || !validTextAnnotation(entry.annotation)) throw new Error("Invalid text annotation entry");
			if (entry.annotation.scope === "text") {
				if (entry.sourceIndex !== -1) throw new Error("Invalid whole-text annotation anchor");
			} else if (entry.sourceIndex < 0 || entry.sourceIndex >= lines.length || entry.annotation.line !== entry.sourceIndex + 1 || lines[entry.sourceIndex] !== entry.annotation.quote) {
				throw new Error("Text annotation anchor does not match its source");
			}
		}
		if (state.editor !== undefined) {
			const editor = state.editor;
			if (!isObject(editor) || !hasOnlyKeys(editor, ["sourceIndex", "scope", "editingAnnotationIndex", "text"]) || !integer(editor.sourceIndex) || typeof editor.text !== "string" || !["text", "line"].includes(editor.scope)) throw new Error("Invalid text annotation editor");
			if ((editor.scope === "text" && editor.sourceIndex !== -1) || (editor.scope === "line" && (editor.sourceIndex < 0 || editor.sourceIndex >= lines.length))) throw new Error("Text editor anchor does not match its source");
			if (editor.editingAnnotationIndex !== undefined && (!integer(editor.editingAnnotationIndex) || editor.editingAnnotationIndex < 0 || editor.editingAnnotationIndex >= state.annotations.length)) throw new Error("Invalid text annotation edit index");
		}
	} else if (source.kind === "diff") {
		if (!hasOnlyKeys(value.source, ["kind", "cwd", "target", "focus"]) || !validateTarget(source.target) || (source.focus !== undefined && typeof source.focus !== "string") || value.state.kind !== "diff" || !hasOnlyKeys(value.state, ["kind", "annotations", "editor"]) || !Array.isArray(value.state.annotations)) throw new Error("Invalid diff annotation draft");
		const state = value.state as Extract<AnnotationOverlayDraft, { kind: "diff" }>;
		const files = source.target.snapshot.files;
		for (const entry of state.annotations) {
			if (!isObject(entry) || !hasOnlyKeys(entry, ["fileIndex", "sourceIndex", "annotation"]) || !integer(entry.fileIndex) || !integer(entry.sourceIndex) || !validCodeAnnotation(entry.annotation)) throw new Error("Invalid diff annotation entry");
			const file = files[entry.fileIndex];
			if (!file || (entry.annotation.scope === "file" ? entry.sourceIndex !== -1 : entry.sourceIndex < 0 || entry.sourceIndex >= diffSourceRows(file).length)) throw new Error("Diff annotation anchor does not match its source");
			if (entry.annotation.path !== file.path || entry.annotation.occurrence !== file.occurrence) throw new Error("Diff annotation file does not match its source");
			if (entry.annotation.scope === "line") {
				const row = diffSourceRows(file)[entry.sourceIndex]!;
				if (entry.annotation.rawLine !== row.raw || entry.annotation.hunkHeader !== row.hunkHeader) throw new Error("Diff annotation line does not match its source");
			}
		}
		if (state.editor !== undefined) {
			const editor = state.editor;
			if (!isObject(editor) || !hasOnlyKeys(editor, ["fileIndex", "sourceIndex", "scope", "editingAnnotationIndex", "text"]) || !integer(editor.fileIndex) || !integer(editor.sourceIndex) || typeof editor.text !== "string" || !["file", "line"].includes(editor.scope)) throw new Error("Invalid diff annotation editor");
			const file = files[editor.fileIndex];
			if (!file || (editor.scope === "file" && editor.sourceIndex !== -1) || (editor.scope === "line" && (editor.sourceIndex < 0 || editor.sourceIndex >= diffSourceRows(file).length))) throw new Error("Diff editor anchor does not match its source");
			if (editor.editingAnnotationIndex !== undefined && (!integer(editor.editingAnnotationIndex) || editor.editingAnnotationIndex < 0 || editor.editingAnnotationIndex >= state.annotations.length)) throw new Error("Invalid diff annotation edit index");
		}
	} else throw new Error("Invalid annotation draft source kind");
	if (annotationDraftKey(source) !== filenameKey) throw new Error("Annotation draft key does not match its source");
	return value as unknown as AnnotationDraftRecord;
}

interface LoadedRecord { record: AnnotationDraftRecord; revision: string; bytes: Buffer }

async function readRecord(filePath: string, sessionId: string, key: string): Promise<LoadedRecord | undefined> {
	try {
		const stat = await fs.lstat(filePath);
		if (!stat.isFile()) throw new Error("Expected a regular file");
		const bytes = await fs.readFile(filePath);
		const record = validateRecord(JSON.parse(bytes.toString("utf8")), sessionId, key);
		return { record, revision: hash(bytes.toString("utf8")), bytes };
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

function effectiveText(source: AnnotationDraftSource): string | undefined {
	return source.kind === "text" ? source.source.text : undefined;
}

function sameTextIdentity(a: AnnotationDraftSource, b: AnnotationDraftSource, effectiveText: string): boolean {
	if (a.kind !== "text" || b.kind !== "text") return false;
	const provenance = (src: TextReviewSource) =>
		src.provenance
			? JSON.stringify(
					src.provenance.kind === "file"
						? { kind: "file", path: path.resolve(src.provenance.path) }
						: src.provenance,
				)
			: null;
	return (
		a.cwd === b.cwd &&
		a.source.kind === b.source.kind &&
		a.source.id === b.source.id &&
		provenance(a.source) === provenance(b.source) &&
		a.source.text === effectiveText
	);
}

function capture(record: AnnotationDraftRecord): AnnotationDraftRecord {
	return structuredClone(record);
}

/** Session-local recoverable annotation state. */
export class AnnotationDraftStore {
	readonly #artifactsDir: string | null;
	readonly #sessionId: string;
	readonly #records = new Map<string, AnnotationDraftRecord>();
	readonly #revisions = new Map<string, string>();
	readonly #leases = new Map<string, FileLockHandle>();
	readonly #invalid = new Map<string, InvalidAnnotationDraft>();
	readonly #sealed = new Set<string>();
	readonly #memoryClaims = new Set<string>();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#queued = new Map<string, AnnotationDraftRecord>();
	#pending: Promise<void> = Promise.resolve();
	#writeError: Error | undefined;
	#disposed = false;

	private constructor(artifactsDir: string | null, sessionId: string) {
		this.#artifactsDir = artifactsDir;
		this.#sessionId = sessionId;
	}

	static async open(artifactsDir: string | null, sessionId: string): Promise<AnnotationDraftStore> {
		const store = new AnnotationDraftStore(artifactsDir, sessionId);
		if (artifactsDir === null) {
			if (!warnedMemoryOnly) {
				warnedMemoryOnly = true;
				logger.warn("Annotation drafts in this session cannot be recovered after restart");
			}
			const memory = MEMORY_RECORDS.get(sessionId);
			if (memory) {
				for (const [key, record] of memory) {
					store.#records.set(key, capture(record));
					store.#revisions.set(key, hash(`${JSON.stringify(record)}\n`));
				}
			}
			return store;
		}
		const directory = recordDirectory(artifactsDir, sessionId);
		let entries: Dirent[];
		try { entries = await fs.readdir(directory, { withFileTypes: true }); }
		catch (error) { if (isEnoent(error)) return store; throw error; }
		for (const entry of entries) {
			const match = FILE_PATTERN.exec(entry.name);
			if (!match || !entry.isFile()) continue;
			const key = match[1]!;
			const filename = entry.name;
			try {
				const loaded = await readRecord(path.join(directory, filename), sessionId, key);
				if (loaded) {
					store.#records.set(key, loaded.record);
					store.#revisions.set(key, loaded.revision);
				}
			} catch (error) {
				const message = toError(error).message;
				logger.warn("Ignoring unreadable annotation draft", { filename, error: message });
				store.#invalid.set(key, { key, filename, error: message });
			}
		}
		return store;
	}

	list(): readonly AnnotationDraftRecord[] {
		return [...this.#records.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
	}

	listInvalid(): readonly InvalidAnnotationDraft[] {
		return [...this.#invalid.values()].sort((a, b) => a.filename.localeCompare(b.filename));
	}

	find(source: AnnotationDraftSource): AnnotationDraftRecord | undefined {
		const exactKey = annotationDraftKey(source);
		const exact = this.#records.get(exactKey);
		if (exact) return exact;
		if (source.kind !== "text") return undefined;
		for (const record of this.#records.values()) {
			if (record.source.kind === "text" && sameTextIdentity(source, record.source, record.state.kind === "text" ? record.state.editedText ?? record.source.source.text : effectiveText(record.source)!)) return record;
		}
		return undefined;
	}

	claim(key: string): Promise<void> {
		return this.#claim(key);
	}

	async #claim(key: string): Promise<void> {
		if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Invalid annotation draft key");
		if (this.#artifactsDir === null) {
			const claims = MEMORY_CLAIMS.get(this.#sessionId) ?? new Map<string, AnnotationDraftStore>();
			MEMORY_CLAIMS.set(this.#sessionId, claims);
			if (claims.has(key)) throw new Error("This annotation draft is already open");
			claims.set(key, this);
			this.#memoryClaims.add(key);
			const record = MEMORY_RECORDS.get(this.#sessionId)?.get(key);
			if (record) {
				this.#records.set(key, capture(record));
				this.#revisions.set(key, hash(`${JSON.stringify(record)}\n`));
			}
			return;
		}
		if (this.#leases.has(key)) throw new Error("This annotation draft is already open");
		const directory = await ensurePrivateDirectory(this.#artifactsDir, this.#sessionId);
		const filePath = path.join(directory, `draft-${key}.json`);
		const lock = await acquireFileLock(filePath, { retries: 1 });
		try {
			const invalid = this.#invalid.get(key);
			if (invalid) throw new Error(`Unreadable annotation draft ${invalid.filename} must be explicitly discarded`);
			const loaded = await readRecord(filePath, this.#sessionId, key);
			if (loaded) {
				this.#records.set(key, loaded.record);
				this.#revisions.set(key, loaded.revision);
			} else {
				this.#records.delete(key);
				this.#revisions.delete(key);
			}
			this.#leases.set(key, lock);
		} catch (error) {
			lock.release();
			throw error;
		}
	}

	revision(key: string): string | undefined { return this.#revisions.get(key); }

	checkpoint(record: AnnotationDraftRecord): void {
		if (this.#disposed || this.#sealed.has(record.key)) return;
		const saved = capture(record);
		validateRecord(saved, this.#sessionId, saved.key);
		this.#records.set(saved.key, saved);
		if (this.#artifactsDir === null) {
			if (!this.#memoryClaims.has(saved.key)) throw new Error(`Annotation draft ${saved.key} must be claimed before checkpointing`);
			const memory = MEMORY_RECORDS.get(this.#sessionId) ?? new Map<string, AnnotationDraftRecord>();
			MEMORY_RECORDS.set(this.#sessionId, memory);
			memory.set(saved.key, saved);
			this.#revisions.set(saved.key, hash(`${JSON.stringify(saved)}\n`));
			return;
		}
		this.#queued.set(saved.key, saved);
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => { this.#timer = undefined; void this.#drain().catch(error => logger.warn("Failed to save annotation draft", { error: toError(error).message })); }, 150);
	}

	async flush(): Promise<void> {
		if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
		this.#writeError = undefined;
		let pending: Promise<void>;
		do {
			if (this.#queued.size > 0) void this.#drain();
			pending = this.#pending;
			await pending;
			if (this.#writeError) throw this.#writeError;
		} while (pending !== this.#pending || this.#queued.size > 0);
	}

	async #drain(): Promise<void> {
		if (this.#queued.size === 0) return this.#pending;
		const batch = this.#queued;
		this.#queued = new Map();
		const write = this.#pending.then(async () => {
			if (this.#writeError) throw this.#writeError;
			for (const [key, record] of batch) {
				if (this.#sealed.has(key)) continue;
				const lease = this.#leases.get(key);
				if (!lease) throw new Error(`Annotation draft ${key} must be claimed before checkpointing`);
				const filePath = recordPath(this.#artifactsDir!, this.#sessionId, key);
				const content = `${JSON.stringify(record)}\n`;
				await writeFileAtomically(filePath, content);
				this.#revisions.set(key, hash(content));
				this.#invalid.delete(key);
			}
		});
		this.#pending = write.catch(error => {
			for (const [key, record] of batch) {
				if (!this.#sealed.has(key) && !this.#queued.has(key)) this.#queued.set(key, record);
			}
			this.#writeError ??= toError(error);
		});
		await this.#pending;
	}

	async remove(key: string, expectedRevision: string): Promise<boolean> {
		if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Invalid annotation draft key");
		if (this.#sealed.has(key)) return false;
		this.#sealed.add(key);
		this.#queued.delete(key);
		let lock: FileLockHandle | undefined;
		let preserveLease = false;
		try {
			await this.#pending;
			lock = await this.#lockFor(key);
			const filePath = this.#artifactsDir === null ? undefined : recordPath(this.#artifactsDir, this.#sessionId, key);
			if (filePath) {
				let bytes: Buffer;
				try { bytes = await fs.readFile(filePath); }
				catch (error) {
					if (!isEnoent(error)) throw error;
					this.#forget(key);
					return true;
				}
				if (hash(bytes.toString("utf8")) !== expectedRevision) {
					this.#sealed.delete(key);
					return false;
				}
				await fs.unlink(filePath);
			} else {
				const claims = MEMORY_CLAIMS.get(this.#sessionId);
				if (claims?.get(key) !== this) throw new Error("This annotation draft is not claimed by this store");
				const current = MEMORY_RECORDS.get(this.#sessionId)?.get(key);
				const revision = current ? hash(`${JSON.stringify(current)}\n`) : undefined;
				if (revision !== expectedRevision) {
					this.#sealed.delete(key);
					return false;
				}
			}
			this.#forget(key);
			return true;
		} catch (error) {
			this.#sealed.delete(key);
			preserveLease = this.#leases.has(key);
			if (preserveLease) {
				const latest = this.#records.get(key);
				if (latest) this.#queued.set(key, capture(latest));
			}
			throw error;
		} finally {
			if (!preserveLease) this.#releaseTemporary(key, lock);
		}
	}

	async discard(key: string): Promise<void> {
		if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Invalid annotation draft key");
		this.#sealed.add(key);
		if (this.#timer && this.#queued.size === 0) { clearTimeout(this.#timer); this.#timer = undefined; }
		this.#queued.delete(key);
		let lock: FileLockHandle | undefined;
		let preserveLease = false;
		try {
			await this.#pending;
			lock = await this.#lockFor(key);
			if (this.#artifactsDir !== null) await fs.rm(recordPath(this.#artifactsDir, this.#sessionId, key), { force: true });
			else {
				const claims = MEMORY_CLAIMS.get(this.#sessionId);
				if (claims?.get(key) !== this) throw new Error("This annotation draft is not claimed by this store");
				MEMORY_RECORDS.get(this.#sessionId)?.delete(key);
			}
			this.#invalid.delete(key);
			this.#forget(key);
		} catch (error) {
			this.#sealed.delete(key);
			preserveLease = this.#leases.has(key);
			if (preserveLease) {
				const latest = this.#records.get(key);
				if (latest) this.#queued.set(key, capture(latest));
			}
			throw error;
		} finally {
			if (!preserveLease) this.#releaseTemporary(key, lock);
		}
	}


	async #lockFor(key: string): Promise<FileLockHandle | undefined> {
		const held = this.#leases.get(key);
		if (held) return undefined;
		if (this.#artifactsDir === null) {
			const claims = MEMORY_CLAIMS.get(this.#sessionId) ?? new Map<string, AnnotationDraftStore>();
			const owner = claims.get(key);
			if (owner && owner !== this) throw new Error("This annotation draft is already open");
			claims.set(key, this);
			MEMORY_CLAIMS.set(this.#sessionId, claims);
			this.#memoryClaims.add(key);
			return undefined;
		}
		const directory = await ensurePrivateDirectory(this.#artifactsDir, this.#sessionId);
		return acquireFileLock(path.join(directory, `draft-${key}.json`), { retries: 1 });
	}

	#releaseTemporary(key: string, temporary: FileLockHandle | undefined): void {
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
			this.#memoryClaims.delete(key);
		}
	}

	#forget(key: string): void {
		this.#records.delete(key);
		this.#revisions.delete(key);
		MEMORY_RECORDS.get(this.#sessionId)?.delete(key);
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		let failure: unknown;
		try { await this.flush(); } catch (error) { failure = error; }
		finally {
			this.#disposed = true;
			for (const lease of this.#leases.values()) lease.release();
			this.#leases.clear();
			const claims = MEMORY_CLAIMS.get(this.#sessionId);
			for (const key of this.#memoryClaims) if (claims?.get(key) === this) claims.delete(key);
			if (claims?.size === 0) MEMORY_CLAIMS.delete(this.#sessionId);
			this.#memoryClaims.clear();
		}
		if (failure) throw failure;
	}
}

export async function hasAnnotationDrafts(artifactsDir: string, sessionId: string): Promise<boolean> {
	try {
		const entries = await fs.readdir(recordDirectory(artifactsDir, sessionId), { withFileTypes: true });
		return entries.some(entry => FILE_PATTERN.test(entry.name) && entry.isFile());
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}
