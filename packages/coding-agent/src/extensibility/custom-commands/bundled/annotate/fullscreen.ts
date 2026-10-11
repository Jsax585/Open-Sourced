import type { BunFile } from "bun";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { OverlayHandle, TUI } from "@oh-my-pi/pi-tui";
import { AnnotationOverlay } from "@oh-my-pi/pi-tui/overlays/annotation-overlay";
import { classifyTerminalMultiplexer, hasTerminalMultiplexerSession } from "@oh-my-pi/pi-tui/terminal-multiplexer";
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
import { isEnoent, pathIsWithin } from "@oh-my-pi/pi-utils";
import type { CustomCommandContext } from "../../../../extensibility/custom-commands/types";
import { createDefaultTerminalLaunchRequest, getTerminalLaunchPlacement } from "../../../../subprocess/terminal-launch";
import {
	getEditorCommand,
	openEditorOnPath,
	openInEditor,
	resolveEditorSpawnCommand,
} from "../../../../utils/external-editor";
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

// Pane launches are detached, so keep the overlay live and the captured source unchanged.
type PaneEditorLaunch = "opened" | "fallback" | "cancelled";

async function openFileInPane(
	ctx: AnnotationOverlayContext,
	editor: string,
	filePath: string,
	label: string,
	sourceNotice: string,
	overlayHandle?: OverlayHandle,
): Promise<PaneEditorLaunch> {
	const openTerminal = ctx.ui.openTerminal;
	if (!openTerminal) return "fallback";
	const safeLabel = displayPathLabel(label);

	const multiplexer = classifyTerminalMultiplexer(process.env);
	const placementInfo = getTerminalLaunchPlacement(multiplexer, "pane");
	if ("error" in placementInfo) return "fallback";
	// Classification may survive a stripped environment; provider-owned target
	// metadata distinguishes a runnable default launch from a local-editor fallback.
	const defaultTargetEnvs = placementInfo.defaultTargetEnvs;
	if (
		defaultTargetEnvs &&
		(!hasTerminalMultiplexerSession(placementInfo.multiplexer, process.env) ||
			!defaultTargetEnvs.some(key => Boolean(process.env[key]?.trim())))
	) {
		return "fallback";
	}

	if (placementInfo.shellGrammar === "posix") {
		const wasHidden = overlayHandle?.isHidden() ?? false;
		let confirmed: boolean;
		try {
			if (!wasHidden) overlayHandle?.setHidden(true);
			confirmed = await ctx.ui.confirm(
				"Confirm destination shell compatibility",
				"This editor command uses POSIX shell syntax. Continue only if the destination's configured interactive shell accepts POSIX syntax; this cannot be inferred from the current terminal.",
			);
		} finally {
			if (overlayHandle && !wasHidden) overlayHandle.setHidden(false);
		}
		if (!confirmed) {
			ctx.ui.notify(
				notificationText(
					"Editor launch cancelled: POSIX shell compatibility was not confirmed for the destination.",
				),
				"warning",
			);
			return "cancelled";
		}
	}

	const spawnCommand = resolveEditorSpawnCommand(editor, filePath);
	const cwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd;
	const launchPlan = createDefaultTerminalLaunchRequest(
		multiplexer,
		"pane",
		spawnCommand.cmd,
		cwd,
		placementInfo.shellGrammar,
	);
	if ("error" in launchPlan) throw new Error(launchPlan.error);

	const result = await openTerminal.call(ctx.ui, launchPlan.request);
	if (result.warning) {
		ctx.ui.notify(
			notificationText(`Opened ${safeLabel} in ${placementInfo.displayName}, but ${result.warning} ${sourceNotice}`),
			"warning",
		);
	} else {
		ctx.ui.notify(
			notificationText(
				`Opened ${safeLabel} in a new ${placementInfo.placementLabel} in ${placementInfo.displayName}. ${sourceNotice}`,
			),
			"info",
		);
	}
	return "opened";
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
	overlayHandle?: OverlayHandle,
): Promise<void> {
	const editor = requireEditor();
	const current = overlay.textSourceText() ?? "";
	if (provenance.kind === "file") {
		await requireRegularFile(provenance.path, provenance.path);
		const paneLaunch = await openFileInPane(
			ctx,
			editor,
			provenance.path,
			provenance.path,
			"The file-backed annotation source stays at this snapshot until you press r to reread it.",
			overlayHandle,
		);
		if (paneLaunch !== "fallback") return;
	}

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

async function openAssociatedFile(
	tui: TUI,
	ctx: AnnotationOverlayContext,
	filePath: string,
	label: string,
	overlayHandle?: OverlayHandle,
): Promise<void> {
	const editor = requireEditor();
	await requireRegularFile(filePath, label);
	const sourceNotice = "The selected source stays at this snapshot until you press r to reread its associated file.";
	const paneLaunch = await openFileInPane(ctx, editor, filePath, label, sourceNotice, overlayHandle);
	if (paneLaunch !== "fallback") return;

	tui.stop();
	let exitCode: number;
	try {
		exitCode = await openEditorOnPath(editor, filePath);
	} finally {
		tui.start();
		tui.requestRender(true);
	}
	if (exitCode !== 0) ctx.ui.notify(notificationText(`Editor exited with code ${exitCode}.`), "warning");
	ctx.ui.notify(notificationText(`Opened ${displayPathLabel(label)}. ${sourceNotice}`), "info");
}

async function editReviewedFile(
	tui: TUI,
	ctx: AnnotationOverlayContext,
	overlay: AnnotationOverlay,
	target: ResolvedReviewTarget,
	overlayHandle?: OverlayHandle,
): Promise<void> {
	const relative = overlay.reviewFilePath();
	if (!relative) throw new Error("No file to open.");
	const editor = requireEditor();
	// External diff paths are only opened when they identify a repository-relative local counterpart.
	const cwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd;
	const repositoryRoot = path.resolve(vcs.repo(cwd)?.root() ?? cwd);
	const sourceNotice = target.refresh
		? "The review diff stays at this snapshot until you press r to refresh it."
		: "The captured review diff remains unchanged.";
	const absolute = path.resolve(repositoryRoot, relative);
	if (path.isAbsolute(relative) || !pathIsWithin(repositoryRoot, absolute)) {
		ctx.ui.notify(
			notificationText(
				`${displayPathLabel(relative)} is not a repository-relative path inside the local checkout. ${sourceNotice}`,
			),
			"warning",
		);
		return;
	}
	try {
		await requireRegularFile(absolute, relative);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(notificationText(`${detail} ${sourceNotice}`), "warning");
		return;
	}
	const paneLaunch = await openFileInPane(ctx, editor, absolute, relative, sourceNotice, overlayHandle);
	if (paneLaunch !== "fallback") return;

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
	let overlayHandle: OverlayHandle | undefined;
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
					// The fetched/supplied diff remains the review source; Ctrl+G only opens its local counterpart.
					onExternalEditor: () => editReviewedFile(tui, ctx, overlay, target, overlayHandle),
				},
			);
			return overlay;
		},
		{
			overlay: true,
			overlayOptions: ANNOTATION_OVERLAY_OPTIONS,
			onHandle: handle => {
				overlayHandle = handle;
			},
		},
	);
}

/** Mount a text source; file-backed sources refresh only on explicit `r`. */
export function showTextReviewOverlay(
	ctx: AnnotationOverlayContext,
	source: TextReviewSource,
): Promise<TextReviewOverlayResult | undefined> {
	let overlayHandle: OverlayHandle | undefined;
	return ctx.ui.custom<TextReviewOverlayResult | undefined>(
		(tui, theme, keybindings, done) => {
			let currentSource: TextReviewSource = { ...source };
			const hasFileSource = Boolean(
				source.provenance?.kind === "file" ? source.provenance.path : source.editorFilePath,
			);
			const canOpenSourceEditor = hasFileSource || source.provenance?.kind === "prompt";
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
							return editTextSource(tui, ctx, overlay, provenance, overlayHandle);
						}
						const filePath = currentSource.editorFilePath;
						if (filePath) return openAssociatedFile(tui, ctx, filePath, filePath, overlayHandle);
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
		{
			overlay: true,
			overlayOptions: ANNOTATION_OVERLAY_OPTIONS,
			onHandle: handle => {
				overlayHandle = handle;
			},
		},
	);
}
