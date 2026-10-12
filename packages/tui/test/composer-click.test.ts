import { beforeAll, describe, expect, it } from "bun:test";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Container, type Component } from "@oh-my-pi/pi-tui";
import { Box } from "@oh-my-pi/pi-tui/components/box";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { markFramedBlockComponent } from "@oh-my-pi/pi-tui/render";
import { VirtualTerminal } from "./virtual-terminal";
import { routeViewportClick, type ViewportClickSpan } from "@oh-my-pi/pi-tui/prompt/composer";

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

class MouseTarget implements Component {
	events: Array<{ col: number; row: number }> = [];
	clicked = false;
	consume = true;
	renders = 0;
	rows: readonly string[] = ["mouse target"];
	render(): readonly string[] {
		this.renders++;
		return this.clicked ? ["mouse clicked"] : this.rows;
	}
	handleMouse(event: { col: number; row: number; leftClick: boolean }): boolean | void {
		if (!event.leftClick) return false;
		this.events.push({ col: event.col, row: event.row });
		this.clicked = true;
		if (this.consume) return true;
	}
}

describe("composer mouse dispatch", () => {
	beforeAll(() => {
		initTheme();
	});

	it("routes left-clicks to the rendered widget with local row and terminal column", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		const target = new MouseTarget();
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const chrome = new Container();
			chrome.addChild(target);
			composer.setRuntimeChildren([transcript, chrome]);
			const frame = composer.renderFrame({ columns: 80, rows: 24 });
			const row = frame.viewport.findIndex(line => line.includes("mouse target"));
			expect(row).toBeGreaterThanOrEqual(0);
			expect(
				composer.dispatchViewportMouse({
					button: 0,
					col: 7,
					row,
					release: false,
					wheel: null,
					motion: false,
					leftClick: true,
				}),
			).toBe("consumed");
			expect(target.events).toEqual([{ col: 7, row: 0 }]);
			expect(composer.renderFrame({ columns: 80, rows: 24 }).viewport.join("\n")).toContain("mouse clicked");
			expect(
				composer.dispatchViewportMouse({
					button: 0,
					col: 7,
					row: -1,
					release: false,
					wheel: null,
					motion: false,
					leftClick: true,
				}),
			).toBe("none");
			expect(
				composer.dispatchViewportMouse({
					button: 0,
					col: 7,
					row,
					release: false,
					wheel: null,
					motion: false,
					leftClick: false,
				}),
			).toBe("none");
		} finally {
			composer.stop();
		}
	});
	it("routes clicks to components rendered inside the live transcript", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		const target = new MouseTarget();
		target.rows = ["", "mouse target", ""];
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			transcript.addChild(target);
			composer.setRuntimeChildren([transcript]);
			const frame = composer.renderFrame({ columns: 80, rows: 24 });
			const row = frame.viewport.findIndex(line => line.includes("mouse target"));
			expect(row).toBeGreaterThanOrEqual(0);
			expect(
				composer.dispatchViewportMouse({
					button: 0,
					col: 7,
					row,
					release: false,
					wheel: null,
					motion: false,
					leftClick: true,
				}),
			).toBe("consumed");
			expect(target.events).toEqual([{ col: 7, row: 1 }]);
			expect(composer.renderFrame({ columns: 80, rows: 24 }).viewport.join("\n")).toContain("mouse clicked");
		} finally {
			composer.stop();
		}
	});
	it("routes clicks through nested containers and padded boxes to transcript children", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		const target = new MouseTarget();
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const box = new Box(0, 1, text => `\x1b[34m${text}\x1b[0m`);
			const nested = new Container();
			nested.addChild(target);
			box.addChild(nested);
			transcript.addChild(box);
			composer.setRuntimeChildren([transcript]);
			const frame = composer.renderFrame({ columns: 80, rows: 24 });
			const row = frame.viewport.findIndex(line => line.includes("mouse target"));
			expect(row).toBeGreaterThanOrEqual(0);
			expect(
				composer.dispatchViewportMouse({
					button: 0,
					col: 7,
					row,
					release: false,
					wheel: null,
					motion: false,
					leftClick: true,
				}),
			).toBe("consumed");
			expect(target.events).toEqual([{ col: 7, row: 0 }]);
			expect(
				composer.dispatchViewportMouse({
					button: 0,
					col: 7,
					row: row - 1,
					release: false,
					wheel: null,
					motion: false,
					leftClick: true,
				}),
			).toBe("delivered");
			expect(target.events).toEqual([{ col: 7, row: 0 }]);
		} finally {
			composer.stop();
		}
	});
	it("reports delivery without consumption when a handler returns void", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		const target = new MouseTarget();
		target.consume = false;
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const chrome = new Container();
			chrome.addChild(target);
			composer.setRuntimeChildren([transcript, chrome]);
			const frame = composer.renderFrame({ columns: 80, rows: 24 });
			const row = frame.viewport.findIndex(line => line.includes("mouse target"));
			expect(row).toBeGreaterThanOrEqual(0);
			expect(
				composer.dispatchViewportMouse({
					button: 0,
					col: 7,
					row,
					release: false,
					wheel: null,
					motion: false,
					leftClick: true,
				}),
			).toBe("delivered");
			expect(target.events).toEqual([{ col: 7, row: 0 }]);
		} finally {
			composer.stop();
		}
	});
	it("does not dispatch mouse events to a tool renderer hidden by its fallback", () => {
		const target = new MouseTarget();
		target.render = () => {
			throw new Error("renderer failed");
		};
		const tool = { label: "custom", renderCall: () => target };
		const component = new ToolExecutionComponent(
			"custom",
			{},
			{ useBuiltInRenderer: false },
			tool as never,
			{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as never,
		);
		component.render(80);

		expect(
			component.handleMouse({
				button: 0,
				col: 2,
				row: 1,
				release: false,
				wheel: null,
				motion: false,
				leftClick: true,
			}),
		).toBe(false);
		expect(target.events).toEqual([]);
	});
	it("restores the row offset when a tight tool allocation trims leading blank rows", () => {
		const target = markFramedBlockComponent(new MouseTarget());
		target.rows = ["", "visible row 1", "visible row 2"];
		const tool = { label: "custom", renderCall: () => target };
		const component = new ToolExecutionComponent(
			"custom",
			{},
			{ useBuiltInRenderer: false },
			tool as never,
			{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as never,
		);
		component.setTranscriptAllocation(2, { tick: 0, now: 0 });
		const rows = component.render(80);
		expect(rows).toHaveLength(2);
		expect(Bun.stripANSI(rows.join("\n"))).toContain("visible row 1");
		expect(Bun.stripANSI(rows.join("\n"))).toContain("visible row 2");

		const event = {
			button: 0,
			col: 2,
			row: 0,
			release: false,
			wheel: null,
			motion: false,
			leftClick: true,
		};
		expect(component.handleMouse(event)).toBe(true);
		event.row = 1;
		expect(component.handleMouse(event)).toBe(true);
		expect(target.events).toEqual([
			{ col: 2, row: 1 },
			{ col: 2, row: 2 },
		]);
	});
	it("does not route compact custom-tool rows to hidden renderer controls", () => {
		const target = new MouseTarget();
		target.rows = ["row 0", "row 1", "row 2", "row 3"];
		const tool = { label: "custom", renderCall: () => target };
		const component = new ToolExecutionComponent(
			"custom",
			{},
			{ useBuiltInRenderer: false },
			tool as never,
			{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as never,
		);
		component.setTranscriptAllocation(2, { tick: 0, now: 0 });
		expect(component.render(80)).toHaveLength(2);

		expect(
			component.handleMouse({
				button: 0,
				col: 2,
				row: 1,
				release: false,
				wheel: null,
				motion: false,
				leftClick: true,
			}),
		).toBe(false);
		expect(target.events).toEqual([]);
	});

	it("does not reuse a container hit map after removing a child", () => {
		const container = new Container();
		const removed = new MouseTarget();
		const remaining = new MouseTarget();
		container.addChild(removed);
		container.addChild(remaining);
		container.render(80);
		container.removeChild(removed);
		const event = {
			button: 0,
			col: 3,
			row: 0,
			release: false,
			wheel: null,
			motion: false,
			leftClick: true,
		};
		expect(container.handleMouse(event)).toBe(false);
		expect(remaining.events).toEqual([]);

		container.render(80);
		expect(container.handleMouse(event)).toBe(true);
		expect(remaining.events).toEqual([{ col: 3, row: 0 }]);
	});
	it("does not route docked children omitted by a custom root render", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		const hiddenTarget = new MouseTarget();
		hiddenTarget.rows = ["hidden child"];
		const hiddenRoot = new (class extends Container {
			override render(width: number): readonly string[] {
				super.render(width);
				return [];
			}
		})();
		hiddenRoot.addChild(hiddenTarget);
		const visibleTarget = new MouseTarget();
		visibleTarget.rows = ["visible widget"];
		const visibleRoot = new Container();
		visibleRoot.addChild(visibleTarget);
		composer.start();
		try {
			composer.setRuntimeChildren([new TranscriptContainer(), hiddenRoot, visibleRoot]);
			const frame = composer.renderFrame({ columns: 80, rows: 24 });
			const visibleRow = frame.viewport.findIndex(line => line.includes("visible widget"));
			expect(visibleRow).toBeGreaterThanOrEqual(0);
			expect(hiddenTarget.renders).toBe(1);

			expect(
				composer.dispatchViewportMouse({
					button: 0,
					col: 7,
					row: visibleRow,
					release: false,
					wheel: null,
					motion: false,
					leftClick: true,
				}),
			).toBe("consumed");
			expect(hiddenTarget.events).toEqual([]);
			expect(visibleTarget.events).toEqual([{ col: 7, row: 0 }]);
		} finally {
			composer.stop();
		}
	});

	it("fails closed for docked children removed after paint and before repaint", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		const target = new MouseTarget();
		const chrome = new Container();
		chrome.addChild(target);
		composer.start();
		try {
			composer.setRuntimeChildren([new TranscriptContainer(), chrome]);
			const frame = composer.renderFrame({ columns: 80, rows: 24 });
			const row = frame.viewport.findIndex(line => line.includes("mouse target"));
			expect(row).toBeGreaterThanOrEqual(0);

			chrome.removeChild(target);
			expect(
				composer.dispatchViewportMouse({
					button: 0,
					col: 7,
					row,
					release: false,
					wheel: null,
					motion: false,
					leftClick: true,
				}),
			).toBe("none");
			expect(target.events).toEqual([]);
		} finally {
			composer.stop();
		}
	});

	it("rejects stale Box mouse layouts after direct child replacement or reorder", () => {
		const event = {
			button: 0,
			col: 7,
			row: 0,
			release: false,
			wheel: null,
			motion: false,
			leftClick: true,
		};
		const original = new MouseTarget();
		const replacement = new MouseTarget();
		const replacedBox = new Box(0, 0);
		replacedBox.addChild(original);
		replacedBox.render(80);
		replacedBox.children[0] = replacement;
		expect(replacedBox.handleMouse(event)).toBe(false);
		expect(replacement.events).toEqual([]);

		const first = new MouseTarget();
		const second = new MouseTarget();
		const reorderedBox = new Box(0, 0);
		reorderedBox.addChild(first);
		reorderedBox.addChild(second);
		reorderedBox.render(80);
		reorderedBox.children.reverse();
		expect(reorderedBox.handleMouse(event)).toBe(false);
		expect(first.events).toEqual([]);
		expect(second.events).toEqual([]);
	});
});
