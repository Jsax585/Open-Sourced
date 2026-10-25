import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { TempDir } from "@oh-my-pi/pi-utils";
import { readArchiveEntries, writeArchive } from "@oh-my-pi/pi-utils/ar";

describe("archive writes from independent sessions", () => {
	let dir: TempDir;

	beforeEach(async () => {
		dir = await TempDir.create("@write-archive-concurrency-");
	});
	afterEach(async () => {
		await dir.remove();
	});

	function writer(): WriteTool {
		return new WriteTool({
			cwd: dir.path(),
			hasUI: false,
			enableLsp: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => dir.join("artifacts"),
			settings: Settings.isolated({ "edit.mode": "replace" }),
		});
	}

	it.each(["existing", "new", "parent-alias"])(
		"preserves both members for concurrent %s archive writes",
		async kind => {
			const file = dir.join("bundle.zip");
			let secondFile = file;
			if (kind === "existing") {
				await writeArchive(file, "zip", [
					["a.txt", "old a"],
					["b.txt", "old b"],
				]);
			} else if (kind === "parent-alias") {
				const alias = dir.join("alias");
				await fs.symlink(dir.path(), alias, process.platform === "win32" ? "junction" : "dir");
				secondFile = dir.join("alias", "bundle.zip");
			}
			const results = await Promise.allSettled([
				writer().execute("a", { path: `${file}:a.txt`, content: "new a" }),
				writer().execute("b", { path: `${secondFile}:b.txt`, content: "new b" }),
			]);
			const entries = await readArchiveEntries(file);
			const decoded = Object.fromEntries(
				[...entries].map(([name, bytes]) => [name, new TextDecoder().decode(bytes)]),
			);
			expect(decoded).toEqual({ "a.txt": "new a", "b.txt": "new b" });
			expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
		},
	);

	it("releases the archive lease after a failed rewrite so a later write can succeed", async () => {
		const file = dir.join("bundle.zip");
		await writeArchive(file, "zip", [["a.txt", "old a"]]);
		await expect(writer().execute("invalid", { path: `${file}:missing.txt:1-2`, content: "" })).rejects.toThrow();
		await writer().execute("valid", { path: `${file}:a.txt`, content: "new a" });
		expect(new TextDecoder().decode((await readArchiveEntries(file)).get("a.txt"))).toBe("new a");
	});
});
