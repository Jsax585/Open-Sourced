import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";

const MAX_DISPLAY_LINE_CHARS = 4000;
let darkTheme: Theme;

beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	expect(loaded).toBeDefined();
	darkTheme = loaded!;
});

describe("BashExecutionComponent #clampDisplayLine", () => {
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

	beforeEach(() => {
		setThemeInstance(darkTheme);
	});

	function createComponentWithOutput(output: string): BashExecutionComponent {
		const component = new BashExecutionComponent("test", ui, false);
		component.appendOutput(output);
		component.setComplete(0, false);
		return component;
	}

	describe("wide glyphs (CJK characters)", () => {
		it("truncates CJK string over limit and calculates omitted correctly", () => {
			const cjkString = "日本語".repeat(2500);
			const expectedVisible = visibleWidth(cjkString);
			const component = createComponentWithOutput(cjkString);
			const output = component.getOutput();

			expect(output.slice(output.lastIndexOf("…"))).toContain(String(expectedVisible - MAX_DISPLAY_LINE_CHARS));
			expect(visibleWidth(output.slice(0, output.lastIndexOf("…")))).toBe(MAX_DISPLAY_LINE_CHARS);
			expect(output).toContain("…");
		});
	});

	describe("ANSI-decorated strings", () => {
		it("calculates omitted count based on visible width, not raw length", () => {
			const ansiString = "\x1b[1;31;47mbold red on white\x1b[0m".repeat(1000);
			const expectedVisible = visibleWidth(ansiString);
			const component = createComponentWithOutput(ansiString);
			const output = component.getOutput();

			expect(expectedVisible).toBeGreaterThan(MAX_DISPLAY_LINE_CHARS);
			const suffix = output.slice(output.lastIndexOf("…"));
			expect(suffix.match(/\d+/)?.[0]).toBe(String(expectedVisible - MAX_DISPLAY_LINE_CHARS));
			expect(visibleWidth(output.slice(0, output.lastIndexOf("…")))).toBe(MAX_DISPLAY_LINE_CHARS);
		});
	});

	describe("truncation with Ellipsis.Omit", () => {
		it("truncates using visibleWidth and truncateToWidth", () => {
			const longAscii = "a".repeat(5000);
			const component = createComponentWithOutput(longAscii);
			const output = component.getOutput();

			expect(output).toContain("…");
			expect(output.length).toBeLessThan(5000);
		});

		it("truncated portion is within MAX_DISPLAY_LINE_CHARS visible width", () => {
			const longString = "hello world ".repeat(1000);
			const component = createComponentWithOutput(longString);
			const output = component.getOutput();

			const truncatedPart = output.slice(0, output.lastIndexOf("…"));
			expect(visibleWidth(truncatedPart)).toBe(MAX_DISPLAY_LINE_CHARS);
		});
	});

	describe("omitted count accuracy", () => {
		it("calculates omitted as visibleWidth(original) - MAX_DISPLAY_LINE_CHARS", () => {
			const testString = "test".repeat(1500);
			const originalVisible = visibleWidth(testString);
			const component = createComponentWithOutput(testString);
			const output = component.getOutput();

			const expectedOmitted = originalVisible - MAX_DISPLAY_LINE_CHARS;
			expect(output.slice(output.lastIndexOf("…")).match(/\d+/)?.[0]).toBe(String(expectedOmitted));
		});

		it("handles mixed content (ASCII + CJK + emoji + ANSI)", () => {
			const mixed = "abc日本語😀\x1b[34mblue\x1b[0m".repeat(500);
			const originalVisible = visibleWidth(mixed);
			const component = createComponentWithOutput(mixed);
			const output = component.getOutput();

			expect(originalVisible).toBeGreaterThan(MAX_DISPLAY_LINE_CHARS);
			const expectedOmitted = originalVisible - MAX_DISPLAY_LINE_CHARS;
			expect(output.slice(output.lastIndexOf("…")).match(/\d+/)?.[0]).toBe(String(expectedOmitted));
			expect(visibleWidth(output.slice(0, output.lastIndexOf("…")))).toBeLessThanOrEqual(MAX_DISPLAY_LINE_CHARS);
		});
	});

	describe("edge cases at, below, and above MAX_DISPLAY_LINE_CHARS", () => {
		it("returns original string when visibleWidth equals MAX_DISPLAY_LINE_CHARS", () => {
			const exactlyAtLimit = "a".repeat(MAX_DISPLAY_LINE_CHARS);
			const component = createComponentWithOutput(exactlyAtLimit);
			const output = component.getOutput();

			expect(output).toBe(exactlyAtLimit);
		});

		it("returns original string when visibleWidth is just below limit", () => {
			const justBelow = "a".repeat(MAX_DISPLAY_LINE_CHARS - 1);
			const component = createComponentWithOutput(justBelow);
			const output = component.getOutput();

			expect(output).toBe(justBelow);
		});

		it("truncates when visibleWidth is just above limit", () => {
			const justAbove = "a".repeat(MAX_DISPLAY_LINE_CHARS + 1);
			const component = createComponentWithOutput(justAbove);
			const output = component.getOutput();

			expect(output.slice(0, output.lastIndexOf("…"))).toBe("a".repeat(MAX_DISPLAY_LINE_CHARS));
			expect(output.slice(output.lastIndexOf("…")).match(/\d+/)?.[0]).toBe("1");
		});

		it("handles empty string", () => {
			const component = createComponentWithOutput("");
			const output = component.getOutput();

			expect(output).toBe("");
		});
	});
});
