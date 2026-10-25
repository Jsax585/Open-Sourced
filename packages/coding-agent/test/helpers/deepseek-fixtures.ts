import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionFormatEvent } from "@deepseek-ai/dsh-session-format";
import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";

export const DEEPSEEK_FIXTURE_TIME = 1_767_225_600_000;

export function deepseekHeader(id: string, cwd: string, version = 4): Record<string, unknown> {
	const header = { version, id, cwd, createdAt: DEEPSEEK_FIXTURE_TIME, delegationDepth: 0 };
	if (version === 4) return sessionFormatCatalog.encodeCurrentHeader({ ...header, isSeeded: false }, 0);
	return { type: "session", ...header, ...(version >= 2 ? { isSeeded: false } : {}) };
}

export function deepseekEvent(type: string, data: unknown, seq: number, surfaceOp?: unknown): Record<string, unknown> {
	return {
		type,
		seq,
		time: DEEPSEEK_FIXTURE_TIME + seq * 1_000,
		data,
		...(surfaceOp === undefined ? {} : { surfaceOp }),
	};
}

export async function writeDeepSeekLog(
	root: string,
	options: {
		id: string;
		cwd: string;
		events: Record<string, unknown>[];
		version?: number;
		compressed?: boolean;
	},
): Promise<string> {
	const version = options.version ?? 4;
	const filename = version === 0 ? "session.jsonl" : `session.v${version}.jsonl`;
	const file = path.join(root, "sessions", "project-key-is-not-cwd", encodeURIComponent(options.id), filename);
	const records = [
		deepseekHeader(options.id, options.cwd, version),
		...options.events.map(event =>
			version === 4 ? sessionFormatCatalog.encodeCurrentEvent(event as unknown as SessionFormatEvent) : event,
		),
	];
	const text = `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
	const destination = options.compressed ? `${file}.zstd` : file;
	await Bun.write(destination, options.compressed ? Bun.zstdCompressSync(text) : text);
	return destination;
}

/** SQLite schema shipped by @morlay/session-rdb 0.1.5 (entities/v3). No backend runtime is loaded. */
export async function writeDeepSeekDatabase(
	root: string,
	sessions: {
		id: string;
		cwd: string;
		events: Record<string, unknown>[];
		version?: number;
		title?: string;
		seedLength?: number;
	}[],
): Promise<string> {
	await fs.mkdir(root, { recursive: true });
	const file = path.join(root, "sessions.sqlite");
	const db = new Database(file, { create: true });
	try {
		db.exec(`
			PRAGMA application_id = 0x44534850;
			PRAGMA user_version = 3;
			CREATE TABLE t_sessions (
				f_id INTEGER PRIMARY KEY AUTOINCREMENT, f_session_id TEXT NOT NULL UNIQUE,
				f_head_event_id TEXT NOT NULL DEFAULT '', f_head_sequence INTEGER NOT NULL DEFAULT -1,
				f_version INTEGER NOT NULL, f_created_at INTEGER NOT NULL, f_cwd TEXT, f_parent_session TEXT,
				f_seed_length INTEGER, f_origin TEXT, f_delegation_depth INTEGER, f_agent_preset TEXT,
				f_incarnation TEXT NOT NULL, f_revision INTEGER NOT NULL, f_archived_at INTEGER,
				f_pinned_seq INTEGER, f_last_event_at INTEGER, f_title TEXT, f_title_seq INTEGER
			);
			CREATE TABLE t_events (
				f_id INTEGER PRIMARY KEY AUTOINCREMENT, f_event_id TEXT NOT NULL UNIQUE,
				f_parent_id TEXT NOT NULL DEFAULT '', f_type TEXT NOT NULL DEFAULT '',
				f_kind TEXT NOT NULL DEFAULT '', f_role TEXT NOT NULL DEFAULT '', f_name TEXT NOT NULL DEFAULT '',
				f_action_id TEXT NOT NULL DEFAULT '', f_encoding TEXT NOT NULL DEFAULT '', f_data TEXT NOT NULL,
				f_created_at INTEGER NOT NULL DEFAULT 0
			);
			CREATE INDEX idx_events_kind ON t_events(f_kind);
			CREATE INDEX idx_events_role ON t_events(f_role);
			CREATE INDEX idx_events_name ON t_events(f_name);
			CREATE INDEX idx_events_action_id ON t_events(f_action_id);
			CREATE TABLE t_session_events (
				f_id INTEGER PRIMARY KEY AUTOINCREMENT,
				f_session_id TEXT NOT NULL REFERENCES t_sessions(f_session_id) ON DELETE CASCADE,
				f_event_id TEXT NOT NULL REFERENCES t_events(f_event_id) ON DELETE CASCADE,
				f_sequence INTEGER NOT NULL, f_surface_op TEXT,
				CONSTRAINT uq_session_events_session_sequence UNIQUE(f_session_id, f_sequence)
			);
			CREATE INDEX idx_session_events_event_id ON t_session_events(f_event_id);
			CREATE TABLE t_persistence_state (
				f_singleton INTEGER PRIMARY KEY CHECK(f_singleton = 1), f_store_id TEXT NOT NULL
			);
			CREATE TABLE t_schema_meta (f_key TEXT PRIMARY KEY, f_value TEXT NOT NULL);
			INSERT INTO t_persistence_state VALUES (1, 'deterministic-deepseek-test-store');
		`);
		const insertSession = db.query(`INSERT INTO t_sessions (
			f_session_id, f_head_event_id, f_head_sequence, f_version, f_created_at, f_cwd,
			f_delegation_depth, f_incarnation, f_revision, f_last_event_at, f_title, f_seed_length
		) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?)`);
		const insertEvent = db.query(`INSERT INTO t_events
			(f_event_id, f_parent_id, f_type, f_encoding, f_data, f_created_at) VALUES (?, ?, ?, 'json', ?, ?)`);
		const insertBridge = db.query(`INSERT INTO t_session_events
			(f_session_id, f_event_id, f_sequence, f_surface_op) VALUES (?, ?, ?, ?)`);
		db.transaction(() => {
			for (const session of sessions) {
				const last = session.events.length - 1;
				insertSession.run(
					session.id,
					last < 0 ? "" : `${session.id}:event:${last}`,
					last,
					session.version ?? 4,
					DEEPSEEK_FIXTURE_TIME,
					session.cwd,
					`${session.id}:incarnation`,
					last < 0 ? null : Number(session.events[last].time),
					session.title ?? null,
					session.seedLength ?? null,
				);
				for (const [seq, event] of session.events.entries()) {
					const eventId = `${session.id}:event:${seq}`;
					insertEvent.run(
						eventId,
						seq === 0 ? "" : `${session.id}:event:${seq - 1}`,
						String(event.type),
						JSON.stringify(event),
						Number(event.time),
					);
					insertBridge.run(
						session.id,
						eventId,
						seq,
						event.surfaceOp === undefined ? null : JSON.stringify(event.surfaceOp),
					);
				}
			}
		})();
	} finally {
		db.close();
	}
	return file;
}
