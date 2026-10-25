import { Database } from "bun:sqlite";
import type { BigIntStats, Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import {
	parseSessionFormatLogFilename,
	type SessionFormatArtifact,
	type SessionFormatCatalog,
	type SessionFormatEvent,
	type SessionFormatHeader,
	type SessionFormatJsonValue,
	snapshotSessionFormatJson,
} from "@deepseek-ai/dsh-session-format";
import {
	createSessionFormatCatalogWithChildren,
	historicalSessionFormatCatalog,
	sessionFormatCatalog,
} from "@deepseek-ai/dsh-session-format-catalog";
import { historicalChildCatalogSource } from "@deepseek-ai/dsh-session-format-v3-to-v4";
import { isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import { zstdDecompressStream } from "@oh-my-pi/pi-utils/ar/codecs/zstd";
import { fileByteSource } from "@oh-my-pi/pi-utils/ar/source";
import { adoptDeepSeekEventShapes, adoptDeepSeekV0SourceShapes } from "./deepseek-compat";
import type { ForeignSessionInfo } from "./foreign-session-store";

/** Detached physical read and released logical migration; backend repairs run afterward. */
export interface DeepSeekSourceSnapshot {
	readonly header: SessionFormatHeader;
	readonly events: readonly SessionFormatEvent[];
	readonly inheritedEventCount: number;
	readonly storedVersion: number;
	readonly kind: "jsonl" | "sqlite";
	readonly metadata: Record<string, unknown>;
}

interface FileSource {
	readonly path: string;
	readonly generation: number;
	readonly headerValue: unknown;
	readonly header: SessionFormatHeader;
	readonly storedVersion: number;
	readonly modified: number;
}

type SqlRow = Record<string, unknown>;

interface SqlSession {
	readonly row: SqlRow;
	readonly headerValue: Record<string, unknown>;
	readonly header: SessionFormatHeader;
	readonly storedVersion: number;
	readonly headSequence: number;
	readonly headEventId: string;
	readonly seedLength: number | null;
	readonly modified: number;
	readonly messageCount: number;
	readonly title?: string;
	readonly firstMessage?: string;
}

interface SqlMetadata {
	readonly backend: "@morlay/session-rdb";
	readonly backendVersion: "0.1.5";
	readonly schemaVersion: number;
	readonly applicationId: number;
	readonly storeId: string;
	readonly schemaMetadata: Record<string, string>;
}

interface PhysicalArtifact {
	readonly headerValue: unknown;
	readonly rows: readonly unknown[];
	readonly shapeRepairs: Record<string, number>;
}

const SQLITE_PREFIX = "deepseek-sqlite:";
const LIST_PREFIX_BYTES = 64 * 1024;
const SQLITE_APPLICATION_ID = 0x44534850;
const SQLITE_SCHEMA_VERSION = 3;

class DeepSeekSourceError extends Error {}

function failure(stage: string, source: string, detail: string): DeepSeekSourceError {
	return new DeepSeekSourceError(`DeepSeek ${stage} failed for ${source}: ${detail}`);
}

async function atStage<T>(stage: string, source: string, action: () => T | Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (error) {
		if (error instanceof DeepSeekSourceError) throw error;
		// Decoder and JSON exceptions can contain source text. Never forward their messages.
		throw failure(stage, source, "source could not be read or validated; no source files were changed");
	}
}

function integer(value: unknown, source: string, field: string, minimum = 0): number {
	const number = typeof value === "bigint" ? Number(value) : value;
	if (typeof number !== "number" || !Number.isSafeInteger(number) || Object.is(number, -0) || number < minimum) {
		throw failure("decode", source, `invalid ${field}`);
	}
	return number;
}

function text(value: unknown, source: string, field: string, nonempty = false): string {
	if (typeof value !== "string" || (nonempty && value.length === 0) || value.includes("\0")) {
		throw failure("decode", source, `invalid ${field}`);
	}
	return value;
}

function timestamp(value: unknown, source: string, field: string): number {
	const number = integer(value, source, field);
	if (!Number.isFinite(new Date(number).getTime())) throw failure("decode", source, `invalid ${field}`);
	return number;
}

function classifyHeader(value: unknown, source: string): { header: SessionFormatHeader; storedVersion: number } {
	const result = sessionFormatCatalog.readHeader(value);
	if (result.status === "unsupported") {
		throw failure(
			"format",
			source,
			`unsupported logical format v${result.storedVersion}; supported formats are v0–v4`,
		);
	}
	if (result.status === "malformed") throw failure("header decode", source, "malformed released session header");
	if (result.header.id.length === 0 || result.header.id.includes("\0")) {
		throw failure("header decode", source, "session ID must be nonempty and contain no NUL");
	}
	if (result.header.cwd !== undefined && (!path.isAbsolute(result.header.cwd) || result.header.cwd.includes("\0"))) {
		throw failure("header decode", source, "recorded cwd must be an absolute path");
	}
	timestamp(result.header.createdAt, source, "createdAt");
	return result;
}

function generation(filename: string): number | undefined {
	return parseSessionFormatLogFilename(filename.endsWith(".zstd") ? filename.slice(0, -5) : filename);
}

async function entries(directory: string): Promise<Dirent[]> {
	try {
		return await fs.readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

async function optionalStat(filename: string): Promise<BigIntStats | null> {
	try {
		const stat = await fs.stat(filename, { bigint: true });
		if (!stat.isFile()) throw failure("snapshot", filename, "expected a regular file");
		return stat;
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

function sameFile(before: BigIntStats | null, after: BigIntStats | null): boolean {
	return before === null || after === null
		? before === after
		: before.dev === after.dev &&
				before.ino === after.ino &&
				before.size === after.size &&
				before.mtimeNs === after.mtimeNs &&
				before.ctimeNs === after.ctimeNs;
}

async function boundedHeader(filename: string): Promise<unknown> {
	let bytes: Uint8Array;
	let complete = true;
	if (filename.endsWith(".zstd")) {
		const prefix = new Uint8Array(LIST_PREFIX_BYTES);
		let length = 0;
		for await (const chunk of zstdDecompressStream(fileByteSource(filename), Number.MAX_SAFE_INTEGER)) {
			const count = Math.min(chunk.length, prefix.length - length);
			prefix.set(chunk.subarray(0, count), length);
			length += count;
			if (prefix.subarray(0, length).includes(10)) break;
			if (length === prefix.length) {
				complete = false;
				break;
			}
		}
		bytes = prefix.subarray(0, length);
	} else {
		const file = Bun.file(filename);
		bytes = await file.slice(0, LIST_PREFIX_BYTES).bytes();
		complete = file.size <= LIST_PREFIX_BYTES;
	}
	const newline = bytes.indexOf(10);
	if (newline < 0 && !complete) throw failure("header decode", filename, "header exceeds 64 KiB prefix limit");
	const line = newline < 0 ? bytes : bytes.subarray(0, newline);
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)) as unknown;
}

async function readFileArtifact(source: FileSource): Promise<PhysicalArtifact> {
	return atStage("snapshot", source.path, async () => {
		const before = await optionalStat(source.path);
		if (before === null) throw failure("snapshot", source.path, "selected source no longer exists");
		const original = await Bun.file(source.path).bytes();
		const after = await optionalStat(source.path);
		if (!sameFile(before, after) || BigInt(original.length) !== before.size) {
			throw failure("snapshot", source.path, "source changed while reading; select it again after writes stop");
		}
		return atStage("physical decode", source.path, () => {
			const bytes = source.path.endsWith(".zstd") ? Bun.zstdDecompressSync(original) : original;
			// parseChunk, unlike Bun.JSONL.parse, reports corruption after valid records.
			new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			const parsed = Bun.JSONL.parseChunk(bytes);
			// parseChunk's `read` stops before the final newline delimiter.
			const trailingNewline = bytes.length > 0 && bytes[bytes.length - 1] === 0x0a;
			if (
				parsed.error ||
				!parsed.done ||
				parsed.read !== bytes.length - (trailingNewline ? 1 : 0) ||
				parsed.values.length === 0
			) {
				throw failure("physical decode", source.path, "malformed or torn JSONL record");
			}
			return { headerValue: parsed.values[0], rows: parsed.values.slice(1), shapeRepairs: {} };
		});
	});
}

function restoreArtifact(
	physical: PhysicalArtifact,
	catalog: SessionFormatCatalog,
	source: string,
): SessionFormatArtifact {
	const restore = catalog.createRestore(physical.headerValue, { recovery: "strict", validation: "transformed" });
	for (const row of physical.rows) restore.decodeRow(row);
	const artifact = restore.finish();
	for (const event of artifact.events) {
		if (catalog.currentVersion === 4 && !KNOWN_SESSION_EVENT_TYPES.has(event.type) && event["ignorable"] !== true) {
			throw failure("event decode", source, `unknown required event at sequence ${event.seq}`);
		}
	}
	return artifact;
}

function sqlLocator(database: string, id: string): string {
	return `${SQLITE_PREFIX}${encodeURIComponent(database)}#${encodeURIComponent(id)}`;
}

function parseLocator(locator: string): { database: string; id: string } {
	const parts = locator.slice(SQLITE_PREFIX.length).split("#");
	if (parts.length !== 2 || parts.some(part => part.length === 0)) {
		throw failure("locator", locator, "malformed SQLite session locator");
	}
	const database = decodeURIComponent(parts[0]);
	const id = decodeURIComponent(parts[1]);
	if (!path.isAbsolute(database) || database.includes("\0") || !id || id.includes("\0")) {
		throw failure("locator", locator, "invalid SQLite session locator");
	}
	return { database, id };
}

// Read-only adaptation of @morlay/session-rdb 0.1.5 src/{schema,legacy,log}.ts.
// Schema 3 is the shipped SQLite schema; logical session versions remain independent.
const SQLITE_COLUMNS: Record<string, Record<string, string>> = {
	t_persistence_state: { f_singleton: "INTEGER", f_store_id: "TEXT" },
	t_schema_meta: { f_key: "TEXT", f_value: "TEXT" },
	t_sessions: {
		f_id: "INTEGER",
		f_session_id: "TEXT",
		f_head_event_id: "TEXT",
		f_head_sequence: "INTEGER",
		f_version: "INTEGER",
		f_created_at: "INTEGER",
		f_cwd: "TEXT",
		f_parent_session: "TEXT",
		f_seed_length: "INTEGER",
		f_origin: "TEXT",
		f_delegation_depth: "INTEGER",
		f_agent_preset: "TEXT",
		f_incarnation: "TEXT",
		f_revision: "INTEGER",
		f_archived_at: "INTEGER",
		f_pinned_seq: "INTEGER",
		f_last_event_at: "INTEGER",
		f_title: "TEXT",
		f_title_seq: "INTEGER",
	},
	t_events: {
		f_id: "INTEGER",
		f_event_id: "TEXT",
		f_parent_id: "TEXT",
		f_type: "TEXT",
		f_kind: "TEXT",
		f_role: "TEXT",
		f_name: "TEXT",
		f_action_id: "TEXT",
		f_encoding: "TEXT",
		f_data: "TEXT",
		f_created_at: "INTEGER",
	},
	t_session_events: {
		f_id: "INTEGER",
		f_session_id: "TEXT",
		f_event_id: "TEXT",
		f_sequence: "INTEGER",
		f_surface_op: "TEXT",
	},
};

function validateSchema(db: Database, source: string): SqlMetadata {
	const versionRow = db.query<SqlRow, []>("PRAGMA user_version").get();
	const applicationRow = db.query<SqlRow, []>("PRAGMA application_id").get();
	const version = integer(versionRow?.user_version, source, "SQLite schema version");
	const application = integer(applicationRow?.application_id, source, "SQLite application ID");
	if (version !== SQLITE_SCHEMA_VERSION || application !== SQLITE_APPLICATION_ID) {
		throw failure(
			"SQLite schema",
			source,
			"unsupported canonical database; requires @morlay/session-rdb 0.1.5 schema 3 (no automatic migration)",
		);
	}
	for (const [table, expected] of Object.entries(SQLITE_COLUMNS)) {
		const object = db.query<SqlRow, [string]>("SELECT type FROM sqlite_schema WHERE name = ?").get(table);
		if (object?.type !== "table") throw failure("SQLite schema", source, `missing required table ${table}`);
		const columns = db.query<SqlRow, []>(`PRAGMA table_info(${table})`).all();
		if (
			columns.length !== Object.keys(expected).length ||
			columns.some(
				column =>
					typeof column.name !== "string" ||
					typeof column.type !== "string" ||
					expected[column.name] !== column.type.toUpperCase(),
			)
		)
			throw failure("SQLite schema", source, `unsupported columns in ${table}`);
	}
	const identities = db.query<SqlRow, []>("SELECT f_singleton, f_store_id FROM t_persistence_state").all();
	if (identities.length !== 1 || integer(identities[0].f_singleton, source, "store singleton") !== 1) {
		throw failure("SQLite schema", source, "database has no unique store identity");
	}
	const storeId = text(identities[0].f_store_id, source, "store identity", true);
	const schemaMetadata: Record<string, string> = {};
	for (const row of db.query<SqlRow, []>("SELECT f_key, f_value FROM t_schema_meta").all()) {
		const key = text(row.f_key, source, "schema metadata key", true);
		Object.defineProperty(schemaMetadata, key, {
			value: text(row.f_value, source, "schema metadata value"),
			enumerable: true,
		});
	}
	if (schemaMetadata.schema_version !== undefined && schemaMetadata.schema_version !== String(SQLITE_SCHEMA_VERSION)) {
		throw failure("SQLite schema", source, "schema metadata disagrees with supported schema 3");
	}
	return {
		backend: "@morlay/session-rdb",
		backendVersion: "0.1.5",
		schemaVersion: version,
		applicationId: application,
		storeId,
		schemaMetadata,
	};
}

function readSqlSession(row: SqlRow, source: string): SqlSession {
	const version = integer(row.f_version, source, "logical format");
	const seedLength = row.f_seed_length === null ? null : integer(row.f_seed_length, source, "inherited event count");
	const headerValue: Record<string, unknown> = {
		type: "session",
		version,
		id: text(row.f_session_id, source, "session ID", true),
		createdAt: timestamp(row.f_created_at, source, "createdAt"),
		delegationDepth:
			row.f_delegation_depth === null ? 0 : integer(row.f_delegation_depth, source, "delegation depth"),
	};
	for (const [column, field] of [
		["f_cwd", "cwd"],
		["f_parent_session", "parentSession"],
		["f_origin", "origin"],
		["f_agent_preset", "agentPreset"],
	]) {
		if (row[column] !== null) headerValue[field] = text(row[column], source, field);
	}
	// Legacy v0 rows store f_seed_length as seed-text length, not an event count, and the
	// released v0 header has no seed field; only v1 headers carry an inherited-event count.
	if (version === 1 && seedLength !== null) headerValue.seedLength = seedLength;
	else if (version >= 2) headerValue.isSeeded = seedLength !== null;
	const classification = classifyHeader(headerValue, source);
	const headSequence = integer(row.f_head_sequence, source, "head sequence", -1);
	const headEventId = text(row.f_head_event_id, source, "head event ID");
	// Pre-v4 rows carry a legacy seed-text length with unrelated scale; only the v4
	// schema stores seedLength as an inherited-event count comparable to the head.
	if (
		(headSequence === -1) !== (headEventId.length === 0) ||
		(version === 4 && seedLength !== null && seedLength > headSequence + 1)
	) {
		throw failure("SQLite head", source, "head or inherited prefix metadata is incomplete");
	}
	text(row.f_incarnation, source, "session incarnation", true);
	integer(row.f_revision, source, "session revision");
	for (const column of ["f_archived_at", "f_last_event_at"]) {
		if (row[column] !== null) timestamp(row[column], source, column);
	}
	for (const column of ["f_pinned_seq", "f_title_seq"]) {
		if (row[column] !== null) integer(row[column], source, column);
	}
	return {
		row,
		headerValue,
		...classification,
		headSequence,
		headEventId,
		seedLength,
		modified:
			row.f_last_event_at === null
				? classification.header.createdAt
				: timestamp(row.f_last_event_at, source, "last event time"),
		messageCount: integer(row.message_count, source, "message count"),
		...(row.f_title === null ? {} : { title: text(row.f_title, source, "title") }),
		...(row.first_user_text === null || row.first_user_text === undefined
			? {}
			: { firstMessage: text(row.first_user_text, source, "first message") }),
	};
}

function sqlSessions(db: Database, source: string): SqlSession[] {
	return db
		.query<SqlRow, []>(`SELECT s.*, (
			SELECT COUNT(*) FROM t_session_events b JOIN t_events e ON e.f_event_id = b.f_event_id
			WHERE b.f_session_id = s.f_session_id AND e.f_type IN ('user/message', 'assistant/message', 'tool/result')
		) AS message_count, (
			SELECT substr(json_extract(e.f_data, '$.data.content[0].text'), 1, 200)
			FROM t_session_events b JOIN t_events e ON e.f_event_id = b.f_event_id
			WHERE b.f_session_id = s.f_session_id AND e.f_type = 'user/message' AND json_valid(e.f_data)
			ORDER BY b.f_sequence LIMIT 1
		) AS first_user_text FROM t_sessions s`)
		.all()
		.map(row => readSqlSession(row, source));
}

function validateHead(db: Database, session: SqlSession, source: string): void {
	const row = db
		.query<SqlRow, [string]>(`SELECT COUNT(*) AS count, MIN(b.f_sequence) AS first_seq,
		MAX(b.f_sequence) AS last_seq, COUNT(DISTINCT b.f_sequence) AS distinct_count,
		SUM(CASE WHEN e.f_event_id IS NULL OR e.f_encoding != 'json' THEN 1 ELSE 0 END) AS invalid_rows
		FROM t_session_events b LEFT JOIN t_events e ON e.f_event_id = b.f_event_id WHERE b.f_session_id = ?`)
		.get(session.header.id);
	const count = integer(row?.count, source, "bridge count");
	if (
		count !== session.headSequence + 1 ||
		integer(row?.distinct_count, source, "distinct bridge count") !== count ||
		(count > 0 &&
			(integer(row?.first_seq, source, "first bridge sequence") !== 0 ||
				integer(row?.last_seq, source, "last bridge sequence") !== session.headSequence)) ||
		(row?.invalid_rows !== null && integer(row?.invalid_rows, source, "invalid bridge count") !== 0)
	) {
		throw failure(
			"SQLite head",
			source,
			"incomplete bridge, sequence gap, unsupported row encoding, or head mismatch",
		);
	}
	if (count > 0) {
		const head = db
			.query<SqlRow, [string, number]>(
				"SELECT f_event_id FROM t_session_events WHERE f_session_id = ? AND f_sequence = ?",
			)
			.get(session.header.id, session.headSequence);
		if (head?.f_event_id !== session.headEventId)
			throw failure("SQLite head", source, "bridge head event does not match session head");
	}
}

function normalizeSurface(value: unknown): unknown {
	if (!isRecord(value) || value.op !== "replace") return value;
	const startSeq = value.startSeq ?? value.start;
	const endSeq = value.endSeq ?? value.end;
	return typeof startSeq === "number" && typeof endSeq === "number" ? { op: "replace", startSeq, endSeq } : value;
}

function readSqlArtifact(db: Database, session: SqlSession, source: string): PhysicalArtifact {
	validateHead(db, session, source);
	const rows = db
		.query<SqlRow, [string]>(`SELECT b.f_sequence, b.f_surface_op, e.f_type, e.f_encoding, e.f_data, e.f_created_at
		FROM t_session_events b JOIN t_events e ON e.f_event_id = b.f_event_id
		WHERE b.f_session_id = ? ORDER BY b.f_sequence`)
		.all(session.header.id);
	const events: SessionFormatEvent[] = [];
	for (const [index, row] of rows.entries()) {
		if (row.f_encoding !== "json") throw failure("SQLite row decode", source, "unsupported event encoding");
		const seq = integer(row.f_sequence, source, "bridge sequence");
		if (seq !== index) throw failure("SQLite head", source, "bridge sequence is not contiguous");
		const time = integer(row.f_created_at, source, "event time", Number.MIN_SAFE_INTEGER);
		const stored: unknown = JSON.parse(text(row.f_data, source, "event JSON"));
		const full = isRecord(stored) && typeof stored.type === "string" && Object.hasOwn(stored, "data");
		const event = {
			...(full ? stored : { type: text(row.f_type, source, "event type", true), data: stored }),
			seq,
			time,
			...(row.f_surface_op === null
				? {}
				: { surfaceOp: normalizeSurface(JSON.parse(text(row.f_surface_op, source, "surface operation JSON"))) }),
		};
		events.push(snapshotSessionFormatJson(event, "SQLite event") as SessionFormatEvent);
	}
	return { headerValue: session.headerValue, rows: events, shapeRepairs: {} };
}

/**
 * Stream-copies the canonical database plus WAL into a private directory. Reading a
 * multi-gigabyte database into memory would exhaust the heap, so stability is checked
 * with stat guards around the copy and integrity is enforced by WAL frame checksums.
 */
async function snapshotDatabaseFiles(source: string, directory: string): Promise<string> {
	const filenames = [source, `${source}-wal`];
	const filename = path.join(directory, "sessions.sqlite");
	for (let attempt = 0; attempt < 3; attempt++) {
		const before = await Promise.all(filenames.map(optionalStat));
		if (before[0] === null)
			throw failure("SQLite snapshot", source, "canonical database no longer exists; stale files will not be used");
		await fs.copyFile(source, filename);
		if (before[1] !== null) await fs.copyFile(`${source}-wal`, `${filename}-wal`);
		const after = await Promise.all(filenames.map(optionalStat));
		// A live harness may checkpoint between the size check and the copy; a later
		// attempt over an idle store yields a consistent snapshot. The source stays untouched.
		if (before.every((stat, i) => sameFile(stat, after[i]))) return filename;
		await fs.rm(`${filename}-wal`, { force: true });
	}
	throw failure(
		"SQLite snapshot",
		source,
		"database or WAL still changing after three stable-copy attempts; stop source writes before importing",
	);
}

/** Verify the WAL copied into the private snapshot is fully committed and applied. */
async function validateWalVisibility(filename: string, pageCount: number, source: string): Promise<void> {
	const wal = await Bun.file(`${filename}-wal`)
		.bytes()
		.catch(() => null);
	if (wal === null || wal.length === 0) return;
	if (wal.length < 32)
		throw failure("SQLite WAL", source, "incomplete WAL header; stop source writes and retry import");
	const view = new DataView(wal.buffer, wal.byteOffset, wal.byteLength);
	const magic = view.getUint32(0);
	if ((magic !== 0x377f0682 && magic !== 0x377f0683) || view.getUint32(4) !== 3007000) {
		throw failure("SQLite WAL", source, "unsupported WAL header");
	}
	const pageSize = view.getUint32(8);
	if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
		throw failure("SQLite WAL", source, "invalid WAL page size");
	}
	const dbHeader = await Bun.file(filename).slice(0, 18).arrayBuffer();
	const storedPageSize = new DataView(dbHeader).getUint16(16);
	if ((storedPageSize === 1 ? 65536 : storedPageSize) !== pageSize) {
		throw failure("SQLite WAL", source, "WAL page size does not match database");
	}
	const littleEndian = magic === 0x377f0682;
	let sum0 = 0;
	let sum1 = 0;
	const checksum = (start: number, end: number): void => {
		for (let offset = start; offset < end; offset += 8) {
			sum0 = (sum0 + view.getUint32(offset, littleEndian) + sum1) >>> 0;
			sum1 = (sum1 + view.getUint32(offset + 4, littleEndian) + sum0) >>> 0;
		}
	};
	checksum(0, 24);
	if (sum0 !== view.getUint32(24) || sum1 !== view.getUint32(28)) {
		throw failure("SQLite WAL", source, "WAL header checksum mismatch");
	}
	const stride = pageSize + 24;
	let committedPages = 0;
	for (let offset = 32; offset + stride <= wal.length; offset += stride) {
		// A reused WAL can retain old frames after its current salt-delimited end.
		if (view.getUint32(offset + 8) !== view.getUint32(16) || view.getUint32(offset + 12) !== view.getUint32(20))
			break;
		checksum(offset, offset + 8);
		checksum(offset + 24, offset + stride);
		if (sum0 !== view.getUint32(offset + 16) || sum1 !== view.getUint32(offset + 20)) {
			throw failure("SQLite WAL", source, "WAL frame checksum mismatch; snapshot is incomplete");
		}
		if (view.getUint32(offset) === 0) throw failure("SQLite WAL", source, "invalid WAL page number");
		if (view.getUint32(offset + 4) !== 0) committedPages = view.getUint32(offset + 4);
	}
	// A read-only WAL connection replays exactly the checksummed prefix; if SQLite
	// ignored frames the private snapshot would be short of committed pages.
	if (committedPages !== 0 && pageCount !== committedPages)
		throw failure("SQLite WAL", source, "committed WAL was not fully applied to private read snapshot");
}

async function withDatabase<T>(
	source: string,
	action: (db: Database, metadata: SqlMetadata) => T | Promise<T>,
): Promise<T> {
	return atStage("SQLite snapshot", source, async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-deepseek-"));
		let db: Database | undefined;
		try {
			const filename = await snapshotDatabaseFiles(source, directory);
			// Never open the source: SQLite may create SHM even for a read-only WAL connection.
			db = new Database(filename, { readonly: true, strict: true, safeIntegers: true });
			db.exec("BEGIN");
			const pageRow = db.query<{ page_count: number | bigint | null }, []>("PRAGMA page_count").get();
			const pageCount = Number(pageRow?.page_count ?? 0);
			await validateWalVisibility(filename, pageCount, source);
			const metadata = validateSchema(db, source);
			const result = await action(db, metadata);
			db.exec("COMMIT");
			return result;
		} finally {
			try {
				db?.close();
			} finally {
				await fs.rm(directory, { recursive: true, force: true });
			}
		}
	});
}

/** Reads first-party nested logs and the supported local SQLite backend without opening source SQLite files. */
export class DeepSeekSources {
	readonly #home: string;
	readonly #sessionsRoot: string;
	readonly #database: string;
	readonly #databaseFallback: string;

	constructor(home: string) {
		this.#home = path.resolve(home);
		this.#sessionsRoot = path.join(this.#home, "sessions");
		this.#database = path.join(this.#home, "sessions.sqlite");
		// Released harness builds store the canonical database inside sessions/; older layouts keep it at the root.
		this.#databaseFallback = path.join(this.#sessionsRoot, "sessions.sqlite");
	}

	/** First existing canonical database: root layout, then the newer sessions/ layout. */
	async #databasePath(): Promise<string | undefined> {
		if ((await optionalStat(this.#database)) !== null) return this.#database;
		return (await optionalStat(this.#databaseFallback)) !== null ? this.#databaseFallback : undefined;
	}

	async #files(): Promise<FileSource[]> {
		return atStage("discovery", this.#sessionsRoot, async () => {
			const files: FileSource[] = [];
			for (const project of await entries(this.#sessionsRoot)) {
				if (!project.isDirectory()) continue;
				for (const session of await entries(path.join(this.#sessionsRoot, project.name))) {
					if (!session.isDirectory()) continue;
					const directory = path.join(this.#sessionsRoot, project.name, session.name);
					let selected: { filename: string; generation: number } | undefined;
					for (const file of await entries(directory)) {
						if (!file.isFile()) continue;
						const version = generation(file.name);
						if (version === undefined) continue;
						if (
							selected === undefined ||
							version > selected.generation ||
							(version === selected.generation &&
								selected.filename.endsWith(".zstd") &&
								!file.name.endsWith(".zstd"))
						) {
							selected = { filename: file.name, generation: version };
						}
					}
					if (selected === undefined) continue;
					const filename = path.join(directory, selected.filename);
					const value = await atStage("header decode", filename, () => boundedHeader(filename));
					const classification = classifyHeader(value, filename);
					if (classification.storedVersion !== selected.generation)
						throw failure(
							"header decode",
							filename,
							"header version disagrees with canonical filename generation",
						);
					const stat = await fs.stat(filename);
					files.push({
						path: filename,
						generation: selected.generation,
						headerValue: value,
						...classification,
						modified: stat.mtimeMs,
					});
				}
			}
			return files;
		});
	}

	/** Header-only file discovery and indexed SQLite metadata; no transcript bodies are parsed. */
	async list(): Promise<ForeignSessionInfo[]> {
		const database = await this.#databasePath();
		const result = new Map<string, ForeignSessionInfo>();
		if (database !== undefined) {
			const sql = await withDatabase(database, db => {
				const sessions = sqlSessions(db, database);
				for (const session of sessions) validateHead(db, session, sqlLocator(database, session.header.id));
				return sessions;
			});
			for (const session of sql) {
				if (result.has(session.header.id)) throw failure("discovery", database, "duplicate logical session ID");
				result.set(session.header.id, {
					source: "deepseek",
					id: session.header.id,
					path: sqlLocator(database, session.header.id),
					cwd: session.header.cwd ?? "",
					created: new Date(session.header.createdAt),
					modified: new Date(session.modified),
					messageCount: session.messageCount,
					...(session.title === undefined ? {} : { title: session.title }),
					...(session.firstMessage === undefined ? {} : { firstMessage: session.firstMessage }),
				});
			}
		}
		for (const file of await this.#files()) {
			if (result.get(file.header.id)?.path.startsWith(SQLITE_PREFIX)) continue;
			if (result.has(file.header.id))
				throw failure("discovery", file.path, "duplicate logical session ID in canonical file directories");
			result.set(file.header.id, {
				source: "deepseek",
				id: file.header.id,
				path: file.path,
				cwd: file.header.cwd ?? "",
				created: new Date(file.header.createdAt),
				modified: new Date(file.modified),
			});
		}
		return [...result.values()].sort((a, b) => b.modified.getTime() - a.modified.getTime());
	}

	async #readSelected(
		info: ForeignSessionInfo,
		files: readonly FileSource[],
		database: string,
		db?: Database,
		metadata?: SqlMetadata,
	): Promise<DeepSeekSourceSnapshot> {
		const sessions = db === undefined ? [] : sqlSessions(db, database);
		const sql = sessions.find(session => session.header.id === info.id);
		const locator = info.path.startsWith(SQLITE_PREFIX) ? parseLocator(info.path) : undefined;
		if (locator !== undefined && (locator.database !== database || locator.id !== info.id)) {
			throw failure("locator", info.path, "locator does not belong to this DeepSeek source root and logical ID");
		}
		if (locator !== undefined && sql === undefined)
			throw failure(
				"SQLite read",
				info.path,
				"selected canonical session no longer exists; stale files will not be used",
			);
		const file = files.find(candidate => candidate.header.id === info.id);
		if (sql === undefined && file === undefined)
			throw failure("discovery", info.path, "selected session has no supported nested canonical source");
		const source = sql === undefined ? file!.path : sqlLocator(database, sql.header.id);
		const storedVersion = sql?.storedVersion ?? file!.storedVersion;
		const header = sql?.header ?? file!.header;
		const physical = await atStage("physical decode", source, () =>
			sql === undefined ? readFileArtifact(file!) : readSqlArtifact(db!, sql, database),
		);
		const classification = classifyHeader(physical.headerValue, source);
		if (classification.header.id !== info.id || classification.storedVersion !== storedVersion)
			throw failure("snapshot", source, "selected header changed during discovery");
		const snapshotHash = new Bun.CryptoHasher("sha256").update(JSON.stringify(physical.headerValue)).update("\n");
		for (const row of physical.rows) snapshotHash.update(JSON.stringify(row)).update("\n");
		let selectedPhysical = physical;
		if (sql !== undefined && storedVersion === 4) {
			const adopted = adoptDeepSeekEventShapes(physical.rows as readonly SessionFormatEvent[]);
			selectedPhysical = { ...physical, rows: adopted.events, shapeRepairs: adopted.repairs };
		}
		if (storedVersion === 0) {
			const adopted = adoptDeepSeekV0SourceShapes(selectedPhysical.rows as readonly SessionFormatEvent[]);
			selectedPhysical = {
				...selectedPhysical,
				rows: adopted.events,
				shapeRepairs: { ...selectedPhysical.shapeRepairs, ...adopted.repairs },
			};
		}
		const children: SessionFormatJsonValue[] = [];
		if (storedVersion < 4) {
			const canonical = new Map<string, FileSource | SqlSession>();
			for (const child of files) {
				if (canonical.has(child.header.id))
					throw failure("child evidence", child.path, "duplicate canonical child identity");
				canonical.set(child.header.id, child);
			}
			for (const child of sessions) canonical.set(child.header.id, child);
			for (const child of canonical.values()) {
				if (child.header.origin !== "subagent" || child.header.parentSession !== header.id) continue;
				const childSource = "row" in child ? sqlLocator(database, child.header.id) : child.path;
				const evidence = await atStage("child evidence", childSource, async () => {
					let childPhysical =
						"row" in child ? readSqlArtifact(db!, child, childSource) : await readFileArtifact(child);
					if ("row" in child && child.storedVersion === 4)
						childPhysical = {
							...childPhysical,
							rows: adoptDeepSeekEventShapes(childPhysical.rows as readonly SessionFormatEvent[]).events,
						};
					if (child.storedVersion === 0)
						childPhysical = {
							...childPhysical,
							rows: adoptDeepSeekV0SourceShapes(childPhysical.rows as readonly SessionFormatEvent[]).events,
						};
					const artifact = restoreArtifact(
						childPhysical,
						child.storedVersion < 4 ? historicalSessionFormatCatalog : sessionFormatCatalog,
						childSource,
					);
					if (
						artifact.header.origin !== "subagent" ||
						artifact.header.parentSession !== header.id ||
						artifact.header.id !== child.header.id
					) {
						throw failure(
							"child evidence",
							childSource,
							"child header changed or does not identify a direct subagent child",
						);
					}
					return historicalChildCatalogSource(artifact);
				});
				children.push(evidence);
			}
		}
		const artifact = await atStage("logical migration", source, () =>
			restoreArtifact(
				selectedPhysical,
				storedVersion < 4 ? createSessionFormatCatalogWithChildren(children) : sessionFormatCatalog,
				source,
			),
		);
		// Some SQLite builds never populate f_seed_length for v4; the decoded seed marker
		// is authoritative there. When a stored count exists it must still agree.
		if (
			sql !== undefined &&
			sql.seedLength !== null &&
			storedVersion === 4 &&
			artifact.inheritedEventCount !== sql.seedLength
		) {
			throw failure("SQLite head", source, "stored inherited prefix disagrees with decoded seed marker");
		}
		return {
			...artifact,
			storedVersion,
			kind: sql === undefined ? "jsonl" : "sqlite",
			metadata: {
				...(sql === undefined
					? { originalPath: file!.path }
					: {
							...metadata,
							databasePath: database,
							archivedAt: sql.row.f_archived_at === null ? null : Number(sql.row.f_archived_at),
							incarnation: sql.row.f_incarnation,
							revision: Number(sql.row.f_revision),
							headEventId: sql.headEventId,
							headSequence: sql.headSequence,
						}),
				logicalSessionId: artifact.header.id,
				sourceCwd: artifact.header.cwd,
				storedVersion,
				migratedVersion: artifact.header.version,
				parentSession: artifact.header.parentSession,
				origin: artifact.header.origin,
				inheritedEventCount: artifact.inheritedEventCount,
				shapeRepairs: selectedPhysical.shapeRepairs,
				childEvidenceCount: children.length,
				originalEventCount: physical.rows.length,
				originalSnapshotSha256: snapshotHash.digest("hex"),
			},
		};
	}

	async read(info: ForeignSessionInfo): Promise<DeepSeekSourceSnapshot> {
		return atStage("read", info.path, async () => {
			if (info.source !== "deepseek") throw failure("locator", info.path, "not a DeepSeek session");
			if (!info.path.startsWith(SQLITE_PREFIX)) {
				const relative = path.relative(this.#sessionsRoot, path.resolve(info.path));
				const components = relative.split(path.sep);
				if (
					components.length !== 3 ||
					components.some(component => component === ".." || component.length === 0) ||
					generation(components[2]) === undefined
				) {
					throw failure(
						"layout",
						info.path,
						"unsupported layout; expected sessions/<project>/<session-id>/session[.vN].jsonl[.zstd] (flat logs are unsupported)",
					);
				}
			}
			const files = await this.#files();
			const database = await this.#databasePath();
			if (database !== undefined) {
				return withDatabase(database, (db, metadata) => this.#readSelected(info, files, database, db, metadata));
			}
			if (info.path.startsWith(SQLITE_PREFIX))
				throw failure("SQLite read", info.path, "canonical database is missing; stale files will not be used");
			return this.#readSelected(info, files, this.#database);
		});
	}
}
