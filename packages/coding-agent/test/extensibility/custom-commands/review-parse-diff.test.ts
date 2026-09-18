import { describe, expect, it } from "bun:test";
import { parseDiff } from "../../../src/extensibility/custom-commands/bundled/review";

// Mode 2 of /review concatenates `git diff` and `git diff --cached`. A file edited
// both staged and unstaged appears in each, producing two entries for one path.
const unstaged = `diff --git a/f.txt b/f.txt
index d936d3a..317d605 100644
--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,3 @@
 line1
 STAGED
+UNSTAGED
`;

const staged = `diff --git a/f.txt b/f.txt
index c0d0fb4..d936d3a 100644
--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,2 @@
 line1
-line2
+STAGED
`;

describe("parseDiff", () => {
	it("merges a path appearing in both the staged and unstaged diff", () => {
		const stats = parseDiff(`${unstaged}\n${staged}`);

		// Two entries for one file would inflate the coverage denominator and make
		// a complete review look incomplete.
		expect(stats.files).toHaveLength(1);
		expect(stats.files[0]?.path).toBe("f.txt");
	});

	it("sums line counts across the merged entries", () => {
		const stats = parseDiff(`${unstaged}\n${staged}`);

		expect(stats.files[0]?.linesAdded).toBe(2);
		expect(stats.files[0]?.linesRemoved).toBe(1);
		expect(stats.totalAdded).toBe(2);
		expect(stats.totalRemoved).toBe(1);
	});

	it("keeps both hunk sets so the reviewer sees every change", () => {
		const stats = parseDiff(`${unstaged}\n${staged}`);
		const hunks = stats.files[0]?.hunks ?? "";

		// Dropping either set hides real changes from the reviewer.
		expect(hunks).toContain("+UNSTAGED");
		expect(hunks).toContain("+STAGED");
	});

	it("still separates genuinely distinct files", () => {
		const other = staged.replaceAll("f.txt", "g.txt");
		const stats = parseDiff(`${unstaged}\n${other}`);

		expect(stats.files.map(f => f.path).sort()).toEqual(["f.txt", "g.txt"]);
	});

	it("merges duplicates among excluded files too", () => {
		const lock = unstaged.replaceAll("f.txt", "bun.lock");
		const lockAgain = staged.replaceAll("f.txt", "bun.lock");
		const stats = parseDiff(`${lock}\n${lockAgain}`);

		expect(stats.files).toHaveLength(0);
		expect(stats.excluded).toHaveLength(1);
		expect(stats.excluded[0]?.linesAdded).toBe(2);
	});
});
