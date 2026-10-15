/**
 * Tool-approval prompt in the composer's place, presented like the ask
 * dialog: the approval title and its details over an action bar. Approving
 * takes a deliberate chord (`app.approval.approve`, Ctrl+Enter by default),
 * so an Enter typed for the composer as the prompt appears never approves a
 * call, and the chord itself only arms {@link APPROVE_ARM_MS} after mount: it
 * is also the follow-up key, pressed mid-run exactly when prompts appear.
 * Esc denies. With an {@link ApprovalDialogDraft}, every other key edits the
 * composer mounted beneath the dialog, so a message can steer the turn while
 * the call waits; an empty composer ignores Enter and arrows scroll the details.
 * The prompt stays a few rows so the composer keeps its room; with a full
 * prompt, the expand key (`app.tools.expand`) swaps it in, wrapped.
 */
import { type Component, Ellipsis, ScrollView, type TUI, truncateToWidth, wrapTextWithAnsi } from "../index";
import { formatKeyHint, formatKeyHints, formatTooltipKey } from "../app-keybindings";
import { OverlayPanel, PanelDivider, PanelRows } from "../chrome/overlay-box";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import { getKeybindings } from "../keybindings";
import { isNativeRendering } from "../native/state";
import {
	appAlwaysApproveFolderKeys,
	appAlwaysApproveKeys,
	appApproveFolderKeys,
	appApproveKeys,
	appToolsExpandKey,
	matchesAppAlwaysApprove,
	matchesAppAlwaysApproveFolder,
	matchesAppApprove,
	matchesAppApproveFolder,
	matchesAppToolsExpand,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { col, node } from "../native/describe";
import type { NativeNode, NativeUiEvent } from "../native/node";
import { actionBar, actionButton } from "../native/overlay";
import { PREVIEW_LIMITS, sanitizeDisplayLines } from "../render/render-utils";
import { theme } from "../theme/theme";
import { CountdownTimer } from "../chrome/countdown-timer";

/** Detail rows shown before the rest scrolls, so the composer beneath keeps its room. */
const MAX_DETAIL_ROWS: number = PREVIEW_LIMITS.COLLAPSED_ITEMS;
/** The approve key is ignored this long after mount, so a follow-up sent as the prompt appears cannot approve it. */
export const APPROVE_ARM_MS = 500;

interface ApprovalDialogCallbacks {
	onApprove(): void;
	/** The directory answer; only reachable when the dialog was given a folder label. */
	onApproveFolder?(): void;
	/** The exact, cross-instance answer; only reachable when the call can record a grant. */
	onAlwaysApprove?(): void;
	/** The directory, cross-instance answer; only reachable with a folder label. */
	onAlwaysApproveFolder?(): void;
	onDeny(): void;
}

/** The answers the dock's menu can offer, in display order. */
type ApprovalDialogAnswerId = "approve" | "folder" | "always" | "always-folder" | "deny";

/** Menu rows for the answers this prompt offers. Directory rows name the folder they would grant. */
function approvalDialogAnswers(
	options: ApprovalDialogOptions,
): readonly { id: ApprovalDialogAnswerId; label: string }[] {
	const folder = options.folderLabel;
	const answers: { id: ApprovalDialogAnswerId; label: string }[] = [{ id: "approve", label: "Approve" }];
	if (folder !== undefined) {
		answers.push({ id: "folder", label: `Approve for directory (${folder})` });
	}
	if (options.exactGrant === true) {
		answers.push({ id: "always", label: "Always approve" });
	}
	if (folder !== undefined) {
		answers.push({ id: "always-folder", label: `Always approve for directory (${folder})` });
	}
	answers.push({ id: "deny", label: "Deny" });
	return answers;
}

/** The composer mounted beneath the dialog: it receives every key the dialog does not own. */
export interface ApprovalDialogDraft {
	/** True while the composer holds a draft — text, attachments, or a paste still landing: keys then edit and send it. */
	hasDraft(): boolean;
	handleInput(keyData: string): void;
}

interface ApprovalDialogOptions {
	tui?: TUI;
	/** The prompt with every detail in full, which the expand key swaps in (wrapped) for the summarized one. */
	fullPrompt?: string;
	/** Directory the directory answers grant; enables them (keys and buttons) when set. */
	folderLabel?: string;
	/** Whether the exact, cross-instance "Always approve" answer is offered. */
	exactGrant?: boolean;
	/** Deny once this many ms pass without input (any key restarts the countdown). */
	timeout?: number;
	/** Called when {@link timeout} expires, before the dialog denies. */
	onTimeout?: () => void;
	/** Called when the countdown starts, as the dialog mounts. */
	onTimeoutStart?: () => void;
	/** Called each time a key restarts the countdown. */
	onTimeoutReset?: () => void;
	/** Route typing to the composer instead of dropping it. */
	draft?: ApprovalDialogDraft;
}

/** A prompt's detail rows: every line after the title, trailing blanks dropped. */
function promptDetails(lines: string[]): string[] {
	const details = lines.slice(1);
	while (details.length > 0 && details[details.length - 1]!.trim() === "") details.pop();
	return details;
}

export class ApprovalDialogComponent implements Component {
	readonly #title: string;
	readonly #summary: readonly string[];
	readonly #full: readonly string[] | undefined;
	#expanded = false;
	readonly #panel: OverlayPanel;
	readonly #body = new PanelRows();
	readonly #choices = new PanelRows();
	readonly #footer = new PanelRows();
	/** Answers shown as a navigable menu; index 0 is highlighted on mount. */
	#answers: readonly { id: ApprovalDialogAnswerId; label: string }[] = [];
	#selected = 0;
	#scrollOffset = 0;
	#bodyRows = MAX_DETAIL_ROWS;
	#closed = false;
	#native: NativeNode | undefined;
	readonly #armedAt = performance.now() + APPROVE_ARM_MS;
	readonly #countdown: CountdownTimer | undefined;

	/** `prompt`: the approval title on its first line, the details after it. */
	constructor(
		prompt: string,
		private readonly callbacks: ApprovalDialogCallbacks,
		private readonly options: ApprovalDialogOptions = {},
	) {
		const lines = sanitizeDisplayLines(prompt);
		const title = lines[0] ?? "";
		this.#title = title;
		this.#summary = promptDetails(lines);
		this.#full =
			options.fullPrompt === undefined ? undefined : promptDetails(sanitizeDisplayLines(options.fullPrompt));
		this.#panel = new OverlayPanel(title, "omp.overlay.approval");
		this.#answers = approvalDialogAnswers(options);
		this.#footer.setHeight(1);
		this.#panel.addChild(this.#body);
		this.#choices.setHeight(this.#answers.length);
		this.#panel.addChild(this.#choices);
		this.#panel.addChild(new PanelDivider());
		this.#panel.addChild(this.#footer);
		if (options.timeout && options.timeout > 0) {
			options.onTimeoutStart?.();
			this.#countdown = new CountdownTimer(
				options.timeout,
				options.tui,
				seconds => {
					this.#panel.title = `${title} (${seconds}s)`;
				},
				() => {
					options.onTimeout?.();
					this.#finish("deny");
				},
			);
		}
	}

	invalidate(): void {
		this.#native = undefined;
		this.#panel.invalidate();
	}

	dispose(): void {
		this.#closed = true;
		this.#countdown?.dispose();
		this.#panel.dispose();
	}

	/**
	 * The arrow-key answer menu is the classic-terminal presentation; a native surface (Tern)
	 * shows the same answers as clickable buttons, so the selection stays invisible there and
	 * the arrows keep scrolling. Prompts that offer only Approve/Deny keep the key hints.
	 */
	get #menuEnabled(): boolean {
		return this.#answers.length > 2 && !isNativeRendering();
	}

	handleInput(keyData: string): void {
		if (this.#closed) return;
		this.#restartCountdown();
		const armed = performance.now() >= this.#armedAt;
		if (matchesAppApprove(keyData)) {
			if (armed) this.#finish("approve");
			return;
		}
		if (this.options.exactGrant === true && matchesAppAlwaysApprove(keyData)) {
			if (armed) this.#finish("always");
			return;
		}
		if (this.options.folderLabel !== undefined && matchesAppApproveFolder(keyData)) {
			if (armed) this.#finish("folder");
			return;
		}
		if (this.options.folderLabel !== undefined && matchesAppAlwaysApproveFolder(keyData)) {
			if (armed) this.#finish("always-folder");
			return;
		}
		if (this.#full && matchesAppToolsExpand(keyData)) {
			this.#toggleExpanded();
			return;
		}
		const draft = this.options.draft;
		// The composer's clear key (Ctrl+C, also a cancel key) clears a draft before it denies.
		if (draft?.hasDraft() && getKeybindings().matches(keyData, "app.clear")) {
			this.#editDraft(draft, keyData);
			return;
		}
		if (matchesSelectCancel(keyData)) {
			this.#finish("deny");
			return;
		}
		if (draft?.hasDraft()) {
			this.#editDraft(draft, keyData);
			return;
		}
		// With the composer empty, the arrows drive the answer menu like any omp selector;
		// page keys keep scrolling the details behind it. Without a menu (native rendering,
		// or a plain Approve/Deny prompt) the arrows keep scrolling as before.
		const menu = this.#menuEnabled;
		const page = Math.max(1, this.#bodyRows - 1);
		if (menu && matchesSelectUp(keyData)) this.#moveSelection(-1);
		else if (menu && matchesSelectDown(keyData)) this.#moveSelection(1);
		else if (matchesSelectPageUp(keyData)) this.#scroll(-page);
		else if (matchesSelectPageDown(keyData)) this.#scroll(page);
		else if (menu && getKeybindings().matches(keyData, "tui.input.submit")) {
			// The highlighted answer confirms on Enter; the arming delay keeps an Enter
			// meant for the composer from answering the prompt as it appears.
			if (armed) this.#finish(this.#answers[this.#selected]?.id ?? "deny");
		} else if (!menu && matchesSelectUp(keyData)) this.#scroll(-1);
		else if (!menu && matchesSelectDown(keyData)) this.#scroll(1);
		else if (draft) this.#editDraft(draft, keyData);
	}

	/** Move the highlight by `delta` rows, stopping at the edges like the selector does. */
	#moveSelection(delta: number): void {
		const next = Math.max(0, Math.min(this.#answers.length - 1, this.#selected + delta));
		if (next === this.#selected) return;
		this.#selected = next;
		this.options.tui?.requestRender();
	}

	#editDraft(draft: ApprovalDialogDraft, keyData: string): void {
		draft.handleInput(keyData);
		this.options.tui?.requestRender();
	}

	/**
	 * Swap the summarized prompt for every detail, wrapped, or back, as the expand key does here;
	 * for hosts that intercept that key first. Restarts the countdown like any key. False (nothing
	 * changes) without a full prompt, so the host's own expand handling (tool previews) can run.
	 */
	toggleDetails(): boolean {
		if (this.#closed || !this.#full) return false;
		this.#restartCountdown();
		this.#toggleExpanded();
		return true;
	}

	/** Any user input restarts the countdown (and its described form). */
	#restartCountdown(): void {
		if (!this.#countdown) return;
		this.#countdown.reset();
		this.options.onTimeoutReset?.();
		this.#native = undefined;
	}

	#toggleExpanded(): void {
		this.#expanded = !this.#expanded;
		this.#scrollOffset = 0;
		this.#native = undefined;
		this.options.tui?.requestRender();
	}

	/** The rows on show: the summary, or every detail once expanded. */
	get #details(): readonly string[] {
		return this.#expanded && this.#full ? this.#full : this.#summary;
	}

	render(width: number): readonly string[] {
		const innerWidth = Math.max(1, width - 4);
		let lines = this.#detailLines(innerWidth);
		const rows = Math.max(1, Math.min(lines.length, MAX_DETAIL_ROWS));
		const overflows = lines.length > rows;
		// Leave a column for the scrollbar once the details overflow.
		if (overflows && innerWidth > 1) lines = this.#detailLines(innerWidth - 1);
		this.#bodyRows = rows;
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, lines.length - rows));
		if (overflows) {
			const view = new ScrollView(lines, {
				height: rows,
				scrollbar: "auto",
				theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
			});
			view.setScrollOffset(this.#scrollOffset);
			this.#body.setLines(view.render(innerWidth));
		} else {
			this.#body.setLines(lines);
		}
		this.#body.setHeight(rows);
		const menu = this.#menuEnabled;
		this.#choices.setHeight(menu ? this.#answers.length : 0);
		this.#choices.setLines(menu ? this.#answerLines(width) : []);
		this.#footer.setLines([theme.fg("dim", this.#footerHint(overflows, menu))]);
		return this.#panel.render(width);
	}

	/**
	 * The answer menu: a cursor row painted with the `selectedBg` band like any omp
	 * selector, so the highlight survives themes whose accent is close to the text color.
	 */
	#answerLines(width: number): string[] {
		const innerWidth = Math.max(1, width - 4);
		return this.#answers.map((answer, index) => {
			const selected = index === this.#selected;
			const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const label = theme.fg(selected ? "accent" : "text", answer.label);
			const row = truncateToWidth(prefix + label, innerWidth, Ellipsis.Unicode);
			return selected ? theme.bg("selectedBg", row) : row;
		});
	}

	/**
	 * In the dock, in the composer's place and framed as the composer is (an
	 * `omp.editor.*` root role), like the ask dialog, rather than a card over
	 * the transcript: the title, the details, then Details (with a full prompt),
	 * Deny, and the primary Approve, whose keys show in their tooltips.
	 */
	describe(): NativeNode {
		if (this.#native) return this.#native;
		const cancelKey = getKeybindings().getKeys("tui.select.cancel")[0];
		const approveKey = appApproveKeys()[0];
		const deny = actionButton("Deny", "deny", {
			...(cancelKey ? { keys: cancelKey } : {}),
			tone: "error",
			title: `Deny this call${cancelKey ? `  ${formatTooltipKey(cancelKey)}` : ""}`,
		});
		const approve = actionButton("Approve", "approve", {
			...(approveKey ? { keys: approveKey } : {}),
			tone: "accent",
			title: `Approve this call${approveKey ? `  ${formatTooltipKey(approveKey)}` : ""}`,
		});
		const expandKey = appToolsExpandKey();
		const expand = this.#full
			? [
					actionButton(this.#expanded ? "Less" : "Details", "expand", {
						keys: expandKey,
						title: `${this.#expanded ? "Summarize" : "Show every detail of"} this call  ${formatTooltipKey(expandKey)}`,
					}),
				]
			: [];
		const folderKey = appApproveFolderKeys()[0];
		const alwaysKey = appAlwaysApproveKeys()[0];
		const alwaysFolderKey = appAlwaysApproveFolderKeys()[0];
		const folderLabel = this.options.folderLabel;
		const directory =
			folderLabel === undefined
				? []
				: [
						actionButton("Approve for directory", "folder", {
							...(folderKey ? { keys: folderKey } : {}),
							title: `Approve and remember ${folderLabel} for this session${folderKey ? `  ${formatTooltipKey(folderKey)}` : ""}`,
						}),
					];
		const always =
			this.options.exactGrant === true
				? [
						actionButton("Always approve", "always", {
							...(alwaysKey ? { keys: alwaysKey } : {}),
							title: `Approve this call and remember it for every session${alwaysKey ? `  ${formatTooltipKey(alwaysKey)}` : ""}`,
						}),
					]
				: [];
		const alwaysDirectory =
			folderLabel === undefined
				? []
				: [
						actionButton("Always approve for directory", "always-folder", {
							...(alwaysFolderKey ? { keys: alwaysFolderKey } : {}),
							title: `Approve and remember ${folderLabel} for every session${alwaysFolderKey ? `  ${formatTooltipKey(alwaysFolderKey)}` : ""}`,
						}),
					];
		const children: NativeNode[] = [
			node("text", { text: this.#title, role: "omp.approval.title", tone: "accent" }, undefined, "title"),
		];
		if (this.#details.length > 0) {
			// One clipped row per detail like the text view; expanded details wrap.
			const rows = this.#details.map((line, index) =>
				node("text", this.#expanded ? { text: line } : { text: line, truncate: "end" }, undefined, String(index)),
			);
			children.push(node("col", { role: "omp.approval.details" }, rows, "details"));
		}
		// The countdown, when one runs, leads the bar like the ask dialog's.
		children.push(
			actionBar([
				...(this.#countdown ? [this.#countdown.describe()] : []),
				null,
				...expand,
				...directory,
				...alwaysDirectory,
				...always,
				deny,
				approve,
			]),
		);
		// Under the `omp.editor.ask` prefix: Tern's console layout sizes an ask's rows to the
		// composer column by that prefix, where a bare `omp.editor.*` role spans the whole dock.
		this.#native = col(children, { role: "omp.editor.ask.approval", gap: "md" });
		return this.#native;
	}

	/** Deny, the four answers, and Details run exactly what their keys run. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#closed || event.type !== "action") return;
		if (event.act === "approve") this.#finish("approve");
		else if (event.act === "folder") this.#finish("folder");
		else if (event.act === "always") this.#finish("always");
		else if (event.act === "always-folder") this.#finish("always-folder");
		else if (event.act === "deny") this.#finish("deny");
		else if (event.act === "expand") this.toggleDetails();
	}

	/** Detail rows at `width`: one clipped row per detail, or wrapped rows once expanded. */
	#detailLines(width: number): string[] {
		if (!this.#expanded) {
			return this.#details.map(line => truncateToWidth(theme.fg("accent", line), width, Ellipsis.Unicode));
		}
		return this.#details.flatMap(line => (line === "" ? [""] : wrapTextWithAnsi(theme.fg("accent", line), width)));
	}

	#footerHint(overflows: boolean, menu: boolean): string {
		const draft = this.options.draft;
		if (menu) {
			const hint = `${editorKeys("tui.select.up", "tui.select.down")} choose · ${formatKeyHint("enter")} confirm · ${editorKey("tui.select.cancel")} deny`;
			if (draft?.hasDraft()) return `${hint} · ${editorKey("tui.input.submit")} deny and send`;
			const scroll = overflows ? ` · ${editorKeys("tui.select.pageUp", "tui.select.pageDown")} scroll` : "";
			const details = this.#full
				? ` · ${formatKeyHints([appToolsExpandKey()])} ${this.#expanded ? "less" : "details"}`
				: "";
			return `${hint}${scroll}${details}${draft ? " · type to steer instead" : ""}`;
		}
		const approve = formatKeyHints(appApproveKeys());
		const expand = this.#full
			? ` · ${formatKeyHints([appToolsExpandKey()])} ${this.#expanded ? "less" : "details"}`
			: "";
		const directory =
			this.options.folderLabel === undefined
				? ""
				: ` · ${formatKeyHints(appApproveFolderKeys())} approve dir · ${formatKeyHints(appAlwaysApproveFolderKeys())} always dir`;
		const always = this.options.exactGrant === true ? ` · ${formatKeyHints(appAlwaysApproveKeys())} always` : "";
		const hint = `${approve} approve${directory}${always} · ${editorKey("tui.select.cancel")} deny${expand}`;
		if (draft?.hasDraft()) return `${hint} · ${editorKey("tui.input.submit")} deny and send`;
		const scroll = overflows ? ` · ${editorKeys("tui.select.up", "tui.select.down")} scroll` : "";
		return `${hint}${scroll}${draft ? " · type to steer instead" : ""}`;
	}

	#scroll(delta: number): void {
		this.#scrollOffset = Math.max(0, this.#scrollOffset + delta);
		this.options.tui?.requestRender();
	}

	#finish(outcome: "approve" | "folder" | "always" | "always-folder" | "deny"): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#countdown?.dispose();
		if (outcome === "approve") this.callbacks.onApprove();
		else if (outcome === "folder") this.callbacks.onApproveFolder?.();
		else if (outcome === "always") this.callbacks.onAlwaysApprove?.();
		else if (outcome === "always-folder") this.callbacks.onAlwaysApproveFolder?.();
		else this.callbacks.onDeny();
	}
}
