import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { TUI } from "@oh-my-pi/pi-tui";
import { AnnotationOverlay } from "@oh-my-pi/pi-tui/overlays/annotation-overlay";
import type { CustomCommandContext } from "../../../../extensibility/custom-commands/types";
import type {
	CodeReviewOverlayResult,
	TextReviewOverlayResult,
	TextReviewSource,
	TextReviewSourceProvenance,
} from "@oh-my-pi/pi-tui/overlays/annotation-types";
import type { ResolvedReviewTarget } from "../review/target";
import { getEditorCommand, openEditorOnPath, openInEditor } from "../../../../utils/external-editor";
import {
	AnnotationDraftStore,
	annotationDraftKey,
	type AnnotationDraftRecord,
	type AnnotationDraftSource,
} from "./draft-store";
import type { AnnotationOverlayDraft } from "@oh-my-pi/pi-tui/overlays/annotation-types";
import { postmortem } from "@oh-my-pi/pi-utils";

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

function requireEditor(): string {
	const editor = getEditorCommand();
	if (!editor) throw new Error(MISSING_EDITOR);
	return editor;
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

async function editTextSource(
	tui: TUI,
	ctx: AnnotationOverlayContext,
	overlay: AnnotationOverlay,
	provenance: EditableProvenance,
): Promise<void> {
	const editor = requireEditor();
	const current = overlay.textSourceText() ?? "";
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
	if (exitCode !== 0) ctx.ui.notify(`Editor exited with code ${exitCode}; using what it saved.`, "warning");
	if (next === null || next === current) return;
	const dropped = overlay.replaceTextSource(next);
	if (dropped > 0) {
		ctx.ui.notify(
			dropped === 1
				? "Dropped 1 line note that no longer matches the edited text."
				: `Dropped ${dropped} line notes that no longer match the edited text.`,
			"warning",
		);
	}
}

async function editReviewedFile(
	tui: TUI,
	ctx: AnnotationOverlayContext,
	overlay: AnnotationOverlay,
	savedCwd: string,
): Promise<void> {
	const relative = overlay.reviewFilePath();
	if (!relative) throw new Error("No file to open.");
	const editor = requireEditor();
	const cwd = savedCwd;
	const absolute = path.resolve(vcs.repo(cwd)?.root() ?? cwd, relative);
	if (!(await Bun.file(absolute).exists())) {
		throw new Error(`${relative} is not on disk. The review still uses the frozen diff.`);
	}
	tui.stop();
	let exitCode: number;
	try {
		exitCode = await openEditorOnPath(editor, absolute);
	} finally {
		tui.start();
		tui.requestRender(true);
	}
	if (exitCode !== 0) ctx.ui.notify(`Editor exited with code ${exitCode}.`, "warning");
	ctx.ui.notify(`Opened ${relative}. The review still uses the frozen diff.`, "info");
}

type HostCallbacks = {
	onComplete(value: CodeReviewOverlayResult | TextReviewOverlayResult | undefined): Promise<void>;
	onDraftChange(state: AnnotationOverlayDraft): void;
	onDiscard(): Promise<void>;
	onWarning(message: string): void;
	onAnnotationExternalEditor(draft: string, commit: (text: string | null) => void): Promise<void>;
};

type OverlayTheme = ConstructorParameters<typeof AnnotationOverlay>[1];
type OverlayKeybindings = ConstructorParameters<typeof AnnotationOverlay>[2];
async function runOverlayHost(
	ctx: AnnotationOverlayContext,
	source: AnnotationDraftSource,
	draft: AnnotationDraftRecord | undefined,
	mount: (
		tui: TUI,
		theme: OverlayTheme,
		keybindings: OverlayKeybindings,
		callbacks: HostCallbacks,
		draft: AnnotationDraftRecord | undefined,
		source: AnnotationDraftSource,
	) => AnnotationOverlay,
): Promise<
	| {
			result: CodeReviewOverlayResult | TextReviewOverlayResult | undefined;
			source: AnnotationDraftSource;
			complete(): Promise<void>;
	  }
	| undefined
> {
	const sessionId = ctx.sessionManager.getSessionId();
	const artifactsDir = ctx.sessionManager.getArtifactsDir();
	const store = await AnnotationDraftStore.open(artifactsDir, sessionId, () => ctx.sessionManager.ensureOnDisk());
	let resumed = draft ?? store.find(source);
	if (resumed && !draft) ctx.ui.notify("Restored the matching annotation draft.", "info");
	const key = resumed?.key ?? annotationDraftKey(source);
	const unregister = postmortem.register(`annotation-draft:${sessionId}:${key}`, () => store.flush());
	try {
		await store.claim(key);
		resumed = store.list().find(item => item.key === key);
		const frozenSource = resumed?.source ?? source;
		let record = resumed;
		const result = await ctx.ui.custom<CodeReviewOverlayResult | TextReviewOverlayResult | undefined>(
			(tui, theme, keybindings, done) => {
				const callbacks: HostCallbacks = {
					onComplete: async value => {
						await store.flush();
						done(value);
					},
					onDraftChange: state => {
						if (
							!record &&
							!state.annotations.length &&
							!state.editor?.text &&
							!(state.kind === "text" && state.editedText !== undefined)
						)
							return;
						record = {
							version: 1,
							sessionId,
							key,
							createdAt: record?.createdAt ?? Date.now(),
							updatedAt: Date.now(),
							source: frozenSource,
							state,
						};
						store.checkpoint(record);
					},
					onDiscard: async () => {
						await store.discard(key);
						done(undefined);
					},
					onWarning: message => ctx.ui.notify(message, "warning"),
					onAnnotationExternalEditor: (text, commit) => editAnnotationDraft(tui, text, commit),
				};
				const overlay = mount(tui, theme, keybindings, callbacks, resumed, frozenSource);
				if (resumed) overlay.restoreDraft(resumed.state);
				return overlay;
			},
			{ overlay: true, overlayOptions: ANNOTATION_OVERLAY_OPTIONS },
		);
		if (!result) return undefined;
		const revision = store.revision(key);
		return {
			result,
			source: frozenSource,
			complete: async () => {
				if (!revision) return;
				try {
					await store.remove(key, revision);
				} catch (error) {
					ctx.ui.notify(`Could not remove completed annotation draft: ${String(error)}`, "warning");
				}
			},
		};
	} finally {
		unregister();
		await store
			.dispose()
			.catch(error => ctx.ui.notify(`Could not save annotation draft: ${String(error)}`, "warning"));
	}
}

export interface CodeAnnotationRun {
	result: CodeReviewOverlayResult;
	target: ResolvedReviewTarget;
	focus?: string;
	complete(): Promise<void>;
}

export interface TextAnnotationRun {
	result: TextReviewOverlayResult;
	source: TextReviewSource;
	complete(): Promise<void>;
}

export async function showCodeReviewOverlay(
	ctx: AnnotationOverlayContext,
	target: ResolvedReviewTarget,
	focus?: string,
	draft?: AnnotationDraftRecord,
): Promise<CodeAnnotationRun | undefined> {
	const host = await runOverlayHost(
		ctx,
		{ kind: "diff", cwd: ctx.cwd, target, ...(focus === undefined ? {} : { focus }) },
		draft,
		(tui, theme, keybindings, callbacks, activeDraft, frozenSource) => {
			const frozenTarget = activeDraft?.source.kind === "diff" ? activeDraft.source.target : target;
			const overlay = new AnnotationOverlay(
				tui,
				theme,
				keybindings,
				frozenTarget.snapshot.files,
				frozenTarget.mode,
				{
					...callbacks,
					onExternalEditor:
						frozenTarget.kind === "pr" || frozenTarget.kind === "patch"
							? undefined
							: () => editReviewedFile(tui, ctx, overlay, frozenSource.cwd),
				},
			);
			return overlay;
		},
	);
	if (!host || host.source.kind !== "diff" || !host.result) return undefined;
	return {
		result: host.result as CodeReviewOverlayResult,
		target: host.source.target,
		focus: host.source.focus,
		complete: host.complete,
	};
}

export async function showTextReviewOverlay(
	ctx: AnnotationOverlayContext,
	source: TextReviewSource,
	draft?: AnnotationDraftRecord,
): Promise<TextAnnotationRun | undefined> {
	const host = await runOverlayHost(
		ctx,
		{ kind: "text", cwd: ctx.cwd, source },
		draft,
		(tui, theme, keybindings, callbacks, activeDraft) => {
			const restoredSource = activeDraft?.source.kind === "text" ? activeDraft.source.source : source;
			const provenance = restoredSource.provenance;
			const editable = provenance?.kind === "file" || provenance?.kind === "prompt" ? provenance : undefined;
			const overlay = new AnnotationOverlay(tui, theme, keybindings, restoredSource, {
				...callbacks,
				onExternalEditor: editable ? () => editTextSource(tui, ctx, overlay, editable) : undefined,
			});
			return overlay;
		},
	);
	if (!host || host.source.kind !== "text" || !host.result) return undefined;
	return {
		result: host.result as TextReviewOverlayResult,
		source: host.source.source,
		complete: host.complete,
	};
}
