import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as natives from "@oh-my-pi/pi-natives";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import * as mermaid from "@oh-my-pi/pi-tui/chat/mermaid-figure";
import type { TranscriptEntryLike } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { isNativeRendering, setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { CopySelectorComponent } from "@oh-my-pi/pi-tui/overlays/copy-selector";
import { DiagramReader } from "@oh-my-pi/pi-tui/overlays/diagram-reader";
import {
	getCellDimensions,
	getImageDimensions,
	ImageProtocol,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { getMarkdownTheme, initTheme, setMarkdownMermaidRendering } from "@oh-my-pi/pi-tui/theme";
import { TUI } from "@oh-my-pi/pi-tui/tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

const NORMAL = "flowchart TD\n  A[Start] --> B[Finish]";
const TINY = "flowchart LR\n  A[One]";
const LARGE = [
	"flowchart TD",
	...Array.from(
		{ length: 120 },
		(_, index) => `  N${index}[Checkpoint ${index}] --> N${index + 1}[Checkpoint ${index + 1}]`,
	),
].join("\n");
const WIDE = [
	"flowchart TD",
	...Array.from(
		{ length: 12 },
		(_, index) => `  Root[Useful root detail] --> B${index}[Parallel branch ${index}] --> Join[Continue]`,
	),
	"  Join --> N0[Trunk 0]",
	...Array.from({ length: 12 }, (_, index) => `  N${index}[Trunk ${index}] --> N${index + 1}[Trunk ${index + 1}]`),
].join("\n");
const CELL = { widthPx: 16, heightPx: 32 };
const CX: DescribeContext = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
const PNG = new Uint8Array(
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR3sAAAAASUVORK5CYII=",
		"base64",
	),
);

const disposables: Array<{ dispose(): void }> = [];
const originalProtocol = TERMINAL.imageProtocol;
const originalCell = { ...getCellDimensions() };
const originalShowImages = chatTranscriptDisplayPreferences.showImages;
const originalNative = isNativeRendering();
let originalMermaid = true;

beforeAll(async () => {
	await initTheme(false);
	originalMermaid = getMarkdownTheme().resolveMermaidAscii !== undefined;
});

beforeEach(() => {
	setTerminalImageProtocol(ImageProtocol.Iterm2);
	setCellDimensions(CELL);
	setNativeRendering(false);
	setMarkdownMermaidRendering(true);
	setChatTranscriptDisplayPreferences({ showImages: true });
});

afterEach(() => {
	for (const component of disposables.splice(0)) component.dispose();
	setTerminalImageProtocol(originalProtocol);
	setCellDimensions(originalCell);
	setNativeRendering(originalNative);
	setMarkdownMermaidRendering(originalMermaid);
	setChatTranscriptDisplayPreferences({ showImages: originalShowImages });
});

interface ReaderHarness {
	reader: DiagramReader;
	resize(height: number): void;
	nextRender(): Promise<void>;
	requests(): number;
	closed(): number;
}

function readerHarness(source = NORMAL, initialHeight = 30): ReaderHarness {
	let height = initialHeight;
	let requests = 0;
	let closed = 0;
	let signal = Promise.withResolvers<void>();
	const reader = new DiagramReader({
		source,
		getHeight: () => height,
		requestRender: () => {
			requests++;
			signal.resolve();
			signal = Promise.withResolvers<void>();
		},
		onClose: () => closed++,
	});
	disposables.push(reader);
	return {
		reader,
		resize: value => {
			height = value;
		},
		nextRender: () => signal.promise,
		requests: () => requests,
		closed: () => closed,
	};
}

async function settled(harness: ReaderHarness, width = 80): Promise<readonly string[]> {
	for (;;) {
		const changed = harness.nextRender();
		const rows = harness.reader.render(width);
		if (!harness.reader.pending) return rows;
		await changed;
	}
}

function assistantEntry(source: string, id = "assistant"): TranscriptEntryLike {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: source }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
	return { type: "message", id, parentId: null, timestamp: "2026-10-23T00:00:00Z", message };
}

interface SelectorHarness {
	selector: CopySelectorComponent;
	copied: string[];
	nextRender(): Promise<void>;
	cancelled(): number;
}

function selectorHarness(entries: TranscriptEntryLike[]): SelectorHarness {
	let cancelled = 0;
	let signal = Promise.withResolvers<void>();
	const copied: string[] = [];
	const ui = new TUI(new VirtualTerminal(100, 34));
	const selector = new CopySelectorComponent(entries, {
		ui,
		cwd: "/tmp",
		requestRender: () => {
			signal.resolve();
			signal = Promise.withResolvers<void>();
		},
		onPick: content => copied.push(content),
		onCancel: () => cancelled++,
	});
	disposables.push(selector);
	return { selector, copied, nextRender: () => signal.promise, cancelled: () => cancelled };
}

/** Wait for the replay preview before exercising keyboard inspection. */
async function renderedFigure(harness: SelectorHarness): Promise<readonly string[]> {
	for (;;) {
		const changed = harness.nextRender();
		const rows = harness.selector.render(100);
		if (rows.some(line => TERMINAL.isImageLine(line))) return rows;
		await changed;
	}
}

describe("DiagramReader geometry and navigation", () => {
	it("starts at natural size and rasterizes only the viewport, not the tall diagram", async () => {
		const harness = readerHarness(LARGE);
		const rows = await settled(harness);
		const state = harness.reader.debugState();
		expect(state.natural!.height).toBeGreaterThan(8_000);
		expect(state.view).toMatchObject({ x: 0, y: 0, zoom: 1, fit: false });
		expect(state.viewport).toEqual({ columns: 78, rows: 28, width: 624, height: 448 });
		expect(rows).toHaveLength(30);
		const image = rows.find(line => line.includes("\x1b]1337;File="));
		const base64 = /File=[^:]*:([^\x07]+)/.exec(image ?? "")?.[1];
		expect(base64).toBeDefined();
		expect(getImageDimensions(base64!, "image/png")).toEqual({ widthPx: 1_248, heightPx: 896 });
	});

	it("centers wide diagrams at natural scale on the first valid viewport and natural reset", async () => {
		const raster = spyOn(natives, "rasterizeSvg");
		try {
			const harness = readerHarness(WIDE, 2);
			harness.reader.render(82);
			expect(harness.reader.debugState().view).toMatchObject({ x: 0, y: 0, zoom: 1, fit: false });
			harness.resize(28);
			harness.reader.render(0);
			expect(raster).not.toHaveBeenCalled();

			await settled(harness, 82);
			let state = harness.reader.debugState();
			expect(state.natural!.width).toBeGreaterThan(2 * state.viewport.width);
			expect(state.natural!.height).toBeGreaterThan(state.viewport.height + 64);
			expect(state.view).toMatchObject({
				x: (state.natural!.width - state.viewport.width) / 2,
				y: 0,
				zoom: 1,
				fit: false,
			});
			expect(new TextDecoder().decode(raster.mock.calls[0]![0])).toContain(
				`viewBox="${state.view.x} 0 ${state.viewport.width} ${state.viewport.height}"`,
			);

			harness.reader.handleInput("j");
			harness.reader.handleInput("h");
			harness.reader.handleInput("0");
			harness.resize(24);
			harness.reader.render(74);
			harness.reader.handleInput("1");
			await settled(harness, 74);
			state = harness.reader.debugState();
			expect(state.view).toMatchObject({
				x: (state.natural!.width - state.viewport.width) / 2,
				y: 0,
				zoom: 1,
				fit: false,
			});
			expect(new TextDecoder().decode(raster.mock.calls.at(-1)![0])).toContain(
				`viewBox="${state.view.x} 0 ${state.viewport.width} ${state.viewport.height}"`,
			);
		} finally {
			raster.mockRestore();
		}
	});

	it("preserves a wide diagram's user pan across repaints and resize, subject only to bounds", () => {
		const harness = readerHarness(WIDE, 28);
		harness.reader.render(82);
		const initial = harness.reader.debugState();
		harness.reader.handleInput("h");
		harness.reader.handleInput("j");
		const panned = harness.reader.debugState().view;
		expect(panned.x).toBe(initial.view.x - 64);
		expect(panned.y).toBe(64);
		harness.reader.render(82);
		harness.reader.invalidate();
		harness.reader.render(82);
		expect(harness.reader.debugState().view).toEqual(panned);

		harness.resize(24);
		harness.reader.render(74);
		expect(harness.reader.debugState().view).toMatchObject({ x: panned.x, y: panned.y, zoom: 1, fit: false });
		harness.resize(28);
		harness.reader.render(82);
		expect(harness.reader.debugState().view).toEqual(panned);

		harness.resize(400);
		harness.reader.render(1_000);
		const enlarged = harness.reader.debugState();
		expect(enlarged.view.x).toBe(Math.min(panned.x, Math.max(0, enlarged.natural!.width - enlarged.view.width)));
		expect(enlarged.view.y).toBe(Math.min(panned.y, Math.max(0, enlarged.natural!.height - enlarged.view.height)));
		harness.reader.render(1_000);
		expect(harness.reader.debugState().view).toEqual(enlarged.view);
	});

	it("does not displace normal or tiny diagrams that fit at natural scale", () => {
		for (const source of [NORMAL, TINY]) {
			const harness = readerHarness(source);
			harness.reader.render(82);
			const state = harness.reader.debugState();
			expect(state.natural!.width).toBeLessThanOrEqual(state.viewport.width);
			expect(state.view).toMatchObject({ x: 0, y: 0, zoom: 1, fit: false });
			harness.reader.handleInput("1");
			expect(harness.reader.debugState().view).toMatchObject({ x: 0, y: 0, zoom: 1, fit: false });
		}
	});

	it("reaches distant content, clamps both origins, and fits or resets naturally", () => {
		const harness = readerHarness(LARGE);
		harness.reader.render(80);
		const steps = Math.ceil(harness.reader.debugState().natural!.height / 64) + 1;
		for (let index = 0; index < steps; index++) harness.reader.handleInput("j");
		let state = harness.reader.debugState();
		expect(state.view.y).toBeGreaterThan(8_000);
		expect(state.view.y + state.view.height).toBeCloseTo(state.natural!.height);
		harness.reader.handleInput("0");
		state = harness.reader.debugState();
		expect(state.view).toMatchObject({ x: 0, y: 0, fit: true });
		expect(state.view.width + 1e-6).toBeGreaterThanOrEqual(state.natural!.width);
		expect(state.view.height + 1e-6).toBeGreaterThanOrEqual(state.natural!.height);
		harness.reader.handleInput("1");
		expect(harness.reader.debugState().view).toMatchObject({ x: 0, y: 0, zoom: 1, fit: false });
		for (let index = 0; index < 4; index++) harness.reader.handleInput("k");
		expect(harness.reader.debugState().view.y).toBe(0);
	});

	it("zooms around the viewport center and preserves state across source toggles", () => {
		const harness = readerHarness(LARGE);
		harness.reader.render(80);
		harness.reader.handleInput("j");
		harness.reader.handleInput("+");
		const zoomed = harness.reader.debugState();
		expect(zoomed.view.zoom).toBe(1.25);
		expect(zoomed.view.width).toBeCloseTo(zoomed.viewport.width / 1.25);
		expect(zoomed.view.y + zoomed.view.height / 2).toBeCloseTo(64 + 448 / 2);
		harness.reader.handleInput("s");
		expect(harness.reader.debugState().sourceMode).toBe(true);
		expect(Bun.stripANSI(harness.reader.render(80).join("\n"))).toContain("flowchart TD");
		harness.reader.handleInput("s");
		expect(harness.reader.debugState().view).toEqual(zoomed.view);
		expect(harness.reader.debugState().sourceMode).toBe(false);
		harness.reader.handleInput("-");
		expect(harness.reader.debugState().view.zoom).toBe(1);
	});

	it("keeps tiny diagrams natural and leaves chrome room during resize", async () => {
		const harness = readerHarness(TINY);
		await settled(harness);
		harness.reader.handleInput("j");
		harness.reader.handleInput("l");
		expect(harness.reader.debugState().view).toMatchObject({ x: 0, y: 0, zoom: 1 });
		harness.resize(6);
		expect(harness.reader.render(24)).toHaveLength(6);
		const rows = await settled(harness, 24);
		expect(rows).toHaveLength(6);
		expect(harness.reader.debugState().viewport.rows).toBe(4);
		expect(Bun.stripANSI(rows[5]!)).toContain("pan");
		harness.resize(1);
		expect(harness.reader.render(24)).toHaveLength(1);
		expect(harness.reader.debugState().viewport.rows).toBe(0);
	});

	it("recomputes fit on resize and retains the native 4096-pixel edge cap", () => {
		const harness = readerHarness(LARGE, 400);
		harness.reader.render(1_000);
		let state = harness.reader.debugState();
		expect(state.viewport.columns * CELL.widthPx).toBeLessThanOrEqual(4_096);
		expect(state.viewport.rows * CELL.heightPx).toBeLessThanOrEqual(4_096);
		harness.reader.handleInput("0");
		const zoom = harness.reader.debugState().view.zoom;
		harness.resize(12);
		harness.reader.render(50);
		state = harness.reader.debugState();
		expect(state.view.fit).toBe(true);
		expect(state.view.zoom).toBeLessThan(zoom);
		expect(state.view.height + 1e-6).toBeGreaterThanOrEqual(state.natural!.height);
	});
});

describe("DiagramReader safety and lifecycle", () => {
	it("coalesces rapid pan revisions without laying the diagram out again", async () => {
		const layout = spyOn(mermaid, "resolveMermaidDiagram");
		const requests: Array<{ source: string; done: PromiseWithResolvers<Uint8Array> }> = [];
		const raster = spyOn(natives, "rasterizeSvg").mockImplementation(input => {
			const done = Promise.withResolvers<Uint8Array>();
			requests.push({ source: new TextDecoder().decode(input), done });
			return done.promise;
		});
		try {
			const harness = readerHarness(LARGE);
			harness.reader.render(80);
			for (let index = 0; index < 20; index++) {
				harness.reader.handleInput("j");
				harness.reader.render(80);
			}
			expect(layout).toHaveBeenCalledTimes(1);
			expect(requests).toHaveLength(1);
			requests[0]!.done.resolve(PNG);
			await requests[0]!.done.promise;
			expect(requests).toHaveLength(2);
			expect(requests[1]!.source).toContain(`viewBox="0 ${harness.reader.debugState().view.y} 624 448"`);
			harness.reader.dispose();
			const before = harness.requests();
			requests[1]!.done.resolve(PNG);
			await requests[1]!.done.promise;
			expect(harness.requests()).toBe(before);
			expect(harness.reader.render(80)).toEqual([]);
		} finally {
			layout.mockRestore();
			raster.mockRestore();
		}
	});

	it("falls back to original source after a raster failure without retry loops", async () => {
		const raster = spyOn(natives, "rasterizeSvg").mockRejectedValue(new Error("raster unavailable"));
		try {
			const harness = readerHarness();
			const rows = await settled(harness);
			expect(harness.reader.debugState().sourceMode).toBe(true);
			expect(Bun.stripANSI(rows.join("\n"))).toContain("A[Start] --> B[Finish]");
			for (let index = 0; index < 5; index++) harness.reader.render(80);
			expect(raster).toHaveBeenCalledTimes(1);
			expect(harness.reader.pending).toBe(false);
		} finally {
			raster.mockRestore();
		}
	});

	it("uses safe scrollable source without graphics, when disabled, or for invalid input", () => {
		setTerminalImageProtocol(null);
		const harness = readerHarness(`${NORMAL}\n${"%% source\n".repeat(80)}%% distant original line`);
		let rows = harness.reader.render(80);
		expect(harness.reader.debugState().sourceMode).toBe(true);
		expect(rows.some(line => TERMINAL.isImageLine(line))).toBe(false);
		harness.reader.handleInput("\x1b[F");
		rows = harness.reader.render(80);
		expect(Bun.stripANSI(rows.join("\n"))).toContain("distant original line");
		setTerminalImageProtocol(ImageProtocol.Iterm2);
		setChatTranscriptDisplayPreferences({ showImages: false });
		expect(readerHarness().reader.debugState().sourceMode).toBe(true);
		setChatTranscriptDisplayPreferences({ showImages: true });
		setMarkdownMermaidRendering(false);
		expect(readerHarness().reader.debugState().sourceMode).toBe(true);
		setMarkdownMermaidRendering(true);
		const invalid = readerHarness("not a valid Mermaid diagram");
		expect(Bun.stripANSI(invalid.reader.render(80).join("\n"))).toContain("not a valid Mermaid diagram");
		expect(invalid.reader.pending).toBe(false);
	});

	it("describes native source without image escapes and closes only once", () => {
		const harness = readerHarness();
		const native = JSON.stringify(harness.reader.describe(CX));
		expect(native).toContain("flowchart TD");
		expect(native).not.toContain("1337");
		expect(native).not.toContain("\\u001b_G");
		harness.reader.handleInput("\x1b");
		harness.reader.handleInput("\x1b");
		expect(harness.closed()).toBe(1);
		expect(harness.reader.debugState().disposed).toBe(true);
	});
});

describe("CopySelector diagram integration", () => {
	it.each([
		["tilde", `~~~MeRmAiD title\n${NORMAL}\n~~~`, NORMAL],
		["long backtick", `\`\`\`\`mermaid\n${NORMAL}\n\`\`\`\``, NORMAL],
		[
			"indented CRLF",
			"  ```mermaid\r\n  flowchart LR\r\n    Indented[Start] --> I[Done]\r\n  ```",
			"  flowchart LR\r\n    Indented[Start] --> I[Done]",
		],
		["CR-only", "```mermaid\rflowchart LR\r A[CR only] --> B[Done]\r```", "flowchart LR\r A[CR only] --> B[Done]"],
	])("opens a supported %s fence and copies its original code bytes", (_name, fenced, source) => {
		setTerminalImageProtocol(null);
		const harness = selectorHarness([assistantEntry(`Before fixture.\n\n${fenced}\n\nAfter fixture.`)]);
		harness.selector.handleInput("o");
		harness.selector.handleInput("\r");
		expect(harness.copied).toEqual([]);
		harness.selector.handleInput("\x1b");
		expect(harness.cancelled()).toBe(0);
		harness.selector.handleInput("\x1b[C");
		harness.selector.handleInput("\r");
		expect(harness.copied).toEqual([source]);
	});

	it("opens the only diagram directly from a reply and returns to whole-reply copying on Esc", () => {
		setTerminalImageProtocol(null);
		const message = `Before diagram\n\n\`\`\`ts\nconst unrelated = 1;\n\`\`\`\n\n\`\`\`mermaid\n${NORMAL}\n\`\`\`\n\nAfter diagram`;
		const harness = selectorHarness([assistantEntry(message)]);
		harness.selector.handleInput("\r");
		expect(harness.copied).toEqual([message]);
		harness.selector.handleInput("o");
		const opened = Bun.stripANSI(harness.selector.render(100).join("\n"));
		expect(opened).toContain("A[Start] --> B[Finish]");
		expect(opened).not.toContain("const unrelated = 1");
		harness.selector.handleInput("\r");
		expect(harness.copied).toEqual([message]);
		harness.selector.handleInput("\x1b");
		expect(harness.cancelled()).toBe(0);
		harness.selector.handleInput("\r");
		expect(harness.copied).toEqual([message, message]);
		harness.selector.handleInput("\x1b");
		expect(harness.cancelled()).toBe(1);
	});

	it("uses the existing blocks to choose among diagrams and restores that choice after inspection", () => {
		setTerminalImageProtocol(null);
		const message = `\`\`\`ts\nconst unrelated = 1;\n\`\`\`\n\n\`\`\`mermaid\n${NORMAL}\n\`\`\`\n\n\`\`\`mermaid\n${TINY}\n\`\`\``;
		const harness = selectorHarness([assistantEntry(message)]);
		harness.selector.handleInput("o");
		harness.selector.handleInput("\r");
		expect(harness.copied).toEqual([NORMAL]);
		harness.selector.handleInput("\x1b[B");
		harness.selector.handleInput("o");
		const opened = Bun.stripANSI(harness.selector.render(100).join("\n"));
		expect(opened).toContain("A[One]");
		expect(opened).not.toContain("A[Start]");
		harness.selector.handleInput("\x1b");
		harness.selector.handleInput("\r");
		expect(harness.copied).toEqual([NORMAL, TINY]);
		harness.selector.handleInput("\x1b");
		harness.selector.handleInput("\r");
		expect(harness.copied).toEqual([NORMAL, TINY, message]);
		expect(harness.cancelled()).toBe(0);
	});

	it("keeps Enter copying original Mermaid and o inspecting, then restores the selected block", () => {
		setTerminalImageProtocol(null);
		const harness = selectorHarness([assistantEntry(`before\n\n\`\`\`mermaid\n${NORMAL}\n\`\`\`\n\nafter`)]);
		harness.selector.handleInput("\x1b[C");
		const prior = harness.selector.render(100);
		harness.selector.handleInput("\r");
		expect(harness.copied).toEqual([NORMAL]);
		harness.selector.handleInput("o");
		expect(Bun.stripANSI(harness.selector.render(100)[0]!)).toContain("Mermaid inspection");
		harness.selector.handleInput("s");
		harness.selector.handleInput("\x1b");
		expect(harness.cancelled()).toBe(0);
		expect(harness.selector.render(100)).toEqual(prior);
		harness.selector.handleInput("\r");
		expect(harness.copied).toEqual([NORMAL, NORMAL]);
	});

	it("opens a mixed-case Mermaid fence-info block with o without copying", () => {
		setTerminalImageProtocol(null);
		const harness = selectorHarness([assistantEntry(`\`\`\`MeRmAiD title\n${TINY}\n\`\`\``)]);
		harness.selector.handleInput("\x1b[C");
		harness.selector.render(100);
		harness.selector.handleInput("o");
		expect(Bun.stripANSI(harness.selector.render(100)[0]!)).toContain("Mermaid inspection");
		expect(harness.copied).toEqual([]);
	});

	for (const [label, source] of [
		["normal", NORMAL],
		["large", LARGE],
		["tiny", TINY],
	] as const) {
		it(`opens the ${label} diagram through its Mermaid block and returns through every keyboard level`, async () => {
			const harness = selectorHarness([
				assistantEntry(`Leading prose\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\nTrailing prose`),
			]);
			await renderedFigure(harness);
			harness.selector.handleInput("\x1b[C");
			const selectedBlock = harness.selector.render(100);
			harness.selector.handleInput("o");
			expect(Bun.stripANSI(harness.selector.render(100)[0]!)).toContain("Mermaid inspection");
			harness.selector.handleInput("s");
			expect(Bun.stripANSI(harness.selector.render(100).join("\n"))).toContain(source.split("\n")[0]!);
			harness.selector.handleInput("\x1b");
			expect(harness.cancelled()).toBe(0);
			expect(harness.selector.render(100)).toEqual(selectedBlock);
			harness.selector.handleInput("\x1b");
			expect(harness.cancelled()).toBe(0);
			harness.selector.handleInput("\x1b");
			expect(harness.cancelled()).toBe(1);
			expect(harness.copied).toEqual([]);
		});
	}
});
