import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { changedRanges, checkAnchor, clearAnchorCache } from "../../src/tools/review-anchor";

async function git(cwd: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const code = await proc.exited;
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
}

let repo: string;

beforeEach(async () => {
	clearAnchorCache();
	repo = await mkdtemp(path.join(tmpdir(), "anchor-test-"));
	await git(repo, "init", "-q");
	await git(repo, "config", "user.email", "t@t.t");
	await git(repo, "config", "user.name", "t");
	// 20 lines so there is ample room to point outside the patch.
	await writeFile(`${repo}/f.txt`, `${Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")}\n`);
	await git(repo, "add", "f.txt");
	await git(repo, "commit", "-qm", "init");
});

afterEach(async () => {
	clearAnchorCache();
	await rm(repo, { recursive: true, force: true });
});

async function editLine(line: number, text: string): Promise<void> {
	const current = (await Bun.file(`${repo}/f.txt`).text()).split("\n");
	current[line - 1] = text;
	await writeFile(`${repo}/f.txt`, current.join("\n"));
}

describe("changedRanges", () => {
	const diff = `diff --git a/a.ts b/a.ts
index 111..222 100644
--- a/a.ts
+++ b/a.ts
@@ -10,3 +10,4 @@
 keep
+added
 keep
 keep
@@ -40,2 +41,3 @@
 keep
+added
 keep
`;

	it("extracts new-side ranges from every hunk", () => {
		expect(changedRanges(diff, "a.ts")).toEqual([
			{ start: 10, end: 13 },
			{ start: 41, end: 43 },
		]);
	});

	it("ignores hunks belonging to other files", () => {
		expect(changedRanges(diff, "other.ts")).toEqual([]);
	});

	it("gives a pure deletion a landing spot", () => {
		const deletion = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -5,3 +5,0 @@
-gone
-gone
-gone
`;
		// newLines === 0 would otherwise produce an inverted, unmatchable range.
		expect(changedRanges(deletion, "a.ts")).toEqual([{ start: 5, end: 5 }]);
	});
});

describe("checkAnchor", () => {
	it("accepts a range inside the patch", async () => {
		await editLine(5, "CHANGED");
		expect((await checkAnchor(repo, "f.txt", 5, 5)).ok).toBe(true);
	});

	it("rejects a range outside the patch and names the valid ones", async () => {
		await editLine(5, "CHANGED");
		const result = await checkAnchor(repo, "f.txt", 18, 19);

		expect(result.ok).toBe(false);
		// The model needs somewhere to go, not just a refusal.
		expect(result.message).toContain("f.txt:18-19");
		expect(result.message).toMatch(/Changed lines in this file: \d/);
		expect(result.message).toContain("report_finding again");
	});

	it("accepts when the range merely clips the patch", async () => {
		await editLine(5, "CHANGED");
		// Partial overlap is still an anchor the reader can follow.
		expect((await checkAnchor(repo, "f.txt", 1, 6)).ok).toBe(true);
	});

	it("accepts a reversed range", async () => {
		await editLine(5, "CHANGED");
		expect((await checkAnchor(repo, "f.txt", 6, 4)).ok).toBe(true);
	});

	it("accepts staged changes", async () => {
		await editLine(5, "CHANGED");
		await git(repo, "add", "f.txt");
		expect((await checkAnchor(repo, "f.txt", 5, 5)).ok).toBe(true);
	});

	it("accepts a range in any hunk of a multi-hunk file", async () => {
		await editLine(2, "CHANGED");
		await editLine(18, "ALSO CHANGED");
		clearAnchorCache();

		expect((await checkAnchor(repo, "f.txt", 2, 2)).ok).toBe(true);
		expect((await checkAnchor(repo, "f.txt", 18, 18)).ok).toBe(true);
	});

	it("reuses cached ranges for repeated findings on one file", async () => {
		await editLine(5, "CHANGED");
		expect((await checkAnchor(repo, "f.txt", 5, 5)).ok).toBe(true);

		// Revert on disk. A cached result within the TTL still reflects the
		// earlier patch, which is the point: one reviewer's findings are judged
		// against one consistent snapshot.
		await editLine(5, "line5");
		expect((await checkAnchor(repo, "f.txt", 5, 5)).ok).toBe(true);

		// After a clear, the now-clean file yields no ranges, so it fails open.
		clearAnchorCache();
		expect((await checkAnchor(repo, "f.txt", 5, 5)).ok).toBe(true);
	});

	it("accepts an untracked file", async () => {
		await writeFile(`${repo}/new.txt`, "brand new\n");
		// Untracked means no diff, which is not evidence the finding is misplaced.
		expect((await checkAnchor(repo, "new.txt", 1, 1)).ok).toBe(true);
	});

	it("accepts a file with no changes at all", async () => {
		expect((await checkAnchor(repo, "f.txt", 3, 3)).ok).toBe(true);
	});

	it("accepts when there is no cwd", async () => {
		// context is optional in AgentToolExecFn; absence must not reject.
		expect((await checkAnchor(undefined, "f.txt", 999, 999)).ok).toBe(true);
	});

	it("accepts outside a git repository", async () => {
		const plain = await mkdtemp(path.join(tmpdir(), "anchor-norepo-"));
		try {
			await writeFile(`${plain}/f.txt`, "hello\n");
			expect((await checkAnchor(plain, "f.txt", 1, 1)).ok).toBe(true);
		} finally {
			await rm(plain, { recursive: true, force: true });
		}
	});

	it("accepts a nonexistent file rather than rejecting", async () => {
		expect((await checkAnchor(repo, "does/not/exist.ts", 1, 1)).ok).toBe(true);
	});
});
