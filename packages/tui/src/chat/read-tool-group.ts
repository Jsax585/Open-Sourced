import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { AssistantMessage, ImageContent, Usage } from "@oh-my-pi/pi-ai";
import { type Component } from "../tui";
import { Container } from "../tui";
import { Text } from "../components/text";
import { Image, type ImageBudget } from "../components/image";
import { getLanguageFromPath, theme } from "../theme";
import { parseLineRanges, selectorLineRanges } from "../tools/line-ranges";
import {
	describeReadImage,
	isImageBlock,
	type ReadImageBlock,
	type ReadRenderArgs,
	type ReadToolDetails,
	readContentCode,
	readResultIsMarkdown,
	readSourceFsPath,
	splitPathAndSel,
} from "../tools/read";
import { PREVIEW_LIMITS, resolveImageOptions, shortenPath } from "../render/render-utils";
import { fileHyperlink, renderCodeCell, renderMarkdownCell } from "../render";
import { canonicalizeMessage } from "./thinking-display";
import { cachedPngConversion, convertImageToPngShared } from "./image-loading";
import { SvgFigure, svgFigureRendering } from "./svg-figure";
import { getImageDimensions, ImageProtocol, imageFallback, TERMINAL } from "../terminal-capabilities";
import { nativeImageNode, nativeMediaNode, readMediaPath } from "../native/blobs";
import { internalUrlSchemeSpec, splitUrlScheme } from "../tools/url-scheme-host";
import type { ToolExecutionHandle } from "./tool-execution";
import { formatUsageRow } from "../overlays/usage-row";
import { formatCount } from "@oh-my-pi/pi-utils";
import type { TspCardStatus, TspSpan, TspText } from "@oh-my-pi/pi-wire";
import type { NativeToolHead } from "../tools/renderer";
import { card, code, keyed, md, node, span, text, withHidden } from "../native/describe";
import {
	type DescribeContext,
	type NativeChild,
	type NativeNode,
	type NativeUiEvent,
	rootToggleExpanded,
} from "../native/node";
import { plainText } from "../native/spans";
import { Memo } from "../native/memo";
import { fileHref, fileRow, inlineErrorView } from "../tools/native-view";

/**
 * Extract the read call's target path. `path` is the canonical arg; `file_path`
 * is the legacy alias still tolerated by the read tool schema.
 */
function readArgsTarget(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const record = args as Record<string, unknown>;
	return typeof record.path === "string"
		? record.path
		: typeof record.file_path === "string"
			? record.file_path
			: undefined;
}

export function readArgsHaveTarget(args: unknown): boolean {
	return readArgsTarget(args) !== undefined;
}

/**
 * Whether a read collapses into the compact {@link ReadToolGroupComponent}
 * rather than a full tool execution. Filesystem/external targets always
 * collapse; registered internal-URL schemes render full so their resolved
 * content is visible, unless their spec declares `compactTranscript`
 * (device listings/docs read better in the compact grouped view).
 */
export function readArgsCollapseIntoGroup(args: unknown): boolean {
	const target = readArgsTarget(args);
	if (target === undefined) return false;
	const url = splitUrlScheme(target);
	const spec = url && internalUrlSchemeSpec(url.scheme);
	return spec === undefined || spec.compactTranscript === true;
}

/**
 * Return the collapsed read calls that can own a turn's usage row. Mixed-tool
 * turns and visible content after a read keep the standalone row so request
 * metrics retain their transcript ordering.
 */
export function groupedReadUsageCallIds(message: AssistantMessage): string[] | undefined {
	const toolCallIds: string[] = [];
	let sawToolCall = false;
	for (const content of message.content) {
		if (content.type === "toolCall") {
			if (content.name !== "read" || !readArgsCollapseIntoGroup(content.arguments)) return undefined;
			sawToolCall = true;
			toolCallIds.push(content.id);
			continue;
		}
		if (
			sawToolCall &&
			(content.type === "image" ||
				(content.type === "text" && canonicalizeMessage(content.text)) ||
				(content.type === "thinking" && canonicalizeMessage(content.thinking)))
		) {
			return undefined;
		}
	}
	return toolCallIds.length > 0 ? toolCallIds : undefined;
}

type ReadToolSuffixResolution = {
	from: string;
	to: string;
};

/** Host surface for inline visual previews: repaint scheduling and the shared image budget. */
export interface ReadToolGroupUi {
	requestRender(): void;
	imageBudget?: ImageBudget;
}

type ReadToolGroupOptions = {
	showContentPreview?: boolean;
	/** Draw raster reads and whole-file SVG sources under their rows where the terminal can show them; default true. */
	showImages?: boolean;
	ui?: ReadToolGroupUi;
};

function getSuffixResolution(details: ReadToolDetails | undefined): ReadToolSuffixResolution | undefined {
	if (typeof details?.suffixResolution?.from !== "string" || typeof details.suffixResolution.to !== "string") {
		return undefined;
	}
	return { from: details.suffixResolution.from, to: details.suffixResolution.to };
}

/** One display path recovered from a delimited read, with the resolved fs link target and image (by index) for its row. */
type ReadDisplayPathSpec = { path: string; linkPath?: string; imageIndex?: number };

/** One raster a read returned, with its Kitty conversion state. */
type ReadVisualImage = {
	/** The block as delivered (tagged with its native node once described). */
	block: ReadImageBlock;
	/**
	 * Kitty draws PNG only: the shared conversion of a non-PNG block, pinned
	 * once drawn so a cache eviction never blanks a row already on screen.
	 */
	kittyPng?: ImageContent;
	/** A conversion is in flight; its landing rebuilds the display. */
	kittyPending?: boolean;
};

type ReadEntry = {
	toolCallId: string;
	path: string;
	displayPaths?: ReadDisplayPathSpec[];
	linkPath?: string;
	status: "pending" | "success" | "warning" | "error";
	correctedFrom?: string;
	contentText?: string;
	/** The result's `details.contentType`; see {@link previewsMarkdown}. */
	contentType?: string;
	/** The call's `raw` arg, which keeps Markdown previews as source. */
	raw?: boolean;
	conflictCount?: number;
	codeStartLine?: number;
	codeLineNumbers?: Array<number | null>;
	/** The result's image blocks in content order; a delimited read maps them to targets via `displayPaths[].imageIndex`. */
	images: ReadVisualImage[];
	/** Whole-file SVG source of a text read, rasterized under the row. */
	svgSource?: string;
	/** The SVG's figure, kept across display rebuilds so its raster is drawn once. */
	figure?: SvgFigure;
	/** The SVG's native `image` node, per source, so a rebuild does not re-register the blob. */
	svgNode?: { source: string; node: NativeNode };
	/** The whole file this read showed that Tern's media viewer shows (`details.mediaPath`); a native `media` host loads it by path. */
	mediaPath?: string;
};

/**
 * Whether an entry previews as rendered Markdown instead of numbered source.
 * Derived on each render so `raw`/path args that land after the result still apply.
 */
function previewsMarkdown(entry: ReadEntry): boolean {
	return readResultIsMarkdown({ contentType: entry.contentType }, { path: entry.path, raw: entry.raw });
}

type ReadUsageRow = {
	toolCallIds: readonly string[];
	usage: Usage;
	durationMs?: number;
	ttftMs?: number;
	timestamp?: number;
	turnElapsedMs?: number;
};

/** Number of preview rows to show per read while collapsed. */
const COLLAPSED_PREVIEW_LINES = PREVIEW_LIMITS.OUTPUT_COLLAPSED;

/**
 * The outer data-first group must not cut off later files: code is trimmed by
 * source line and Markdown is clamped by each file's native card after rendering.
 */
const TRIMMED_BODY_PREVIEW = { lines: 1000 } as const;

/** Native item tone per read status; successful reads stay neutral. */
const READ_STATUS_TONE: Record<ReadEntry["status"], "pending" | "warning" | "error" | undefined> = {
	success: undefined,
	pending: "pending",
	warning: "warning",
	error: "error",
};

type ReadDisplayTarget = {
	entry: ReadEntry;
	targetPath: string;
	basePath: string;
	linkPath?: string;
	selector?: string;
	/** The raster this target returned, drawn under its row. */
	image?: ReadVisualImage;
};

type ReadSummaryRow = {
	targetPath: string;
	basePath: string;
	targets: ReadDisplayTarget[];
};

const READ_STATUS_RANK: Record<ReadEntry["status"], number> = {
	success: 0,
	pending: 1,
	warning: 2,
	error: 3,
};

function getDisplayReadTargets(details: ReadToolDetails | undefined): ReadDisplayPathSpec[] | undefined {
	if (!Array.isArray(details?.displayReadTargets)) return undefined;
	const links = Array.isArray(details.displayReadTargetLinks) ? details.displayReadTargetLinks : undefined;
	const images = Array.isArray(details.displayReadTargetImages) ? details.displayReadTargetImages : undefined;
	const targets: ReadDisplayPathSpec[] = [];
	details.displayReadTargets.forEach((raw, index) => {
		if (typeof raw !== "string") return;
		const path = raw.trim();
		if (!path) return;
		const link = links?.[index];
		const image = images?.[index];
		targets.push({
			path,
			linkPath: typeof link === "string" && link.length > 0 ? link : undefined,
			imageIndex: typeof image === "number" && image >= 0 ? image : undefined,
		});
	});
	return targets.length > 0 ? targets : undefined;
}

function displayPathWithSuffixResolution(currentPath: string, suffixResolution: ReadToolSuffixResolution): string {
	const currentSelector = splitPathAndSel(currentPath).sel;
	if (!currentSelector || splitPathAndSel(suffixResolution.to).sel) return suffixResolution.to;
	return `${suffixResolution.to}:${currentSelector}`;
}

function readResultLinkPath(details: ReadToolDetails | undefined): string | undefined {
	return (
		details?.displayTarget ??
		(typeof details?.resolvedPath === "string" ? details.resolvedPath : readSourceFsPath(details))
	);
}

function readTargetLinkPath(basePath: string, entryLinkPath: string | undefined): string | undefined {
	if (entryLinkPath) return entryLinkPath;
	return path.isAbsolute(basePath) ? basePath : undefined;
}

function firstSelectorLine(selector: string | undefined): number | undefined {
	try {
		return selectorLineRanges(selector)?.[0].startLine;
	} catch {
		return undefined;
	}
}

function firstSelectorLineForTargets(targets: ReadDisplayTarget[]): number | undefined {
	let line: number | undefined;
	for (const target of targets) {
		const targetLine = firstSelectorLine(target.selector);
		if (targetLine === undefined) continue;
		if (line === undefined || targetLine < line) line = targetLine;
	}
	return line;
}

function linkPathForTargets(targets: ReadDisplayTarget[]): string | undefined {
	for (const target of targets) {
		if (target.linkPath) return target.linkPath;
	}
	return undefined;
}

function selectorChunkIsLineRangeList(chunk: string): boolean {
	const trimmed = chunk.trim();
	if (!trimmed) return false;
	try {
		return parseLineRanges(trimmed) !== null;
	} catch {
		return false;
	}
}

function nextTopLevelToken(input: string, start: number): string {
	let braceDepth = 0;
	for (let i = start; i < input.length; i++) {
		const ch = input[i];
		if (ch === "\\" && i + 1 < input.length) {
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (braceDepth === 0 && (ch === "," || ch === ";")) {
			return input.slice(start, i);
		}
	}
	return input.slice(start);
}

function commaContinuesLineRangeSelector(input: string, partStart: number, commaIndex: number): boolean {
	const currentPart = input.slice(partStart, commaIndex).trim();
	if (!splitPathAndSel(currentPart).sel) return false;
	return selectorChunkIsLineRangeList(nextTopLevelToken(input, commaIndex + 1));
}

function splitReadDisplayPathSpecs(rawPath: string): string[] {
	const normalized = rawPath.trim();
	if (!normalized || splitUrlScheme(normalized)) return [rawPath];

	const parts: string[] = [];
	let braceDepth = 0;
	let partStart = 0;
	for (let i = 0; i < normalized.length; i++) {
		const ch = normalized[i];
		if (ch === "\\" && i + 1 < normalized.length) {
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (braceDepth !== 0 || (ch !== "," && ch !== ";")) continue;
		if (ch === "," && commaContinuesLineRangeSelector(normalized, partStart, i)) continue;
		parts.push(normalized.slice(partStart, i).trim());
		partStart = i + 1;
	}
	parts.push(normalized.slice(partStart).trim());

	const cleanParts = parts.filter(part => part.length > 0);
	if (cleanParts.length <= 1) return [rawPath];
	return cleanParts.every(part => splitPathAndSel(part).sel !== undefined) ? cleanParts : [rawPath];
}

function splitSelectorDisplayParts(sel: string | undefined): Array<string | undefined> {
	if (!sel) return [undefined];
	const chunks = sel.split(":");
	if (chunks.length === 1) {
		if (!selectorChunkIsLineRangeList(sel) || !sel.includes(",")) return [sel];
		return sel
			.split(",")
			.map(chunk => chunk.trim())
			.filter(chunk => chunk.length > 0);
	}
	if (chunks.length === 2) {
		const [left, right] = chunks as [string, string];
		const leftIsRange = selectorChunkIsLineRangeList(left);
		const rightIsRange = selectorChunkIsLineRangeList(right);
		if (leftIsRange && left.includes(",")) {
			return left
				.split(",")
				.map(chunk => chunk.trim())
				.filter(chunk => chunk.length > 0)
				.map(chunk => `${chunk}:${right}`);
		}
		if (rightIsRange && right.includes(",")) {
			return right
				.split(",")
				.map(chunk => chunk.trim())
				.filter(chunk => chunk.length > 0)
				.map(chunk => `${left}:${chunk}`);
		}
	}
	return [sel];
}

function formatMergedSelectorParts(selectors: string[]): string {
	if (selectors.length <= 3) return selectors.join(",");
	const first = selectors[0]!;
	const second = selectors[1]!;
	const last = selectors[selectors.length - 1]!;
	return `${first},${second},…,${last}`;
}

/**
 * Whether a text read's body is one complete SVG document worth rasterizing:
 * a single `.svg`/`.svgz` target read whole — no range selector (`:raw` still
 * is whole), the scan reached EOF (`totalLines`), and the display content is
 * exactly lines 1…totalLines with nothing elided, truncated or summarized. A
 * prefix or a structural summary would only ever fail to draw.
 */
function isWholeSvgRead(entry: ReadEntry, details: ReadToolDetails | undefined): boolean {
	if (entry.displayPaths && entry.displayPaths.length > 1) return false;
	const split = splitPathAndSel(entry.path);
	const ext = path.extname(split.path).toLowerCase();
	if (ext !== ".svg" && ext !== ".svgz") return false;
	if (split.sel !== undefined && split.sel.toLowerCase() !== "raw") return false;
	if (!details || details.summary !== undefined || details.truncation !== undefined) return false;
	if (details.meta?.truncation !== undefined) return false;
	const totalLines = details.totalLines;
	const lineNumbers = details.displayContent?.lineNumbers;
	if (typeof totalLines !== "number" || totalLines < 1 || !lineNumbers || lineNumbers.length !== totalLines) {
		return false;
	}
	return lineNumbers.every((lineNumber, index) => lineNumber === index + 1);
}

export class ReadToolGroupComponent extends Container implements ToolExecutionHandle {
	#entries = new Map<string, ReadEntry>();
	#usageRows = new Map<string, ReadUsageRow>();
	#usageBatchByToolCallId = new Map<string, string>();
	#text: Text;
	#expanded = false;
	#toolActivityVisible = true;
	#showContentPreview: boolean;
	#showImages: boolean;
	readonly #ui: ReadToolGroupUi | undefined;
	// A read group accretes entries across multiple assistant completions for as
	// long as the run of reads is uninterrupted. It remains active while its
	// header can change from `Read <path>` to `Read (N)` plus a tree. The
	// controller calls `finalize()` once the run breaks; TranscriptContainer
	// retires the finalized block as an immutable history batch.
	#finalized = false;
	// Forced terminal even with a still-pending entry: the turn ended (abort or
	// completion) so no late result is coming. Set via `seal()`.
	#sealed = false;
	// Post-finalize mutation counter (FinalizableBlock.getTranscriptBlockVersion):
	// a finalized group can still change — a late read result landing after the
	// run broke, seal(), or an expansion toggle — and the transcript's
	// width-epoch resolution and committed-render bypass must observe it.
	#blockVersion = 0;
	#displayVersion = 0;
	readonly #native = new Memo();
	/** Content previews toggled in the terminal, by tool call id. */
	#previewCollapsed = new Map<string, boolean>();

	constructor(options: ReadToolGroupOptions = {}) {
		super();
		this.#showContentPreview = options.showContentPreview ?? false;
		this.#showImages = options.showImages ?? true;
		this.#ui = options.ui;
		this.#text = new Text("", 0, 0);
		this.addChild(this.#text);
		this.#updateDisplay();
	}

	override render(width: number): readonly string[] {
		if (!this.#toolActivityVisible) return [];
		return super.render(width);
	}
	isTranscriptBlockFinalized(): boolean {
		if (this.#sealed) return true;
		if (!this.#finalized) return false;
		// Closed to new entries, but a still-pending entry means its result is in
		// flight — parallel reads can finalize the group (a sibling tool starts and
		// breaks the run) before a read's `tool_execution_end` lands. Keep the block
		// active so the late result updates the pending preview.
		return !this.#hasPendingEntries();
	}

	#hasPendingEntries(): boolean {
		for (const entry of this.#entries.values()) {
			if (entry.status === "pending") return true;
		}
		return false;
	}

	finalize(): void {
		this.#finalized = true;
	}

	/**
	 * Force the group terminal even if an entry never received its result (the
	 * turn aborted or ended), allowing the container to retire it as history.
	 */
	seal(): void {
		if (!this.#sealed) this.#blockVersion++;
		this.#sealed = true;
	}

	/** Reads never park as background tasks; the handle method is a no-op. */
	parkAsBackground(): void {}

	getTranscriptBlockVersion(): number {
		return this.#blockVersion;
	}

	updateArgs(args: ReadRenderArgs, toolCallId?: string): void {
		if (!toolCallId) return;
		const rawPath =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
		const entry: ReadEntry = this.#entries.get(toolCallId) ?? {
			toolCallId,
			path: rawPath,
			status: "pending",
			images: [],
		};
		entry.path = rawPath;
		entry.raw = args.raw === true;
		this.#entries.set(toolCallId, entry);
		this.#updateDisplay();
	}

	/**
	 * Re-key an entry whose streamed tool-call id changed mid-stream (a provider
	 * rewriting the id across deltas; see EventController's
	 * `#streamedToolCallIdByIndex`). Preserves row order so a sibling read run is
	 * not visibly reshuffled, and no-ops when the rename would collide.
	 */
	renameEntry(oldId: string, newId: string): void {
		if (oldId === newId || !newId) return;
		const entry = this.#entries.get(oldId);
		if (!entry || this.#entries.has(newId)) return;
		entry.toolCallId = newId;
		const reordered = [...this.#entries].map(([key, value]): [string, ReadEntry] => [
			key === oldId ? newId : key,
			value,
		]);
		this.#entries.clear();
		for (const [key, value] of reordered) this.#entries.set(key, value);
		this.#updateDisplay();
	}
	/** Remove one call without discarding successful siblings in the shared group. */
	removeEntry(toolCallId: string): boolean {
		const entry = this.#entries.get(toolCallId);
		if (!entry || !this.#entries.delete(toolCallId)) return this.#entries.size === 0;
		entry.figure?.dispose();
		this.#updateDisplay();
		return this.#entries.size === 0;
	}

	override dispose(): void {
		for (const entry of this.#entries.values()) entry.figure?.dispose();
		super.dispose();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: unknown;
			isError?: boolean;
		},
		isPartial = false,
		toolCallId?: string,
	): void {
		if (!toolCallId) return;
		const entry = this.#entries.get(toolCallId);
		if (!entry) return;
		if (isPartial) return;
		this.#blockVersion++;
		const details = result.details as ReadToolDetails | undefined;
		const suffixResolution = getSuffixResolution(details);
		const displayPaths = getDisplayReadTargets(details);
		entry.linkPath = readResultLinkPath(details);
		if (suffixResolution) {
			entry.path = displayPathWithSuffixResolution(entry.path, suffixResolution);
			entry.correctedFrom = suffixResolution.from;
			entry.displayPaths = undefined;
		} else {
			entry.correctedFrom = undefined;
			entry.displayPaths = displayPaths;
		}
		const conflictCount =
			typeof details?.conflictCount === "number" && details.conflictCount > 0 ? details.conflictCount : undefined;
		entry.conflictCount = conflictCount;
		entry.status = result.isError ? "error" : suffixResolution ? "warning" : "success";
		entry.contentType = details?.contentType;
		entry.mediaPath = result.isError ? undefined : readMediaPath(details);
		// Store clean display content for preview/expanded display when the read
		// tool provides it; fall back to model-facing text for legacy results.
		const displayContent = details?.displayContent;
		const textContent = result.content?.find(c => c.type === "text")?.text;
		if (displayContent !== undefined || textContent !== undefined) {
			entry.contentText = displayContent?.text ?? textContent;
			entry.codeStartLine = displayContent?.startLine;
			entry.codeLineNumbers = displayContent?.lineNumbers;
		}
		const imageBlocks = result.content?.filter(isImageBlock) ?? [];
		const sameImages =
			imageBlocks.length === entry.images.length &&
			imageBlocks.every((block, index) => block === entry.images[index]!.block);
		if (!sameImages) entry.images = imageBlocks.map(block => ({ block }));
		entry.svgSource =
			imageBlocks.length === 0 &&
			!result.isError &&
			entry.contentText !== undefined &&
			isWholeSvgRead(entry, details)
				? entry.contentText
				: undefined;
		if (!entry.svgSource && entry.figure) {
			entry.figure.dispose();
			entry.figure = undefined;
		}
		this.#updateDisplay();
	}

	/**
	 * Nest one request's usage beneath the last visible read call from that
	 * request. Parallel reads share one row rather than duplicating request totals.
	 */
	attachUsage(
		toolCallIds: readonly string[],
		usage: Usage,
		durationMs?: number,
		ttftMs?: number,
		timestamp?: number,
		turnElapsedMs?: number,
	): boolean {
		const attachedToolCallIds: string[] = [];
		let anchorId: string | undefined;
		for (const toolCallId of toolCallIds) {
			if (!this.#entries.has(toolCallId)) continue;
			attachedToolCallIds.push(toolCallId);
			anchorId = toolCallId;
		}
		if (!anchorId) return false;
		for (const toolCallId of attachedToolCallIds) {
			this.#usageBatchByToolCallId.set(toolCallId, anchorId);
		}
		this.#usageRows.set(anchorId, {
			toolCallIds: attachedToolCallIds,
			usage,
			durationMs,
			ttftMs,
			timestamp,
			turnElapsedMs,
		});
		this.#updateDisplay();
		return true;
	}

	setArgsComplete(_toolCallId?: string): void {
		this.#updateDisplay();
	}

	setExecutionStarted(_toolCallId?: string): void {
		this.#updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) this.#blockVersion++;
		this.#expanded = expanded;
		this.#previewCollapsed.clear();
		this.#updateDisplay();
	}

	setToolActivityVisible(visible: boolean): void {
		this.#toolActivityVisible = visible;
		super.invalidate();
	}

	/** Draw or hide the rows' visual previews (the host's `terminal.showImages`). */
	setShowImages(visible: boolean): void {
		if (this.#showImages === visible) return;
		this.#showImages = visible;
		this.#blockVersion++;
		this.#updateDisplay();
	}

	getComponent(): Component {
		return this;
	}

	/**
	 * Mirrors the terminal's toggles: the `tool` head (the group's root) is
	 * `Ctrl+O`'s expansion; a fallback preview card collapses on its own
	 * (`setExpanded` resets those).
	 */
	handleNativeEvent(event: NativeUiEvent): void {
		const expanded = rootToggleExpanded(event);
		if (expanded !== undefined) {
			this.setExpanded(expanded);
			return;
		}
		if (event.type !== "toggle" || !event.key.startsWith("p")) return;
		const toolCallId = event.key.slice(1);
		if (!this.#entries.has(toolCallId)) return;
		this.#previewCollapsed.set(toolCallId, event.collapsed);
		this.#displayVersion++;
	}

	/**
	 * The read run as one inline `tool` on terminals that list the kind, else
	 * the fallback: a bare `card` (role `omp.tool.read`) with `Read <path>` or
	 * `Read (N)` in the head, a `list` of path items (status tone, link,
	 * correction and conflict detail, nested usage) and a clamped preview per
	 * read when content previews are on.
	 */
	override describe(cx?: DescribeContext): NativeNode {
		const dataFirst = cx?.supports("tool") === true;
		const media = cx?.supports("media") === true;
		const key = [dataFirst, media, this.#displayVersion, this.#toolActivityVisible, this.#sealed];
		return this.#native.get(key, () =>
			withHidden(dataFirst ? this.#describeTool(media) : this.#describeGroup(media), !this.#toolActivityVisible),
		);
	}

	/**
	 * The data-first read (§7.3 read, read group, read error): one inline
	 * `tool` (role `omp.tool.read`). One file: `Read path:13-36`, a failure's
	 * message in the head. Several: `Read 3 files` over one 22px row per file
	 * (glyph, dim dir, strong name, range). Each content preview is numbered
	 * code or rendered Markdown, clamped per file while collapsed.
	 */
	#describeTool(media: boolean): NativeNode {
		const entries = [...this.#entries.values()];
		const rows = this.#buildSummaryRows(this.#displayTargetsForEntries(entries));
		const status = this.#groupStatus(entries);
		const previewed = entries.filter(entry => entry.status !== "error" && this.#shouldRenderPreview(entry));
		const body: NativeChild[] = [];
		const shownMedia = new Set<string>();
		let head: NativeToolHead;
		// Previews, visuals and a long error message are what a collapse hides; plain rows always show.
		let collapsible =
			previewed.length > 0 || entries.some(entry => this.#hasVisual(entry) || this.#hasMedia(entry, media));
		if (rows.length <= 1) {
			const row = rows[0];
			const error = row && this.#statusForTargets(row.targets) === "error" ? this.#errorFor(row) : undefined;
			const rowHead: NativeToolHead = row ? this.#nativeRowHead(row) : { target: "…", targetKind: "path" };
			if (error !== undefined) {
				const view = inlineErrorView(rowHead, error);
				head = view.tool ?? rowHead;
				if (view.body) {
					body.push(...view.body);
					collapsible = true;
				}
			} else {
				head = rowHead;
			}
			if (row) body.push(...this.#nativeVisualsForRow(row, media, shownMedia));
			for (const entry of previewed) body.push(...this.#nativeBody(entry));
			for (const [i, usage] of (this.#usageRowsBySummaryRow(rows).get(0) ?? []).entries()) {
				body.push(this.#nativeUsage(usage, `u${i}`));
			}
		} else {
			head = { target: formatCount("file", rows.length), targetKind: "text" };
			const summaryRows = this.#buildSummaryRows(
				this.#displayTargetsForEntries(entries.filter(entry => !previewed.includes(entry))),
			);
			const usageByRow = this.#usageRowsBySummaryRow(summaryRows);
			for (const [index, row] of summaryRows.entries()) {
				body.push(this.#nativeFileRow(row));
				body.push(...this.#nativeVisualsForRow(row, media, shownMedia));
				for (const [i, usage] of (usageByRow.get(index) ?? []).entries()) {
					body.push(this.#nativeUsage(usage, `u${index}.${i}`));
				}
			}
			for (const entry of previewed) {
				const split = splitPathAndSel(entry.path);
				const name = shortenPath(split.path);
				const sectionHead: TspSpan[] = [span(name || "…", "path")];
				if (split.sel) sectionHead.push(span(`:${split.sel}`, "muted"));
				body.push(node("section", { head: sectionHead }, this.#nativeBody(entry), `p${entry.toolCallId}`));
				const usage = this.#usageRows.get(entry.toolCallId);
				if (usage) body.push(this.#nativeUsage(usage, `u${entry.toolCallId}`));
			}
		}
		return node(
			"tool",
			{
				...head,
				role: "omp.tool.read",
				name: "read",
				title: "Read",
				status,
				tone: status === "error" ? "error" : undefined,
				frame: "inline",
				collapsible,
				collapsed: collapsible ? !this.#expanded : undefined,
				preview: collapsible ? TRIMMED_BODY_PREVIEW : undefined,
			},
			body,
		);
	}

	/** Head data for one summary row: the path (+ selector) target, its link, correction and conflicts. */
	#nativeRowHead(row: ReadSummaryRow): NativeToolHead {
		const split = splitPathAndSel(row.targetPath);
		const filePath = shortenPath(split.sel ? split.path : row.targetPath);
		const correctedFrom = this.#correctedFromForTargets(row.targets);
		const conflicts = this.#conflictCountForTargets(row.targets);
		return {
			target: filePath ? `${filePath}${split.sel ? `:${split.sel}` : ""}` : "…",
			targetKind: "path",
			href: fileHref(linkPathForTargets(row.targets)),
			meta: correctedFrom ? [`corrected from ${shortenPath(correctedFrom)}`] : undefined,
			badges: conflicts
				? [{ text: `${conflicts} conflict${conflicts === 1 ? "" : "s"}`, tone: "warning" }]
				: undefined,
		};
	}

	/** One 22px group row: status glyph, path and range, conflicts chip, then the correction or error message. */
	#nativeFileRow(row: ReadSummaryRow): NativeNode {
		const split = splitPathAndSel(row.targetPath);
		const status = this.#statusForTargets(row.targets);
		const correctedFrom = this.#correctedFromForTargets(row.targets);
		const conflicts = this.#conflictCountForTargets(row.targets);
		const error = status === "error" ? this.#errorFor(row) : undefined;
		const detail: TspText | undefined =
			error !== undefined
				? [span(`— ${error.split("\n", 1)[0]}`, "error")]
				: correctedFrom
					? `corrected from ${shortenPath(correctedFrom)}`
					: undefined;
		return fileRow(shortenPath(split.sel ? split.path : row.targetPath), {
			range: split.sel ? `:${split.sel}` : undefined,
			href: fileHref(linkPathForTargets(row.targets)),
			icon: status === "error" ? "x-circle" : undefined,
			tone: READ_STATUS_TONE[status],
			chip: conflicts ? { text: `${conflicts} conflict${conflicts === 1 ? "" : "s"}` } : undefined,
			detail,
			title: error,
			key: row.targetPath,
		});
	}

	/** The failure message of a row's failed read (its result text, `Error:` prefix dropped). */
	#errorFor(row: ReadSummaryRow): string {
		const failed = row.targets.find(target => target.entry.status === "error")?.entry;
		return (
			plainText(failed?.contentText ?? "")
				.replace(/^Error:\s*/, "")
				.trim() || "Read failed"
		);
	}

	/** A previewed entry's body: its SVG figure (when any) over the trimmed content preview. */
	#nativeBody(entry: ReadEntry): NativeChild[] {
		const blocks: NativeChild[] = [];
		if (this.#hasSvgVisual(entry)) blocks.push(this.#nativeSvg(entry));
		blocks.push(...this.#nativePreview(entry));
		return blocks;
	}

	/**
	 * The native nodes under one summary row: on a `media` host the file by
	 * path (once per file across the group: `shownMedia`), else each target's
	 * own raster (as delivered), then the SVG source of an unpreviewed entry
	 * for the host to draw. Each image and each SVG appears once per row.
	 */
	#nativeVisualsForRow(row: ReadSummaryRow, media: boolean, shownMedia: Set<string>): NativeNode[] {
		const nodes: NativeNode[] = [];
		const seenImages = new Set<ReadVisualImage>();
		const seenEntries = new Set<string>();
		for (const target of row.targets) {
			const entry = target.entry;
			// A file Tern's media viewer shows: the host loads it by path once, no bytes uploaded.
			if (this.#hasMedia(entry, media)) {
				const mediaPath = entry.mediaPath!;
				if (!shownMedia.has(mediaPath)) nodes.push(nativeMediaNode(mediaPath, `media${entry.toolCallId}`));
				shownMedia.add(mediaPath);
				continue;
			}
			if (target.image && this.#hasVisual(entry) && !seenImages.has(target.image)) {
				seenImages.add(target.image);
				const alt = shortenPath(target.basePath) || "image";
				nodes.push(
					keyed(
						describeReadImage(target.image.block, alt),
						`img${entry.toolCallId}:${entry.images.indexOf(target.image)}`,
					),
				);
			}
			if (seenEntries.has(entry.toolCallId)) continue;
			seenEntries.add(entry.toolCallId);
			if (this.#hasSvgVisual(entry) && !this.#shouldRenderPreview(entry)) nodes.push(this.#nativeSvg(entry));
		}
		return nodes;
	}

	/**
	 * Whether a native `media` host shows `entry`'s file by path in place of its
	 * images or SVG: the read named a whole Tern-viewable file (an image, SVG,
	 * model, PDF — the model may have received no image at all).
	 */
	#hasMedia(entry: ReadEntry, media: boolean): boolean {
		return media && this.#showImages && entry.status !== "error" && entry.mediaPath !== undefined;
	}

	/** The entry's SVG source as a native `image`, cached per source so a rebuild does not re-register the blob. */
	#nativeSvg(entry: ReadEntry): NativeNode {
		const source = entry.svgSource ?? "";
		let cached = entry.svgNode;
		if (cached?.source !== source) {
			cached = entry.svgNode = {
				source,
				node: nativeImageNode(new TextEncoder().encode(source), "image/svg+xml", {
					alt: shortenPath(splitPathAndSel(entry.path).path) || "image",
					role: "omp.tool.read.image",
				}),
			};
		}
		return keyed(cached.node, `svg${entry.toolCallId}`);
	}

	/** One read's content, clamped per file while the group is collapsed. */
	#nativePreview(entry: ReadEntry): NativeChild[] {
		if (previewsMarkdown(entry)) {
			return [
				card(
					{
						variant: "bare",
						collapsible: true,
						collapsed: !this.#expanded,
						preview: { lines: COLLAPSED_PREVIEW_LINES },
					},
					[md(entry.contentText ?? "")],
				),
			];
		}
		const split = splitPathAndSel(entry.path);
		const lines = (entry.contentText ?? "").split("\n");
		const shown = this.#expanded ? lines.length : Math.min(lines.length, COLLAPSED_PREVIEW_LINES);
		const blocks: NativeChild[] = readContentCode(
			lines.slice(0, shown).join("\n"),
			entry.codeStartLine ?? firstSelectorLine(split.sel) ?? 1,
			entry.codeLineNumbers?.slice(0, shown),
			getLanguageFromPath(split.path),
		);
		const hidden = lines.length - shown;
		if (hidden > 0) {
			blocks.push(
				keyed(text([span(formatCount("more line", hidden), "muted")], { role: "omp.tool.stats" }), "more"),
			);
		}
		return blocks;
	}

	#describeGroup(media: boolean): NativeNode {
		const entries = [...this.#entries.values()];
		const rows = this.#buildSummaryRows(this.#displayTargetsForEntries(entries));
		const usageByRow = this.#usageRowsBySummaryRow(rows);
		const previewed = entries.filter(entry => this.#shouldRenderPreview(entry));
		const status = this.#groupStatus(entries);
		const title = span("Read", "toolTitle");
		const children: NativeChild[] = [];
		const shownMedia = new Set<string>();
		let head: TspSpan[] = [title];
		if (rows.length === 1) {
			head = [title, span(" "), ...this.#nativePathSpans(rows[0]!)];
			children.push(...this.#nativeVisualsForRow(rows[0]!, media, shownMedia));
			if (previewed.length === 0) {
				for (const usage of usageByRow.get(0) ?? []) children.push(this.#nativeUsage(usage, "u0"));
			}
		} else if (rows.length > 1) {
			head = [title, span(` (${rows.length})`, "dim")];
			const summaryTargets = this.#displayTargetsForEntries(entries.filter(entry => !previewed.includes(entry)));
			const summaryRows = this.#buildSummaryRows(summaryTargets);
			const summaryUsage = this.#usageRowsBySummaryRow(summaryRows);
			const items = summaryRows.map((row, index) => {
				const usage = (summaryUsage.get(index) ?? []).map(usageRow =>
					plainText(
						formatUsageRow(
							usageRow.usage,
							usageRow.durationMs,
							usageRow.ttftMs,
							usageRow.timestamp,
							usageRow.turnElapsedMs,
						),
					),
				);
				return node(
					"item",
					{
						label: this.#nativePathSpans(row),
						tone: READ_STATUS_TONE[this.#statusForTargets(row.targets)],
						detail: usage.length > 0 ? [span(usage.join(" · "), "dim")] : undefined,
					},
					this.#nativeVisualsForRow(row, media, shownMedia),
					row.targetPath,
				);
			});
			if (items.length > 0) children.push(node("list", {}, items));
		}
		for (const entry of previewed) {
			const split = splitPathAndSel(entry.path);
			const pathValue = shortenPath(entry.path);
			const cardBody: NativeChild[] = [];
			if (this.#hasSvgVisual(entry)) cardBody.push(this.#nativeSvg(entry));
			cardBody.push(
				previewsMarkdown(entry)
					? md(entry.contentText ?? "")
					: code(entry.contentText ?? "", {
							lang: getLanguageFromPath(split.path),
							start: entry.codeStartLine,
							numbers: true,
						}),
			);
			children.push(
				node(
					"card",
					{
						role: "omp.tool.read.preview",
						tone: READ_STATUS_TONE[entry.status],
						head: pathValue ? [title, span(" "), span(pathValue, "path")] : [title],
						collapsible: true,
						collapsed: this.#previewCollapsed.get(entry.toolCallId) ?? !this.#expanded,
						preview: { lines: COLLAPSED_PREVIEW_LINES },
					},
					cardBody,
					`p${entry.toolCallId}`,
				),
			);
			const usage = this.#usageRows.get(entry.toolCallId);
			if (usage) children.push(this.#nativeUsage(usage, `u${entry.toolCallId}`));
		}
		return card(
			{
				role: "omp.tool.read",
				// A group is plain rows: the per-file previews are the only frames.
				variant: "bare",
				status,
				tone: status === "error" ? "error" : status === "running" ? "pending" : undefined,
				head,
			},
			children,
		);
	}

	#groupStatus(entries: readonly ReadEntry[]): TspCardStatus {
		let rank = 0;
		for (const entry of entries) rank = Math.max(rank, READ_STATUS_RANK[entry.status]);
		if (rank === READ_STATUS_RANK.error) return "error";
		if (rank === READ_STATUS_RANK.pending) return this.#sealed ? "cancelled" : "running";
		return "done";
	}

	/** Path spans for a summary row: linked path, selector, correction note and conflict badge. */
	#nativePathSpans(row: ReadSummaryRow): TspSpan[] {
		const split = splitPathAndSel(row.targetPath);
		const filePath = shortenPath(split.sel ? split.path : row.targetPath);
		const linkPath = linkPathForTargets(row.targets);
		const spans: TspSpan[] = [];
		if (filePath) {
			const href = linkPath && path.isAbsolute(linkPath) ? pathToFileURL(linkPath).href : undefined;
			spans.push(span(filePath, "path", href ? { href } : undefined));
		} else {
			spans.push(span("…", "toolOutput"));
		}
		if (split.sel) spans.push(span(`:${split.sel}`, "accent"));
		const correctedFrom = this.#correctedFromForTargets(row.targets);
		if (correctedFrom) spans.push(span(` (corrected from ${shortenPath(correctedFrom)})`, "dim"));
		const conflicts = this.#conflictCountForTargets(row.targets);
		if (conflicts) spans.push(span(` (⚠ ${conflicts} conflict${conflicts === 1 ? "" : "s"})`, "warning"));
		return spans;
	}

	#nativeUsage(usage: ReadUsageRow, key: string): NativeNode {
		const line = formatUsageRow(usage.usage, usage.durationMs, usage.ttftMs, usage.timestamp, usage.turnElapsedMs);
		return text([span(plainText(line), "dim")], { wrap: "word", key, role: "omp.usage" });
	}

	#updateDisplay(): void {
		this.#displayVersion++;
		const entries = [...this.#entries.values()];
		const displayTargets = this.#displayTargetsForEntries(entries);
		const displayRows = this.#buildSummaryRows(displayTargets);

		// Clear previous children and rebuild the summary and preview blocks.
		this.clear();
		this.#text = new Text("", 0, 0);

		if (displayRows.length === 0) {
			this.#text.setText(` ${theme.format.bullet} ${theme.fg("toolTitle", theme.bold("Read"))}`);
			this.addChild(this.#text);
			return;
		}

		if (displayRows.length === 1) {
			const row = displayRows[0]!;
			if (!this.#shouldRenderPreviewRow(row)) {
				const statusSymbol = this.#formatStatus(this.#statusForTargets(row.targets));
				const pathDisplay = this.#formatRowPath(row);
				const lines = [` ${statusSymbol} ${theme.fg("toolTitle", theme.bold("Read"))} ${pathDisplay}`.trimEnd()];
				const usageRows = this.#usageRowsBySummaryRow(displayRows).get(0) ?? [];
				const visuals = this.#visualsForRow(row);
				if (visuals.length === 0) {
					this.#appendUsageRows(lines, usageRows, "   ");
					this.#text.setText(lines.join("\n"));
					this.addChild(this.#text);
				} else {
					// The visual sits right under its row; the usage follows it.
					this.#text.setText(lines[0]!);
					this.addChild(this.#text);
					for (const visual of visuals) this.addChild(visual);
					const usageLines: string[] = [];
					this.#appendUsageRows(usageLines, usageRows, "   ");
					if (usageLines.length > 0) this.addChild(new Text(usageLines.join("\n"), 0, 0));
				}
				return;
			}
			for (const entry of this.#previewEntriesForRow(row)) {
				this.#addContentPreview(entry);
				this.#addVisual(entry);
				this.#addPreviewUsage(entry);
			}
			return;
		}

		const header = `${theme.fg("toolTitle", theme.bold("Read"))}${theme.fg("dim", ` (${displayRows.length})`)}`;
		let lines = [` ${theme.format.bullet} ${header}`];
		const entriesWithoutPreview = entries.filter(entry => !this.#shouldRenderPreview(entry));
		const summaryTargets = this.#displayTargetsForEntries(entriesWithoutPreview);
		const rows = this.#buildSummaryRows(summaryTargets);
		const usageRowsBySummaryRow = this.#usageRowsBySummaryRow(rows);
		for (const [index, row] of rows.entries()) {
			const usageRows = usageRowsBySummaryRow.get(index) ?? [];
			const visuals = this.#visualsForRow(row);
			if (visuals.length === 0) {
				this.#appendSummaryRow(lines, row, index, rows.length, usageRows);
				continue;
			}
			// Break the tree text around the visual so it hangs under its own row.
			this.#appendSummaryRow(lines, row, index, rows.length, []);
			this.addChild(new Text(lines.join("\n"), 0, 0));
			lines = [];
			for (const visual of visuals) this.addChild(visual);
			this.#appendUsageRows(lines, usageRows, this.#summaryContinuation(index, rows.length));
		}
		if (lines.length > 0) {
			this.#text.setText(lines.join("\n"));
			this.addChild(this.#text);
		}

		for (const entry of entries) {
			if (this.#shouldRenderPreview(entry)) {
				this.#addContentPreview(entry);
				this.#addVisual(entry);
				this.#addPreviewUsage(entry);
			}
		}
	}

	#displayTargetsForEntries(entries: ReadEntry[]): ReadDisplayTarget[] {
		const targets: ReadDisplayTarget[] = [];
		for (const entry of entries) {
			const pathSpecs: ReadDisplayPathSpec[] =
				entry.displayPaths ?? splitReadDisplayPathSpecs(entry.path).map(path => ({ path }));
			const singleTarget = pathSpecs.length === 1;
			for (const pathSpec of pathSpecs) {
				const split = splitPathAndSel(pathSpec.path);
				const entryLinkPath = pathSpec.linkPath ?? (singleTarget ? entry.linkPath : undefined);
				const linkPath = readTargetLinkPath(split.path, entryLinkPath);
				// A delimited read names each target's image by index; a single
				// target owns the result's image. Several targets without a mapping
				// (a result from before it existed) draw none rather than the wrong one.
				const image =
					pathSpec.imageIndex !== undefined
						? entry.images[pathSpec.imageIndex]
						: singleTarget
							? entry.images[0]
							: undefined;
				for (const [index, selector] of splitSelectorDisplayParts(split.sel).entries()) {
					targets.push({
						entry,
						targetPath: selector ? `${split.path}:${selector}` : pathSpec.path,
						basePath: split.path,
						linkPath,
						selector,
						image: index === 0 ? image : undefined,
					});
				}
			}
		}
		return targets;
	}

	#buildSummaryRows(targets: ReadDisplayTarget[]): ReadSummaryRow[] {
		const selectorTargetsByBasePathAndBatch = new Map<string, Map<string | undefined, ReadDisplayTarget[]>>();
		for (const target of targets) {
			if (!target.selector) continue;
			let targetsByBatch = selectorTargetsByBasePathAndBatch.get(target.basePath);
			if (!targetsByBatch) {
				targetsByBatch = new Map<string | undefined, ReadDisplayTarget[]>();
				selectorTargetsByBasePathAndBatch.set(target.basePath, targetsByBatch);
			}
			const batchId = this.#usageBatchByToolCallId.get(target.entry.toolCallId);
			const existing = targetsByBatch.get(batchId);
			if (existing) existing.push(target);
			else targetsByBatch.set(batchId, [target]);
		}

		const mergedTargetsByTarget = new Map<ReadDisplayTarget, ReadDisplayTarget[]>();
		for (const [basePath, targetsByBatch] of selectorTargetsByBasePathAndBatch) {
			if (!basePath) continue;
			for (const groupedTargets of targetsByBatch.values()) {
				if (groupedTargets.length <= 1) continue;
				for (const target of groupedTargets) {
					mergedTargetsByTarget.set(target, groupedTargets);
				}
			}
		}

		const emittedMergedTargets = new Set<ReadDisplayTarget[]>();
		const rows: ReadSummaryRow[] = [];
		for (const target of targets) {
			const mergedTargets = mergedTargetsByTarget.get(target);
			if (mergedTargets) {
				if (!emittedMergedTargets.has(mergedTargets)) {
					rows.push({
						targetPath: `${target.basePath}:${formatMergedSelectorParts(
							mergedTargets
								.map(mergedTarget => mergedTarget.selector)
								.filter(selector => selector !== undefined),
						)}`,
						basePath: target.basePath,
						targets: mergedTargets,
					});
					emittedMergedTargets.add(mergedTargets);
				}
				continue;
			}
			rows.push({ targetPath: target.targetPath, basePath: target.basePath, targets: [target] });
		}
		return rows;
	}

	#appendSummaryRow(
		lines: string[],
		row: ReadSummaryRow,
		index: number,
		total: number,
		usageRows: ReadUsageRow[],
	): void {
		const connector = index === total - 1 ? theme.tree.last : theme.tree.branch;
		lines.push(`   ${theme.fg("dim", connector)} ${this.#formatRow(row)}`.trimEnd());
		this.#appendUsageRows(lines, usageRows, this.#summaryContinuation(index, total));
	}

	/** Indent for lines continuing a tree row: the trunk while rows follow, blank under the last. */
	#summaryContinuation(index: number, total: number): string {
		const connector = index === total - 1 ? theme.tree.last : theme.tree.branch;
		const connectorWidth = Bun.stringWidth(connector);
		const continuation =
			index === total - 1
				? " ".repeat(connectorWidth)
				: `${theme.tree.vertical}${" ".repeat(Math.max(0, connectorWidth - Bun.stringWidth(theme.tree.vertical)))}`;
		return `   ${continuation} `;
	}

	#usageRowsBySummaryRow(rows: ReadSummaryRow[]): Map<number, ReadUsageRow[]> {
		const lastRowIndexByToolCallId = new Map<string, number>();
		for (const [index, row] of rows.entries()) {
			for (const target of row.targets) {
				lastRowIndexByToolCallId.set(target.entry.toolCallId, index);
			}
		}

		const usageRowsByIndex = new Map<number, ReadUsageRow[]>();
		for (const usageRow of this.#usageRows.values()) {
			let lastRowIndex: number | undefined;
			for (const toolCallId of usageRow.toolCallIds) {
				const index = lastRowIndexByToolCallId.get(toolCallId);
				if (index !== undefined && (lastRowIndex === undefined || index > lastRowIndex)) {
					lastRowIndex = index;
				}
			}
			if (lastRowIndex === undefined) continue;
			const usageRows = usageRowsByIndex.get(lastRowIndex);
			if (usageRows) usageRows.push(usageRow);
			else usageRowsByIndex.set(lastRowIndex, [usageRow]);
		}
		return usageRowsByIndex;
	}

	#appendUsageRows(lines: string[], usageRows: ReadUsageRow[], prefix: string): void {
		for (const usageRow of usageRows) {
			lines.push(
				theme.fg(
					"dim",
					`${prefix}${formatUsageRow(usageRow.usage, usageRow.durationMs, usageRow.ttftMs, usageRow.timestamp, usageRow.turnElapsedMs)}`,
				),
			);
		}
	}

	#formatRow(row: ReadSummaryRow): string {
		const status = this.#statusForTargets(row.targets);
		const statusPrefix = status === "success" ? "" : `${this.#formatStatus(status)} `;
		return `${statusPrefix}${this.#formatRowPath(row)}`;
	}

	#formatRowPath(row: ReadSummaryRow): string {
		return this.#formatPathValue(row.targetPath, {
			correctedFrom: this.#correctedFromForTargets(row.targets),
			conflictCount: this.#conflictCountForTargets(row.targets),
			line: firstSelectorLineForTargets(row.targets),
			linkPath: linkPathForTargets(row.targets),
		});
	}

	#statusForTargets(targets: ReadDisplayTarget[]): ReadEntry["status"] {
		let status: ReadEntry["status"] = "success";
		for (const target of targets) {
			if (READ_STATUS_RANK[target.entry.status] > READ_STATUS_RANK[status]) {
				status = target.entry.status;
			}
		}
		return status;
	}

	#correctedFromForTargets(targets: ReadDisplayTarget[]): string | undefined {
		for (const target of targets) {
			if (target.entry.correctedFrom) return target.entry.correctedFrom;
		}
		return undefined;
	}

	#conflictCountForTargets(targets: ReadDisplayTarget[]): number | undefined {
		let conflictCount = 0;
		for (const target of targets) {
			if (target.entry.conflictCount && target.entry.conflictCount > conflictCount) {
				conflictCount = target.entry.conflictCount;
			}
		}
		return conflictCount > 0 ? conflictCount : undefined;
	}

	#previewEntriesForRow(row: ReadSummaryRow): ReadEntry[] {
		const entries: ReadEntry[] = [];
		const seen = new Set<string>();
		for (const target of row.targets) {
			if (seen.has(target.entry.toolCallId) || !this.#shouldRenderPreview(target.entry)) continue;
			entries.push(target.entry);
			seen.add(target.entry.toolCallId);
		}
		return entries;
	}

	#shouldRenderPreviewRow(row: ReadSummaryRow): boolean {
		return this.#previewEntriesForRow(row).length > 0;
	}

	#formatPathValue(
		value: string,
		options: { correctedFrom?: string; conflictCount?: number; line?: number; linkPath?: string } = {},
	): string {
		const split = splitPathAndSel(value);
		const selectorSuffix = split.sel ? `:${split.sel}` : "";
		const baseValue = split.sel ? split.path : value;
		const filePath = shortenPath(baseValue);
		let pathDisplay = filePath ? theme.fg("accent", filePath) : theme.fg("toolOutput", "…");
		if (filePath && options.linkPath) {
			const linkOptions = options.line !== undefined ? { line: options.line } : undefined;
			pathDisplay = fileHyperlink(options.linkPath, pathDisplay, linkOptions);
		}
		if (selectorSuffix) {
			pathDisplay += theme.fg("accent", selectorSuffix);
		}
		if (options.correctedFrom) {
			pathDisplay += theme.fg("dim", ` (corrected from ${shortenPath(options.correctedFrom)})`);
		}
		pathDisplay += this.#formatConflictBadge(options.conflictCount);
		return pathDisplay;
	}

	#formatConflictBadge(conflictCount: number | undefined): string {
		if (!conflictCount || conflictCount <= 0) return "";
		const n = conflictCount;
		return ` ${theme.fg("warning", `(⚠ ${n} conflict${n === 1 ? "" : "s"})`)}`;
	}

	/**
	 * Add a code-cell (or Markdown-cell) content preview below the entry summary.
	 * When collapsed: shows first COLLAPSED_PREVIEW_LINES lines with a "… N more lines ⟨<key>: Expand⟩" hint.
	 * When expanded: shows full content.
	 */
	#addContentPreview(entry: ReadEntry): void {
		const split = splitPathAndSel(entry.path);
		const lang = getLanguageFromPath(split.path);
		const pathValue = shortenPath(entry.path);
		const pathDisplay = pathValue
			? this.#formatPathValue(entry.path, {
					correctedFrom: entry.correctedFrom,
					conflictCount: entry.conflictCount,
					line: firstSelectorLine(split.sel),
					linkPath: readTargetLinkPath(split.path, entry.linkPath),
				})
			: "";
		const title = pathDisplay ? `Read ${pathDisplay}` : "Read";
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		const dropCache = () => {
			cachedWidth = undefined;
			cachedLines = undefined;
		};
		const expanded = this.#expanded;
		const component: Component = {
			render: (width: number) => {
				if (cachedLines && cachedWidth === width) return cachedLines;
				const status = entry.status === "success" ? "complete" : entry.status;
				cachedLines = previewsMarkdown(entry)
					? renderMarkdownCell(
							{
								content: entry.contentText ?? "",
								title,
								status,
								expanded,
								contentMaxLines: COLLAPSED_PREVIEW_LINES,
								width,
							},
							theme,
						)
					: renderCodeCell(
							{
								code: entry.contentText ?? "",
								language: lang,
								title,
								status,
								expanded,
								codeMaxLines: expanded ? undefined : COLLAPSED_PREVIEW_LINES,
								codeStartLine: entry.codeStartLine,
								codeLineNumbers: entry.codeLineNumbers,
								width,
							},
							theme,
						);
				cachedWidth = width;
				return cachedLines;
			},
			invalidate: dropCache,
			releaseRenderCaches: dropCache,
		};
		this.addChild(component);
	}

	#addPreviewUsage(entry: ReadEntry): void {
		const usageRow = this.#usageRows.get(entry.toolCallId);
		if (!usageRow) return;
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					formatUsageRow(
						usageRow.usage,
						usageRow.durationMs,
						usageRow.ttftMs,
						usageRow.timestamp,
						usageRow.turnElapsedMs,
					),
				),
				3,
				0,
			),
		);
	}

	/** Content previews are the setting's numbered code; a raster read's text is only its note, so it has none. */
	#shouldRenderPreview(entry: ReadEntry): boolean {
		return this.#showContentPreview && entry.contentText !== undefined && entry.images.length === 0;
	}

	/** Whether `entry` has visuals shown under its rows: raster reads, or a whole-file SVG while figures are on. */
	#hasVisual(entry: ReadEntry): boolean {
		if (!this.#showImages || entry.status === "error") return false;
		return entry.images.length > 0 || (entry.svgSource !== undefined && svgFigureRendering());
	}

	/** Whether `entry` draws its SVG under its row (a previewed entry draws it inside the preview instead). */
	#hasSvgVisual(entry: ReadEntry): boolean {
		return this.#hasVisual(entry) && entry.images.length === 0 && entry.svgSource !== undefined;
	}

	/**
	 * The visuals under one summary row: each target's own image, then the
	 * row's SVG figure. Targets merged from one call share the entry; each
	 * image and each figure is drawn once.
	 */
	#visualsForRow(row: ReadSummaryRow): Component[] {
		const visuals: Component[] = [];
		const seenImages = new Set<ReadVisualImage>();
		const seenEntries = new Set<string>();
		for (const target of row.targets) {
			const entry = target.entry;
			if (target.image && this.#hasVisual(entry) && !seenImages.has(target.image)) {
				seenImages.add(target.image);
				const visual = this.#imageVisual(entry, target.image);
				if (visual) visuals.push(visual);
			}
			if (seenEntries.has(entry.toolCallId)) continue;
			seenEntries.add(entry.toolCallId);
			if (this.#hasSvgVisual(entry) && !this.#shouldRenderPreview(entry)) {
				const figure = this.#svgVisual(entry);
				if (figure) visuals.push(figure);
			}
		}
		return visuals;
	}

	/** Under a content preview only an SVG figure can hang: previewed entries have no raster. */
	#addVisual(entry: ReadEntry): void {
		if (!this.#hasSvgVisual(entry)) return;
		const figure = this.#svgVisual(entry);
		if (figure) this.addChild(figure);
	}

	/**
	 * The terminal component drawing one raster: an inline image (on Kitty its
	 * PNG conversion, once landed) or a text marker where the terminal draws no
	 * graphics.
	 */
	#imageVisual(entry: ReadEntry, image: ReadVisualImage): Component | undefined {
		if (!TERMINAL.imageProtocol) {
			const dimensions = getImageDimensions(image.block.data, image.block.mimeType) ?? undefined;
			return new Text(theme.fg("dim", imageFallback(image.block.mimeType, dimensions)), 3, 0);
		}
		const drawable = this.#drawableImage(entry, image);
		if (!drawable) return undefined;
		return new Image(
			drawable.data,
			drawable.mimeType,
			{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
			{
				...resolveImageOptions(),
				budget: this.#ui?.imageBudget,
				imageKey: `read:${entry.toolCallId}:${entry.images.indexOf(image)}`,
				requestRender: () => this.#ui?.requestRender(),
			},
		);
	}

	/** The entry's SVG figure, created once and fed the final source; nothing where the terminal draws no graphics. */
	#svgVisual(entry: ReadEntry): Component | undefined {
		if (!TERMINAL.imageProtocol) return undefined;
		let figure = entry.figure;
		if (!figure) {
			figure = entry.figure = new SvgFigure({
				budget: this.#ui?.imageBudget,
				maxRows: () => resolveImageOptions().maxHeightCells,
				onChange: () => {
					this.#blockVersion++;
					this.#ui?.requestRender();
				},
			});
		}
		figure.update(entry.svgSource ?? "", true);
		return figure;
	}

	/**
	 * The raster to draw on this terminal: the block as delivered, or on Kitty
	 * (PNG only) a non-PNG's shared conversion — started here when absent and
	 * pinned on the image once it lands, which rebuilds the display.
	 */
	#drawableImage(entry: ReadEntry, image: ReadVisualImage): ImageContent | undefined {
		const block = image.block;
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty || block.mimeType === "image/png") return block;
		image.kittyPng ??= cachedPngConversion(block);
		if (image.kittyPng || image.kittyPending) return image.kittyPng;
		image.kittyPending = true;
		convertImageToPngShared(block)
			.then(converted => {
				image.kittyPending = false;
				if (!entry.images.includes(image)) return;
				image.kittyPng = converted;
				this.#blockVersion++;
				this.#updateDisplay();
				this.#ui?.requestRender();
			})
			.catch(() => {
				image.kittyPending = false;
			});
		return undefined;
	}

	#formatStatus(status: ReadEntry["status"]): string {
		if (status === "success") {
			return theme.fg("text", theme.status.enabled);
		}
		if (status === "warning") {
			return theme.fg("warning", theme.status.warning);
		}
		if (status === "error") {
			return theme.fg("error", theme.status.error);
		}
		return theme.fg("dim", theme.status.pending);
	}
}
