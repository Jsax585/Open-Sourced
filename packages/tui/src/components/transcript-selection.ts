import type { SgrMouseEvent } from "../mouse";
import { theme } from "../theme/theme";
import { extractSegments, getWidthConfigEpoch, sliceWithWidth, stripTerminalSequences, visibleWidth } from "../utils";

interface TranscriptPoint {
	column: number;
	row: number;
}

export interface TranscriptSelectionResult {
	handled: boolean;
	click?: TranscriptPoint;
	text?: string;
}

const NESTED_BG_OPEN_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[(?:4[0-7]|10[0-7]|48;[0-9;]*)m`, "g");
const OSC66_PATTERN = /\x1b\]66;[^;]*;([\s\S]*?)(?:\x07|\x1b\\)/g;

/** Primary-button selection against unhighlighted transcript display cells. */
export class TranscriptSelection {
	#rows: readonly string[] | undefined;
	#width = 0;
	#widthEpoch = 0;
	#anchor: TranscriptPoint | undefined;
	#extent: TranscriptPoint | undefined;
	#pressed = false;
	#dragged = false;

	/** Includes a pending press so the host can route releases outside the viewport. */
	get active(): boolean {
		return this.#pressed;
	}

	/** Pending gestures and retained highlights need validation against the next frame. */
	get hasSelection(): boolean {
		return this.#rows !== undefined;
	}

	clear(): void {
		this.#rows = undefined;
		this.#anchor = undefined;
		this.#extent = undefined;
		this.#pressed = false;
		this.#dragged = false;
	}

	handle(event: SgrMouseEvent, rows: readonly string[], width: number): TranscriptSelectionResult {
		if (this.#rows && !this.#matches(rows, width)) this.clear();
		if ((event.button & 64) !== 0 || event.wheel !== null || (event.button & 3) !== 0) {
			return { handled: false };
		}
		if (event.leftClick) {
			this.clear();
			if (
				!Number.isInteger(width) ||
				width <= 0 ||
				!Number.isInteger(event.col) ||
				!Number.isInteger(event.row) ||
				event.col < 0 ||
				event.col >= width ||
				event.row < 0 ||
				event.row >= rows.length
			) {
				return { handled: false };
			}
			this.#rows = [...rows];
			this.#width = width;
			this.#widthEpoch = getWidthConfigEpoch();
			this.#anchor = this.#extent = { column: event.col, row: event.row };
			this.#pressed = true;
			return { handled: true };
		}
		if (!this.#pressed || !this.#anchor) return { handled: false };
		if (!Number.isInteger(event.col) || !Number.isInteger(event.row)) {
			this.clear();
			return { handled: true };
		}
		const point = {
			column: Math.max(0, Math.min(width, event.col)),
			row: Math.max(0, Math.min(rows.length - 1, event.row)),
		};
		if (event.release || event.motion) {
			this.#dragged ||= event.col !== this.#anchor.column || event.row !== this.#anchor.row;
			this.#extent = point;
			if (!this.#matches(rows, width)) {
				this.clear();
				return { handled: true };
			}
			if (!event.release) return { handled: true };
			this.#pressed = false;
			if (this.#dragged) {
				const text = this.#text(rows);
				if (!text) this.clear();
				return text ? { handled: true, text } : { handled: true };
			}
			this.clear();
			return { handled: true, click: point };
		}
		return { handled: false };
	}

	paint(rows: readonly string[], width: number): readonly string[] {
		if (!this.#rows) return rows;
		if (!this.#matches(rows, width)) {
			this.clear();
			return rows;
		}
		if (!this.#dragged) return rows;
		const [start, end] = this.#range();
		const painted = [...rows];
		for (let row = start.row; row <= end.row; row++) {
			const line = rows[row]!;
			const [from, to] = this.#columns(line, row, start, end);
			if (to <= from) continue;
			const { before, after } = extractSegments(line, from, to, Math.max(0, visibleWidth(line) - to), true);
			const selected = sliceWithWidth(line, from, to - from, true).text;
			// A nested card/table background must not cover the selection fill.
			painted[row] =
				`${before}\x1b[0m${theme.bgFill("selectedBg", selected.replace(NESTED_BG_OPEN_PATTERN, ""))}\x1b[0m${after}\x1b[0m`;
		}
		return painted;
	}

	#matches(rows: readonly string[], width: number): boolean {
		const snapshot = this.#rows;
		if (!snapshot || width !== this.#width || getWidthConfigEpoch() !== this.#widthEpoch) return false;
		const [start, extent] = this.#range();
		// A pending click still anchors one display cell, including a whole wide grapheme.
		const end =
			start.row === extent.row && start.column === extent.column
				? { row: extent.row, column: Math.min(width, extent.column + 1) }
				: extent;
		if (start.row < 0 || end.row >= rows.length || end.row >= snapshot.length) return false;
		for (let row = start.row; row <= end.row; row++) {
			const before = snapshot[row]!;
			const after = rows[row]!;
			if (before === after) continue;
			if (row > start.row && row < end.row) return false;
			const [from, to] = this.#columns(before, row, start, end);
			const [nextFrom, nextTo] = this.#columns(after, row, start, end);
			if (
				from !== nextFrom ||
				to !== nextTo ||
				sliceWithWidth(before, from, to - from, true).text !==
					sliceWithWidth(after, nextFrom, nextTo - nextFrom, true).text
			) {
				return false;
			}
		}
		return true;
	}

	#range(): [TranscriptPoint, TranscriptPoint] {
		const anchor = this.#anchor!;
		const extent = this.#extent!;
		return anchor.row < extent.row || (anchor.row === extent.row && anchor.column <= extent.column)
			? [anchor, extent]
			: [extent, anchor];
	}

	#columns(line: string, row: number, start: TranscriptPoint, end: TranscriptPoint): [number, number] {
		let from = row === start.row ? start.column : 0;
		let to = row === end.row ? end.column : this.#width;
		if (to <= from) return [from, from];
		// Sized spans stay atomic: slicing their payload would change terminal cell geometry.
		for (const span of line.matchAll(OSC66_PATTERN)) {
			const left = visibleWidth(line.slice(0, span.index));
			const right = left + visibleWidth(span[0]);
			if (from < right && to > left) {
				from = Math.min(from, left);
				to = Math.max(to, right);
			}
		}
		return [sliceWithWidth(line, 0, from, true).width, sliceWithWidth(line, 0, to).width];
	}

	#text(rows: readonly string[]): string {
		const [start, end] = this.#range();
		const selected: string[] = [];
		for (let row = start.row; row <= end.row; row++) {
			const line = rows[row]!;
			const [from, to] = this.#columns(line, row, start, end);
			const text = sliceWithWidth(line, from, Math.max(0, to - from), true).text;
			selected.push(stripTerminalSequences(text.replace(OSC66_PATTERN, "$1")).trimEnd());
		}
		return selected.join("\n");
	}
}
