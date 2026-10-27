import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import type { SingleResult, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { taskToolRenderer } from "@oh-my-pi/pi-tui/tools/task";

describe("task renderer: isolation artifact visibility", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		setThemeInstance(theme!);
	});

	function makeResult(overrides: Partial<SingleResult>): SingleResult {
		return {
			index: 0,
			id: "artifacts",
			agent: "task",
			agentSource: "bundled",
			task: "do work",
			assignment: "do work",
			description: "do work",
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 250,
			tokens: 0,
			requests: 0,
			...overrides,
		};
	}

	async function renderResultText(result: SingleResult): Promise<string> {
		const theme = (await getThemeByName("dark"))!;
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [result],
			totalDurationMs: 250,
		};
		const component = taskToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: false, spinnerFrame: 0 },
			theme,
		);
		return Bun.stripANSI(component.render(160).join("\n"));
	}

	it("keeps root and nested artifact paths visible after sanitization", async () => {
		const text = await renderResultText(
			makeResult({
				patchPath: "/home/user/.omp/artifacts/Worker.patch",
				nestedPatchPaths: ["/home/user/.omp/artifacts/Worker.nested-0-inner.patch"],
			}),
		);
		expect(text).toContain("Worker.patch");
		expect(text).toContain("Worker.nested-0-inner.patch");
	});

	it("keeps the branch name visible after sanitization", async () => {
		const text = await renderResultText(makeResult({ branchName: "omp/task/Worker" }));
		expect(text).toContain("omp/task/Worker");
	});

	it("hides the empty root Patch row for nested-only work", async () => {
		const text = await renderResultText(
			makeResult({
				patchPath: "/home/user/.omp/artifacts/Worker.patch",
				hasRootChanges: false,
				nestedPatchPaths: ["/home/user/.omp/artifacts/Worker.nested-0-inner.patch"],
			}),
		);
		expect(text).not.toContain("Worker.patch");
		expect(text).toContain("Worker.nested-0-inner.patch");
	});
});
