import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
	setTranscriptActionHandler,
	setTranscriptMouseEnabled,
	type TranscriptAction,
	type TranscriptActionOptions,
} from "../src/chat/transcript-actions";
import { Markdown } from "../src/components/markdown";
import { Text } from "../src/components/text";
import { Container } from "../src/tui";
import { getMarkdownTheme, initTheme } from "../src/theme";
import { stripTerminalSequences, visibleWidth } from "../src/utils";

beforeAll(async () => {
	await initTheme(false);
	setTranscriptMouseEnabled(true);
});

afterEach(() => {
	setTranscriptActionHandler(undefined);
});

function controls(rows: readonly string[], label: string): { column: number; row: number }[] {
	const out: { column: number; row: number }[] = [];
	for (const [row, styled] of rows.entries()) {
		const text = stripTerminalSequences(styled);
		const at = text.indexOf(label);
		if (at >= 0) out.push({ column: visibleWidth(text.slice(0, at)), row });
	}
	return out;
}

describe("Markdown row table controls", () => {
	it("draws no classic controls and resolves nothing while the pointer layer is off", () => {
		setTranscriptActionHandler(() => {});
		setTranscriptMouseEnabled(false);
		try {
			const markdown = new Markdown("| Name | Value |\n| --- | --- |\n| A | 1 |", 0, 0, getMarkdownTheme());
			const rows = markdown.render(60);
			expect(stripTerminalSequences(rows.join("\n"))).not.toContain("[Copy TSV]");
			expect(markdown.getInlineControlResolver(60)).toBeUndefined();
		} finally {
			setTranscriptMouseEnabled(true);
		}
	});

	it("resolves exact button cells without copying and activates the selected table with its original payload", () => {
		const actions: TranscriptAction[] = [];
		const feedback: (TranscriptActionOptions | undefined)[] = [];
		setTranscriptActionHandler((action, options) => {
			actions.push(action);
			feedback.push(options);
		});
		const first = "| Name | Value |\n| --- | --- |\n| A | a,b |";
		const second = "| Name | Value |\n| --- | --- |\n| β | a\\|b |";
		const source = `${first}\n\nBetween\n\n${second}`;
		const theme = getMarkdownTheme();
		const markdown = new Markdown(source, 2, 1, theme).setIgnoreTight(true);
		const rows = markdown.render(60);
		expect(rows.join("\n")).not.toContain("\x1b]omp-table-");
		expect(actions).toEqual([]);
		expect(markdown.render(60)).toBe(rows);
		const resolve = markdown.getInlineControlResolver(60)!;
		const tsv = controls(rows, "[Copy TSV]")[1]!;
		const csv = controls(rows, "[Copy CSV]")[0]!;
		const md = controls(rows, "[Copy Markdown]")[1]!;
		const tsvControl = resolve(tsv.column, tsv.row)!;
		const csvControl = resolve(csv.column + 2, csv.row)!;
		const markdownControl = resolve(md.column, md.row)!;
		expect(tsvControl).toBeDefined();
		for (let column = tsv.column; column < tsv.column + "[Copy TSV]".length; column++) {
			expect(resolve(column, tsv.row)).toBe(tsvControl);
		}
		expect(tsvControl.row).toBe(tsv.row);
		expect(tsvControl.from).toBe(tsv.column);
		expect(tsvControl.to).toBe(tsv.column + "[Copy TSV]".length);
		expect(csvControl.id).not.toBe(tsvControl.id);
		const firstTsv = controls(rows, "[Copy TSV]")[0]!;
		const firstMarkdown = controls(rows, "[Copy Markdown]")[0]!;
		for (let column = firstTsv.column + "[Copy TSV]".length; column < csv.column; column++) {
			expect(resolve(column, csv.row)).toBeUndefined();
		}
		for (let column = csv.column + "[Copy CSV]".length; column < firstMarkdown.column; column++) {
			expect(resolve(column, csv.row)).toBeUndefined();
		}
		expect(resolve(0, tsv.row)).toBeUndefined();
		expect(resolve(tsv.column + "[Copy TSV]".length, tsv.row)).toBeUndefined();
		expect(resolve(tsv.column, 0)).toBeUndefined();
		expect(resolve(Number.NaN, tsv.row)).toBeUndefined();
		expect(resolve(tsv.column + 0.5, tsv.row)).toBeUndefined();
		expect(actions).toEqual([]);
		expect(tsvControl.activate()).toBe(true);
		expect(csvControl.activate()).toBe(true);
		expect(markdownControl.activate()).toBe(true);
		expect(actions).toEqual([
			{ act: "copy", text: "Name\tValue\nβ\ta|b" },
			{ act: "copy", text: 'Name,Value\nA,"a,b"' },
			{ act: "copy", text: second },
		]);
		expect(feedback).toEqual([{ quiet: true }, { quiet: true }, { quiet: true }]);
		const restored = new Markdown(source, 2, 1, theme).setIgnoreTight(true);
		const restoredRows = restored.render(60);
		expect(restoredRows).toEqual(rows);
		expect(restoredRows.join("\n")).not.toContain("\x1b]omp-table-");
		const restoredTarget = controls(restoredRows, "[Copy TSV]")[1]!;
		expect(restored.getInlineControlResolver(60)!(restoredTarget.column, restoredTarget.row)!.activate()).toBe(true);
		expect(actions.at(-1)).toEqual({ act: "copy", text: "Name\tValue\nβ\ta|b" });
	});

	it("keeps nested table controls aligned with quote and list prefixes", () => {
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		const source =
			"> | H | V |\n> | --- | --- |\n> | quote | one |\n\n7. Keep numbering\n\n   | H | V |\n   | --- | --- |\n   | list | two |";
		const markdown = new Markdown(source, 2, 1, getMarkdownTheme()).setIgnoreTight(true);
		const rows = markdown.render(60);
		const targets = controls(rows, "[Copy TSV]");
		const resolve = markdown.getInlineControlResolver(60)!;
		expect(targets).toHaveLength(2);
		expect(resolve(targets[0]!.column, targets[0]!.row)!.activate()).toBe(true);
		expect(resolve(targets[1]!.column, targets[1]!.row)!.activate()).toBe(true);
		expect(actions).toEqual([
			{ act: "copy", text: "H\tV\nquote\tone" },
			{ act: "copy", text: "H\tV\nlist\ttwo" },
		]);
		expect(rows.join("\n")).not.toContain("\x1b]omp-table-");
	});

	it("does not let fenced examples, copied labels, or untrusted marker syntax create controls", () => {
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		const example =
			"```text\n[Copy TSV] [Copy CSV] [Copy Markdown]\n\x1b]omp-table-untrusted;abc;tsv\x07[Copy TSV]\x1b]omp-table-untrusted;;\x07\n| Fake | Table |\n| --- | --- |\n| code | only |\n```";
		const source = `${example}\n\n| H |\n| --- |\n| real |`;
		const markdown = new Markdown(source, 0, 0, getMarkdownTheme());
		const rows = markdown.render(60);
		const targets = controls(rows, "[Copy TSV]");
		const resolve = markdown.getInlineControlResolver(60)!;
		expect(targets).toHaveLength(3);
		expect(resolve(targets[0]!.column, targets[0]!.row)).toBeUndefined();
		expect(resolve(targets[1]!.column, targets[1]!.row)).toBeUndefined();
		expect(actions).toEqual([]);
		expect(resolve(targets[2]!.column, targets[2]!.row)!.activate()).toBe(true);
		expect(actions).toEqual([{ act: "copy", text: "H\nreal" }]);
		const onlyCode = new Markdown(example, 0, 0, getMarkdownTheme());
		onlyCode.render(60);
		expect(onlyCode.getInlineControlResolver(60)).toBeUndefined();
	});

	it("rejects saved activation after resize, invalidation, replacement, and host removal while narrow controls remain usable", () => {
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		const source = "| H | V |\n| --- | --- |\n| one | two |";
		const markdown = new Markdown(source, 1, 0, getMarkdownTheme()).setIgnoreTight(true);
		const wide = markdown.render(60);
		const old = markdown.getInlineControlResolver(60)!;
		const oldTarget = controls(wide, "[Copy TSV]")[0]!;
		const oldControl = old(oldTarget.column, oldTarget.row)!;
		const narrow = markdown.render(14);
		expect(narrow.every(line => visibleWidth(line) <= 14)).toBe(true);
		expect(narrow.join("\n")).not.toContain("\x1b]omp-table-");
		expect(old(oldTarget.column, oldTarget.row)).toBeUndefined();
		expect(oldControl.activate()).toBe(false);
		expect(markdown.getInlineControlResolver(60)).toBeUndefined();
		const target = controls(narrow, "[Markdown]")[0]!;
		const resolve = markdown.getInlineControlResolver(14)!;
		const narrowControl = resolve(target.column, target.row)!;
		expect(narrowControl.activate()).toBe(true);
		expect(actions).toEqual([{ act: "copy", text: source }]);
		markdown.invalidate();
		expect(resolve(target.column, target.row)).toBeUndefined();
		expect(narrowControl.activate()).toBe(false);
		expect(markdown.getInlineControlResolver(14)).toBeUndefined();
		markdown.render(14);
		const refreshed = markdown.getInlineControlResolver(14)!;
		const refreshedControl = refreshed(target.column, target.row)!;
		markdown.setText("No table anymore");
		expect(refreshed(target.column, target.row)).toBeUndefined();
		expect(refreshedControl.activate()).toBe(false);
		markdown.render(14);
		expect(markdown.getInlineControlResolver(14)).toBeUndefined();
		markdown.setText(source);
		const restoredRows = markdown.render(60);
		const restored = markdown.getInlineControlResolver(60)!;
		const restoredTarget = controls(restoredRows, "[Copy CSV]")[0]!;
		const restoredControl = restored(restoredTarget.column, restoredTarget.row)!;
		setTranscriptActionHandler(undefined);
		expect(restored(restoredTarget.column, restoredTarget.row)).toBeUndefined();
		expect(restoredControl.activate()).toBe(false);
		expect(markdown.render(60).join("\n")).not.toContain("[Copy");
		expect(actions).toHaveLength(1);
	});

	it("copies through nested container offsets and rejects saved activation after the surrounding layout changes", () => {
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		const markdown = new Markdown("| H | V |\n| --- | --- |\n| 原文 | a,b |", 0, 0, getMarkdownTheme());
		const prefix = new Text("Title", 0, 0);
		const child = new Container();
		child.addChild(new Text("Section", 0, 0));
		child.addChild(markdown);
		const parent = new Container();
		parent.addChild(prefix);
		parent.addChild(child);
		const rows = parent.render(60);
		const point = controls(rows, "[Copy CSV]")[0]!;
		const resolve = parent.getChildInlineControlResolver(60)!;
		const control = resolve(point.column, point.row)!;
		expect(resolve(point.column + 1, point.row)!.id).toBe(control.id);
		expect(resolve(point.column, point.row - 1)).toBeUndefined();
		expect(actions).toEqual([]);
		expect(control.activate()).toBe(true);
		expect(actions).toEqual([{ act: "copy", text: 'H,V\n原文,"a,b"' }]);

		prefix.setText("Title\nSubtitle");
		const shiftedRows = parent.render(60);
		expect(resolve(point.column, point.row)).toBeUndefined();
		expect(control.activate()).toBe(false);
		const shifted = controls(shiftedRows, "[Copy CSV]")[0]!;
		const shiftedResolve = parent.getChildInlineControlResolver(60)!;
		const shiftedControl = shiftedResolve(shifted.column, shifted.row)!;
		expect(shiftedControl.activate()).toBe(true);
		parent.removeChild(child);
		expect(shiftedResolve(shifted.column, shifted.row)).toBeUndefined();
		expect(shiftedControl.activate()).toBe(false);
		expect(actions).toHaveLength(2);
	});

	it("preserves original incomplete-cell data while streaming, including cached tables before a growing paragraph", () => {
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		const prefix = "| H | V |\n| --- | --- |\n| A | one |\n| B | **par";
		const markdown = new Markdown(prefix, 0, 0, getMarkdownTheme());
		markdown.transientRenderCache = true;
		const rows = markdown.render(60);
		const target = controls(rows, "[Copy TSV]")[0]!;
		const resolve = markdown.getInlineControlResolver(60)!;
		const originalControl = resolve(target.column, target.row)!;
		expect(actions).toEqual([]);
		expect(originalControl.activate()).toBe(true);
		expect(actions).toEqual([{ act: "copy", text: "H\tV\nA\tone\nB\t**par" }]);
		markdown.setText(`${prefix}tial** |\n\nA growing paragraph`);
		const next = markdown.render(60);
		expect(resolve(target.column, target.row)).toBeUndefined();
		expect(originalControl.activate()).toBe(false);
		const nextTarget = controls(next, "[Copy TSV]")[0]!;
		expect(markdown.getInlineControlResolver(60)!(nextTarget.column, nextTarget.row)!.activate()).toBe(true);
		expect(actions.at(-1)).toEqual({ act: "copy", text: "H\tV\nA\tone\nB\tpartial" });
		markdown.setText(`${prefix}tial** |\n\nA growing paragraph with more`);
		const appended = markdown.render(60);
		expect(appended.join("\n")).not.toContain("\x1b]omp-table-");
		const appendedTarget = controls(appended, "[Copy CSV]")[0]!;
		expect(markdown.getInlineControlResolver(60)!(appendedTarget.column, appendedTarget.row)!.activate()).toBe(true);
		expect(actions.at(-1)).toEqual({ act: "copy", text: "H,V\nA,one\nB,partial" });
		markdown.transientRenderCache = false;
		const final = markdown.render(60);
		const finalTarget = controls(final, "[Copy TSV]")[0]!;
		expect(markdown.getInlineControlResolver(60)!(finalTarget.column, finalTarget.row)!.activate()).toBe(true);
		expect(actions.at(-1)).toEqual({ act: "copy", text: "H\tV\nA\tone\nB\tpartial" });
	});
});
