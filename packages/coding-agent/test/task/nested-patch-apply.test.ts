import { afterEach, describe, expect, it, vi } from "bun:test";
import { applyEligibleNestedPatches } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

afterEach(() => {
	vi.restoreAllMocks();
});

function result(relativePaths: string[]): SingleResult {
	return {
		index: 0,
		id: "NestedApply",
		agent: "task",
		agentSource: "bundled",
		task: "Do work",
		assignment: "Do work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		nestedPatches: relativePaths.map(relativePath => ({ relativePath, patch: "diff\n" })),
		nestedPatchPaths: ["/artifacts/NestedApply.nested-0-a.patch"],
	};
}

async function apply(relativePaths: string[]): Promise<{ summary: string; unapplied: readonly string[] | undefined }> {
	let unapplied: readonly string[] | undefined;
	const summary = await applyEligibleNestedPatches({
		result: result(relativePaths),
		repoRoot: "/tmp",
		mergeMode: "patch",
		changesApplied: true,
		mergedBranchForNestedPatches: true,
		onUnapplied: paths => {
			unapplied = paths;
		},
	});
	return { summary, unapplied };
}

describe("applyEligibleNestedPatches reports what did not apply", () => {
	it("names the repositories the apply stopped at and the ones it never reached", async () => {
		// The apply goes repo by repo: `b` failed, so `c` was never attempted. `a` is applied and committed.
		vi.spyOn(worktreeModule, "applyNestedPatches").mockRejectedValue(
			new worktreeModule.NestedPatchApplyError(new Error("patch does not apply"), ["b", "c"]),
		);
		const { summary, unapplied } = await apply(["a", "b", "c"]);
		expect(unapplied).toEqual(["b", "c"]);
		expect(summary).toContain("patch does not apply");
	});

	it("treats every repository in the capture as unapplied when the error does not say which failed", async () => {
		// Too many kept cumulative only costs a larger later patch; too few would drop applied-looking work.
		vi.spyOn(worktreeModule, "applyNestedPatches").mockRejectedValue(new Error("disk full"));
		const { unapplied } = await apply(["a", "b", "a"]);
		expect(unapplied).toEqual(["a", "b"]);
	});

	it("reports nothing when every patch applied, even if restoring stashed work warned", async () => {
		vi.spyOn(worktreeModule, "applyNestedPatches").mockResolvedValue(["could not be auto-restored"]);
		const { summary, unapplied } = await apply(["a"]);
		expect(unapplied).toBeUndefined();
		expect(summary).toContain("could not be auto-restored");
	});
});
