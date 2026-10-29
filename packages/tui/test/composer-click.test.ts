import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Container, type Component } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";
import { routeViewportClick, type ViewportClickSpan } from "@oh-my-pi/pi-tui/prompt/composer";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import {
	setTranscriptActionHandler,
	setTranscriptMouseEnabled,
	type TranscriptAction,
} from "@oh-my-pi/pi-tui/chat/transcript-actions";

// Classic inline controls are opt-in; these tests exercise the enabled mode.
setTranscriptMouseEnabled(true);
import { parseSgrMouse } from "@oh-my-pi/pi-tui/mouse";

function mouse(button: number, column: number, row: number, release = false) {
	const event = parseSgrMouse(`\x1b[<${button};${column + 1};${row + 1}${release ? "m" : "M"}`);
	if (!event) throw new Error("invalid mouse fixture");
	return event;
}

function click(composer: Composer, column: number, row: number): void {
	composer.handleTranscriptMouse(mouse(0, column, row));
	composer.handleTranscriptMouse(mouse(0, column, row, true));
}

function span(start: number, end: number, ids: string[]): ViewportClickSpan {
	return { start, end, candidates: () => ids };
}

describe("routeViewportClick", () => {
	it("returns the hit span's candidates with the span-local row", () => {
		let local = -1;
		const spans: ViewportClickSpan[] = [
			{
				start: 0,
				end: 2,
				candidates: row => {
					local = row;
					return ["CardAgent"];
				},
			},
			{ start: 3, end: 5, candidates: () => ["HudAgent"] },
		];
		expect(routeViewportClick(spans, 1)).toEqual(["CardAgent"]);
		expect(local).toBe(1);
		expect(routeViewportClick(spans, 4)).toEqual(["HudAgent"]);
	});

	it("misses separators, out-of-range rows, and non-integer indexes", () => {
		const spans = [span(0, 2, ["A"]), span(3, 4, ["B"])];
		expect(routeViewportClick(spans, 2)).toEqual([]);
		expect(routeViewportClick(spans, -1)).toEqual([]);
		expect(routeViewportClick(spans, Number.NaN)).toEqual([]);
		expect(routeViewportClick(spans, 99)).toEqual([]);
	});

	it("lets the first overlapping span win", () => {
		const spans = [span(0, 5, ["A"]), span(2, 4, ["B"])];
		expect(routeViewportClick(spans, 3)).toEqual(["A"]);
	});
});

class ClickableBlock implements Component {
	constructor(
		private readonly rows: readonly string[],
		private readonly ids: readonly string[],
	) {}
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
	render(): readonly string[] {
		return this.rows;
	}
	getClickFocusAgentIds(): string[] {
		return [...this.ids];
	}
}

describe("composer hover band", () => {
	beforeAll(() => {
		initTheme();
	});

	it("bands only the hovered target's rows and clears byte-identically", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			transcript.addChild(new ClickableBlock(["card one", "card two"], ["AgentA"]));
			transcript.addChild(new ClickableBlock(["plain"], []));
			composer.setRuntimeChildren([transcript]);
			const plain = composer.renderFrame({ columns: 80, rows: 24 });
			expect(plain.viewport.join("\n")).not.toContain("\x1b[48");

			composer.setHoveredClickId("AgentA");
			const hovered = composer.renderFrame({ columns: 80, rows: 24 });
			const banded = hovered.viewport.filter(line => line.includes("\x1b[48"));
			expect(banded).toHaveLength(2);
			expect(Bun.stripANSI(banded.join("\n"))).toContain("card one");
			expect(Bun.stripANSI(banded.join("\n"))).toContain("card two");
			expect(hovered.viewport.filter(line => line.includes("plain") && line.includes("\x1b[48"))).toHaveLength(0);

			composer.setHoveredClickId("Nobody");
			expect(composer.renderFrame({ columns: 80, rows: 24 }).viewport).toEqual(plain.viewport);

			composer.setHoveredClickId(undefined);
			expect(composer.renderFrame({ columns: 80, rows: 24 }).viewport).toEqual(plain.viewport);
		} finally {
			composer.stop();
		}
	});

	it("drops nested background opens so the band wins tinted rows", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const esc = String.fromCharCode(27);
			const tinted = `${esc}[48;2;15;18;22mcard tinted${esc}[49m`;
			const transcript = new TranscriptContainer();
			transcript.addChild(new ClickableBlock([tinted], ["AgentT"]));
			composer.setRuntimeChildren([transcript]);
			composer.setHoveredClickId("AgentT");
			const hovered = composer.renderFrame({ columns: 80, rows: 24 });
			const banded = hovered.viewport.filter(line => line.includes("card tinted"));
			expect(banded).toHaveLength(1);
			expect(banded[0]).toContain(`${esc}[48`);
			expect(banded[0]).not.toContain("48;2;15;18;22");
		} finally {
			composer.stop();
		}
	});
});
class RowTarget implements Component {
	constructor(
		private readonly rows: readonly string[],
		private readonly ids: readonly string[],
	) {}
	render(): readonly string[] {
		return this.rows;
	}
	getClickAgentAtRow(row: number): string | undefined {
		return this.ids[row];
	}
}

describe("composer click-span clipping", () => {
	beforeAll(() => {
		initTheme();
	});

	it("offsets hit-testing past clipped viewport rows", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const chrome = new Container();
			const ids = Array.from({ length: 10 }, (_, index) => `row${index}`);
			chrome.addChild(
				new RowTarget(
					ids.map(id => `line ${id}`),
					ids,
				),
			);
			composer.setRuntimeChildren([transcript, chrome]);

			// Ten chrome rows in a six-row viewport: the first four scroll off,
			// so viewport row 0 must hit-test as component row 4.
			const frame = composer.renderFrame({ columns: 80, rows: 6 });
			expect(frame.viewport).toHaveLength(6);
			expect(composer.viewportClickCandidates(0)).toEqual(["row4"]);
			expect(composer.viewportClickCandidates(5)).toEqual(["row9"]);
		} finally {
			composer.stop();
		}
	});
});

class CountingBlock implements Component {
	renders = 0;
	constructor(private readonly rows: readonly string[]) {}
	render(): readonly string[] {
		this.renders++;
		return this.rows;
	}
}

describe("composer chrome span recording", () => {
	beforeAll(() => {
		initTheme();
	});

	it("does not re-render chrome without click targets", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const chrome = new Container();
			const first = new CountingBlock(["status one"]);
			const second = new CountingBlock(["status two"]);
			chrome.addChild(first);
			chrome.addChild(second);
			composer.setRuntimeChildren([transcript, chrome]);

			const frame = composer.renderFrame({ columns: 80, rows: 24 });
			expect(frame.viewport.join("\n")).toContain("status two");
			expect([first.renders, second.renders]).toEqual([1, 1]);
			expect(composer.viewportClickCandidates(0)).toEqual([]);
		} finally {
			composer.stop();
		}
	});

	it("renders target-bearing chrome children once per frame", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const chrome = new Container();
			const first = new CountingBlock(["status one"]);
			const hud = new RowTarget(["hud row"], ["AgentH"]);
			chrome.addChild(first);
			chrome.addChild(hud);
			composer.setRuntimeChildren([transcript, chrome]);

			const frame = composer.renderFrame({ columns: 80, rows: 24 });
			const hudRow = frame.viewport.findIndex(line => line.includes("hud row"));
			expect(hudRow).toBeGreaterThanOrEqual(0);
			expect(composer.viewportClickCandidates(hudRow)).toEqual(["AgentH"]);
			expect(first.renders).toBe(1);
		} finally {
			composer.stop();
		}
	});
});

function tableMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function tableButton(rows: readonly string[], format: string, table = 0): { column: number; row: number } {
	const label = `[Copy ${format}]`;
	const matches: { column: number; row: number }[] = [];
	for (let row = 0; row < rows.length; row++) {
		const plain = Bun.stripANSI(rows[row]!);
		const index = plain.indexOf(label);
		if (index !== -1) matches.push({ column: Bun.stringWidth(plain.slice(0, index)) + 1, row });
	}
	expect(matches.length).toBeGreaterThan(table);
	return matches[table]!;
}

describe("composer classic table controls", () => {
	beforeAll(() => {
		initTheme();
	});
	afterEach(() => {
		setTranscriptActionHandler(undefined);
	});

	const firstTable = "| Name | Value |\n| --- | --- |\n| first | alpha |";
	const secondTable = "| Name | Value |\n| --- | --- |\n| second | beta |";

	it("copies each format from its own rendered assistant table, without acting during render", () => {
		const term = new VirtualTerminal(80, 40);
		const composer = new Composer({ terminal: term, preferences: { quiet: true } });
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const assistant = new AssistantMessageComponent();
			assistant.updateContent(tableMessage(`Before\n\n${firstTable}\n\nBetween\n\n${secondTable}`));
			transcript.addChild(assistant);
			composer.setRuntimeChildren([transcript]);
			const frame = composer.renderFrame({ columns: 80, rows: 40 });
			expect(actions).toEqual([]);
			for (const [table, value] of ["first\talpha", "second\tbeta"].entries()) {
				for (const format of ["TSV", "CSV", "Markdown"]) {
					const point = tableButton(frame.viewport, format, table);
					click(composer, point.column, point.row);
					expect(actions.at(-1)).toEqual({
						act: "copy",
						text:
							format === "TSV"
								? `Name\tValue\n${value}`
								: format === "CSV"
									? `Name,Value\n${value.replace("\t", ",")}`
									: table === 0
										? firstTable
										: secondTable,
					});
				}
			}
			expect(actions).toHaveLength(6);
			click(
				composer,
				0,
				frame.viewport.findIndex(row => row.includes("Before")),
			);
			expect(actions).toHaveLength(6);
		} finally {
			composer.stop();
		}
	});

	it("captures ordinary transcript interactions and suspends capture for overlays", () => {
		const term = new VirtualTerminal(80, 40);
		const composer = new Composer({ terminal: term, preferences: { quiet: true } });
		setTranscriptActionHandler(() => {});
		composer.ui.setInlineMouseTrackingProvider(() => composer.hasInlineClickTargets());
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const assistant = new AssistantMessageComponent();
			assistant.updateContent(tableMessage("Plain answer"));
			transcript.addChild(assistant);
			composer.setRuntimeChildren([transcript]);
			composer.ui.renderNow();
			expect(composer.ui.isInlineMouseTrackingActive()).toBe(true);

			assistant.updateContent(tableMessage(firstTable));
			composer.ui.renderNow();
			expect(composer.ui.isInlineMouseTrackingActive()).toBe(true);

			const overlay = composer.ui.showOverlay({ render: () => ["dialog"] });
			composer.ui.renderNow();
			expect(composer.ui.isInlineMouseTrackingActive()).toBe(false);
			overlay.hide();
			composer.ui.renderNow();
			expect(composer.ui.isInlineMouseTrackingActive()).toBe(true);

			assistant.updateContent(tableMessage("No table remains"));
			composer.ui.renderNow();
			expect(composer.ui.isInlineMouseTrackingActive()).toBe(true);
		} finally {
			composer.stop();
		}
	});

	it("claims no inline capture and draws no controls while the pointer layer is off", () => {
		const term = new VirtualTerminal(80, 40);
		const composer = new Composer({ terminal: term, preferences: { quiet: true } });
		setTranscriptActionHandler(() => {});
		setTranscriptMouseEnabled(false);
		try {
			composer.ui.setInlineMouseTrackingProvider(() => composer.hasInlineClickTargets());
			composer.start();
			const transcript = new TranscriptContainer();
			const assistant = new AssistantMessageComponent();
			assistant.updateContent(tableMessage(firstTable));
			transcript.addChild(assistant);
			composer.setRuntimeChildren([transcript]);
			composer.ui.renderNow();
			expect(composer.hasInlineClickTargets()).toBe(false);
			expect(composer.ui.isInlineMouseTrackingActive()).toBe(false);
			const frame = composer.renderFrame({ columns: 80, rows: 40 });
			expect(frame.viewport.join("\n")).not.toContain("[Copy TSV]");
		} finally {
			composer.stop();
			setTranscriptMouseEnabled(true);
		}
	});

	it("maps a clipped table tail to its actual controls, not the block's old first rows", () => {
		const term = new VirtualTerminal(80, 5);
		const composer = new Composer({ terminal: term, preferences: { quiet: true } });
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const assistant = new AssistantMessageComponent();
			assistant.updateContent(tableMessage(`Long introduction\n\n${firstTable}\n\n${secondTable}`));
			transcript.addChild(assistant);
			composer.setRuntimeChildren([transcript]);
			const frame = composer.renderFrame({ columns: 80, rows: 5 });
			const point = tableButton(frame.viewport, "TSV");
			click(composer, point.column, point.row);
			expect(actions).toEqual([{ act: "copy", text: "Name\tValue\nsecond\tbeta" }]);
		} finally {
			composer.stop();
		}
	});

	it("declines stale controls after a source update, resize, or transcript removal", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { quiet: true } });
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const assistant = new AssistantMessageComponent();
			assistant.updateContent(tableMessage(firstTable));
			transcript.addChild(assistant);
			composer.setRuntimeChildren([transcript]);
			let frame = composer.renderFrame({ columns: 80, rows: 24 });
			let point = tableButton(frame.viewport, "TSV");
			assistant.updateContent(tableMessage(secondTable));
			click(composer, point.column, point.row);
			frame = composer.renderFrame({ columns: 80, rows: 24 });
			point = tableButton(frame.viewport, "TSV");
			term.resize(60, 24);
			click(composer, point.column, point.row);
			frame = composer.renderFrame({ columns: 60, rows: 24 });
			point = tableButton(frame.viewport, "TSV");
			transcript.clear();
			click(composer, point.column, point.row);
			expect(actions).toEqual([]);
		} finally {
			composer.stop();
		}
	});

	it("highlights the button immediately, tolerates jitter, and supports leaving and re-entering before release", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { quiet: true } });
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			transcript.addChild(new AssistantMessageComponent(tableMessage(firstTable)));
			composer.setRuntimeChildren([transcript, new CountingBlock(["fixed editor"])]);
			const paint = () => composer.renderFrame({ columns: 80, rows: 24 }).viewport;
			const baseline = paint();
			const point = tableButton(baseline, "Markdown");
			composer.handleTranscriptMouse(mouse(35, point.column, point.row));
			const hovered = paint()[point.row]!;
			expect(hovered).toContain("\x1b[4m");
			expect(Bun.stripANSI(hovered)).toBe(Bun.stripANSI(baseline[point.row]!));
			composer.handleTranscriptMouse(mouse(0, point.column, point.row));
			const pressed = paint()[point.row]!;
			expect(pressed).not.toBe(hovered);
			expect(pressed).toContain("\x1b[48");
			expect(actions).toEqual([]);
			composer.handleTranscriptMouse(mouse(32, 79, point.row));
			expect(paint()[point.row]).toBe(baseline[point.row]);
			composer.handleTranscriptMouse(mouse(32, point.column + 1, point.row));
			expect(paint()[point.row]).toBe(pressed);
			composer.handleTranscriptMouse(mouse(0, point.column + 2, point.row, true));
			expect(actions).toEqual([{ act: "copy", text: firstTable }]);
			expect(paint()[point.row]).toBe(hovered);
			composer.handleTranscriptMouse(mouse(0, point.column + 2, point.row, true));
			expect(actions).toHaveLength(1);
		} finally {
			composer.stop();
		}
	});

	it("cancels releases outside the original button, including another format and the editor", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { quiet: true } });
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			transcript.addChild(new AssistantMessageComponent(tableMessage(firstTable)));
			composer.setRuntimeChildren([transcript, new CountingBlock(["fixed editor"])]);
			const frame = composer.renderFrame({ columns: 80, rows: 24 });
			const markdown = tableButton(frame.viewport, "Markdown");
			const csv = tableButton(frame.viewport, "CSV");
			const editorRow = frame.viewport.findIndex(row => row.includes("fixed editor"));
			for (const end of [csv, { column: 79, row: markdown.row }, { column: 0, row: editorRow }]) {
				composer.handleTranscriptMouse(mouse(0, markdown.column, markdown.row));
				composer.handleTranscriptMouse(mouse(32, end.column, end.row));
				composer.handleTranscriptMouse(mouse(0, end.column, end.row, true));
			}
			expect(actions).toEqual([]);
			composer.handleTranscriptMouse(mouse(0, markdown.column, markdown.row));
			composer.handleTranscriptMouse(mouse(0, markdown.column + 1, markdown.row, true));
			expect(actions).toEqual([{ act: "copy", text: firstTable }]);
		} finally {
			composer.stop();
		}
	});

	it("keeps a drag starting outside buttons as text selection when it crosses a button", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { quiet: true } });
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			transcript.addChild(new AssistantMessageComponent(tableMessage(firstTable)));
			composer.setRuntimeChildren([transcript]);
			const frame = composer.renderFrame({ columns: 80, rows: 24 });
			const tsv = tableButton(frame.viewport, "TSV");
			const csv = tableButton(frame.viewport, "CSV");
			composer.handleTranscriptMouse(mouse(0, tsv.column + 9, tsv.row));
			composer.handleTranscriptMouse(mouse(32, csv.column + 4, csv.row));
			composer.handleTranscriptMouse(mouse(0, csv.column + 4, csv.row, true));
			expect(actions).toEqual([{ act: "copy", text: " [Copy" }]);
		} finally {
			composer.stop();
		}
	});

	it("keeps a short two-turn frame at its original header, chrome and editor geometry", () => {
		const term = new VirtualTerminal(100, 60);
		const composer = new Composer({ terminal: term, preferences: { quiet: true } });
		const actions: TranscriptAction[] = [];
		const quiet: (boolean | undefined)[] = [];
		composer.start({ playWelcomeIntro: false });
		try {
			composer.setHeaderExtras([new CountingBlock(["original header", "header detail"])], []);
			composer.editor.setText("draft remains here");
			const transcript = new TranscriptContainer();
			transcript.addChild(new ClickableBlock(["user first", "assistant first"], []));
			transcript.addChild(new ClickableBlock(["user latest", "assistant latest"], []));
			composer.setRuntimeChildren(
				[
					new CountingBlock(["pre-transcript chrome"]),
					transcript,
					new CountingBlock(["input gap"]),
					composer.editor,
					new CountingBlock(["working status", "footer status"]),
				],
				{ transientChrome: [composer.editor] },
			);
			// The ordinary, action-host-free frame is the original classic layout oracle.
			setTranscriptActionHandler(undefined);
			const original = composer.renderFrame({ columns: 100, rows: 60 }).viewport;
			const editorRow = original.findIndex(row => row.includes("draft remains here"));
			expect(editorRow).toBeGreaterThan(0);
			expect(original.length).toBeLessThan(60);
			expect(original.slice(0, 3)).toEqual(["original header", "header detail", "pre-transcript chrome"]);
			setTranscriptActionHandler((action, options) => {
				actions.push(action);
				quiet.push(options?.quiet);
			});
			const paint = () => composer.renderFrame({ columns: 100, rows: 60 }).viewport;
			const unchanged = () => {
				const rows = paint();
				expect(rows.map(row => Bun.stripANSI(row))).toEqual(original.map(row => Bun.stripANSI(row)));
				expect(rows.findIndex(row => row.includes("draft remains here"))).toBe(editorRow);
			};
			unchanged();
			const latestRow = original.findIndex(row => row.includes("user latest"));
			for (const button of [64, 65]) {
				expect(composer.handleTranscriptMouse(mouse(button, 1, latestRow)).handled).toBe(true);
				unchanged();
			}
			composer.handleTranscriptMouse(mouse(0, 0, latestRow));
			unchanged();
			composer.handleTranscriptMouse(mouse(32, 4, latestRow));
			unchanged();
			composer.handleTranscriptMouse(mouse(0, 4, latestRow, true));
			unchanged();
			expect(actions).toEqual([{ act: "copy", text: "user" }]);
			expect(quiet).toEqual([true]);
			composer.ui.renderNow();
			const screen = term.getViewport();
			composer.handleTranscriptMouse(mouse(64, 1, latestRow));
			composer.ui.renderNow();
			expect(term.getViewport()).toEqual(screen);
			transcript.addChild(new ClickableBlock(["new genuine turn"], []));
			const grown = paint();
			expect(grown.findIndex(row => row.includes("draft remains here"))).toBe(editorRow + 2);
			expect(grown.length).toBe(original.length + 2);
		} finally {
			composer.stop();
		}
	});

	it("restores the original latest allocation after browsing up and down without new output", () => {
		const term = new VirtualTerminal(80, 10);
		const composer = new Composer({ terminal: term, preferences: { quiet: true } });
		setTranscriptActionHandler(() => {});
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			transcript.addChild(new AssistantMessageComponent(tableMessage(firstTable)));
			transcript.addChild(
				new ClickableBlock(
					Array.from({ length: 18 }, (_, index) => `latest ${index}`),
					[],
				),
			);
			composer.setRuntimeChildren([transcript, new CountingBlock(["fixed editor", "fixed status"])]);
			const paint = () => {
				let frame = composer.renderFrame({ columns: 80, rows: 10 });
				while (frame.history) {
					composer.acknowledgeHistory(frame.history.id);
					frame = composer.renderFrame({ columns: 80, rows: 10 });
				}
				return frame.viewport;
			};
			const original = paint();
			composer.handleTranscriptMouse(mouse(64, 1, 0));
			expect(paint()).not.toEqual(original);
			composer.handleTranscriptMouse(mouse(65, 1, 0));
			expect(paint()).toEqual(original);
			composer.handleTranscriptMouse(mouse(65, 1, 0));
			expect(paint()).toEqual(original);
		} finally {
			composer.stop();
		}
	});

	it("keeps pre-transcript chrome and the original dock while browsing an overflowing transcript", () => {
		const term = new VirtualTerminal(80, 10);
		const composer = new Composer({ terminal: term, preferences: { quiet: true } });
		setTranscriptActionHandler(() => {});
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			transcript.addChild(
				new ClickableBlock(
					Array.from({ length: 20 }, (_, index) => `line ${index}`),
					[],
				),
			);
			composer.setRuntimeChildren([
				new CountingBlock(["persistent pre-root"]),
				transcript,
				new CountingBlock(["fixed editor", "fixed status"]),
			]);
			const original = composer.renderFrame({ columns: 80, rows: 10 }).viewport;
			composer.handleTranscriptMouse(mouse(64, 1, 1));
			const older = composer.renderFrame({ columns: 80, rows: 10 });
			expect(older.history).toBeUndefined();
			expect(older.viewport[0]).toBe("persistent pre-root");
			expect(older.viewport.slice(-2)).toEqual(["fixed editor", "fixed status"]);
			expect(older.viewport.length).toBe(original.length);
			expect(older.viewport).not.toEqual(original);
			composer.handleTranscriptMouse(mouse(65, 1, 1));
			expect(composer.renderFrame({ columns: 80, rows: 10 }).viewport).toEqual(original);
		} finally {
			composer.stop();
		}
	});

	it("selects and clicks the real native committed prefix without changing a compact live allocation", () => {
		const term = new VirtualTerminal(80, 20);
		const composer = new Composer({ terminal: term, preferences: { quiet: true } });
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			transcript.addChild(new AssistantMessageComponent(tableMessage(firstTable)));
			const expanded = Array.from({ length: 24 }, (_, index) => `expanded live ${index}`);
			const active = {
				allocation: Number.MAX_SAFE_INTEGER,
				isTranscriptBlockFinalized: () => false,
				setTranscriptAllocation(rows: number): void {
					this.allocation = rows;
				},
				render(): readonly string[] {
					return this.allocation === Number.MAX_SAFE_INTEGER ? expanded : ["compact live"];
				},
			};
			const dockRows = ["fixed editor", "fixed status"];
			transcript.addChild(active);
			composer.setRuntimeChildren([transcript, new CountingBlock(dockRows)]);
			for (let count = 0; count < 4; count++) composer.ui.renderNow();
			expect(transcript.blockStates()[0]).toBe("committed");
			const original = term.getViewport();
			const origin = composer.ui.getMutableViewport().top;
			expect(origin).toBeGreaterThan(0);
			const localMouse = (button: number, column: number, screenRow: number, release = false) => ({
				...mouse(button, column, screenRow, release),
				row: screenRow - origin,
			});
			expect(composer.ui.getVisibleProviderHistory().map(row => Bun.stripANSI(row).trimEnd())).toEqual(
				original.slice(0, origin).map(row => row.trimEnd()),
			);
			expect(active.allocation).toBeLessThan(Number.MAX_SAFE_INTEGER);
			expect(original.some(row => row.includes("compact live"))).toBe(true);
			expect(original.some(row => row.includes("expanded live"))).toBe(false);
			const point = tableButton(original, "CSV");
			expect(point.row).toBeLessThan(origin);
			composer.handleTranscriptMouse(localMouse(0, point.column, point.row));
			composer.ui.renderNow();
			expect(term.getViewport()).toEqual(original);
			composer.handleTranscriptMouse(localMouse(0, point.column, point.row, true));
			composer.ui.renderNow();
			expect(actions).toEqual([{ act: "copy", text: "Name,Value\nfirst,alpha" }]);
			expect(term.getViewport()).toEqual(original);
			const row = original.findIndex(line => line.includes("first"));
			expect(row).toBeLessThan(origin);
			const column = original[row]!.indexOf("first");
			for (const event of [
				localMouse(0, column, row),
				localMouse(32, column + 5, row),
				localMouse(0, column + 5, row, true),
			]) {
				composer.handleTranscriptMouse(event);
				composer.ui.renderNow();
				expect(term.getViewport()).toEqual(original);
				expect(active.allocation).toBeLessThan(Number.MAX_SAFE_INTEGER);
			}
			expect(actions.at(-1)).toEqual({ act: "copy", text: "first" });
			expect(term.getViewport().findIndex(line => line.includes("fixed editor"))).toBe(
				original.findIndex(line => line.includes("fixed editor")),
			);
			dockRows.unshift(...Array<string>(12).fill("expanded chrome"));
			composer.ui.renderNow();
			const expandedChrome = term.getViewport();
			expect(composer.ui.getMutableViewport().top).not.toBe(origin);
			expect(composer.handleTranscriptMouse(localMouse(0, point.column, point.row)).handled).toBe(false);
			composer.ui.renderNow();
			expect(term.getViewport()).toEqual(expandedChrome);
			expect(actions).toHaveLength(2);
		} finally {
			composer.stop();
		}
	});

	it("browses a genuinely flushed native transcript with no remaining live rows and restores its dock", () => {
		const term = new VirtualTerminal(80, 12);
		const composer = new Composer({ terminal: term, preferences: { quiet: true } });
		setTranscriptActionHandler(() => {});
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			for (let index = 0; index < 6; index++) {
				transcript.addChild(new AssistantMessageComponent(tableMessage(`turn ${index}\n\n${firstTable}`)));
			}
			composer.setRuntimeChildren([transcript, new CountingBlock(["fixed editor", "fixed status"])]);
			composer.beginHistoryFlush();
			for (let count = 0; count < 12; count++) composer.ui.renderNow();
			expect(transcript.blockStates().every(state => state === "committed")).toBe(true);
			const original = term.getViewport();
			const origin = composer.ui.getMutableViewport().top;
			expect(origin).toBeGreaterThan(0);
			expect(composer.ui.getMutableViewport().length).toBe(2);
			expect(composer.handleTranscriptMouse(mouse(64, 1, -1)).handled).toBe(true);
			composer.ui.renderNow();
			expect(term.getViewport()).not.toEqual(original);
			expect(term.getViewport().slice(-2)).toEqual(original.slice(-2));
			expect(composer.ui.getMutableViewport().top).toBe(origin);
			composer.handleTranscriptMouse(mouse(65, 1, -1));
			composer.ui.renderNow();
			expect(term.getViewport()).toEqual(original);
			expect(composer.ui.getMutableViewport().top).toBe(origin);
		} finally {
			composer.stop();
		}
	});

	it("browses committed tables with a fixed dock and live snapshot controls, then returns to latest", () => {
		const term = new VirtualTerminal(80, 10);
		const composer = new Composer({ terminal: term, preferences: { quiet: true } });
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const assistant = new AssistantMessageComponent(tableMessage(firstTable));
			transcript.addChild(assistant);
			const streamedRows = Array.from({ length: 18 }, (_, index) => `latest ${index}`);
			transcript.addChild(new CountingBlock(streamedRows));
			const dock = new CountingBlock(["fixed editor", "fixed status"]);
			composer.setRuntimeChildren([transcript, dock]);
			const paint = () => {
				let frame = composer.renderFrame({ columns: 80, rows: 10 });
				for (let count = 0; frame.history !== undefined && count < 20; count++) {
					composer.acknowledgeHistory(frame.history.id);
					frame = composer.renderFrame({ columns: 80, rows: 10 });
				}
				return frame;
			};
			let frame = paint();
			expect(transcript.blockStates()[0]).toBe("committed");
			const states = [...transcript.blockStates()];
			expect(composer.hasInlineClickTargets()).toBe(true);
			for (let count = 0; !frame.viewport.some(row => row.includes("[Copy TSV]")) && count < 20; count++) {
				expect(composer.handleTranscriptMouse(mouse(64, 1, 0)).handled).toBe(true);
				frame = composer.renderFrame({ columns: 80, rows: 10 });
				expect(frame.history).toBeUndefined();
				expect(frame.viewport.slice(-2)).toEqual(["fixed editor", "fixed status"]);
			}
			const anchored = frame.viewport;
			streamedRows.push("latest 18");
			frame = composer.renderFrame({ columns: 80, rows: 10 });
			expect(frame.viewport).toEqual(anchored);
			transcript.addChild(new CountingBlock(["new incoming message"]));
			frame = composer.renderFrame({ columns: 80, rows: 10 });
			expect(frame.viewport).toEqual(anchored);
			const point = tableButton(frame.viewport, "TSV");
			composer.handleTranscriptMouse(mouse(0, point.column, point.row));
			expect(actions).toEqual([]);
			composer.handleTranscriptMouse(mouse(0, point.column, point.row, true));
			expect(actions).toEqual([{ act: "copy", text: "Name\tValue\nfirst\talpha" }]);
			expect(transcript.blockStates().slice(0, states.length)).toEqual(states);
			for (let count = 0; count < 20; count++) {
				composer.handleTranscriptMouse(mouse(65, 1, 0));
				frame = paint();
			}
			expect(frame.viewport.join("\n")).toContain("latest 17");
			expect(frame.viewport.join("\n")).toContain("latest 18");
			expect(frame.viewport.join("\n")).toContain("new incoming message");
			expect(frame.viewport.join("\n")).not.toContain("[Copy TSV]");
			expect(frame.viewport.slice(-2)).toEqual(["fixed editor", "fixed status"]);
			expect(transcript.blockStates().slice(0, states.length)).toEqual(states);
		} finally {
			composer.stop();
		}
	});

	it("keeps an entirely retired transcript selectable instead of leaving a scrollback-only dead end", () => {
		const term = new VirtualTerminal(80, 12);
		const composer = new Composer({ terminal: term, preferences: { quiet: true } });
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const assistant = new AssistantMessageComponent(tableMessage(firstTable));
			transcript.addChild(assistant);
			const batch = transcript.peekFlushBatch(80)!;
			transcript.acknowledgeFinalizedBatch(batch.id);
			composer.setRuntimeChildren([transcript, new CountingBlock(["fixed editor"])]);
			const frame = composer.renderFrame({ columns: 80, rows: 12 });
			expect(frame.history).toBeUndefined();
			expect(frame.viewport.at(-1)).toBe("fixed editor");
			expect(composer.hasInlineClickTargets()).toBe(true);
			const point = tableButton(frame.viewport, "CSV");
			composer.handleTranscriptMouse(mouse(0, point.column, point.row));
			composer.handleTranscriptMouse(mouse(0, point.column, point.row, true));
			expect(actions).toEqual([{ act: "copy", text: "Name,Value\nfirst,alpha" }]);
			expect(transcript.blockStates()).toEqual(["committed"]);
			expect(composer.handleTranscriptMouse(mouse(64, 1, 0)).handled).toBe(true);
		} finally {
			composer.stop();
		}
	});

	it("preserves generic append-only presentation without a transcript mouse action host", () => {
		const term = new VirtualTerminal(80, 12);
		const composer = new Composer({ terminal: term, preferences: { quiet: true } });
		setTranscriptActionHandler(undefined);
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const assistant = new AssistantMessageComponent(tableMessage(firstTable));
			transcript.addChild(assistant);
			const batch = transcript.peekFlushBatch(80)!;
			transcript.acknowledgeFinalizedBatch(batch.id);
			composer.setRuntimeChildren([transcript, new CountingBlock(["fixed editor"])]);
			expect(composer.renderFrame({ columns: 80, rows: 12 }).viewport).toEqual(["fixed editor"]);
			expect(composer.hasInlineClickTargets()).toBe(false);
			setTranscriptActionHandler(() => {});
			expect(composer.renderFrame({ columns: 80, rows: 12 }).viewport.join("\n")).toContain("[Copy TSV]");
			expect(composer.hasInlineClickTargets()).toBe(true);
			setTranscriptActionHandler(undefined);
			expect(composer.renderFrame({ columns: 80, rows: 12 }).viewport).toEqual(["fixed editor"]);
			expect(composer.hasInlineClickTargets()).toBe(false);
		} finally {
			composer.stop();
		}
	});

	it("cancels pending gestures on overlays, resize, changed painted rows and /new", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { quiet: true } });
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const assistant = new AssistantMessageComponent();
			assistant.updateContent(tableMessage(firstTable));
			transcript.addChild(assistant);
			composer.setRuntimeChildren([transcript]);
			let frame = composer.renderFrame({ columns: 80, rows: 24 });
			let point = tableButton(frame.viewport, "TSV");
			const press = () => {
				composer.handleTranscriptMouse(mouse(0, point.column, point.row));
				composer.handleTranscriptMouse(mouse(32, point.column + 5, point.row));
			};
			press();
			const overlay = composer.ui.showOverlay({ render: () => ["dialog"] });
			expect(composer.handleTranscriptMouse(mouse(0, point.column + 5, point.row, true)).handled).toBe(false);
			overlay.hide();
			frame = composer.renderFrame({ columns: 80, rows: 24 });
			point = tableButton(frame.viewport, "TSV");
			press();
			assistant.updateContent(tableMessage(secondTable));
			frame = composer.renderFrame({ columns: 80, rows: 24 });
			composer.handleTranscriptMouse(mouse(0, point.column + 5, point.row, true));
			expect(actions).toEqual([]);
			point = tableButton(frame.viewport, "TSV");
			press();
			term.resize(60, 24);
			expect(composer.handleTranscriptMouse(mouse(0, point.column + 5, point.row, true)).handled).toBe(false);
			frame = composer.renderFrame({ columns: 60, rows: 24 });
			point = tableButton(frame.viewport, "TSV");
			press();
			transcript.clear();
			expect(composer.handleTranscriptMouse(mouse(0, point.column + 5, point.row, true)).handled).toBe(false);
			expect(actions).toEqual([]);
			expect(composer.hasInlineClickTargets()).toBe(false);
		} finally {
			composer.stop();
		}
	});
});
