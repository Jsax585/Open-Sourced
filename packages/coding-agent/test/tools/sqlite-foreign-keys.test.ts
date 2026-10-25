import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("SQLite writes enforce declared foreign keys", () => {
	let dir: TempDir;
	let db: Database;
	let file: string;
	let write: WriteTool;

	beforeEach(async () => {
		dir = await TempDir.create("@sqlite-foreign-keys-");
		file = dir.join("records.sqlite");
		db = new Database(file);
		db.run("PRAGMA foreign_keys = ON");
		db.run(`
			CREATE TABLE parents (id INTEGER PRIMARY KEY);
			CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id) ON DELETE CASCADE);
			INSERT INTO parents VALUES (1), (2);
			INSERT INTO children VALUES (1, 1), (2, 2);
		`);
		write = new WriteTool({
			cwd: dir.path(),
			hasUI: false,
			enableLsp: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => dir.join("artifacts"),
			settings: Settings.isolated({ "edit.mode": "replace" }),
		});
	});

	afterEach(async () => {
		db.close();
		await dir.remove();
	});

	it("rejects an orphan insert without leaving invalid data behind", async () => {
		await expect(
			write.execute("insert", { path: `${file}:children`, content: "{id: 3, parent_id: 999}" }),
		).rejects.toThrow("FOREIGN KEY constraint failed");
		expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
		expect(db.query("SELECT id FROM children ORDER BY id").all()).toEqual([{ id: 1 }, { id: 2 }]);
	});

	it("applies ON DELETE CASCADE without deleting unrelated children", async () => {
		await write.execute("delete", { path: `${file}:parents:1`, content: "" });
		expect(db.query("SELECT id FROM children ORDER BY id").all()).toEqual([{ id: 2 }]);
		expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
	});

	it("rejects an orphan update and a restricted parent deletion, preserving both rows", async () => {
		db.run(
			"CREATE TABLE restricted (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id) ON DELETE RESTRICT); INSERT INTO restricted VALUES (1, 1)",
		);
		await expect(
			write.execute("update", { path: `${file}:children:1`, content: "{parent_id: 999}" }),
		).rejects.toThrow("FOREIGN KEY constraint failed");
		await expect(write.execute("restrict", { path: `${file}:parents:1`, content: "" })).rejects.toThrow(
			"FOREIGN KEY constraint failed",
		);
		expect(db.query("SELECT * FROM children WHERE id = 1").get()).toEqual({ id: 1, parent_id: 1 });
		expect(db.query("SELECT id FROM parents ORDER BY id").all()).toEqual([{ id: 1 }, { id: 2 }]);
		expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
	});
});
