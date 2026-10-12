import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { sessionToolRenderer } from "../src/tools/session";

const opts = { expanded: false, isPartial: false };

describe("session tool renderer", () => {
	it("shows worktree paths relative to the home directory, in the call and in the result", () => {
		const worktree = path.join(os.homedir(), ".omp", "wt", "login");
		const result = sessionToolRenderer.describeResult(
			{
				content: [
					{
						type: "text",
						text: `${worktree}  [login]\n${worktree}-b  [other, uncommitted changes] (this session)`,
					},
				],
				details: { op: "worktree_list" },
			},
			opts,
		);
		const call = sessionToolRenderer.describeCall({ op: "worktree_remove", path: worktree });

		const rendered = JSON.stringify({ result, call });
		expect(rendered).toContain("~/.omp/wt/login");
		expect(rendered).toContain("~/.omp/wt/login-b");
		expect(rendered).not.toContain(os.homedir());
	});

	it("shortens paths in error output, keeps home paths with spaces intact, and strips terminal control sequences", () => {
		const spaced = path.join(os.homedir(), "my dir", "wt");
		const error = sessionToolRenderer.describeResult(
			{
				content: [{ type: "text", text: `Directory does not exist: ${spaced}` }],
				isError: true,
				details: { op: "move" },
			},
			opts,
		);
		const created = sessionToolRenderer.describeResult(
			{
				content: [{ type: "text", text: `Created worktree ${spaced} on branch x` }],
				details: { op: "worktree_create" },
			},
			opts,
		);
		const call = sessionToolRenderer.describeCall({ op: "rename", title: "a\u001b[2Jb" });

		const rendered = JSON.stringify({ error, created, call });
		expect(rendered).toContain("~/my dir/wt");
		expect(rendered).not.toContain(os.homedir());
		expect(rendered).not.toContain("\u001b");
	});

	it("bounds the call preview for very long branch and path arguments", () => {
		const long = "x".repeat(5000);
		for (const args of [
			{ op: "worktree_create", branch: long },
			{ op: "worktree_remove", path: long },
			{ op: "move", path: long },
		] as const) {
			expect(JSON.stringify(sessionToolRenderer.describeCall(args)).length).toBeLessThan(1000);
		}
	});
});
