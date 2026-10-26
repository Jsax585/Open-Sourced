import { chatTranscriptDisplayPreferences } from "../chat/display-preferences";
import { type MermaidDiagram, resolveMermaidDiagram } from "../chat/mermaid-figure";
import { mermaidFigurePalette } from "../chat/mermaid-theme";
import { MAX_SVG_RASTER_EDGE, SvgFigure } from "../chat/svg-figure";
import { type ImageBudget, imageMaxColumns } from "../components/image";
import { Markdown } from "../components/markdown";
import { matchesKey } from "../index";
import { matchesSelectCancel } from "../keybinding-matchers";
import { code, span, text } from "../native/describe";
import { sameItems } from "../native/memo";
import type { DescribeContext, NativeNode } from "../native/node";
import { hintsRow, overlayCard } from "../native/overlay";
import { isNativeRendering } from "../native/state";
import { sanitizeDisplayLines } from "../render/render-utils";
import { getCellDimensions, TERMINAL } from "../terminal-capabilities";
import { getMarkdownTheme, theme } from "../theme";
import type { Component } from "../tui";
import { sliceByColumn, truncateToWidth, visibleWidth } from "../utils";

/** Match SvgFigure's natural scale and the existing native raster edge limit. */
const UNITS_PER_ROW = 16;
const ZOOM_STEP = 1.25;
const MAX_ZOOM = 8;
const CHROME_ROWS = 2;

export interface DiagramReaderOptions {
	source: string;
	getHeight: () => number;
	requestRender: () => void;
	onClose: () => void;
	/** The fullscreen host's existing budget, not a separate graphics surface. */
	budget?: ImageBudget;
}

interface Viewport {
	columns: number;
	rows: number;
	width: number;
	height: number;
}

/** Natural user-space coordinates; the raster always contains just one bounded viewport. */
interface DiagramView {
	x: number;
	y: number;
	width: number;
	height: number;
	zoom: number;
	fit: boolean;
}

/**
 * Read-only inspection within /copy. Layout is resolved once, independently of
 * transcript preview rasters; navigation only changes the full SVG's viewBox.
 * SvgFigure coalesces revisions and keeps raster work single-flight.
 */
export class DiagramReader implements Component {
	readonly #options: DiagramReaderOptions;
	readonly #diagram: MermaidDiagram | null;
	readonly #naturalSvg: string | undefined;
	readonly #sourceLines: string[];
	readonly #figure: SvgFigure;
	#viewport: Viewport = { columns: 0, rows: 0, width: 0, height: 0 };
	#view: DiagramView = { x: 0, y: 0, width: 0, height: 0, zoom: 1, fit: false };
	#naturalFramingPending = true;
	#cropKey = "";
	#showSource = false;
	#sourceRow = 0;
	#sourceColumn = 0;
	#sourceWidth = 0;
	#rasterFailed = false;
	#disposed = false;
	#rendered: readonly string[] | undefined;
	#native: NativeNode | undefined;

	constructor(options: DiagramReaderOptions) {
		this.#options = options;
		this.#diagram = resolveMermaidDiagram(options.source);
		this.#sourceLines = sanitizeDisplayLines(options.source.replace(/\r\n?/g, "\n"));
		for (const line of this.#sourceLines) this.#sourceWidth = Math.max(this.#sourceWidth, visibleWidth(line));
		const diagram = this.#diagram;
		// Keep the original viewBox and all authored styling inside a natural-size
		// nested SVG. The outer root alone clips/pans/zooms, including SVGs whose
		// natural viewBox origin is not (0, 0).
		this.#naturalSvg = diagram?.svg.replace(/<svg\b[^>]*>/i, (tag: string) => {
			const root = tag.replace(/\s(?:x|y|width|height)\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
			return root.replace(/>$/, ` x="0" y="0" width="${diagram.width}" height="${diagram.height}">`);
		});
		this.#figure = new SvgFigure({
			budget: options.budget,
			maxRows: () => this.#viewport.rows,
			sourceFallback: () => ({ language: "mermaid", source: options.source }),
			label: "Mermaid",
			palette: mermaidFigurePalette,
			markdown: source => {
				this.#rasterFailed = true;
				// The reader switches to its scrollable original-source view below;
				// SvgFigure still receives a truthful, safe source fallback of its own.
				return new Markdown(source, 0, 0, { ...getMarkdownTheme(), resolveMermaidAscii: undefined });
			},
			onChange: () => {
				if (!this.#disposed) options.requestRender();
			},
		});
	}

	get pending(): boolean {
		return !this.#disposed && !this.#sourceMode() && this.#viewport.rows > 0 && this.#figure.pending;
	}

	invalidate(): void {
		this.#figure.invalidate();
		this.#native = undefined;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#figure.dispose();
	}

	/** Geometry and lifecycle state, without retaining or exposing raster bytes. */
	debugState(): {
		diagramId: string | undefined;
		natural: { width: number; height: number } | null;
		viewport: Viewport;
		view: DiagramView;
		sourceMode: boolean;
		sourceRow: number;
		sourceColumn: number;
		pending: boolean;
		disposed: boolean;
	} {
		return {
			diagramId: this.#diagram?.id,
			natural: this.#diagram ? { width: this.#diagram.width, height: this.#diagram.height } : null,
			viewport: { ...this.#viewport },
			view: { ...this.#view },
			sourceMode: this.#sourceMode(),
			sourceRow: this.#sourceRow,
			sourceColumn: this.#sourceColumn,
			pending: this.pending,
			disposed: this.#disposed,
		};
	}

	#unavailable(): string | undefined {
		if (!this.#diagram) return "Cannot draw this Mermaid diagram · original source";
		if (this.#rasterFailed) return "Diagram raster unavailable · original source";
		if (isNativeRendering()) return "Native reader · original Mermaid source";
		if (!chatTranscriptDisplayPreferences.showImages) return "Images hidden · original Mermaid source";
		if (getMarkdownTheme().resolveMermaidAscii === undefined) return "Mermaid rendering disabled · original source";
		if (TERMINAL.imageProtocol === null) return "Terminal graphics unavailable · original Mermaid source";
		return undefined;
	}

	#sourceMode(): boolean {
		return this.#showSource || this.#unavailable() !== undefined;
	}

	#fitZoom(): number {
		const diagram = this.#diagram;
		if (!diagram || this.#viewport.width <= 0 || this.#viewport.height <= 0) return 1;
		return Math.min(1, this.#viewport.width / diagram.width, this.#viewport.height / diagram.height);
	}

	#clamp(): void {
		const diagram = this.#diagram;
		const view = this.#view;
		view.width = this.#viewport.width / view.zoom;
		view.height = this.#viewport.height / view.zoom;
		// Frame the natural-size top once on open/reset, not on repaint or resize.
		if (this.#naturalFramingPending && this.#viewport.width > 0 && this.#viewport.height > 0) {
			view.x = ((diagram?.width ?? 0) - view.width) / 2;
			view.y = 0;
			this.#naturalFramingPending = false;
		}
		view.x = Math.max(0, Math.min(view.x, Math.max(0, (diagram?.width ?? 0) - view.width)));
		view.y = Math.max(0, Math.min(view.y, Math.max(0, (diagram?.height ?? 0) - view.height)));
		this.#sourceRow = Math.max(0, Math.min(this.#sourceRow, this.#sourceLines.length - this.#viewport.rows));
		this.#sourceColumn = Math.max(0, Math.min(this.#sourceColumn, this.#sourceWidth - this.#viewport.columns));
	}

	#resize(width: number, height: number): void {
		const cell = getCellDimensions();
		const columns = Math.max(0, Math.min(imageMaxColumns(width), Math.floor(MAX_SVG_RASTER_EDGE / cell.widthPx)));
		const rows = Math.max(0, Math.min(height - CHROME_ROWS, Math.floor(MAX_SVG_RASTER_EDGE / cell.heightPx)));
		this.#viewport = {
			columns: width > 0 ? columns : 0,
			rows,
			width: width > 0 ? (columns * UNITS_PER_ROW * cell.widthPx) / cell.heightPx : 0,
			height: rows * UNITS_PER_ROW,
		};
		if (this.#view.fit) this.#view.zoom = this.#fitZoom();
		this.#clamp();
	}

	#zoom(zoom: number): void {
		const view = this.#view;
		const x = view.x + view.width / 2;
		const y = view.y + view.height / 2;
		view.zoom = Math.max(Math.min(1 / 16, this.#fitZoom()), Math.min(MAX_ZOOM, zoom));
		view.fit = false;
		view.x = x - this.#viewport.width / view.zoom / 2;
		view.y = y - this.#viewport.height / view.zoom / 2;
	}

	handleInput(data: string): void {
		if (this.#disposed) return;
		if (matchesSelectCancel(data) || matchesKey(data, "escape")) {
			this.dispose();
			this.#options.onClose();
			return;
		}
		if (data === "s" || data === "S") {
			this.#showSource = !this.#showSource;
		} else if (this.#sourceMode()) {
			if (matchesKey(data, "up") || data === "k") this.#sourceRow--;
			else if (matchesKey(data, "down") || data === "j") this.#sourceRow++;
			else if (matchesKey(data, "left") || data === "h") this.#sourceColumn -= 8;
			else if (matchesKey(data, "right") || data === "l") this.#sourceColumn += 8;
			else if (matchesKey(data, "pageUp")) this.#sourceRow -= Math.max(1, this.#viewport.rows - 1);
			else if (matchesKey(data, "pageDown")) this.#sourceRow += Math.max(1, this.#viewport.rows - 1);
			else if (matchesKey(data, "home")) this.#sourceRow = this.#sourceColumn = 0;
			else if (matchesKey(data, "end")) this.#sourceRow = this.#sourceLines.length;
			else return;
		} else {
			const view = this.#view;
			if (matchesKey(data, "up") || data === "k") view.y -= (4 * UNITS_PER_ROW) / view.zoom;
			else if (matchesKey(data, "down") || data === "j") view.y += (4 * UNITS_PER_ROW) / view.zoom;
			else if (matchesKey(data, "left") || data === "h") view.x -= (4 * UNITS_PER_ROW) / view.zoom;
			else if (matchesKey(data, "right") || data === "l") view.x += (4 * UNITS_PER_ROW) / view.zoom;
			else if (data === "+" || data === "=") this.#zoom(view.zoom * ZOOM_STEP);
			else if (data === "-" || data === "_") this.#zoom(view.zoom / ZOOM_STEP);
			else if (data === "0" || data === "1") {
				view.fit = data === "0";
				view.zoom = view.fit ? this.#fitZoom() : 1;
				view.x = view.y = 0;
			} else return;
			this.#naturalFramingPending = data === "1";
		}
		this.#clamp();
		this.#options.requestRender();
	}

	/** Native never receives terminal graphics escapes: original Mermaid is a code node. */
	describe(_cx: DescribeContext): NativeNode {
		this.#native ??= overlayCard("omp.overlay.diagram", "Mermaid inspection", [
			text([span("Native inspection shows the original Mermaid source.", "muted")]),
			code(this.#sourceLines.join("\n"), { lang: "mermaid", wrap: true }),
			hintsRow([{ keys: ["escape"], label: "back" }]),
		]);
		return this.#native;
	}

	#sourceRows(): string[] {
		return this.#sourceLines
			.slice(this.#sourceRow, this.#sourceRow + this.#viewport.rows)
			.map(line => theme.fg("mdCodeBlock", sliceByColumn(line, this.#sourceColumn, this.#viewport.columns)));
	}

	render(width: number): readonly string[] {
		if (this.#disposed) return [];
		const heightValue = this.#options.getHeight();
		const height = Number.isFinite(heightValue) ? Math.max(0, Math.trunc(heightValue)) : 0;
		const columns = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
		this.#resize(columns, height);
		let body: readonly string[] = [];
		if (this.#sourceMode()) body = this.#sourceRows();
		else if (this.#viewport.rows > 0 && this.#viewport.columns > 0) {
			const view = this.#view;
			const viewport = this.#viewport;
			const key = `${viewport.width},${viewport.height},${view.x},${view.y},${view.zoom}`;
			if (key !== this.#cropKey) {
				this.#cropKey = key;
				this.#figure.update(
					`<svg xmlns="http://www.w3.org/2000/svg" width="${viewport.width}" height="${viewport.height}" viewBox="${view.x} ${view.y} ${view.width} ${view.height}" preserveAspectRatio="none">${this.#naturalSvg}</svg>`,
					true,
				);
			}
			body = this.#figure.render(columns);
			if (this.#rasterFailed) body = this.#sourceRows();
			// An old raster can be taller than a newly shrunken viewport. Do not
			// slice its transport rows (the final row owns its placement); wait for
			// the bounded replacement instead of painting over reader chrome.
			else if (body.length > viewport.rows) body = [theme.fg("dim", "Resizing Mermaid…")];
		}
		if (height === 0) return [];
		const source = this.#sourceMode();
		const unavailable = this.#unavailable();
		const status =
			unavailable ??
			(source
				? "original source"
				: `${Math.round(this.#view.zoom * 100)}% · x ${Math.round(this.#view.x)} y ${Math.round(this.#view.y)}`);
		const header = truncateToWidth(` ${theme.bold("Mermaid inspection")}${theme.sep.dot}${status}`, columns);
		if (height === 1) return [header];
		const hints = source
			? `↑↓/hjkl scroll · PgUp/PgDn · ${unavailable ? "" : "s diagram · "}Esc back`
			: "↑↓←→/hjkl pan · +/- zoom · 0 fit · 1 natural · s source · Esc back";
		const lines = [header, ...body];
		while (lines.length < height - 1) lines.push("");
		lines.push(truncateToWidth(` ${theme.fg("dim", hints)}`, columns));
		if (this.#rendered && sameItems(this.#rendered, lines)) return this.#rendered;
		this.#rendered = lines;
		return lines;
	}
}
