/**
 * On-touch loading of nested context files (`contextFiles.onTouch`).
 *
 * The system prompt carries the context files of cwd and its ancestors. A
 * subdirectory's own AGENTS.md (or CLAUDE.md, …) is only listed there by path.
 * With the setting on, the first successful read/write/edit/ast_edit below
 * such a directory delivers that file as trusted passive context: a developer
 * message after the tool batch, never part of the tool result.
 *
 * Dedupe state is the conversation itself: a file is loaded when the system
 * prompt lists it, or the live context still holds its `<nested-context path="…">`
 * block or a full read of it. Compaction that drops the block re-arms the file
 * without bookkeeping. Subagents inherit the parent's loaded files, delivered
 * or fully read, through {@link NestedContextInjector.carried}, which lands
 * them in the child's system prompt.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AfterToolCallContext, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isRecord, logger, prompt } from "@oh-my-pi/pi-utils";
import { invalidate as invalidateCapabilityCache } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import type { Settings } from "../config/settings";
import { loadCapability } from "../discovery";
import { expandAtImports } from "../discovery/at-imports";
import nestedContextFileTemplate from "../prompts/system/nested-context-file.md" with { type: "text" };
import type { ContextFileEntry } from "../tools";
import { cfgContextFilesOnTouch } from "./context-settings";

/** Tools whose successful results count as touching a directory. */
const TRIGGER_TOOLS: Record<string, true> = { read: true, write: true, edit: true, ast_edit: true };
/** Characters of one context file delivered before it is truncated. */
export const NESTED_CONTEXT_FILE_MAX_CHARS = 16_384;
/** Directory names whose context files never load on touch, besides hidden ones. */
const EXCLUDED_SEGMENTS: Record<string, true> = { node_modules: true };
const NOTICE_SOURCE = "context-files";

/**
 * One delivered block. The body capture relies on the template's shape: a
 * single header line and a blank line before the file content.
 */
const BLOCK_RE = /<nested-context path="([^"]+)">\n[^\n]*\n\n([\s\S]*?)\n<\/nested-context>/g;

/** Capabilities the injector borrows from its owning session. */
export interface NestedContextHost {
	settings: Settings;
	/** Session cwd; its context files and its ancestors' are already in the system prompt. */
	cwd(): string;
	/** Additional workspace roots, whose context files are also in the system prompt. */
	additionalDirectories(): readonly string[];
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
}

interface NestedContextFile {
	/** Absolute path of the context file. */
	path: string;
	/** Directory the file governs, strictly below cwd. */
	owner: string;
	content: string;
}

interface BatchState {
	message: AssistantMessage;
	/** Files claimed by earlier calls of this batch: their block lands only after the batch settles. */
	claimed: Set<string>;
}

/** Delivers subdirectory context files the first time a tool touches their directory. */
export class NestedContextInjector {
	readonly #host: NestedContextHost;
	#batch: BatchState | undefined;

	constructor(host: NestedContextHost) {
		this.#host = host;
	}

	/**
	 * Passive context for a settled tool call. Returns undefined synchronously when
	 * the call cannot touch a nested directory, so most calls never await.
	 */
	afterToolCall(ctx: AfterToolCallContext): Promise<string | undefined> | undefined {
		if (!cfgContextFilesOnTouch.get(this.#host.settings)) return undefined;
		if (ctx.isError || TRIGGER_TOOLS[ctx.toolCall.name] !== true) return undefined;
		const cwd = path.resolve(this.#host.cwd());
		const edited = editedFiles(ctx, cwd);
		// Discovery reads through the capability fs cache, which would still hold
		// the directory listing and content from before this edit.
		for (const file of edited) invalidateCapabilityCache(file);
		const directories = touchedDirectories(ctx, cwd, edited).filter(dir => isStrictlyBelow(cwd, dir));
		if (directories.length === 0) return undefined;
		return this.#load(ctx, cwd, directories);
	}

	async #load(ctx: AfterToolCallContext, cwd: string, directories: readonly string[]): Promise<string | undefined> {
		let files: NestedContextFile[];
		try {
			files = await this.#discover(directories, cwd);
		} catch (error) {
			logger.warn("Nested context discovery failed", { error: String(error) });
			return undefined;
		}
		if (files.length === 0) return undefined;

		if (this.#batch?.message !== ctx.assistantMessage) {
			this.#batch = { message: ctx.assistantMessage, claimed: new Set() };
		}
		const batch = this.#batch;
		const loadedInWindow = scanWindow(ctx.context.messages, cwd);
		// A whole read of the context file itself already put it in context.
		const fullRead = ctx.toolCall.name === "read" ? fullReadPath(ctx.result.details) : undefined;
		if (fullRead) batch.claimed.add(fullRead);

		const blocks: string[] = [];
		const loaded: string[] = [];
		for (const file of files) {
			const display = displayPath(cwd, file.path);
			if (loadedInWindow.has(display) || batch.claimed.has(file.path)) continue;
			if (inSystemPrompt(ctx.context.systemPrompt, file.path)) continue;
			batch.claimed.add(file.path);
			const block = prompt.render(nestedContextFileTemplate, {
				path: display,
				dir: `${displayPath(cwd, file.owner)}/`,
				content: capContent(file.content, display),
			});
			blocks.push(block);
			loaded.push(display);
		}
		if (blocks.length === 0) return undefined;
		this.#host.emitNotice("info", `Loaded ${loaded.join(", ")}`, NOTICE_SOURCE);
		return blocks.join("\n\n");
	}

	/**
	 * Context files governing `directories`, farthest from cwd first, each once.
	 * Discovery is the context-file capability itself, walked up from the touched
	 * directory, so provider priority, one-file-per-directory shadowing and
	 * `contextFiles.extra` behave exactly as they do for the system prompt.
	 */
	async #discover(directories: readonly string[], cwd: string): Promise<NestedContextFile[]> {
		const additional = this.#host.additionalDirectories().map(dir => path.resolve(dir));
		const byPath = new Map<string, NestedContextFile>();
		for (const dir of directories) {
			const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: dir });
			for (const item of result.items) {
				if (item.level !== "project" || byPath.has(item.path)) continue;
				const owner = ancestor(dir, Math.max(0, item.depth ?? 0));
				if (!isStrictlyBelow(cwd, owner)) continue;
				// Hidden directories and dependency trees are not project context.
				const segments = path.relative(cwd, owner).split(path.sep);
				if (segments.some(segment => segment.startsWith(".") || EXCLUDED_SEGMENTS[segment] === true)) continue;
				// An additional workspace root and its ancestors are already in the system prompt.
				if (additional.some(root => root === owner || isStrictlyBelow(owner, root))) continue;
				byPath.set(item.path, { path: item.path, owner, content: item.content });
			}
		}
		const files = [...byPath.values()].sort(
			(a, b) => a.owner.split(path.sep).length - b.owner.split(path.sep).length || a.path.localeCompare(b.path),
		);
		return Promise.all(
			files.map(async file => ({ ...file, content: await expandAtImports(file.content, file.path) })),
		);
	}

	/**
	 * Nested context files the live window holds, as system-prompt context file
	 * entries for a subagent: delivered blocks with the content as delivered, and
	 * full reads of a nested context file with the content discovery loads (the
	 * read result itself carries line prefixes).
	 */
	async carried(messages: readonly AgentMessage[]): Promise<ContextFileEntry[]> {
		const cwd = path.resolve(this.#host.cwd());
		const byPath = new Map<string, string>();
		const fullReads = new Set<string>();
		for (const message of messages) {
			if (message.role === "developer") {
				for (const match of messageText(message.content).matchAll(BLOCK_RE)) {
					byPath.set(path.resolve(cwd, match[1]), match[2]);
				}
			} else if (message.role === "toolResult" && message.toolName === "read" && !message.isError) {
				const readPath = fullReadPath(message.details);
				if (readPath && isStrictlyBelow(cwd, path.dirname(readPath))) fullReads.add(readPath);
			}
		}
		const unread = [...fullReads].filter(filePath => !byPath.has(filePath));
		if (unread.length > 0) {
			try {
				// Discovery decides which read files are context files, as it does for touches.
				const files = await this.#discover(
					unread.map(filePath => path.dirname(filePath)),
					cwd,
				);
				for (const file of files) {
					if (!fullReads.has(file.path) || byPath.has(file.path)) continue;
					byPath.set(file.path, capContent(file.content, displayPath(cwd, file.path)));
				}
			} catch (error) {
				logger.warn("Nested context discovery failed", { error: String(error) });
			}
		}
		return [...byPath].map(([filePath, content]) => ({ path: filePath, content }));
	}
}

/** The per-file cost bound: content past the cap is cut, with a pointer to the rest. */
function capContent(content: string, display: string): string {
	if (content.length <= NESTED_CONTEXT_FILE_MAX_CHARS) return content;
	return `${content.slice(0, NESTED_CONTEXT_FILE_MAX_CHARS)}\n[truncated at ${NESTED_CONTEXT_FILE_MAX_CHARS} characters; read ${display} for the rest]`;
}

/** Context files the live window already holds, by cwd-relative path. */
function scanWindow(messages: readonly AgentMessage[], cwd: string): Set<string> {
	const loaded = new Set<string>();
	for (const message of messages) {
		if (message.role === "developer") {
			for (const match of messageText(message.content).matchAll(BLOCK_RE)) loaded.add(match[1]);
		} else if (message.role === "toolResult" && message.toolName === "read" && !message.isError) {
			const readPath = fullReadPath(message.details);
			if (readPath) loaded.add(displayPath(cwd, readPath));
		}
	}
	return loaded;
}

/** Whether the system prompt's `<repo-rules>` already carries `filePath`. */
function inSystemPrompt(systemPrompt: readonly string[], filePath: string): boolean {
	const marker = `<file path="${filePath}">`;
	return systemPrompt.some(part => part.includes(marker));
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (isRecord(part) && part.type === "text" && typeof part.text === "string") text += part.text;
	}
	return text;
}

/**
 * Filesystem path a read result covers: `resolvedPath` when the read resolved
 * the input, else the path plain-file reads record in `meta.source`. Undefined
 * for internal URLs (skill://, local://, …) and web reads.
 */
function readDetailsPath(details: Record<string, unknown>): string | undefined {
	const source = isRecord(details.meta) && isRecord(details.meta.source) ? details.meta.source : undefined;
	if (source && source.type !== "path") return undefined;
	if (typeof details.resolvedPath === "string") return path.resolve(details.resolvedPath);
	return typeof source?.value === "string" ? path.resolve(source.value) : undefined;
}

/**
 * Absolute path of a read that showed the whole file: every line from 1 to the
 * end, in order, with nothing truncated, elided, summarised or cut at a column.
 * A tail or range read can start at line 1 and still skip the middle, so the
 * displayed line numbers are the proof.
 */
function fullReadPath(details: unknown): string | undefined {
	if (!isRecord(details) || details.isDirectory === true) return undefined;
	if (details.truncation !== undefined || details.summary !== undefined) return undefined;
	const meta = isRecord(details.meta) ? details.meta : {};
	if (meta.truncation !== undefined) return undefined;
	if (isRecord(meta.limits) && meta.limits.columnTruncated !== undefined) return undefined;
	const display = details.displayContent;
	if (typeof details.totalLines !== "number" || !isRecord(display)) return undefined;
	const lines = display.lineNumbers;
	if (!Array.isArray(lines) || lines.length !== details.totalLines) return undefined;
	if (lines.some((line, index) => line !== index + 1)) return undefined;
	return readDetailsPath(details);
}

/** Absolute paths a write, edit or ast_edit changed, from the tool's own resolved paths where it reports them. */
function editedFiles(ctx: AfterToolCallContext, cwd: string): string[] {
	const details = isRecord(ctx.result.details) ? ctx.result.details : {};
	const args = isRecord(ctx.args) ? ctx.args : {};
	const files = new Set<string>();
	const add = (filePath: unknown, base = cwd): void => {
		if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("://")) return;
		files.add(path.resolve(base, filePath));
	};
	switch (ctx.toolCall.name) {
		case "write":
			add(details.resolvedPath ?? args.path);
			break;
		case "edit":
			add(details.path);
			if (Array.isArray(details.perFileResults)) {
				for (const entry of details.perFileResults) if (isRecord(entry)) add(entry.path);
			}
			break;
		case "ast_edit": {
			const base = typeof details.cwd === "string" ? details.cwd : cwd;
			if (Array.isArray(details.files)) for (const file of details.files) add(file, base);
			break;
		}
	}
	return [...files];
}

/** Directories the call touched: a read's targets, or the parents of the files it edited. */
function touchedDirectories(ctx: AfterToolCallContext, cwd: string, edited: readonly string[]): string[] {
	if (ctx.toolCall.name !== "read") return [...new Set(edited.map(file => path.dirname(file)))];
	const details = isRecord(ctx.result.details) ? ctx.result.details : {};
	const dirs = new Set<string>();
	const resolved = readDetailsPath(details);
	if (resolved) dirs.add(details.isDirectory === true ? resolved : path.dirname(resolved));
	// A grouped read (`a.ts;b/c.ts`) reports each target only as a link.
	if (Array.isArray(details.displayReadTargetLinks)) {
		for (const link of details.displayReadTargetLinks) {
			if (typeof link !== "string" || link.length === 0 || link.includes("://")) continue;
			const target = path.resolve(cwd, link);
			dirs.add(fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() ? target : path.dirname(target));
		}
	}
	return [...dirs];
}

function isStrictlyBelow(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function ancestor(dir: string, levels: number): string {
	let current = dir;
	for (let i = 0; i < levels; i++) current = path.dirname(current);
	return current;
}

function displayPath(cwd: string, target: string): string {
	return path.relative(cwd, target).split(path.sep).join("/");
}
