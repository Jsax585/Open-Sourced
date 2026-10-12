/**
 * Keeps model-visible project instructions current after the system prompt is built.
 *
 * Two jobs, both derived from the conversation that is actually in context so
 * compaction, branch switches and reverts need no bookkeeping of their own:
 *
 * 1. Nested discovery. When `read` touches a file or directory below the
 *    workspace root, the standalone `AGENTS.md` / `CLAUDE.md` files in the
 *    directories between the target and the root are not in the system prompt
 *    (discovery walks up, not down). They are injected once as a hidden
 *    {@link NESTED_CONTEXT_MESSAGE_TYPE} custom message, nearest directory
 *    first, at the next step boundary. A file whose message is still in the
 *    current context is never injected again; once compaction or a revert drops
 *    it, a later read loads it again.
 * 2. Ambient updates. The user-level and ancestor context files loaded at
 *    session start are watched by mtime/size. An edit or deletion produces a
 *    hidden {@link CONTEXT_FILE_UPDATE_MESSAGE_TYPE} message before the next
 *    request. What counts as already delivered is read back from the messages
 *    in context, so a dropped update is delivered again. A read that fails for
 *    a transient reason keeps the last known instructions instead of treating
 *    the file as deleted.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage, AsideMessage } from "@oh-my-pi/pi-agent-core";
import { isEnoent, isEnotdir, isRecord, logger, prompt } from "@oh-my-pi/pi-utils";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { isProviderEnabled } from "../capability";
import type { Settings } from "../config/settings";
import { expandAtImports } from "../discovery/at-imports";
import { isWithin } from "../discovery/helpers";
import { cfgDisabledExtensions } from "../extensibility/settings";
import contextFileTruncatedPrompt from "../prompts/system/context-file-truncated.md" with { type: "text" };
import contextFileUpdatePrompt from "../prompts/system/context-file-update.md" with { type: "text" };
import nestedContextPrompt from "../prompts/system/nested-context.md" with { type: "text" };
import type { ContextFileEntry } from "../tools";
import { readDetailsLinkPath } from "../tools/read";
import { cfgContextFilesLiveUpdates, cfgContextFilesNestedDiscovery } from "./context-settings";
import type { CustomMessage } from "./messages";

export const NESTED_CONTEXT_MESSAGE_TYPE = "nested-context";
export const CONTEXT_FILE_UPDATE_MESSAGE_TYPE = "context-file-update";

/**
 * Standalone project context files, in the order the directory's winner is chosen.
 * These are exactly the names the `agents-md` and `claude-md` discovery providers load.
 */
const NESTED_CONTEXT_FILES = [
	{ name: "AGENTS.md", provider: "agents-md" },
	{ name: "CLAUDE.md", provider: "claude-md" },
] as const;

/** Directories whose instruction files are third-party content, never project instructions. */
const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", ".git"]);

export interface NestedContextDetails {
	path: string;
}

export interface ContextFileUpdateDetails {
	/** `hash` is null when the file no longer provides instructions (deleted or empty). */
	files: Array<{ path: string; hash: string | null }>;
}

export interface ContextFileTrackerHost {
	settings: Settings;
	cwd(): string;
	additionalDirectories(): string[];
	/** The messages the next provider request will carry. */
	messages(): readonly AgentMessage[];
}

interface PendingNested {
	path: string;
	/** Size of the injected instruction text, counted against the batch budget. */
	bytes: number;
	message: CustomMessage<NestedContextDetails>;
}

interface TrackedFile {
	/** Hash of the expanded content the system prompt was built with. */
	loadedHash: string;
	/** Last disk observation that read cleanly. */
	sig: string | null;
	hash: string | null;
	/** Expanded content behind `hash`; null when the file no longer provides instructions. */
	content: string | null;
	/** Messages stamped before this are covered by the loaded content. */
	registeredAt: number;
}

function hashContent(content: string): string {
	return Bun.hash(content).toString(36);
}

/** True when `target` is strictly below `root`: the root itself is not a nested directory. */
function isBelow(root: string, target: string): boolean {
	return path.resolve(root) !== path.resolve(target) && isWithin(root, target);
}

/**
 * True when any directory component of `dir` below `root` is a third-party tree or a dot
 * directory (the standalone providers ignore files whose parent is one). `..draft` is an
 * ordinary name, not a dot directory.
 */
function hasExcludedSegment(root: string, dir: string): boolean {
	return path
		.relative(root, dir)
		.split(path.sep)
		.some(segment => SKIPPED_DIRECTORY_NAMES.has(segment) || (segment.startsWith(".") && !segment.startsWith("..")));
}

/**
 * Resolves symlinks and accepts the result only if it is strictly inside `realRoot` and no
 * physical directory on the way is excluded. A link must not smuggle in files from
 * `node_modules` or from outside the workspace.
 */
async function resolvesInsideWorkspace(realRoot: string, candidate: string, isDirectory: boolean): Promise<boolean> {
	let physical: string;
	try {
		physical = await fs.promises.realpath(candidate);
	} catch {
		return false;
	}
	const directory = isDirectory ? physical : path.dirname(physical);
	return isBelow(realRoot, directory) && !hasExcludedSegment(realRoot, directory);
}

function signature(stat: fs.Stats): string {
	return `${stat.mtimeMs}:${stat.size}`;
}

/** Fits injected content in the same budget a `read` result gets. */
function boundContent(content: string): string {
	const truncated = truncateHead(content, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncated.truncated) return content;
	return prompt.render(contextFileTruncatedPrompt, { content: truncated.content, maxBytes: DEFAULT_MAX_BYTES });
}

function isCustom(message: AgentMessage, customType: string): message is CustomMessage {
	return message.role === "custom" && message.customType === customType;
}

export class ContextFileTracker {
	readonly #host: ContextFileTrackerHost;
	#ambient = new Map<string, TrackedFile>();
	#pending = new Map<string, PendingNested>();
	#inflight = new Set<Promise<void>>();
	#generation = 0;
	/** Loaded entries with no backing file (SDK-supplied content): never watched, but still in force. */
	#unwatched = 0;
	#ambientSeq = 0;

	constructor(host: ContextFileTrackerHost) {
		this.#host = host;
	}

	/** Declare the context files the system prompt was just built with; drops earlier tracking. */
	async setAmbientFiles(files: readonly ContextFileEntry[]): Promise<void> {
		const registeredAt = Date.now();
		const seq = ++this.#ambientSeq;
		const stats = await Promise.all(
			files.map(async file => {
				try {
					return await fs.promises.stat(path.resolve(file.path));
				} catch {
					return undefined; // Not backed by a file on disk, so there is nothing to watch.
				}
			}),
		);
		if (seq !== this.#ambientSeq) return; // A newer declaration superseded this one while it was statting.
		const next = new Map<string, TrackedFile>();
		let unwatched = 0;
		files.forEach((file, index) => {
			const stat = stats[index];
			if (!stat?.isFile()) {
				if (file.content.trim() !== "") unwatched++;
				return;
			}
			const loadedHash = hashContent(file.content);
			next.set(path.resolve(file.path), {
				loadedHash,
				// Unknown until the first refresh reads the file: an edit between prompt discovery and
				// this stat would otherwise be recorded as already loaded and never announced.
				sig: null,
				hash: loadedHash,
				content: file.content,
				registeredAt,
			});
		});
		this.#ambient = next;
		this.#unwatched = unwatched;
	}

	/** Forget queued nested files and in-flight discovery, e.g. when the conversation is replaced. */
	reset(): void {
		this.#generation++;
		this.#pending.clear();
		this.#inflight.clear();
	}

	/** Start nested discovery for a finished `read` call. Returns immediately; {@link takeAsides} awaits it. */
	noteReadResult(result: { details?: unknown } | undefined): void {
		if (!cfgContextFilesNestedDiscovery.get(this.#host.settings)) return;
		const targets = readTargets(result?.details);
		if (targets.length === 0) return;
		const generation = this.#generation;
		const work = this.#discover(targets, generation)
			.catch(error => logger.warn("Nested context discovery failed", { error: String(error) }))
			.finally(() => this.#inflight.delete(work));
		this.#inflight.add(work);
	}

	/**
	 * Messages to fold in at a step boundary that is followed by another model
	 * request. Only the mid-work boundary qualifies: at the final stop boundary
	 * these would start a turn that exists only to acknowledge them.
	 */
	async takeAsides(): Promise<AsideMessage[]> {
		while (this.#inflight.size > 0) await Promise.allSettled(this.#inflight);
		const messages = this.#host.messages();
		if (messages.at(-1)?.role !== "toolResult") {
			this.#pending.clear();
			return [];
		}
		const asides: AsideMessage[] = [];
		// Map order is insertion order: nearest directory first within each read.
		for (const pending of this.#pending.values()) {
			asides.push(() => {
				this.#pending.delete(pending.path);
				return this.#nestedInContext(pending.path) ? null : pending.message;
			});
		}
		const update = await this.#buildUpdate();
		if (update) asides.push(update);
		return asides;
	}

	/** The update to place before the next user-authored prompt, if any watched file changed. */
	async takePromptUpdate(): Promise<CustomMessage<ContextFileUpdateDetails> | undefined> {
		return await this.#buildUpdate();
	}

	#nestedInContext(filePath: string): boolean {
		return this.#host.messages().some(message => {
			return (
				isCustom(message, NESTED_CONTEXT_MESSAGE_TYPE) &&
				isRecord(message.details) &&
				message.details.path === filePath
			);
		});
	}

	/** Whether nested instructions are in the conversation or about to be injected: they still apply. */
	#hasNestedContext(): boolean {
		return (
			this.#pending.size > 0 || this.#host.messages().some(message => isCustom(message, NESTED_CONTEXT_MESSAGE_TYPE))
		);
	}

	#roots(): string[] {
		return [this.#host.cwd(), ...this.#host.additionalDirectories()].map(root => path.resolve(root));
	}

	async #discover(targets: string[], generation: number): Promise<void> {
		const roots = this.#roots();
		const disabledIds = new Set(cfgDisabledExtensions.get(this.#host.settings));
		for (const target of targets) {
			const absolute = path.resolve(target);
			const root = roots.filter(candidate => isBelow(candidate, absolute)).sort((a, b) => b.length - a.length)[0];
			if (!root) continue;
			let realRoot: string;
			try {
				realRoot = await fs.promises.realpath(root);
			} catch {
				continue;
			}
			let directory = absolute;
			try {
				if (!(await fs.promises.stat(absolute)).isDirectory()) directory = path.dirname(absolute);
			} catch {
				continue;
			}
			const found: PendingNested[] = [];
			for (let dir = directory; isBelow(root, dir); dir = path.dirname(dir)) {
				const loaded = await this.#loadDirectory(dir, root, realRoot, absolute, disabledIds);
				if (loaded) found.push(loaded);
			}
			if (this.#generation !== generation) return;
			// One read can surface several ancestor files, and the step-boundary path appends the whole
			// batch without a size check. Keep the batch within one read's budget, nearest first;
			// files that do not fit stay undiscovered and load on a later read.
			let queuedBytes = 0;
			for (const queued of this.#pending.values()) queuedBytes += queued.bytes;
			for (const entry of found) {
				if (this.#pending.has(entry.path)) continue;
				if (queuedBytes > 0 && queuedBytes + entry.bytes > DEFAULT_MAX_BYTES) break;
				queuedBytes += entry.bytes;
				this.#pending.set(entry.path, entry);
			}
		}
	}

	async #loadDirectory(
		dir: string,
		root: string,
		realRoot: string,
		target: string,
		disabledIds: ReadonlySet<string>,
	): Promise<PendingNested | undefined> {
		if (hasExcludedSegment(root, dir)) return undefined;
		if (!(await resolvesInsideWorkspace(realRoot, dir, true))) return undefined;
		for (const candidate of NESTED_CONTEXT_FILES) {
			if (!isProviderEnabled(candidate.provider)) continue;
			if (disabledIds.has(`context-file:project:${candidate.name}`)) continue;
			const filePath = path.join(dir, candidate.name);
			if (filePath === target) return undefined; // The model is reading it right now.
			if (this.#ambient.has(filePath) || this.#pending.has(filePath) || this.#nestedInContext(filePath)) {
				return undefined;
			}
			if (!(await resolvesInsideWorkspace(realRoot, filePath, false))) continue;
			const raw = await readInstructionFile(filePath);
			if (raw === undefined || raw.trim() === "") continue;
			const content = boundContent(await expandAtImports(raw, filePath, { uncached: true }));
			// Each notice repeats the file, directory and target paths, so budget the rendered text.
			const rendered = prompt.render(nestedContextPrompt, {
				path: filePath,
				directory: dir,
				target,
				content,
			});
			return {
				path: filePath,
				bytes: Buffer.byteLength(rendered),
				message: {
					role: "custom",
					customType: NESTED_CONTEXT_MESSAGE_TYPE,
					content: rendered,
					details: { path: filePath },
					attribution: "agent",
					display: false,
					timestamp: Date.now(),
				},
			};
		}
		return undefined;
	}

	/** Latest hash the model was told about per watched file, from messages still in context. */
	#deliveredHashes(): Map<string, string | null> {
		const delivered = new Map<string, string | null>();
		for (const message of this.#host.messages()) {
			if (!isCustom(message, CONTEXT_FILE_UPDATE_MESSAGE_TYPE)) continue;
			if (!isRecord(message.details) || !Array.isArray(message.details.files)) continue;
			for (const file of message.details.files) {
				if (!isRecord(file) || typeof file.path !== "string") continue;
				const tracked = this.#ambient.get(file.path);
				// Updates from before the prompt was last rebuilt are subsumed by it.
				if (tracked && message.timestamp >= tracked.registeredAt) {
					delivered.set(file.path, typeof file.hash === "string" ? file.hash : null);
				}
			}
		}
		return delivered;
	}

	async #refreshDisk(filePath: string, tracked: TrackedFile): Promise<void> {
		let stat: fs.Stats;
		try {
			stat = await fs.promises.stat(filePath);
		} catch (error) {
			if (isEnoent(error) || isEnotdir(error)) {
				tracked.sig = null;
				tracked.hash = null;
				tracked.content = null;
			}
			return; // Anything else (EACCES, EIO, ...) is transient: keep the last known state.
		}
		if (!stat.isFile()) {
			tracked.sig = null;
			tracked.hash = null;
			tracked.content = null;
			return;
		}
		const sig = signature(stat);
		if (sig === tracked.sig) return;
		let raw: string;
		try {
			raw = await Bun.file(filePath).text();
		} catch {
			return; // Keep the last known state and retry on the next check.
		}
		const content = await expandAtImports(raw, filePath, { uncached: true });
		tracked.sig = sig;
		tracked.hash = content.trim() === "" ? null : hashContent(content);
		tracked.content = content;
	}

	async #buildUpdate(): Promise<CustomMessage<ContextFileUpdateDetails> | undefined> {
		if (this.#ambient.size === 0 || !cfgContextFilesLiveUpdates.get(this.#host.settings)) return undefined;
		await Promise.all([...this.#ambient].map(([filePath, tracked]) => this.#refreshDisk(filePath, tracked)));
		const delivered = this.#deliveredHashes();
		const updated: Array<{ path: string; content: string }> = [];
		const removed: string[] = [];
		const files: ContextFileUpdateDetails["files"] = [];
		let remaining = 0;
		let updatedBytes = 0;
		for (const [filePath, tracked] of this.#ambient) {
			const effective = delivered.has(filePath) ? (delivered.get(filePath) ?? null) : tracked.loadedHash;
			if (tracked.hash !== null) remaining++;
			if (tracked.hash === effective) continue;
			if (tracked.hash === null) {
				files.push({ path: filePath, hash: null });
				removed.push(filePath);
				continue;
			}
			// The step-boundary path appends this message without a size check, so one update shares a
			// single read-sized budget. Files that do not fit stay undelivered and follow in the next update.
			const content = boundContent(tracked.content ?? "");
			const bytes = Buffer.byteLength(content) + Buffer.byteLength(filePath);
			if (updated.length > 0 && updatedBytes + bytes > DEFAULT_MAX_BYTES) continue;
			updatedBytes += bytes;
			files.push({ path: filePath, hash: tracked.hash });
			updated.push({ path: filePath, content });
		}
		if (files.length === 0) return undefined;
		return {
			role: "custom",
			customType: CONTEXT_FILE_UPDATE_MESSAGE_TYPE,
			content: prompt.render(contextFileUpdatePrompt, {
				updated,
				removed,
				allRemoved: remaining + this.#unwatched === 0 && !this.#hasNestedContext(),
			}),
			details: { files },
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		};
	}
}

async function readInstructionFile(filePath: string): Promise<string | undefined> {
	try {
		const stat = await fs.promises.stat(filePath);
		if (!stat.isFile()) return undefined;
		return await Bun.file(filePath).text();
	} catch {
		return undefined;
	}
}

/** Filesystem paths a finished `read` call touched, including each part of a multi-file read. */
function readTargets(details: unknown): string[] {
	if (!isRecord(details)) return [];
	const targets = new Set<string>();
	if (Array.isArray(details.displayReadTargetLinks)) {
		for (const link of details.displayReadTargetLinks) if (typeof link === "string") targets.add(link);
	}
	const single = readDetailsLinkPath(details);
	if (single) targets.add(single);
	return [...targets];
}
