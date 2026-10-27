import { beforeAll, describe, expect, it } from "bun:test";
import { editToolRenderer } from "@oh-my-pi/pi-tui/tools/edit";
import { getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-tui/theme";
import { readToolRenderer } from "@oh-my-pi/pi-tui/tools/read";
import { writeToolRenderer } from "@oh-my-pi/pi-tui/tools/write";
import type { Component } from "@oh-my-pi/pi-tui";

interface InvalidPathCase {
	readonly name: string;
	readonly path: unknown;
}

const invalidPathCases: readonly InvalidPathCase[] = [
	{ name: "array path", path: ["src/example.ts"] },
	{ name: "object path", path: { value: "src/example.ts" } },
];

let uiTheme: Theme;

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("dark theme missing");
	uiTheme = theme;
});

function renderPlain(component: Component, width = 120): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

describe("tool path renderers with invalid provider arguments", () => {
	for (const invalid of invalidPathCases) {
		it(`read renderer preserves content with ${invalid.name}`, () => {
			const component = readToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "hello from read" }],
					details: {
						displayContent: { text: "hello from read", startLine: 1 },
						contentType: "text/plain",
					},
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ path: invalid.path },
			);
			expect(renderPlain(component)).toContain("hello from read");
		});

		it(`write renderer preserves content with ${invalid.name}`, () => {
			const call = writeToolRenderer.renderCall(
				{ path: invalid.path, content: "first line\nsecond line" },
				{ expanded: false, isPartial: true, spinnerFrame: 0 },
				uiTheme,
			);
			expect(renderPlain(call!)).toContain("second line");

			const result = writeToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "Wrote file" }],
					details: { resolvedPath: "/tmp/example.ts" },
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ path: invalid.path, content: "first line\nsecond line" },
			);
			expect(renderPlain(result)).toContain("first line");
		});

		it(`edit renderer preserves the diff with ${invalid.name}`, () => {
			const component = editToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "updated" }],
					details: { diff: "-before\n+after" },
				},
				{ expanded: false, isPartial: false, renderContext: { editMode: "replace" } },
				uiTheme,
				{ path: invalid.path, oldText: "before", newText: "after" },
			);
			const rendered = renderPlain(component);
			expect(rendered).toContain("before");
			expect(rendered).toContain("after");
		});
	}
});
