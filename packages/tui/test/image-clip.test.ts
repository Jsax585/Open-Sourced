import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Image, ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import {
	type CellDimensions,
	encodeKittyPlacementLine,
	getCellDimensions,
	ImageProtocol,
	parseKittyDirectPlacementLine,
	setCellDimensions,
	TERMINAL,
	wrapTmuxPassthrough,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { type HistoryBatch, TUI } from "@oh-my-pi/pi-tui/tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

type MutableTerminalInfo = { id: string; imageProtocol: ImageProtocol | null };
const terminal = TERMINAL as unknown as MutableTerminalInfo;

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

// Direct-placement contract: a straddling image block must be re-anchored at
// its first visible row with the source rectangle clipped to the visible
// slice, and a placement id whose cells reached native scrollback must never
// be re-used (Kitty replace semantics strip the old placement everywhere,
// scrollback included — the permanently cropped images on WezTerm).

const originalProtocol = TERMINAL.imageProtocol;
const originalTerminalId = terminal.id;
const originalGraphics = { ...getKittyGraphics() };
let originalCellDims: CellDimensions;

beforeEach(() => {
	originalCellDims = getCellDimensions();
	setCellDimensions({ widthPx: 10, heightPx: 10 });
	terminal.imageProtocol = ImageProtocol.Kitty;
	terminal.id = "wezterm";
	setKittyGraphics({ unicodePlaceholders: false });
});

afterEach(() => {
	vi.restoreAllMocks();
	setCellDimensions(originalCellDims);
	terminal.imageProtocol = originalProtocol;
	terminal.id = originalTerminalId;
	setKittyGraphics(originalGraphics);
});

describe("kitty direct-placement wire format", () => {
	it("round-trips the exact line Image renders for a direct placement", () => {
		const budget = new ImageBudget(8, () => {});
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 6, budget, imageKey: "roundtrip" },
			{ widthPx: 40, heightPx: 60 },
		);
		const imageId = budget.acquireId("roundtrip");
		budget.beginPass();
		const lines = image.render(40);
		budget.endPass();
		expect(lines.length).toBe(6);
		const parsed = parseKittyDirectPlacementLine(lines[lines.length - 1]!);
		expect(parsed).toEqual({ imageId, placementId: imageId, columns: 4, rows: 6 });
	});

	it("rejects non-placement image lines", () => {
		// Placeholder virtual placement (a=p,U=1 lead) is not a direct placement.
		expect(parseKittyDirectPlacementLine("\x1b_Ga=p,U=1,q=2,i=5,p=5,c=4,r=4\x1b\\")).toBeNull();
		// Transmit-and-display and plain text never match.
		expect(parseKittyDirectPlacementLine("\x1b_Ga=T,f=100,q=2,C=1,c=4,r=4;AAAA\x1b\\")).toBeNull();
		expect(parseKittyDirectPlacementLine("plain text")).toBeNull();
	});

	it("recognizes passthrough placements so tmux redraws can delete the old image", () => {
		const line = `\x1b7\x1b[3A${wrapTmuxPassthrough("\x1b_Ga=p,q=2,C=1,i=5,p=5,c=4,r=4\x1b\\")}\x1b8`;
		expect(parseKittyDirectPlacementLine(line)).toEqual({ imageId: 5, placementId: 5, columns: 4, rows: 4 });
	});

	it("encodes the anchored, clipped, and last-row-only placement forms", () => {
		const base = { imageId: 7, columns: 4, rows: 6, imageHeightPx: 60 };
		// Whole block visible (last line at viewport row 9): full anchored form.
		expect(encodeKittyPlacementLine({ ...base, placementId: 1, screenRow: 9 })).toBe(
			"\x1b7\x1b[5A\x1b_Ga=p,q=2,C=1,i=7,p=1,c=4,r=6\x1b\\\x1b8",
		);
		// Straddling (last line at row 3): two rows hidden above, four visible —
		// the source slice starts at 60*2/6 = 20px.
		expect(encodeKittyPlacementLine({ ...base, placementId: 2, screenRow: 3 })).toBe(
			"\x1b7\x1b[3A\x1b_Ga=p,q=2,C=1,i=7,p=2,c=4,r=4,y=20,h=40\x1b\\\x1b8",
		);
		// Only the last row visible: no cursor movement, bottom slice only.
		expect(encodeKittyPlacementLine({ ...base, placementId: 3, screenRow: 0 })).toBe(
			"\x1b_Ga=p,q=2,C=1,i=7,p=3,c=4,r=1,y=50,h=10\x1b\\",
		);
	});
});

/** A multi-row graphic for exercising viewport ownership against the terminal engine. */
function image(budget: ImageBudget): Image {
	return new Image(
		BASE64_ONE_PIXEL_PNG,
		"image/png",
		{ fallbackColor: text => text },
		{ maxWidthCells: 4, maxHeightCells: 4, budget, imageKey: "placement" },
		{ widthPx: 40, heightPx: 40 },
	);
}

describe("direct placement lifecycle", () => {
	for (const fullscreen of [false, true]) {
		it(`removes moved and hidden images from the ${fullscreen ? "alternate" : "normal"} viewport`, async () => {
			const term = new VirtualTerminal(40, 12);
			const scheduler = new VirtualRenderScheduler();
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			const graphic = image(tui.imageBudget);
			let top = 1;
			let visible = true;
			const render = (width: number) => [
				...Array.from({ length: top }, (_, index) => `prose ${index}`),
				...(visible ? graphic.render(width) : ["replacement prose"]),
			];
			tui.setFrameProvider({ renderFrame: size => ({ viewport: render(size.columns) }), acknowledgeHistory() {} });
			if (fullscreen) tui.showOverlay({ render, invalidate() {} }, { fullscreen: true, anchor: "top-left" });
			try {
				tui.start();
				await scheduler.settle(term);
				expect(term.graphicsPlacements().map(placement => placement.row)).toEqual([1]);

				top = 2;
				tui.requestRender();
				await scheduler.settle(term);
				expect(term.graphicsPlacements().map(placement => placement.row)).toEqual([2]);

				visible = false;
				tui.requestRender();
				await scheduler.settle(term);
				expect(term.graphicsPlacements()).toEqual([]);
				expect(term.getViewport()[2]?.trimEnd()).toBe("replacement prose");
			} finally {
				tui.stop();
			}
		});
	}

	it("deletes a live copy without deleting the same image already committed to scrollback", async () => {
		const term = new VirtualTerminal(40, 12);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const graphic = image(tui.imageBudget);
		let append = false;
		let acknowledged = false;
		let visible = true;
		tui.setFrameProvider({
			renderFrame: size => {
				const rows = graphic.render(size.columns);
				const history: HistoryBatch | undefined =
					append && !acknowledged
						? { id: 1, rows: [...rows, ...Array.from({ length: 16 }, (_, index) => `history ${index}`)] }
						: undefined;
				return { history, viewport: visible ? rows : ["replacement prose"] };
			},
			acknowledgeHistory() {
				acknowledged = true;
			},
		});
		try {
			tui.start();
			await scheduler.settle(term);
			append = true;
			visible = false;
			tui.requestRender();
			await scheduler.settle(term);
			const archived = term.graphicsPlacements();
			expect(archived).toHaveLength(1);

			visible = true;
			tui.requestRender();
			await scheduler.settle(term);
			expect(term.graphicsPlacements()).toHaveLength(2);

			visible = false;
			tui.requestRender();
			await scheduler.settle(term);
			expect(term.graphicsPlacements()).toEqual(archived);
		} finally {
			tui.stop();
		}
	});

	it("preserves replay history split into the viewport after the next live repaint", async () => {
		const term = new VirtualTerminal(40, 12);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const graphic = image(tui.imageBudget);
		let acknowledged = false;
		tui.setFrameProvider({
			renderFrame: size => ({
				history: acknowledged ? undefined : { id: 1, kind: "replay", rows: graphic.render(size.columns) },
				viewport: ["live prose"],
			}),
			acknowledgeHistory() {
				acknowledged = true;
			},
		});
		try {
			tui.start();
			await scheduler.settle(term);
			const archived = term.graphicsPlacements();
			expect(archived).toHaveLength(1);

			tui.requestRender();
			await scheduler.settle(term);
			expect(term.graphicsPlacements()).toEqual(archived);
		} finally {
			tui.stop();
		}
	});
});

const ITERM_RASTER = "▓";

/**
 * Paint the cell footprint of the actual emitted OSC 1337 over the VT grid.
 * Native erases then remove those cells just as they remove an inline image.
 * Absolute cursor moves keep the image line's own DEC save/restore untouched.
 */
function trackItermRaster(term: VirtualTerminal): { row: number; col: number; columns: number; rows: number }[] {
	const placements: { row: number; col: number; columns: number; rows: number }[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		let offset = 0;
		for (const match of data.matchAll(/\x1b\]1337;File=([^:]*):[^\x07]*\x07/g)) {
			realWrite(data.slice(offset, match.index));
			offset = match.index + match[0].length;
			const columns = Number(/(?:^|;)width=(\d+)(?:;|$)/.exec(match[1]!)?.[1]);
			const rows = Number(/(?:^|;)height=(\d+)(?:;|$)/.exec(match[1]!)?.[1]);
			if (!(columns > 0 && rows > 0)) throw new Error("Expected an explicitly cell-sized inline image");
			const cursor = term.getCursor();
			placements.push({ ...cursor, columns, rows });
			let paint = "";
			for (let row = cursor.row; row < Math.min(term.rows, cursor.row + rows); row++) {
				paint += `\x1b[${row + 1};${cursor.col + 1}H${ITERM_RASTER.repeat(columns)}`;
			}
			realWrite(`${paint}\x1b[${cursor.row + 1};${cursor.col + 1}H`);
		}
		realWrite(data.slice(offset));
	});
	return placements;
}

describe("iTerm2 direct placement boundaries", () => {
	for (const fullscreen of [false, true]) {
		it(`clears a moved image's old top strip across identical reserved rows in the ${fullscreen ? "alternate" : "normal"} viewport`, async () => {
			terminal.imageProtocol = ImageProtocol.Iterm2;
			terminal.id = "iterm2";
			const term = new VirtualTerminal(40, 12);
			const placements = trackItermRaster(term);
			const scheduler = new VirtualRenderScheduler();
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			const graphic = image(tui.imageBudget);
			let top = 0;
			let footer = "following prose";
			const render = (width: number) => {
				const rows = graphic.render(width);
				// Layout can reserve the same zero-width rows as an adjacent image.
				// Moving the image must clear its old pixels even when those rows match.
				return [...Array.from({ length: top }, () => rows[0]!), ...rows, footer];
			};
			tui.setFrameProvider({ renderFrame: size => ({ viewport: render(size.columns) }), acknowledgeHistory() {} });
			if (fullscreen) tui.showOverlay({ render, invalidate() {} }, { fullscreen: true, anchor: "top-left" });
			try {
				tui.start();
				await scheduler.settle(term);
				expect(placements).toEqual([{ row: 0, col: 0, columns: 4, rows: 4 }]);

				top = 1;
				tui.requestRender();
				await scheduler.settle(term);
				expect(placements).toEqual([
					{ row: 0, col: 0, columns: 4, rows: 4 },
					{ row: 1, col: 0, columns: 4, rows: 4 },
				]);
				expect(term.getViewport().flatMap((line, row) => (line.includes(ITERM_RASTER) ? [row] : []))).toEqual([
					1, 2, 3, 4,
				]);
				expect(term.getViewport()[5]?.trimEnd()).toBe("following prose");
				expect(term.getBufferPosition().baseY).toBe(0);

				footer = "updated following prose";
				tui.requestRender();
				await scheduler.settle(term);
				expect(placements).toHaveLength(2);
				expect(term.getViewport()[5]?.trimEnd()).toBe(footer);
			} finally {
				tui.stop();
			}
		});
	}

	for (const archivedImage of [false, true]) {
		it(`drops an unpaintable live image tail without overwriting ${archivedImage ? "its complete visible history copy" : "the following unchanged prose"}`, async () => {
			terminal.imageProtocol = ImageProtocol.Iterm2;
			terminal.id = "iterm2";
			const term = new VirtualTerminal(40, 12);
			const placements = trackItermRaster(term);
			const scheduler = new VirtualRenderScheduler();
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			const graphic = image(tui.imageBudget);
			let phase = 0;
			let acknowledged = 0;
			tui.setFrameProvider({
				renderFrame: size => {
					const rows = graphic.render(size.columns);
					const history: HistoryBatch | undefined = !archivedImage
						? undefined
						: phase === 0 && acknowledged < 1
							? { id: 1, rows: ["retained 0", "retained 1", "retained 2"] }
							: phase === 1 && acknowledged < 2
								? { id: 2, rows }
								: undefined;
					const live = phase === 0 ? rows : rows.slice(2);
					return {
						history,
						viewport: [
							...live.map((line, index) => (phase === 2 && index === live.length - 1 ? `${line}\x1b[0m` : line)),
							"following prose",
							"another untouched line",
						],
					};
				},
				acknowledgeHistory(id) {
					acknowledged = id;
				},
			});
			try {
				tui.start();
				await scheduler.settle(term);
				expect(placements).toEqual([{ row: archivedImage ? 3 : 0, col: 0, columns: 4, rows: 4 }]);

				phase = 1;
				tui.requestRender();
				await scheduler.settle(term);
				const expectedPlacements = archivedImage ? 2 : 1;
				expect(placements).toHaveLength(expectedPlacements);
				if (archivedImage) {
					expect(placements[1]).toEqual({ row: 3, col: 0, columns: 4, rows: 4 });
					expect(acknowledged).toBe(2);
				}

				// Only the image line changes now. An uncropped whole-image repaint
				// would overwrite prose that the row diff otherwise leaves untouched.
				phase = 2;
				tui.requestRender();
				await scheduler.settle(term);
				expect(placements).toHaveLength(expectedPlacements);
				const viewport = term.getViewport();
				expect(viewport.flatMap((line, row) => (line.includes(ITERM_RASTER) ? [row] : []))).toEqual(
					archivedImage ? [3, 4, 5, 6] : [],
				);
				if (archivedImage) {
					expect(viewport.slice(0, 3).map(line => line.trimEnd())).toEqual([
						"retained 0",
						"retained 1",
						"retained 2",
					]);
				}
				const liveTop = archivedImage ? 7 : 0;
				expect(viewport[liveTop + 2]?.trimEnd()).toBe("following prose");
				expect(viewport[liveTop + 3]?.trimEnd()).toBe("another untouched line");
				expect(term.getCursor()).toEqual({ row: liveTop, col: 0 });
				expect(term.getBufferPosition().baseY).toBe(0);
			} finally {
				tui.stop();
			}
		});
	}
});
