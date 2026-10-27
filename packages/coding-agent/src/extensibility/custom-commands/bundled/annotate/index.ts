import type {
	CustomCommand,
	CustomCommandAPI,
	CustomCommandContext,
	CustomCommandResult,
} from "../../../../extensibility/custom-commands/types";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import type { TextReviewSource } from "@oh-my-pi/pi-tui/overlays/annotation-types";
import {
	extractReviewPrRefFromArgs,
	liveCommandCwd,
	resolvePrReviewTarget,
	ReviewCommand,
	selectReviewChoice,
	type ReviewPrRef,
} from "../review";
import { buildCodeReviewFeedback } from "../review/prompt";
import {
	getReviewTargetIssue,
	type LocalReviewKind,
	type ResolvedReviewTarget,
	resolveLocalReviewTarget,
	type ReviewTargetUI,
} from "../review/target";
import { acquireFileTextReviewSource, createPromptTextReviewSource } from "./direct-source";
import {
	AnnotationDraftStore,
	type AnnotationDraftRecord,
	type InvalidAnnotationDraft,
} from "./draft-store";
import { selectAnnotationSourceKind, selectSessionTextReviewSource, type AnnotationSourceChoice, type AnnotationSourceKind } from "./text-source";
import {
	buildTextReviewPrompt,
	normalizeTextReviewContextSummary,
	shouldSummarizeTextReviewSource,
} from "./text-review";
import { generateTextReviewContextSummary } from "./text-summary";
import {
	showCodeReviewOverlay,
	showTextReviewOverlay,
	type CodeAnnotationRun,
	type TextAnnotationRun,
} from "./fullscreen";

interface CodeReviewDependencies {
	resolveLocalReviewTarget(
		kind: LocalReviewKind,
		cwd: string,
		ui: ReviewTargetUI,
	): Promise<ResolvedReviewTarget | undefined>;
	resolvePrReviewTarget(
		cwd: string,
		ctx: CustomCommandContext,
		ref: ReviewPrRef,
	): Promise<ResolvedReviewTarget | undefined>;
	showCodeReviewOverlay(ctx: CustomCommandContext, target: ResolvedReviewTarget, focus?: string, draft?: AnnotationDraftRecord): Promise<CodeAnnotationRun | undefined>;
}

interface TextAnnotationDependencies {
	selectAnnotationSourceKind: typeof selectAnnotationSourceKind;
	selectSessionTextReviewSource: typeof selectSessionTextReviewSource;
	acquireFileTextReviewSource: typeof acquireFileTextReviewSource;
	createPromptTextReviewSource: typeof createPromptTextReviewSource;
	showTextReviewOverlay: (ctx: CustomCommandContext, source: TextReviewSource, draft?: AnnotationDraftRecord) => Promise<TextAnnotationRun | undefined>;
	generateTextReviewContextSummary: typeof generateTextReviewContextSummary;
}

const defaultCodeReviewDependencies: CodeReviewDependencies = {
	resolveLocalReviewTarget,
	resolvePrReviewTarget,
	showCodeReviewOverlay,
};

const defaultTextAnnotationDependencies: TextAnnotationDependencies = {
	selectAnnotationSourceKind,
	selectSessionTextReviewSource,
	acquireFileTextReviewSource,
	createPromptTextReviewSource,
	showTextReviewOverlay,
	generateTextReviewContextSummary,
};

function parseCodeReviewFocus(args: string): string | undefined {
	const match = args.trim().match(/^code-review(?:\s+([\s\S]*))?$/);
	return match ? (match[1]?.trim() ?? "") : undefined;
}

function parseAnnotationSourceKind(args: string): AnnotationSourceKind | undefined {
	const trimmed = args.trim();
	if (trimmed === "last" || trimmed === "session") return trimmed;
	return undefined;
}

function splitReviewArgs(args: string): string[] {
	return args.trim() ? args.trim().split(/\s+/) : [];
}

const ANNOTATE_MODE_COMPLETIONS: readonly AutocompleteItem[] = [
	{
		value: "last ",
		label: "last",
		description: "Annotate the latest assistant reply",
	},
	{
		value: "session ",
		label: "session",
		description: "Annotate a message or code block from this session",
	},
	{
		value: "code-review ",
		label: "code-review",
		description: "Annotate local changes, a GitHub pull request, or a GitLab merge request",
	},
];

const ANNOTATE_GUIDANCE_COMPLETIONS: readonly AutocompleteItem[] = [
	{
		value: "./",
		label: "<file path>",
		description: "Annotate a file by path",
		hint: "Annotate a file; paths with spaces stay unquoted",
	},
	{
		value: '"',
		label: '"prompt text"',
		description: "Annotate literal prompt text",
		hint: "Wrap literal prompt text in matching quotes",
	},
];

function buildUnclosedLiteralCompletion(argumentPrefix: string, quote: '"' | "'"): AutocompleteItem {
	const value = `${argumentPrefix}${quote}`;
	return {
		value,
		label: value,
		hint: "Finish with the matching quote to annotate literal prompt text",
	};
}

async function getAnnotateArgumentCompletions(
	argumentPrefix: string,
	fileProvider: CombinedAutocompleteProvider,
): Promise<AutocompleteItem[] | null> {
	const trimmed = argumentPrefix.trim();
	if (trimmed.length === 0) {
		return [...ANNOTATE_MODE_COMPLETIONS, ...ANNOTATE_GUIDANCE_COMPLETIONS];
	}

	const first = trimmed[0];
	if (first === '"' || first === "'") {
		if (trimmed.length < 2 || trimmed[trimmed.length - 1] !== first) {
			// Keep the generic provider from treating an unfinished literal as a
			// quoted filename and offer the matching closing quote instead.
			return [buildUnclosedLiteralCompletion(argumentPrefix, first)];
		}
		return null;
	}

	if (!/\s/.test(trimmed) && !/\s$/.test(argumentPrefix)) {
		const lower = trimmed.toLowerCase();
		const modes = ANNOTATE_MODE_COMPLETIONS.filter(item => item.label.toLowerCase().startsWith(lower));
		if (modes.length > 0) return modes;
	}

	if (/^(?:last|session|code-review)$/i.test(trimmed) && /\s$/.test(argumentPrefix)) return null;

	// Code-review's remainder is free-form focus/PR text, not a file path.
	if (/^code-review(?:\s|$)/i.test(trimmed)) return null;

	// Quote the synthetic path only while querying the shared provider. This
	// preserves spaces in the complete path token; returned values are unquoted
	// because annotate treats any user-entered quotes as literal prompt syntax.
	const syntheticLine = `/annotate "${trimmed}`;
	const result = await fileProvider.getForceFileSuggestions([syntheticLine], 0, syntheticLine.length);
	if (!result) return null;
	const items = result.items.map(item => ({
		...item,
		value: item.value.startsWith('"')
			? item.value.endsWith('"')
				? item.value.slice(1, -1)
				: item.value.slice(1)
			: item.value,
	}));
	return items.length > 0 ? items : null;
}

function displaySafe(value: string, limit = 56): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

function draftLabel(draft: AnnotationDraftRecord): string {
	const source = draft.source;
	const kind = source.kind === "diff" ? "Diff" : source.source.kind;
	const label = source.kind === "diff" ? source.target.mode : source.source.label;
	const state = draft.state;
	const noteCount = state.annotations.length;
	const unfinished = !!state.editor?.text ? ", unfinished note" : "";
	const edited = state.kind === "text" && state.editedText !== undefined ? ", edited source" : "";
	return `${kind}: ${displaySafe(label)} — ${displaySafe(source.cwd, 40)} — ${new Date(draft.updatedAt).toLocaleString()} — ${noteCount} note${noteCount === 1 ? "" : "s"}${unfinished}${edited} (${draft.key.slice(0, 8)})`;
}

function invalidDraftLabel(draft: InvalidAnnotationDraft): string {
	return `Unreadable draft — ${draft.filename} (${draft.key.slice(0, 8)})`;
}

async function selectDraft(
	ctx: CustomCommandContext,
	store: AnnotationDraftStore,
	includeUnreadable: boolean,
): Promise<AnnotationDraftRecord | InvalidAnnotationDraft | undefined> {
	const options = [
		...store.list().map(draft => ({ label: draftLabel(draft), draft })),
		...(includeUnreadable ? store.listInvalid().map(draft => ({ label: invalidDraftLabel(draft), draft })) : []),
	];
	if (options.length === 0) return undefined;
	const selected = await ctx.ui.select("Select an annotation draft", options.map(option => option.label));
	return options.find(option => option.label === selected)?.draft;
}

async function manageDraftChoice(
	ctx: CustomCommandContext,
	choice: Extract<AnnotationSourceChoice, "resume-draft" | "discard-draft">,
): Promise<AnnotationDraftRecord | undefined> {
	const store = await AnnotationDraftStore.open(ctx.sessionManager.getArtifactsDir(), ctx.sessionManager.getSessionId());
	try {
		const selected = await selectDraft(ctx, store, choice === "discard-draft");
		if (!selected) return undefined;
		if (choice === "resume-draft") return selected as AnnotationDraftRecord;
		const confirm = await ctx.ui.select("Discard this annotation draft?", ["Keep draft", "Discard draft"]);
		if (confirm !== "Discard draft") return undefined;
		await store.discard(selected.key);
		ctx.ui.notify("Annotation draft discarded.", "info");
		return undefined;
	} finally {
		await store.dispose();
	}
}


async function finishCodeReview(
	ctx: CustomCommandContext,
	target: ResolvedReviewTarget,
	focus: string | undefined,
	showOverlay: CodeReviewDependencies["showCodeReviewOverlay"],
	draft?: AnnotationDraftRecord,
): Promise<CustomCommandResult> {
	const issue = getReviewTargetIssue(target);
	if (issue) { ctx.ui.notify(issue, "warning"); return undefined; }
	const run = await showOverlay(ctx, target, focus, draft);
	if (!run) return undefined;
	const review = run.result.action === "review";
	const feedback = buildCodeReviewFeedback(run.target, run.result.annotations, review, run.focus);
	if (review) return feedback ? { text: feedback, onSubmitted: run.complete } : undefined;
	if (feedback) {
		ctx.ui.pasteToEditor(feedback);
	}
	return undefined;
}

/** Run `/annotate code-review`, freezing one target before the overlay opens. */
export async function runCodeReviewCommand(
	api: CustomCommandAPI,
	args: string,
	ctx: CustomCommandContext,
	dependencies: Partial<CodeReviewDependencies> = {},
): Promise<CustomCommandResult> {
	if (!ctx.hasUI) {
		return new ReviewCommand(api).execute(splitReviewArgs(args), ctx);
	}
	const resolved = { ...defaultCodeReviewDependencies, ...dependencies };
	const cwd = liveCommandCwd(api, ctx);
	const parsed = extractReviewPrRefFromArgs(splitReviewArgs(args));
	const focus = parsed.extraInstructions || undefined;
	const choice = parsed.prRef ? { kind: "pr" as const, ref: parsed.prRef } : await selectReviewChoice(ctx, cwd);
	if (!choice) return undefined;
	const target =
		choice.kind === "pr"
			? await resolved.resolvePrReviewTarget(cwd, ctx, choice.ref)
			: await resolved.resolveLocalReviewTarget(choice.kind, cwd, ctx.ui);
	return target ? finishCodeReview(ctx, target, focus, resolved.showCodeReviewOverlay) : undefined;
}

/** Run `/annotate` text sources; all resulting feedback is pasted, never submitted. */
export async function runAnnotateCommand(
	api: CustomCommandAPI,
	args: string,
	ctx: CustomCommandContext,
	dependencies: Partial<TextAnnotationDependencies & CodeReviewDependencies> = {},
): Promise<CustomCommandResult> {
	const codeReviewFocus = parseCodeReviewFocus(args);
	if (codeReviewFocus !== undefined) {
		return runCodeReviewCommand(api, codeReviewFocus, ctx, dependencies);
	}
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"Text annotation requires the interactive UI. Re-run /annotate from an interactive session; no message was sent.",
			"error",
		);
		return undefined;
	}
	const textDependencies = { ...defaultTextAnnotationDependencies, ...dependencies };
	const trimmed = args.trim();
	let kind: AnnotationSourceChoice | undefined;
	let source: TextReviewSource | undefined;
	let draft: AnnotationDraftRecord | undefined;
	if (trimmed.length === 0) {
		const listing = await AnnotationDraftStore.open(ctx.sessionManager.getArtifactsDir(), ctx.sessionManager.getSessionId());
		const hasDrafts = listing.list().length > 0 || listing.listInvalid().length > 0;
		await listing.dispose();
		kind = await textDependencies.selectAnnotationSourceKind(ctx.ui, { hasDrafts });
		if (kind === "resume-draft" || kind === "discard-draft") {
			draft = await manageDraftChoice(ctx, kind);
			if (!draft) return undefined;
			if (draft.source.kind === "diff") {
				ctx.ui.notify("Resuming a saved diff snapshot; it will not be rebased.", "info");
				return finishCodeReview(
					ctx,
					draft.source.target,
					draft.source.focus,
					{ ...defaultCodeReviewDependencies, ...dependencies }.showCodeReviewOverlay,
					draft,
				);
			}
			ctx.ui.notify("Resuming a saved annotation snapshot.", "info");
			source = draft.source.source;
		}
	} else {
		const first = trimmed[0];
		const isQuoted = (first === '"' || first === "'") && trimmed.length >= 2 && trimmed[trimmed.length - 1] === first;
		if (isQuoted) {
			source = textDependencies.createPromptTextReviewSource(ctx, trimmed.slice(1, -1));
		} else {
			kind = parseAnnotationSourceKind(trimmed);
			if (!kind) source = await textDependencies.acquireFileTextReviewSource(ctx, trimmed);
		}
	}
	if (kind && kind !== "resume-draft" && kind !== "discard-draft") {
		switch (kind) {
			case "code-review":
				return runCodeReviewCommand(api, "", ctx, dependencies);
			case "last":
				source = await textDependencies.selectSessionTextReviewSource(ctx, { autoSelect: "latest-assistant" });
				break;
			case "session":
				source = await textDependencies.selectSessionTextReviewSource(ctx);
				break;
			case "file": {
				const filePath = await ctx.ui.input("File path to annotate");
				if (filePath !== undefined) source = await textDependencies.acquireFileTextReviewSource(ctx, filePath);
				break;
			}
			case "prompt": {
				const text = await ctx.ui.editor("Text prompt to annotate");
				if (text !== undefined) source = textDependencies.createPromptTextReviewSource(ctx, text);
				break;
			}
		}
	}
	if (!source) return undefined;
	const run = await textDependencies.showTextReviewOverlay(ctx, source, draft);
	if (!run || run.result.annotations.length === 0) return undefined;
	source = run.source;
	if (run.result.editedText !== undefined) source = { ...source, text: run.result.editedText };
	let contextSummary: string | undefined;
	if (shouldSummarizeTextReviewSource(source)) {
		ctx.ui.setStatus("annotate-summary", "Rephrasing annotation source with the session model…");
		try {
			const generated = await textDependencies.generateTextReviewContextSummary(ctx, source.text);
			contextSummary =
				typeof generated === "string" ? normalizeTextReviewContextSummary(generated) || undefined : undefined;
			if (!contextSummary) {
				ctx.ui.notify(
					"Source summary unavailable; including the full source verbatim beyond the normal 999-character context limit.",
					"warning",
				);
			}
		} catch {
			ctx.ui.notify(
				"Source summary failed; including the full source verbatim beyond the normal 999-character context limit.",
				"warning",
			);
		} finally {
			ctx.ui.setStatus("annotate-summary", undefined);
		}
	}
	const prompt = buildTextReviewPrompt(source, run.result.annotations, contextSummary);
	if (prompt) {
		ctx.ui.pasteToEditor(prompt);
	}
}

export class AnnotateCommand implements CustomCommand {
	name = "annotate";
	description = "Annotate a diff or text from a file, prompt, latest reply, or session";
	#fileCompletionProvider: CombinedAutocompleteProvider | undefined;
	#fileCompletionCwd: string | undefined;

	constructor(private readonly api: CustomCommandAPI) {}

	getArgumentCompletions(argumentPrefix: string, cwd: string): Promise<AutocompleteItem[] | null> {
		if (!this.#fileCompletionProvider || this.#fileCompletionCwd !== cwd) {
			this.#fileCompletionProvider = new CombinedAutocompleteProvider([], cwd);
			this.#fileCompletionCwd = cwd;
		}
		return getAnnotateArgumentCompletions(argumentPrefix, this.#fileCompletionProvider);
	}

	execute(args: string[], ctx: CustomCommandContext, rawArgs?: string): Promise<CustomCommandResult> {
		return runAnnotateCommand(this.api, rawArgs ?? args.join(" "), ctx);
	}
}

export default AnnotateCommand;
