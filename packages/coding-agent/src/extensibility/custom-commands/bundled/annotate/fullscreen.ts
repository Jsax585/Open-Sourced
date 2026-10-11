import type { BunFile } from "bun";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { TUI } from "@oh-my-pi/pi-tui";
import { AnnotationOverlay } from "@oh-my-pi/pi-tui/overlays/annotation-overlay";
import type {
	CodeReviewOverlayResult,
	TextReviewOverlayResult,
	TextReviewSource,
	TextReviewSourceProvenance,
} from "@oh-my-pi/pi-tui/overlays/annotation-types";
import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import {
	sanitizeDisplayWarning,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "@oh-my-pi/pi-tui/render/render-utils";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { CustomCommandContext } from "../../../../extensibility/custom-commands/types";
import { getEditorCommand, openEditorOnPath, openInEditor } from "../../../../utils/external-editor";
import type { ResolvedReviewTarget } from "../review/target";

/** What the overlay host reads: the UI surface plus the live session cwd for editor paths. */
export type AnnotationOverlayContext = Pick<CustomCommandContext, "ui" | "cwd" | "sessionManager">;

const ANNOTATION_OVERLAY_OPTIONS = {
	width: "100%",
	maxHeight: "100%",
	margin: 0,
	fullscreen: true,
	mouseTracking: false,
} as const;

const MISSING_EDITOR = "Set $VISUAL or $EDITOR to edit in an external editor.";

function notificationText(message: string): string {
	return truncateToWidth(sanitizeDisplayWarning(message), TRUNCATE_LENGTHS.LINE);
}

function displayPathLabel(filePath: string): string {
	const sanitized = sanitizeDisplayLine(filePath);
	const shortened = shortenPath(sanitized);
	return truncateToWidth(shortened, TRUNCATE_LENGTHS.TITLE);
}

function requireEditor(): string {
	const editor = getEditorCommand();
	if (!editor) throw new Error(MISSING_EDITOR);
	return editor;
}

async function requireRegularFile(filePath: string, label: string, context = ""): Promise<BunFile> {
	const suffix = context ? ` ${context}` : "";
	const file = Bun.file(filePath);
	try {
		if (!(await file.stat()).isFile()) throw new Error(`${label} is not a regular file.${suffix}`);
	} catch (error) {
		if (isEnoent(error)) throw new Error(`${label} is not on disk.${suffix}`);
		throw error;
	}
	return file;
}

async function editAnnotationDraft(tui: TUI, draft: string, commit: (text: string | null) => void): Promise<void> {
	const editor = requireEditor();
	tui.stop();
	try {
		commit(await openInEditor(editor, draft, { extension: ".md" }));
	} finally {
		tui.start();
		tui.requestRender(true);
	}
}

/**
 * Only sources whose full text reaches the prompt may be edited: a file (written back in
 * place) or a typed prompt. Session messages are omitted or summarized in the prompt, so
 * notes on edited session text would quote lines the model never sees.
 */
type EditableProvenance = Extract<TextReviewSourceProvenance, { kind: "file" } | { kind: "prompt" }>;

async function refreshFileSource(source: TextReviewSource): Promise<TextReviewSource | undefined> {
	const filePath = source.provenance?.kind === "file" ? source.provenance.path : source.editorFilePath;
	if (!filePath) return undefined;
	const file = await requireRegularFile(filePath, filePath);
	const text = await file.text();
	return {
		...source,
		kind: "file",
		label: displayPathLabel(filePath),
		text,
		provenance: { kind: "file", path: filePath },
		editorFilePath: filePath,
	};
}

async function editTextSource(
	tui: TUI,
	ctx: AnnotationOverlayContext,
	overlay: AnnotationOverlay,
	provenance: EditableProvenance,
): Promise<void> {
	const editor = requireEditor();
	const current = overlay.textSourceText() ?? "";
	if (provenance.kind === "file") await requireRegularFile(provenance.path, provenance.path);

	tui.stop();
	let next: string | null;
	let exitCode = 0;
	try {
		if (provenance.kind === "file") {
			exitCode = await openEditorOnPath(editor, provenance.path);
			next = await Bun.file(provenance.path).text();
		} else {
			next = await openInEditor(editor, current, { extension: ".txt", trimTrailingNewline: false });
		}
	} finally {
		tui.start();
		tui.requestRender(true);
	}
	if (exitCode !== 0) {
		ctx.ui.notify(notificationText(`Editor exited with code ${exitCode}; using what it saved.`), "warning");
	}
	if (next !== null && next !== current) overlay.replaceTextSource(next);
}

async function editReviewedFile(
	tui: TUI,
	ctx: AnnotationOverlayContext,
	overlay: AnnotationOverlay,
	target: ResolvedReviewTarget,
): Promise<void> {
	const relative = overlay.reviewFilePath();
	if (!relative) throw new Error("No file to open.");
	const editor = requireEditor();
	// Diff paths are repository-relative and exact, so resolve them from the repo root, not the session cwd.
	const cwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd;
	const absolute = path.resolve(vcs.repo(cwd)?.root() ?? cwd, relative);
	const sourceNotice = target.refresh
		? "The review diff stays at this snapshot until you press r to refresh it."
		: "The captured review diff remains unchanged.";
	if (!(await Bun.file(absolute).exists())) {
		throw new Error(`${displayPathLabel(relative)} is not on disk. ${sourceNotice}`);
	}
	tui.stop();
	let exitCode: number;
	try {
		exitCode = await openEditorOnPath(editor, absolute);
	} finally {
		tui.start();
		tui.requestRender(true);
	}
	if (exitCode !== 0) ctx.ui.notify(notificationText(`Editor exited with code ${exitCode}.`), "warning");
	ctx.ui.notify(notificationText(`Opened ${displayPathLabel(relative)}. ${sourceNotice}`), "info");
}

/** Mount a diff in the TUI annotation surface; refreshing a live source is explicit. */
export function showCodeReviewOverlay(
	ctx: AnnotationOverlayContext,
	target: ResolvedReviewTarget,
): Promise<CodeReviewOverlayResult | undefined> {
	const refreshTarget = target.refresh;
	return ctx.ui.custom<CodeReviewOverlayResult | undefined>(
		(tui, theme, keybindings, done) => {
			const overlay: AnnotationOverlay = new AnnotationOverlay(
				tui,
				theme,
				keybindings,
				target.snapshot.files,
				target.mode,
				{
					onComplete: done,
					onWarning: message => ctx.ui.notify(notificationText(message), "warning"),
					onRefreshDiff: refreshTarget
						? async () => {
								const refreshed = await refreshTarget();
								return { rawDiff: refreshed.rawDiff, files: refreshed.snapshot.files };
							}
						: undefined,
					onAnnotationExternalEditor: (draft, commit) => editAnnotationDraft(tui, draft, commit),
					// PR and caller-supplied diffs need not match the local checkout, so only local reviews open the working-tree file.
					onExternalEditor:
						target.kind === "pr" || target.kind === "patch"
							? undefined
							: () => editReviewedFile(tui, ctx, overlay, target),
				},
			);
			return overlay;
		},
		{ overlay: true, overlayOptions: ANNOTATION_OVERLAY_OPTIONS },
	);
}

/** Mount a text source; file-backed sources refresh only on explicit `r`. */
export function showTextReviewOverlay(
	ctx: AnnotationOverlayContext,
	source: TextReviewSource,
): Promise<TextReviewOverlayResult | undefined> {
	return ctx.ui.custom<TextReviewOverlayResult | undefined>(
		(tui, theme, keybindings, done) => {
			let currentSource: TextReviewSource = { ...source };
			const hasFileSource = Boolean(
				source.provenance?.kind === "file" ? source.provenance.path : source.editorFilePath,
			);
			// Ctrl+G eligibility is fixed to the original prompt/file source; associated-file provenance enables only `r`.
			const canOpenSourceEditor = source.provenance?.kind === "file" || source.provenance?.kind === "prompt";
			const refreshSource = hasFileSource
				? async () => {
						const refreshed = await refreshFileSource(currentSource);
						if (refreshed) currentSource = refreshed;
						return refreshed;
					}
				: undefined;
			const openSourceEditor = canOpenSourceEditor
				? () => {
						const provenance = currentSource.provenance;
						if (provenance?.kind === "file" || provenance?.kind === "prompt") {
							return editTextSource(tui, ctx, overlay, provenance);
						}
					}
				: undefined;
			const overlay: AnnotationOverlay = new AnnotationOverlay(tui, theme, keybindings, source, {
				onComplete: done,
				onWarning: message => ctx.ui.notify(notificationText(message), "warning"),
				onAnnotationExternalEditor: (draft, commit) => editAnnotationDraft(tui, draft, commit),
				onExternalEditor: openSourceEditor,
				onRefreshSource: refreshSource,
			});
			return overlay;
		},
		{ overlay: true, overlayOptions: ANNOTATION_OVERLAY_OPTIONS },
	);
}
