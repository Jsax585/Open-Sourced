import { beforeAll, describe, expect, it } from "bun:test";
import { TranscriptSelection } from "@oh-my-pi/pi-tui/components/transcript-selection";
import { parseSgrMouse, type SgrMouseEvent } from "@oh-my-pi/pi-tui/mouse";
import { initThemeSync } from "@oh-my-pi/pi-tui/theme";
import { encodeTextSized, stripTerminalSequences, visibleWidth } from "@oh-my-pi/pi-tui/utils";

function mouse(button: number, col: number, row = 0, release = false): SgrMouseEvent {
	return parseSgrMouse(`\x1b[<${button};${col + 1};${row + 1}${release ? "m" : "M"}`)!;
}

describe("TranscriptSelection", () => {
	beforeAll(() => {
		initThemeSync();
	});

	it("keeps a press pending, then copies a one-cell drag only on release", () => {
		const selection = new TranscriptSelection();
		const rows = ["abc"];
		expect(selection.handle(mouse(0, 0), rows, 12)).toEqual({ handled: true });
		expect(selection.active).toBe(true);
		expect(selection.hasSelection).toBe(true);
		expect(selection.paint(rows, 12)).toEqual(rows);
		expect(selection.handle(mouse(32, 1), rows, 12)).toEqual({ handled: true });
		expect(selection.paint(rows, 12)).not.toEqual(rows);
		expect(selection.handle(mouse(0, 1, 0, true), rows, 12)).toEqual({ handled: true, text: "a" });
		expect(selection.active).toBe(false);
		expect(selection.hasSelection).toBe(true);
		expect(selection.handle(mouse(0, 1, 0, true), rows, 12)).toEqual({ handled: false });
	});

	it("copies exactly the CJK word when the drag head reaches its next display column", () => {
		const selection = new TranscriptSelection();
		const rows = ["│ 需求确认 next"];
		selection.handle(mouse(0, 2), rows, 24);
		selection.handle(mouse(32, 10), rows, 24);
		expect(selection.handle(mouse(0, 10, 0, true), rows, 24)).toEqual({ handled: true, text: "需求确认" });
	});

	it("copies a fast CJK drag on release without an intermediate motion packet", () => {
		const selection = new TranscriptSelection();
		const rows = ["│ 需求确认 next"];
		selection.handle(mouse(0, 2), rows, 24);
		expect(selection.handle(mouse(0, 10, 0, true), rows, 24)).toEqual({ handled: true, text: "需求确认" });
		expect(selection.active).toBe(false);
		expect(selection.paint(rows, 24)).not.toEqual(rows);
	});

	it("snaps a fast backward drag to whole CJK and emoji display cells", () => {
		const selection = new TranscriptSelection();
		const rows = ["a界🙂z"];
		selection.handle(mouse(0, 4), rows, 12);
		expect(selection.handle(mouse(0, 2, 0, true), rows, 12)).toEqual({ handled: true, text: "界🙂" });
	});

	it("orders a fast backward multiline release and strips terminal sequences", () => {
		const selection = new TranscriptSelection();
		const rows = ["\x1b[31mfirst\x1b[0m", "", "\x1b]8;;https://example.com\x1b\\third\x1b]8;;\x1b\\"];
		selection.handle(mouse(0, 3, 2), rows, 8);
		expect(selection.handle(mouse(0, 2, 0, true), rows, 8)).toEqual({ handled: true, text: "rst\n\nthi" });
	});

	it("includes whole CJK and emoji graphemes when either boundary lands in a wide cell", () => {
		const selection = new TranscriptSelection();
		const rows = ["a界🙂z"];
		selection.handle(mouse(0, 2), rows, 12);
		selection.handle(mouse(32, 4), rows, 12);
		expect(selection.handle(mouse(0, 4, 0, true), rows, 12)).toEqual({ handled: true, text: "界🙂" });
	});

	it("does not split a ZWJ emoji, skin-tone modifier, or combining accent", () => {
		const selection = new TranscriptSelection();
		const rows = ["a👩🏽‍💻e\u0301z"];
		selection.handle(mouse(0, 2), rows, 12);
		selection.handle(mouse(32, 4), rows, 12);
		expect(selection.handle(mouse(0, 4, 0, true), rows, 12)).toEqual({ handled: true, text: "👩🏽‍💻e\u0301" });
	});

	it("orders a backward multiline drag and retains empty middle lines without viewport padding", () => {
		const selection = new TranscriptSelection();
		const rows = ["first   ", "        ", "third   "];
		selection.handle(mouse(0, 3, 2), rows, 8);
		selection.handle(mouse(32, 2, 0), rows, 8);
		expect(selection.handle(mouse(0, 2, 0, true), rows, 8)).toEqual({ handled: true, text: "rst\n\nthi" });
	});

	it("copies visible text without SGR, hyperlink targets, or APC payloads", () => {
		const selection = new TranscriptSelection();
		const rows = ["\x1b[31mred\x1b[0m \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\\x1b_cursor\x07"];
		selection.handle(mouse(0, 0), rows, 16);
		selection.handle(mouse(32, 8), rows, 16);
		expect(selection.handle(mouse(0, 8, 0, true), rows, 16)).toEqual({ handled: true, text: "red link" });
	});

	it("returns a click only for a no-drag release at the pressed cell", () => {
		const selection = new TranscriptSelection();
		const rows = ["TSV  CSV  Markdown"];
		selection.handle(mouse(0, 1), rows, 24);
		expect(selection.handle(mouse(0, 1, 0, true), rows, 24)).toEqual({ handled: true, click: { column: 1, row: 0 } });
		expect(selection.handle(mouse(0, 1), rows, 24)).toEqual({ handled: true });
		selection.handle(mouse(32, 1), rows, 24);
		expect(selection.handle(mouse(0, 1, 0, true), rows, 24)).toEqual({ handled: true, click: { column: 1, row: 0 } });
		expect(selection.active).toBe(false);

		selection.handle(mouse(0, 1), rows, 24);
		expect(selection.handle(mouse(0, 6, 0, true), rows, 24)).toEqual({ handled: true, text: "SV  C" });
	});

	it("never turns a drag into a click, even after returning to its origin", () => {
		const selection = new TranscriptSelection();
		const rows = ["TSV  CSV  Markdown"];
		selection.handle(mouse(0, 1), rows, 24);
		selection.handle(mouse(32, 6), rows, 24);
		expect(selection.handle(mouse(0, 6, 0, true), rows, 24)).toEqual({ handled: true, text: "SV  C" });

		selection.handle(mouse(0, 1), rows, 24);
		selection.handle(mouse(32, 6), rows, 24);
		selection.handle(mouse(32, 1), rows, 24);
		expect(selection.handle(mouse(0, 1, 0, true), rows, 24)).toEqual({ handled: true });
		expect(selection.hasSelection).toBe(false);
	});

	it("leaves hover-only motion, vertical and horizontal wheels, and non-primary buttons unhandled", () => {
		const selection = new TranscriptSelection();
		const rows = ["TSV  CSV  Markdown"];
		selection.handle(mouse(0, 1), rows, 24);
		for (const button of [35, 64, 65, 66, 67, 1, 2]) {
			expect(selection.handle(mouse(button, 6), rows, 24)).toEqual({ handled: false });
		}
		expect(selection.paint(rows, 24)).toEqual(rows);
		expect(selection.handle(mouse(0, 1, 0, true), rows, 24)).toEqual({ handled: true, click: { column: 1, row: 0 } });
	});

	it("cancels a drag when the source array is mutated in place before release", () => {
		const selection = new TranscriptSelection();
		const rows = ["before"];
		selection.handle(mouse(0, 0), rows, 12);
		selection.handle(mouse(32, 3), rows, 12);
		rows[0] = "after";
		expect(selection.handle(mouse(0, 3, 0, true), rows, 12)).toEqual({ handled: false });
		expect(selection.active).toBe(false);
		expect(selection.paint(rows, 12)).toEqual(rows);
	});

	it("keeps a pending press, active drag, and retained highlight while unrelated rows stream below", () => {
		const selection = new TranscriptSelection();
		const rows = ["stable text", "stream"];
		selection.handle(mouse(0, 0), rows, 20);
		rows[1] = "stream grows";
		rows.push("another row");
		expect(selection.paint(rows, 20)).toEqual(rows);
		expect(selection.active).toBe(true);
		selection.handle(mouse(32, 6), rows, 20);
		rows[1] = "stream grows again";
		expect(selection.paint(rows, 20)[0]).not.toEqual(rows[0]);
		expect(selection.handle(mouse(0, 6, 0, true), rows, 20)).toEqual({ handled: true, text: "stable" });
		const shorter = [rows[0]!];
		expect(selection.paint(shorter, 20)[0]).not.toEqual(shorter[0]);
		expect(selection.hasSelection).toBe(true);
	});

	it("copies a fast selection while streaming appends after its selected prefix on the same row", () => {
		const selection = new TranscriptSelection();
		const rows = ["a界🙂"];
		selection.handle(mouse(0, 2), rows, 20);
		rows[0] += " streaming";
		expect(selection.handle(mouse(0, 4, 0, true), rows, 20)).toEqual({ handled: true, text: "界🙂" });
		rows[0] += " more";
		expect(selection.paint(rows, 20)[0]).not.toEqual(rows[0]);
		expect(selection.hasSelection).toBe(true);
	});

	it("preserves backward selection when only unselected boundary cells change", () => {
		const selection = new TranscriptSelection();
		const rows = ["xx界🙂", "middle", "end tail"];
		selection.handle(mouse(0, 3, 2), rows, 16);
		selection.handle(mouse(32, 3), rows, 16);
		const changed = ["yy界🙂", "middle", "end growing tail"];
		expect(selection.paint(changed, 16)[0]).not.toEqual(changed[0]);
		expect(selection.handle(mouse(0, 3, 0, true), changed, 16)).toEqual({
			handled: true,
			text: "界🙂\nmiddle\nend",
		});
	});

	it("cancels rather than extending a drag into text that changed outside its previous range", () => {
		const selection = new TranscriptSelection();
		const rows = ["abc old"];
		selection.handle(mouse(0, 0), rows, 16);
		selection.handle(mouse(32, 3), rows, 16);
		rows[0] = "abc new";
		expect(selection.paint(rows, 16)[0]).not.toEqual(rows[0]);
		expect(selection.handle(mouse(0, 7, 0, true), rows, 16)).toEqual({ handled: true });
		expect(selection.hasSelection).toBe(false);
	});

	it("cancels a fast release if newly selected cells changed after the press", () => {
		const selection = new TranscriptSelection();
		const rows = ["abc old"];
		selection.handle(mouse(0, 0), rows, 16);
		rows[0] = "abc new";
		expect(selection.handle(mouse(0, 7, 0, true), rows, 16)).toEqual({ handled: true });
		expect(selection.active).toBe(false);
		expect(selection.hasSelection).toBe(false);
	});

	it("cancels on selected boundary, interior, or coordinate changes and missing endpoints", () => {
		const rows = ["xx界🙂", "middle", "end tail"];
		const changes = [
			["xx語🙂", "middle", "end tail"],
			["xx界🙂", "mutate", "end tail"],
			["xx界🙂", "middle", "new tail"],
			["xxx界🙂", "middle", "end tail"],
			["inserted", ...rows],
			rows.slice(0, 2),
		];
		for (const changed of changes) {
			const selection = new TranscriptSelection();
			selection.handle(mouse(0, 3, 2), rows, 16);
			selection.handle(mouse(32, 3), rows, 16);
			expect(selection.paint(changed, 16)).toEqual(changed);
			expect(selection.hasSelection).toBe(false);
			expect(selection.handle(mouse(0, 3, 0, true), changed, 16)).toEqual({ handled: false });
		}
	});

	it("cancels a retained highlight when its viewport is resized", () => {
		const selection = new TranscriptSelection();
		const rows = ["stable text"];
		selection.handle(mouse(0, 0), rows, 16);
		selection.handle(mouse(0, 6, 0, true), rows, 16);
		expect(selection.paint(rows, 17)).toEqual(rows);
		expect(selection.hasSelection).toBe(false);
	});

	it("cancels pending clicks when the viewport width changes", () => {
		const selection = new TranscriptSelection();
		const rows = ["TSV  CSV"];
		selection.handle(mouse(0, 1), rows, 12);
		expect(selection.handle(mouse(0, 1, 0, true), rows, 13)).toEqual({ handled: false });
		expect(selection.active).toBe(false);
	});

	it("cancels on a repaint whose raw styling changes even when its plain text is identical", () => {
		const selection = new TranscriptSelection();
		const rows = ["\x1b[31mtext\x1b[0m"];
		const changed = ["\x1b[32mtext\x1b[0m"];
		selection.handle(mouse(0, 0), rows, 12);
		selection.handle(mouse(32, 3), rows, 12);
		expect(selection.paint(changed, 12)).toEqual(changed);
		expect(selection.active).toBe(false);
		expect(selection.handle(mouse(0, 3, 0, true), changed, 12)).toEqual({ handled: false });
	});

	it("keeps a selection across identical raw repaint arrays without selecting its own highlight escapes", () => {
		const selection = new TranscriptSelection();
		const rows = ["same text"];
		selection.handle(mouse(0, 0), rows, 12);
		selection.handle(mouse(32, 4), rows, 12);
		const highlighted = selection.paint([...rows], 12);
		expect(highlighted).not.toEqual(rows);
		expect(selection.paint([...rows], 12)).toEqual(highlighted);
		expect(selection.active).toBe(true);
		expect(selection.handle(mouse(0, 4, 0, true), [...rows], 12)).toEqual({ handled: true, text: "same" });
	});

	it("paints styled multiline CJK/emoji text without changing row count, visible text, or cell widths", () => {
		const selection = new TranscriptSelection();
		const rows = ["\x1b[48;2;10;20;30mA界\x1b[0m🙂 tail", "", "\x1b[31m👩🏽‍💻e\u0301 end\x1b[0m"];
		const original = [...rows];
		selection.handle(mouse(0, 2), rows, 16);
		selection.handle(mouse(32, 4, 2), rows, 16);
		const painted = selection.paint(rows, 16);
		expect(painted).not.toEqual(rows);
		expect(painted.map(stripTerminalSequences)).toEqual(rows.map(stripTerminalSequences));
		expect(painted.map(visibleWidth)).toEqual(rows.map(visibleWidth));
		expect(rows).toEqual(original);
	});

	it("keeps scaled terminal spans atomic while copying their visible payload as plain text", () => {
		const selection = new TranscriptSelection();
		const rows = [`A${encodeTextSized("Hi", { scale: 2 })}Z`];
		selection.handle(mouse(0, 2), rows, 12);
		selection.handle(mouse(32, 3), rows, 12);
		expect(selection.paint(rows, 12).map(visibleWidth)).toEqual(rows.map(visibleWidth));
		expect(selection.handle(mouse(0, 3, 0, true), rows, 12)).toEqual({ handled: true, text: "Hi" });
	});

	it("clamps an active drag outside the viewport so the dock cannot enter copied text", () => {
		const selection = new TranscriptSelection();
		const rows = ["alpha", "beta"];
		selection.handle(mouse(0, 1), rows, 8);
		selection.handle(mouse(32, 40, 20), rows, 8);
		expect(selection.handle(mouse(0, 40, 20, true), rows, 8)).toEqual({ handled: true, text: "lpha\nbeta" });
	});

	it("clear removes a completed highlight and cancels a pending press without later copying or clicking", () => {
		const selection = new TranscriptSelection();
		const rows = ["abc"];
		selection.handle(mouse(0, 0), rows, 12);
		selection.handle(mouse(32, 2), rows, 12);
		selection.handle(mouse(0, 2, 0, true), rows, 12);
		expect(selection.paint(rows, 12)).not.toEqual(rows);
		selection.clear();
		expect(selection.hasSelection).toBe(false);
		expect(selection.paint(rows, 12)).toEqual(rows);
		expect(selection.handle(mouse(0, 2, 0, true), rows, 12)).toEqual({ handled: false });

		selection.handle(mouse(0, 0), rows, 12);
		selection.clear();
		expect(selection.active).toBe(false);
		expect(selection.handle(mouse(0, 0, 0, true), rows, 12)).toEqual({ handled: false });
	});
});
