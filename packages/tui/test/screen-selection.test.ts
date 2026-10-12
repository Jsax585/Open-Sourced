import { describe, expect, it, spyOn } from "bun:test";
import { encodeTextSized, type TerminalFramePlan, type TerminalFrameProvider, TUI } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

class Provider implements TerminalFrameProvider {
	plan: TerminalFramePlan;

	constructor(viewport: string[]) {
		this.plan = { viewport };
	}

	renderFrame(): TerminalFramePlan {
		return this.plan;
	}

	renderResizeFrame(): readonly string[] {
		return this.plan.viewport;
	}

	acknowledgeHistory(): void {
		this.plan = { viewport: this.plan.viewport };
	}

	beginHistoryReplay(): void {}
}

describe("TUI screen selection", () => {
	it("follows its rows when content above them grows, ignoring repeated separator rows", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const scheduler = new VirtualRenderScheduler();
		const provider = new Provider(["───", "alpha one", "───", "editor"]);
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		tui.start();
		await scheduler.settle(terminal);

		// Anchor on a separator: a row whose content repeats elsewhere on screen.
		tui.setScreenSelection({ anchor: { row: 0, col: 0 }, focus: { row: 1, col: 8 } });
		expect(tui.getScreenSelectionText()).toBe("───\nalpha one");

		// A row inserted above moves the selected rows down by two; the old
		// separator row now holds a different separator at the same position.
		provider.plan = { viewport: ["───", "inserted", "───", "alpha one", "───", "editor"] };
		tui.requestRender();
		await scheduler.settle(terminal);
		expect(tui.getScreenSelectionText()).toBe("───\nalpha one");
		tui.stop();
	});

	it("follows its rows when content above them grows while the row below changes", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const scheduler = new VirtualRenderScheduler();
		const provider = new Provider(["intro", "target row", "streaming", "editor"]);
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		tui.start();
		await scheduler.settle(terminal);

		tui.setScreenSelection({ anchor: { row: 1, col: 0 }, focus: { row: 1, col: 5 } });
		expect(tui.getScreenSelectionText()).toBe("target");

		// Two rows land above the selection while the line below it keeps streaming.
		provider.plan = { viewport: ["intro", "new one", "new two", "target row", "streaming more", "editor"] };
		tui.requestRender();
		await scheduler.settle(terminal);
		expect(tui.getScreenSelectionText()).toBe("target");
		tui.stop();
	});

	it("keeps the selected text when its rows commit to history and scroll up", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const scheduler = new VirtualRenderScheduler();
		const provider = new Provider(["alpha one", "bravo two", "charlie", "", "", "editor"]);
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		tui.start();
		await scheduler.settle(terminal);

		tui.setScreenSelection({ anchor: { row: 1, col: 6 }, focus: { row: 2, col: 2 } });
		expect(tui.getScreenSelectionText()).toBe("two\ncha");

		// Three rows commit and four new ones follow: the screen scrolls one row,
		// pushing "alpha one" into native scrollback and the selection to the top.
		provider.plan = {
			history: { id: 1, rows: ["alpha one", "bravo two", "charlie"], kind: "append" },
			viewport: ["delta", "echo", "foxtrot", "editor"],
		};
		tui.requestRender();
		await scheduler.settle(terminal);
		expect(terminal.getViewport()[0]?.trimEnd()).toBe("bravo two");
		expect(tui.getScreenSelectionText()).toBe("two\ncha");
		tui.stop();
	});

	it("drops the selection when a resize reflows the screen", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const scheduler = new VirtualRenderScheduler();
		const provider = new Provider(["alpha one", "editor"]);
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		tui.start();
		await scheduler.settle(terminal);

		tui.setScreenSelection({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 4 } });
		expect(tui.getScreenSelectionText()).toBe("alpha");

		terminal.resize(30, 6);
		await scheduler.advance(terminal, 200);
		await scheduler.settle(terminal);
		expect(tui.getScreenSelectionText()).toBe("");
		tui.stop();
	});

	it("snaps a start on a wide glyph's second cell back to the glyph", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const scheduler = new VirtualRenderScheduler();
		const provider = new Provider(["界X界Y", "editor"]);
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		tui.start();
		await scheduler.settle(terminal);

		// Column 1 is the continuation cell of the first 界.
		tui.setScreenSelection({ anchor: { row: 0, col: 1 }, focus: { row: 0, col: 2 } });
		await terminal.flush();
		expect(tui.getScreenSelectionText()).toBe("界X");
		// The highlight rewrite must not split the glyph.
		expect(terminal.getViewport()[0]?.trimEnd()).toBe("界X界Y");
		tui.stop();
	});

	it("repaints only the rows whose highlight a drag changes", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const scheduler = new VirtualRenderScheduler();
		const provider = new Provider(["row a", "row b", "row c", "row d", "row e", "editor"]);
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		tui.start();
		await scheduler.settle(terminal);

		tui.setScreenSelection({ anchor: { row: 0, col: 0 }, focus: { row: 3, col: 2 } });
		const write = spyOn(terminal, "write");
		try {
			// Rows 0-2 stay fully selected; only the old and new focus rows change.
			tui.extendScreenSelection({ row: 4, col: 1 });
			const addressed = write.mock.calls.flatMap(([data]) =>
				[...data.matchAll(/\x1b\[(\d+);\d+H/g)].map(match => Number(match[1]) - 1),
			);
			expect([...new Set(addressed)].sort((a, b) => a - b)).toEqual([3, 4]);
		} finally {
			write.mockRestore();
		}
		expect(terminal.getViewportRowReverseColumns(0)).toEqual([0, 1, 2, 3, 4]);
		expect(terminal.getViewportRowReverseColumns(3)).toEqual([0, 1, 2, 3, 4]);
		expect(terminal.getViewportRowReverseColumns(4)).toEqual([0, 1]);

		// Dragging back up restores every row the selection left.
		tui.extendScreenSelection({ row: 1, col: 2 });
		expect(terminal.getViewportRowReverseColumns(1)).toEqual([0, 1, 2]);
		for (const row of [2, 3, 4]) expect(terminal.getViewportRowReverseColumns(row)).toEqual([]);
		expect(tui.getScreenSelectionText()).toBe("row a\nrow");
		tui.stop();
	});

	it("reads the text of an OSC 66 sized heading, whole or from inside the span", async () => {
		const terminal = new VirtualTerminal(30, 6);
		const scheduler = new VirtualRenderScheduler();
		const heading = encodeTextSized("Heading One", { scale: 2, widthCells: 11 });
		const provider = new Provider(["intro", heading, "", "after text", "editor"]);
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		tui.start();
		await scheduler.settle(terminal);

		tui.setScreenSelection({ anchor: { row: 0, col: 0 }, focus: { row: 3, col: 4 } });
		expect(tui.getScreenSelectionText()).toBe("intro\nHeading One\n\nafter");

		// Cells 2–5 of the scale-2 heading hold "ea": a start inside the span
		// stays in screen columns instead of the span's unscaled width.
		tui.setScreenSelection({ anchor: { row: 1, col: 2 }, focus: { row: 1, col: 5 } });
		expect(tui.getScreenSelectionText()).toBe("ea");
		tui.stop();
	});
});
