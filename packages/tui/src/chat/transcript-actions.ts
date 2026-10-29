/**
 * Pointer actions on transcript blocks in a native terminal (a user message's
 * hover toolbar, an error frame's action row). Blocks describe the controls;
 * the interactive host registers the one handler that runs omp's existing
 * commands for them, so a click and the key binding take the same path.
 */
export type TranscriptAction =
	/** Retry the last failed turn (`app.retry`). */
	| { readonly act: "retry" }
	/** Open the temporary model picker (`app.model.selectTemporary`). */
	| { readonly act: "switch-model" }
	/** Open the transcript rewind selector. */
	| { readonly act: "rewind" }
	/** Resume the session stored at `path` (a welcome card's recent session). */
	| { readonly act: "resume"; readonly path: string }
	/** Put `text` on the clipboard. */
	| { readonly act: "copy"; readonly text: string };

export interface TranscriptActionOptions {
	/** Suppress successful copy feedback without hiding failures. */
	readonly quiet?: boolean;
}

type Handler = (action: TranscriptAction, options?: TranscriptActionOptions) => void;

let handler: Handler | undefined;

/** Register (or clear, with `undefined`) the host's handler. */
export function setTranscriptActionHandler(next: Handler | undefined): void {
	handler = next;
}

/** Run `action` through the host; false when no host handles actions. */
export function runTranscriptAction(action: TranscriptAction, options?: TranscriptActionOptions): boolean {
	if (!handler) return false;
	handler(action, options);
	return true;
}

/** Whether a host handles actions (controls are only described when one does). */
export function hasTranscriptActions(): boolean {
	return handler !== undefined;
}

let transcriptMouse = false;

/**
 * Enable the host's transcript pointer layer in classic terminals: drag
 * selection, wheel browsing, and the inline table copy controls. Off unless the
 * user opts in, because terminal mouse reporting takes native selection and
 * scrollback away from the terminal.
 */
export function setTranscriptMouseEnabled(enabled: boolean): void {
	transcriptMouse = enabled;
}

/** Whether the host routes transcript pointer gestures in classic terminals. */
export function isTranscriptMouseEnabled(): boolean {
	return transcriptMouse;
}
