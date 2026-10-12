import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { inflateSync } from "node:zlib";
import * as natives from "@oh-my-pi/pi-natives";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Image } from "@oh-my-pi/pi-tui/components/image";
import {
	encodeKittyPlaceholderGrid,
	getKittyGraphics,
	KITTY_PLACEHOLDER,
	setKittyGraphics,
} from "@oh-my-pi/pi-tui/kitty-graphics";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import {
	type CellDimensions,
	encodeImageRowsNow,
	getCellDimensions,
	ImageProtocol,
	renderImage,
	setCellDimensions,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

// 40x60 px, six 10 px bands; band k is rgb(20 + 40k, 0, 0). At 10x10 px cells
// and 4 columns, terminal row k of the image shows band k.
const BANDED_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAACgAAAA8CAIAAACb22+3AAAASklEQVR42u3NMREAIRAEsBOBnJeDHOQg58XgYZttMpM+s2YqRiwWi+P4KxGLxeI83iVisVicx6dELBaL8/iWiMVicR7/JWKxWBx7cgdlPdozFvUAAAAASUVORK5CYII=";
const IMAGE_COLUMNS = 4;

const OSC_1337 = /\x1b\]1337;File=([^:\x07]*):([A-Za-z0-9+/=]*)\x07/g;

/** Size and the red channel of one pixel of a non-interlaced 8-bit RGB/RGBA PNG. */
function pngPixel(png: Buffer, x: number, y: number): { width: number; height: number; red: number } {
	const width = png.readUInt32BE(16);
	const height = png.readUInt32BE(20);
	const channels = png[25] === 6 ? 4 : 3;
	const idat: Buffer[] = [];
	for (let offset = 8; offset < png.length;) {
		const length = png.readUInt32BE(offset);
		if (png.toString("latin1", offset + 4, offset + 8) === "IDAT")
			idat.push(png.subarray(offset + 8, offset + 8 + length));
		offset += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const rows: Uint8Array[] = [];
	for (let row = 0; row <= y; row++) {
		const filter = raw[row * (stride + 1)]!;
		const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
		const prior = rows[row - 1];
		const out = new Uint8Array(stride);
		for (let i = 0; i < stride; i++) {
			const left = i >= channels ? out[i - channels]! : 0;
			const up = prior ? prior[i]! : 0;
			const upLeft = prior && i >= channels ? prior[i - channels]! : 0;
			const p = left + up - upLeft;
			const paeth =
				Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - upLeft)
					? left
					: Math.abs(p - up) <= Math.abs(p - upLeft)
						? up
						: upLeft;
			const predictor = [0, left, up, (left + up) >> 1, paeth][filter]!;
			out[i] = (line[i]! + predictor) & 0xff;
		}
		rows.push(out);
	}
	return { width, height, red: rows[y]![x * channels]! };
}

/**
 * iTerm2's cell model on top of the engine: an inline image occupies `height`
 * rows of `width` cells from the cursor, text and erases replace its cells,
 * and scrolling carries them into history. Each painted row becomes the label
 * of the source band its pixels show, so the text grid records which slice of
 * the image every terminal row really displays.
 */
class ITerm2CellTerminal extends VirtualTerminal {
	override write(data: string): void {
		let last = 0;
		for (const match of data.matchAll(OSC_1337)) {
			super.write(data.slice(last, match.index));
			last = match.index + match[0].length;
			const params = Object.fromEntries(match[1]!.split(";").map(pair => pair.split("=")));
			const png = Buffer.from(match[2]!, "base64");
			const cell = getCellDimensions();
			const columns = Number(params.width);
			const { width, height } = pngPixel(png, 0, 0);
			const rows =
				params.height === "auto"
					? Math.ceil((columns * cell.widthPx * height) / width / cell.heightPx)
					: Number(params.height);
			const column = this.getCursor().col;
			let painted = "";
			for (let row = 0; row < rows; row++) {
				if (row > 0) painted += `\n\r${column > 0 ? `\x1b[${column}C` : ""}`;
				const { red } = pngPixel(png, Math.floor(width / 2), Math.floor(((row + 0.5) * height) / rows));
				painted += label(Math.round((red - 20) / 40));
			}
			super.write(painted);
		}
		super.write(data.slice(last));
	}
}

function label(band: number): string {
	return `@${band}`.padEnd(IMAGE_COLUMNS, "#");
}

// Kitty Unicode placeholders are real text cells, so the engine shows exactly
// the rows the frame plan laid out; the row diacritic names the image row.
const PLACEHOLDER_ROW = new Map(
	encodeKittyPlaceholderGrid({ imageId: 1, columns: 1, rows: 6 }).map((line, row) => [
		Bun.stripANSI(line).codePointAt(KITTY_PLACEHOLDER.length)!,
		row,
	]),
);

function normalize(row: string): string {
	const text = Bun.stripANSI(row).trimEnd();
	const start = text.indexOf(KITTY_PLACEHOLDER);
	if (start < 0) return text;
	const band = PLACEHOLDER_ROW.get(text.codePointAt(start + KITTY_PLACEHOLDER.length)!);
	return text.slice(0, start) + label(band ?? -1);
}

interface Transcript {
	frames: string[][];
	history: string[];
}

async function streamPastImage(protocol: ImageProtocol): Promise<Transcript> {
	info.imageProtocol = protocol;
	const term = protocol === ImageProtocol.Iterm2 ? new ITerm2CellTerminal(40, 20) : new VirtualTerminal(40, 20);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal: term,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { spellingTypoDetection: false, spellingAutocomplete: "off", spellingAutocorrect: false },
	});
	const transcript = new TranscriptContainer();
	composer.setRuntimeChildren([transcript, new Text("EDITOR", 0, 0)]);
	const rowsEncode = spyOn(natives, "encodeImageRowsAsync");
	const frames: string[][] = [];
	composer.start();
	try {
		for (let i = 0; i < 3; i++) transcript.addChild(new Text(`before ${i}`, 0, 0));
		const block = new Container();
		block.addChild(new Text("IMG-ABOVE", 0, 0));
		block.addChild(
			new Image(
				BANDED_PNG,
				"image/png",
				{ fallbackColor: text => text },
				{ maxWidthCells: IMAGE_COLUMNS, budget: composer.ui.imageBudget, imageKey: "banded" },
			),
		);
		block.addChild(new Text("IMG-BELOW", 0, 0));
		transcript.addChild(block);
		composer.ui.requestRender();
		await scheduler.settle(term);
		for (const result of rowsEncode.mock.results) await result.value;
		await scheduler.settle(term);
		frames.push(term.getViewport().map(normalize));
		for (let i = 0; i < 14; i++) {
			transcript.addChild(new Text(`after ${i}`, 0, 0));
			composer.ui.requestRender();
			await scheduler.settle(term);
			frames.push(term.getViewport().map(normalize));
		}
	} finally {
		composer.stop();
		rowsEncode.mockRestore();
	}
	return { frames, history: term.getScrollBuffer().map(normalize) };
}

const info = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
const original = { imageProtocol: info.imageProtocol, graphics: { ...getKittyGraphics() } };
let originalCell: CellDimensions;

beforeAll(async () => {
	await initTheme();
});
beforeEach(() => {
	originalCell = getCellDimensions();
	setCellDimensions({ widthPx: 10, heightPx: 10 });
	setKittyGraphics({ unicodePlaceholders: true });
});
afterEach(() => {
	setCellDimensions(originalCell);
	info.imageProtocol = original.imageProtocol;
	setKittyGraphics(original.graphics);
});

describe("iTerm2 inline images", () => {
	it("show the rows the frame lays out while the image scrolls through the viewport top", async () => {
		// Kitty placeholders render the frame plan cell for cell; iTerm2 must
		// show the same image rows in the same places. A cursor-anchored image
		// painted from its block's last row lands on other rows whenever the
		// rows above it are not its own, and leaves the wrong slice visible.
		const laidOut = await streamPastImage(ImageProtocol.Kitty);
		const shown = await streamPastImage(ImageProtocol.Iterm2);
		expect(laidOut.frames[0]).toContain(label(0));
		expect(shown.frames).toEqual(laidOut.frames);
		expect(shown.history).toEqual(laidOut.history);
	});

	it("stay per-row strips when the image is larger than the native decode limits", () => {
		// 500x750 cells at 16 px per column asks for 8000x12000 px of strips,
		// past the encoder's 8192 px edge and 4,194,304-pixel limits. Falling
		// back to the single anchored image would bring the viewport-top bug back.
		info.imageProtocol = ImageProtocol.Iterm2;
		const result = renderImage(
			BANDED_PNG,
			{ widthPx: 8000, heightPx: 12000 },
			{
				maxWidthCells: 500,
				maxHeightCells: 750,
				iterm2Rows: (widthPx, rowHeightPx, rows) => encodeImageRowsNow(BANDED_PNG, widthPx, rowHeightPx, rows),
			},
		);
		expect(result?.sequence).toBeUndefined();
		expect(result?.lines).toHaveLength(750);
		const strip = Buffer.from(result!.lines![0]!.match(OSC_1337.source)![2]!, "base64");
		const { width, height } = pngPixel(strip, 0, 0);
		expect(width * height * 750).toBeLessThanOrEqual(4 * 1024 * 1024);
		expect(height * 750).toBeLessThanOrEqual(8192);
	});
});
