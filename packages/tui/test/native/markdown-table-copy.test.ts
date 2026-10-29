import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { setTranscriptActionHandler, type TranscriptAction } from "@oh-my-pi/pi-tui/chat/transcript-actions";
import { extractMarkdownLinks, extractMarkdownTables, Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { nativeComponentId } from "@oh-my-pi/pi-tui/native/reconcile";
import { Lexer } from "@oh-my-pi/pi-utils/marked";
import { getMarkdownTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import type { TspNode } from "@oh-my-pi/pi-wire";
import { TspHarness } from "./tsp-harness";

const CX: DescribeContext = { cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
let harness: TspHarness | undefined;

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	setTranscriptActionHandler(undefined);
	harness?.stop();
	harness = undefined;
});

function markdownText(node: TspNode): string {
	if (node.k !== "md") throw new Error("expected Markdown");
	return node.p?.text ?? "";
}

function click(h: TspHarness, control: TspNode): void {
	const act = control.p?.actions?.click;
	if (!act) throw new Error("expected copy action");
	h.event({ ev: "action", sf: h.terminal.surface!, id: control.id, act });
}

describe("Markdown table copy actions", () => {
	it("places controls beside each real table and dispatches only that table's requested format", async () => {
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => {
			actions.push(action);
		});
		const first = "| Name | Value |\n| --- | --- |\n| **Alice** | a,b |\n";
		const second = "| Item | Note |\n| --- | --- |\n| β | a\\|b |\n";
		const fake = "```md\n| Fake | Table |\n| --- | --- |\n| No | Controls |\n```\n";
		const source = `Before\n\n${first}\nBetween\n\n${fake}\n${second}\nAfter`;
		const component = new Markdown(source, 0, 0, getMarkdownTheme());
		harness = await TspHarness.start(tui => tui.addChild(component));
		const h = harness;
		const blocks = h.findAll(node => node.p?.role === "omp.table");
		expect(blocks).toHaveLength(2);
		for (const [index, block] of blocks.entries()) {
			expect(block.c?.[1]?.c?.map(node => node.p?.aria)).toEqual([
				`Copy TSV from table ${index + 1}`,
				`Copy CSV from table ${index + 1}`,
				`Copy Markdown from table ${index + 1}`,
			]);
			for (const control of block.c?.[1]?.c ?? []) click(h, control);
		}
		expect(actions).toEqual([
			{ act: "copy", text: "Name\tValue\nAlice\ta,b" },
			{ act: "copy", text: 'Name,Value\nAlice,"a,b"' },
			{ act: "copy", text: first.trimEnd() },
			{ act: "copy", text: "Item\tNote\nβ\ta|b" },
			{ act: "copy", text: "Item,Note\nβ,a|b" },
			{ act: "copy", text: second.trimEnd() },
		]);
		expect(h.errors).toEqual([]);
	});

	it("keeps reference resolution and nested list/quote Markdown intact without offering fenced examples", async () => {
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		const quote = "> | Name | Link |\n> | --- | --- |\n> | Q | [**guide**][doc] |\n";
		const list = "7. Keep numbering\n\n   | Name | Link |\n   | --- | --- |\n   | L | [guide][doc] |\n";
		const source = `[intro][doc]\n\n${quote}\n${list}\n[doc]: https://example.com/guide\n\n\`\`\`md\n| Code | Only |\n| --- | --- |\n\`\`\``;
		const component = new Markdown(source, 0, 0, getMarkdownTheme());
		harness = await TspHarness.start(tui => tui.addChild(component));
		const h = harness;
		const bodies = h.findAll(node => node.p?.role === "omp.table").map(node => markdownText(node.c![0]!));
		expect(bodies).toHaveLength(2);
		expect(Lexer.lex(bodies[0]!).some(token => token.type === "blockquote")).toBe(true);
		expect(Lexer.lex(bodies[1]!).find(token => token.type === "list")).toMatchObject({ start: 7 });
		const links = h.findAll(node => node.k === "md").flatMap(node => extractMarkdownLinks(markdownText(node)));
		expect(links).toEqual([
			{ text: "intro", href: "https://example.com/guide" },
			{ text: "guide", href: "https://example.com/guide" },
			{ text: "guide", href: "https://example.com/guide" },
		]);
		expect(extractMarkdownTables(source).map(table => table.rows[0]?.[0]?.text)).toEqual(["Q", "L"]);
		expect(actions).toEqual([]);
		click(
			h,
			h.find(node => node.p?.aria === "Copy TSV from table 2")!,
		);
		expect(actions).toEqual([{ act: "copy", text: "Name\tLink\nL\tguide" }]);
	});

	it("holds incomplete rows, rejects stale actions, and keeps table identity across cache hits and resizes", async () => {
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		const prefix = "| Name | Value |\n| --- | --- |\n| A | one |\n";
		const component = new Markdown(`${prefix}| B | par`, 0, 0, getMarkdownTheme());
		component.transientRenderCache = true;
		harness = await TspHarness.start(tui => tui.addChild(component));
		const h = harness;
		const oldControl = h.find(node => node.p?.aria === "Copy TSV from table 1")!;
		const first = component.describe(CX);
		expect(component.describe(CX)).toBe(first);
		expect(markdownText(h.find(node => node.k === "md")!)).toBe(prefix);
		expect(actions).toEqual([]);
		click(h, oldControl);
		expect(actions).toEqual([{ act: "copy", text: "Name\tValue\nA\tone" }]);
		h.event({ ev: "resize", cols: 35 });
		expect(h.find(node => node.p?.aria === "Copy TSV from table 1")?.id).toBe(oldControl.id);
		component.setText(prefix);
		component.transientRenderCache = false;
		await h.render();
		expect(h.find(node => node.p?.aria === "Copy TSV from table 1")?.id).toBe(oldControl.id);
		component.transientRenderCache = true;
		component.setText(`${prefix}| B | partial`);
		await h.render();
		expect(h.find(node => node.p?.aria === "Copy TSV from table 1")?.id).toBe(oldControl.id);
		component.setText(`${prefix.replace("one", "two")}| B | partial`);
		component.handleNativeEvent({
			type: "action",
			key: oldControl.id.slice(nativeComponentId(component).length + 1),
			act: "copy-table-tsv",
			mods: [],
		});
		expect(actions).toHaveLength(1);
		await h.render();
		click(h, oldControl);
		expect(actions).toHaveLength(1);
		component.transientRenderCache = false;
		await h.render();
		const finalControl = h.find(node => node.p?.aria === "Copy TSV from table 1")!;
		click(h, finalControl);
		expect(actions.at(-1)).toEqual({ act: "copy", text: "Name\tValue\nA\ttwo\nB\tpartial" });
		expect(h.findAll(node => node.k === "md").every(node => node.k === "md" && node.p?.stream === undefined)).toBe(
			true,
		);
		component.setText("Replacement without a table");
		await h.render();
		click(h, finalControl);
		expect(actions).toHaveLength(2);
		expect(h.findAll(node => node.p?.role === "omp.table.copy")).toEqual([]);
		expect(h.errors).toEqual([]);
	});

	it("keeps conflicting reference definitions in one document so splitting cannot change link precedence", async () => {
		setTranscriptActionHandler(() => {});
		const source =
			"[label][doc]\n\n[doc]: https://first.example\n\n| H |\n| --- |\n| [label][doc] |\n\n[doc]: https://last.example\n";
		const component = new Markdown(source, 0, 0, getMarkdownTheme());
		harness = await TspHarness.start(tui => tui.addChild(component));
		const bodies = harness.findAll(node => node.k === "md");
		expect(bodies).toHaveLength(1);
		expect(extractMarkdownLinks(markdownText(bodies[0]!))).toEqual(extractMarkdownLinks(source));
	});

	it("preserves original CRLF and tab bytes when lexer normalization prevents splitting the document", async () => {
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		const source = "Before\r\n\r\n| Name | Value |\r\n| --- | --- |\r\n| A | one |\r\n\r\n```\r\n\tcode\r\n```";
		const component = new Markdown(source, 0, 0, getMarkdownTheme());
		harness = await TspHarness.start(tui => tui.addChild(component));
		const bodies = harness.findAll(node => node.k === "md");
		expect(bodies.map(markdownText)).toEqual([source]);
		expect(actions).toEqual([]);
		click(
			harness,
			harness.find(node => node.p?.aria === "Copy TSV from table 1")!,
		);
		expect(actions).toEqual([{ act: "copy", text: "Name\tValue\nA\tone" }]);
	});

	it("does not expose inert controls without a clipboard host and updates when the host becomes available", async () => {
		const source = "| H |\n| --- |\n| V |";
		const component = new Markdown(source, 0, 0, getMarkdownTheme());
		harness = await TspHarness.start(tui => tui.addChild(component));
		expect(harness.findAll(node => node.p?.role === "omp.table.copy")).toEqual([]);
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		await harness.render();
		expect(actions).toEqual([]);
		click(
			harness,
			harness.find(node => node.p?.aria === "Copy CSV from table 1")!,
		);
		expect(actions).toEqual([{ act: "copy", text: "H\nV" }]);
		setTranscriptActionHandler(undefined);
		await harness.render();
		expect(harness.findAll(node => node.p?.role === "omp.table.copy")).toEqual([]);
	});
});
