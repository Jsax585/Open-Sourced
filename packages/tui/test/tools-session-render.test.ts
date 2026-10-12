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
});
