import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isSqliteStoreWriteLocked, openSqliteDatabase } from "@oh-my-pi/pi-utils/sqlite";
import { TempDir } from "@oh-my-pi/pi-utils/temp";

describe("sqlite quarantine write-lock probe", () => {
	test("sees another connection's open write transaction", async () => {
		await using tempDir = await TempDir.create("@omp-sqlite-quarantine-");
		const dbPath = tempDir.join("store.db");

		const writer = new Database(dbPath);
		writer.run("PRAGMA journal_mode=WAL");
		writer.run("CREATE TABLE probe (value TEXT)");
		writer.run("INSERT INTO probe (value) VALUES ('held')");
		writer.run("BEGIN IMMEDIATE");
		try {
			expect(isSqliteStoreWriteLocked(dbPath)).toBe(true);
		} finally {
			writer.run("ROLLBACK");
			writer.close();
		}

		expect(isSqliteStoreWriteLocked(dbPath)).toBe(false);
	});

	test("recovery is not pinned behind a writer that never releases the lock", async () => {
		await using tempDir = await TempDir.create("@omp-sqlite-quarantine-");
		const dbPath = tempDir.join("store.db");

		const seeded = new Database(dbPath);
		seeded.run("PRAGMA journal_mode=WAL");
		seeded.run("CREATE TABLE seeded (value TEXT)");
		seeded.run("PRAGMA wal_checkpoint(TRUNCATE)");
		seeded.close();
		const damaged = await Bun.file(dbPath).bytes();
		// Corrupt the schema page's b-tree type: the file opens, its tables do not read.
		damaged[100] = 0xff;
		await Bun.write(dbPath, damaged);

		const holder = new Database(dbPath);
		holder.run("BEGIN IMMEDIATE");
		try {
			const started = Bun.nanoseconds();
			const initialized = await openSqliteDatabase(
				dbPath,
				db => {
					db.run("CREATE TABLE IF NOT EXISTS replacement (value TEXT)");
					return "initialized";
				},
				{ recoverCorruption: true },
			);
			// Waiting is bounded: a peer that holds the write lock for the whole call
			// delays the replacement but can never pin recovery.
			expect(initialized).toBe("initialized");
			const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;
			expect(elapsedMs).toBeGreaterThanOrEqual(200);
			expect(elapsedMs).toBeLessThan(5_000);
			const prefix = `${path.basename(dbPath)}.corrupt-`;
			const preserved = (await fs.readdir(path.dirname(dbPath))).filter(
				name =>
					name.startsWith(prefix) &&
					!name.endsWith("-wal") &&
					!name.endsWith("-shm") &&
					!name.endsWith("-journal"),
			);
			expect(preserved).toHaveLength(1);
		} finally {
			holder.run("ROLLBACK");
			holder.close();
		}
	});
});
