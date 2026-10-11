import * as fs from "node:fs/promises";
import type { ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { editInspect } from "@oh-my-pi/pi-natives";
import { isRecord } from "@oh-my-pi/pi-utils";
import { transcriptEntryMessage } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { type CopyPickSource, CopySelectorComponent } from "@oh-my-pi/pi-tui/overlays/copy-selector";
import { assistantText } from "@oh-my-pi/pi-tui/overlays/copy-targets";
import type { TextReviewSource } from "@oh-my-pi/pi-tui/overlays/annotation-types";
import { isReadableUrlPath } from "@oh-my-pi/pi-tui/tools/read";
import { splitUrlScheme } from "@oh-my-pi/pi-tui/tools/url-scheme-host";
import type { CustomCommandContext } from "../../../../extensibility/custom-commands/types";
import { EDIT_MODES } from "../../../../edit/settings";
import { InternalUrlRouter } from "../../../../internal-urls";
import { isTranscriptEntry } from "../../../../session/session-context";
import type { SessionEntry } from "../../../../session/session-entries";
import { expandPath, isFilesystemSourcePath } from "../../../../tools/path-utils";

export type AnnotationSourceKind = "code-review" | "last" | "session" | "file" | "prompt";

export const ANNOTATION_SOURCE_CHOICES = [
	{
		kind: "code-review",
		label: "Code review",
		description: "Annotate a local diff before review",
	},
	{
		kind: "last",
		label: "Latest assistant reply",
		description: "Annotate the latest non-empty assistant reply on this branch",
	},
	{
		kind: "session",
		label: "Session message or block",
		description: "Choose a message, code block, quote, or command from this session",
	},
	{
		kind: "file",
		label: "File",
		description: "Read a regular text file from the current working directory",
	},
	{
		kind: "prompt",
		label: "Text prompt",
		description: "Enter text directly for annotation",
	},
] as const satisfies ReadonlyArray<{ kind: AnnotationSourceKind; label: string; description: string }>;

export async function selectAnnotationSourceKind(
	ui: Pick<CustomCommandContext["ui"], "select">,
): Promise<AnnotationSourceKind | undefined> {
	const selected = await ui.select(
		"Select content to annotate",
		ANNOTATION_SOURCE_CHOICES.map(choice => choice.label),
	);
	return ANNOTATION_SOURCE_CHOICES.find(choice => choice.label === selected)?.kind;
}

/** Exact picked content plus the transcript entry/block it came from. */
export interface SessionPick extends CopyPickSource {
	content: string;
	label: string;
}

function latestAssistantEntry(branch: readonly SessionEntry[]): { id: string; text: string } | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "message") continue;
		const text = assistantText(entry.message);
		if (text) return { id: entry.id, text };
	}
	return undefined;
}

/** The latest non-empty assistant reply on the active branch, or undefined when none exists. */
export function latestAssistantTextReviewSource(
	branch: readonly SessionEntry[],
	sessionId: string,
): TextReviewSource | undefined {
	const latest = latestAssistantEntry(branch);
	if (!latest) return undefined;
	return {
		id: `message:${latest.id}`,
		kind: "message",
		label: "Latest assistant reply",
		text: latest.text,
		provenance: { kind: "latest-assistant", entryId: latest.id },
		sessionId,
	};
}

function sourceKind(selection: SessionPick): TextReviewSource["kind"] {
	if (selection.block?.kind) return selection.block.kind;
	switch (transcriptEntryMessage(selection.entry)?.role) {
		case "toolResult":
			return "code";
		case "bashExecution":
		case "pythonExecution":
			return "command";
		default:
			return "message";
	}
}

function toolCallForId(branch: readonly SessionEntry[], id: string): ToolCall | undefined {
	let found: ToolCall | undefined;
	for (const entry of branch) {
		if (!isTranscriptEntry(entry)) continue;
		const message = transcriptEntryMessage(entry);
		if (message?.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall" || part.id !== id) continue;
			if (found) return undefined;
			found = part;
		}
	}
	return found;
}

function toolResultForId(branch: readonly SessionEntry[], id: string): ToolResultMessage | undefined {
	let found: ToolResultMessage | undefined;
	for (const entry of branch) {
		if (!isTranscriptEntry(entry)) continue;
		const message = transcriptEntryMessage(entry);
		if (message?.role !== "toolResult" || message.toolCallId !== id) continue;
		if (found) return undefined;
		found = message;
	}
	return found;
}

function toolResultText(message: ToolResultMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n")
		.trim();
}

type FileContextToolName = "read" | "edit" | "write";

function fileContextToolName(name: string): FileContextToolName | undefined {
	switch (name) {
		case "read":
		case "edit":
		case "write":
			return name;
		case "apply_patch":
			return "edit";
		default:
			return undefined;
	}
}

function selectedToolContext(
	branch: readonly SessionEntry[],
	selection: SessionPick,
): { call: ToolCall; name: FileContextToolName; details?: Record<string, unknown> } | undefined {
	const selectedMessage = transcriptEntryMessage(selection.entry);
	let call: ToolCall | undefined;
	let result: ToolResultMessage | undefined;

	if (selectedMessage?.role === "toolResult") {
		result = toolResultForId(branch, selectedMessage.toolCallId);
		if (result !== selectedMessage) return undefined;
		call = toolCallForId(branch, selectedMessage.toolCallId);
	} else if (
		selectedMessage?.role === "assistant" &&
		selection.block === undefined &&
		assistantText(selectedMessage) === undefined
	) {
		const calls = selectedMessage.content.filter((part): part is ToolCall => part.type === "toolCall");
		if (calls.length !== 1) return undefined;
		call = toolCallForId(branch, calls[0]!.id);
		result = toolResultForId(branch, calls[0]!.id);
		if (
			!call ||
			call !== calls[0] ||
			!result ||
			fileContextToolName(result.toolName) !== fileContextToolName(call.name) ||
			toolResultText(result) !== selection.content
		) {
			return undefined;
		}
	} else {
		return undefined;
	}

	const name = call ? fileContextToolName(call.name) : undefined;
	const resultName = result ? fileContextToolName(result.toolName) : undefined;
	if (!call || !result || !name || name !== resultName) return undefined;
	return { call, name, ...(isRecord(result.details) ? { details: result.details } : {}) };
}

type PathEvidence = { kind: "none" } | { kind: "reject" } | { kind: "path"; value: string };

function metadataPathEvidence(name: string, details: Record<string, unknown> | undefined): PathEvidence {
	if (!details) return { kind: "none" };
	if (name === "edit" && details.op === "delete") return { kind: "reject" };

	if (name === "read") {
		const meta = isRecord(details.meta) ? details.meta : undefined;
		const source = meta && isRecord(meta.source) ? meta.source : undefined;
		if (
			details.isDirectory === true ||
			details.kind === "url" ||
			typeof details.url === "string" ||
			typeof details.finalUrl === "string" ||
			(details.summary !== undefined && details.summary !== null) ||
			(source !== undefined && source.type !== "path") ||
			Array.isArray(details.displayReadTargets) ||
			Array.isArray(details.displayReadTargetLinks)
		) {
			return { kind: "reject" };
		}
		if (typeof details.editableFilePath !== "string") return { kind: "none" };
		return isFilesystemSourcePath(details.editableFilePath)
			? { kind: "path", value: details.editableFilePath }
			: { kind: "reject" };
	}

	if (name === "edit") {
		if (Array.isArray(details.perFileResults)) {
			if (details.perFileResults.length !== 1) return { kind: "reject" };
			const result = details.perFileResults[0];
			if (!isRecord(result)) return { kind: "none" };
			if (result.op === "delete") return { kind: "reject" };
			return typeof result.path === "string" && isFilesystemSourcePath(result.path)
				? { kind: "path", value: result.path }
				: { kind: "none" };
		}
		return typeof details.path === "string" && isFilesystemSourcePath(details.path)
			? { kind: "path", value: details.path }
			: { kind: "none" };
	}

	return typeof details.resolvedPath === "string" && isFilesystemSourcePath(details.resolvedPath)
		? { kind: "path", value: details.resolvedPath }
		: { kind: "none" };
}

function isNonFilesystemUrl(value: string): boolean {
	const scheme = splitUrlScheme(value)?.scheme;
	const router = InternalUrlRouter.instance();
	return (
		isReadableUrlPath(value) ||
		/^https?:\/(?!\/)/i.test(value) ||
		(scheme !== undefined && scheme !== "file") ||
		router.canResolve(expandPath(value)) ||
		(value.startsWith("@") && router.canResolve(value.slice(1)))
	);
}
function editInputTargets(
	call: ToolCall,
): { sources: Set<string>; destinations: Set<string>; deletes: Set<string> } | undefined {
	let argsJson: string;
	try {
		argsJson = JSON.stringify(call.arguments);
	} catch {
		return undefined;
	}

	const modes = call.name === "apply_patch" ? ["apply_patch"] : EDIT_MODES;
	const sources = new Set<string>();
	const destinations = new Set<string>();
	const deletes = new Set<string>();
	for (const mode of modes) {
		let inspection;
		try {
			inspection = editInspect(mode, argsJson);
		} catch {
			continue;
		}
		for (const source of inspection.paths) {
			if (!source || isNonFilesystemUrl(source)) return undefined;
			sources.add(source);
		}
		for (const operation of inspection.fileOps) {
			if (!operation.path || isNonFilesystemUrl(operation.path)) return undefined;
			sources.add(operation.path);
			if (operation.kind === "delete") deletes.add(operation.path);
			if (operation.to !== undefined) {
				if (!operation.to || isNonFilesystemUrl(operation.to)) return undefined;
				destinations.add(operation.to);
			}
		}
	}
	if (sources.size !== 1 || destinations.size > 1) return undefined;
	return { sources, destinations, deletes };
}

async function resolveFilePath(value: string): Promise<string | undefined> {
	if (!value || isNonFilesystemUrl(value) || !isFilesystemSourcePath(value)) return undefined;
	try {
		if ((await fs.stat(value)).isDirectory()) return undefined;
	} catch {
		// A single-file write may name a file that has not been created yet.
	}
	return value;
}

async function editorFilePathFromSelection(
	branch: readonly SessionEntry[],
	selection: SessionPick,
): Promise<string | undefined> {
	const toolContext = selectedToolContext(branch, selection);
	if (!toolContext) return undefined;
	const inputPath = toolContext.call.arguments.path;
	if (typeof inputPath === "string" && isNonFilesystemUrl(inputPath)) return undefined;
	const editTargets = toolContext.name === "edit" ? editInputTargets(toolContext.call) : undefined;
	if (toolContext.name === "edit" && (!editTargets || editTargets.deletes.size > 0)) return undefined;

	const evidence = metadataPathEvidence(toolContext.name, toolContext.details);
	if (evidence.kind === "reject") return undefined;
	if (evidence.kind === "path") return resolveFilePath(evidence.value);
	if (toolContext.name === "read") return undefined;

	const argumentPath =
		toolContext.name === "edit"
			? editTargets!.destinations.size > 0
				? [...editTargets!.destinations][0]
				: [...editTargets!.sources][0]
			: inputPath;
	return typeof argumentPath === "string" ? resolveFilePath(argumentPath) : undefined;
}

async function sourceFromSelection(
	ctx: CustomCommandContext,
	branch: readonly SessionEntry[],
	selection: SessionPick,
	latestAssistantId: string | undefined,
): Promise<TextReviewSource> {
	const editorFilePath = await editorFilePathFromSelection(branch, selection);
	const kind = sourceKind(selection);
	const entryId = selection.entry.id;
	const isLatestWholeAssistant =
		selection.block === undefined &&
		entryId === latestAssistantId &&
		transcriptEntryMessage(selection.entry)?.role === "assistant";
	return {
		id: `${kind}:${entryId}`,
		kind,
		label: selection.label,
		text: selection.content,
		provenance: isLatestWholeAssistant ? { kind: "latest-assistant", entryId } : { kind: "session", entryId },
		sessionId: ctx.sessionManager.getSessionId(),
		...(editorFilePath ? { editorFilePath } : {}),
	};
}

/** Choose exact content through the native copy selector without copying it. */
export async function selectSessionTextReviewSource(
	ctx: CustomCommandContext,
	options?: { autoSelect?: "latest-assistant" },
): Promise<TextReviewSource | undefined> {
	const branch = ctx.sessionManager.getBranch();
	if (options?.autoSelect === "latest-assistant") {
		const source = latestAssistantTextReviewSource(branch, ctx.sessionManager.getSessionId());
		if (!source) ctx.ui.notify("No non-empty assistant reply is available on the active session branch.", "warning");
		return source;
	}
	const latest = latestAssistantEntry(branch);

	const entries = branch.filter(isTranscriptEntry);
	if (entries.length === 0) {
		ctx.ui.notify("No messages to annotate yet.", "warning");
		return undefined;
	}
	const selection = await ctx.ui.custom<SessionPick | undefined>((tui, _theme, _keybindings, done) => {
		return new CopySelectorComponent(entries, {
			ui: tui,
			cwd: ctx.sessionManager.getCwd?.() ?? ctx.cwd,
			title: "Select message to annotate",
			actionLabel: "select",
			requestRender: () => tui.requestRender(),
			onPick: (content, label, source) => done({ content, label, ...source }),
			onCancel: () => done(undefined),
		});
	});
	return selection ? sourceFromSelection(ctx, branch, selection, latest?.id) : undefined;
}
