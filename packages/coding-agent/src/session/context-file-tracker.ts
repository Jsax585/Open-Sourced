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
import { cfgDisabledExtensions } from "../extensibility/settings";
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

function isWithin(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function signature(stat: fs.Stats): string {
	return `${stat.mtimeMs}:${stat.size}`;
}

/** Fits injected content in the same budget a `read` result gets. */
function boundContent(content: string): string {
	const truncated = truncateHead(content, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncated.truncated) return content;
	return `${truncated.content}\n[Truncated: this file is larger than the ${DEFAULT_MAX_BYTES} byte context limit. Read it directly for the rest.]`;
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

	constructor(host: ContextFileTrackerHost) {
		this.#host = host;
	}

	/** Declare the context files the system prompt was just built with; drops earlier tracking. */
	setAmbientFiles(files: readonly ContextFileEntry[]): void {
		const registeredAt = Date.now();
		const next = new Map<string, TrackedFile>();
		for (const file of files) {
			const filePath = path.resolve(file.path);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(filePath);
			} catch {
				continue; // Not backed by a file on disk, so there is nothing to watch.
			}
			if (!stat.isFile()) continue;
			const loadedHash = hashContent(file.content);
			next.set(filePath, {
				loadedHash,
				sig: signature(stat),
				hash: loadedHash,
				content: file.content,
				registeredAt,
			});
		}
		this.#ambient = next;
	}

	/** Forget queued nested files and in-flight discovery, e.g. when the conversation is replaced. */
	reset(): void {
		this.#generation++;
		this.#pending.clear();
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

	#roots(): string[] {
		return [this.#host.cwd(), ...this.#host.additionalDirectories()].map(root => path.resolve(root));
	}

	async #discover(targets: string[], generation: number): Promise<void> {
		const roots = this.#roots();
		const disabledIds = new Set(cfgDisabledExtensions.get(this.#host.settings));
		for (const target of targets) {
			const absolute = path.resolve(target);
			const root = roots.filter(candidate => isWithin(candidate, absolute)).sort((a, b) => b.length - a.length)[0];
			if (!root) continue;
			let directory = absolute;
			try {
				if (!(await fs.promises.stat(absolute)).isDirectory()) directory = path.dirname(absolute);
			} catch {
				continue;
			}
			const found: PendingNested[] = [];
			for (let dir = directory; isWithin(root, dir); dir = path.dirname(dir)) {
				const loaded = await this.#loadDirectory(dir, root, absolute, disabledIds);
				if (loaded) found.push(loaded);
			}
			if (this.#generation !== generation) return;
			for (const entry of found) {
				if (!this.#pending.has(entry.path)) this.#pending.set(entry.path, entry);
			}
		}
	}

	async #loadDirectory(
		dir: string,
		root: string,
		target: string,
		disabledIds: ReadonlySet<string>,
	): Promise<PendingNested | undefined> {
		const relative = path.relative(root, dir).split(path.sep);
		if (relative.some(segment => SKIPPED_DIRECTORY_NAMES.has(segment))) return undefined;
		// The standalone providers ignore files whose parent directory is a dot directory.
		if (path.basename(dir).startsWith(".")) return undefined;
		for (const candidate of NESTED_CONTEXT_FILES) {
			if (!isProviderEnabled(candidate.provider)) continue;
			if (disabledIds.has(`context-file:project:${candidate.name}`)) continue;
			const filePath = path.join(dir, candidate.name);
			if (filePath === target) return undefined; // The model is reading it right now.
			if (this.#ambient.has(filePath) || this.#pending.has(filePath) || this.#nestedInContext(filePath)) {
				return undefined;
			}
			const raw = await readInstructionFile(filePath);
			if (raw === undefined || raw.trim() === "") continue;
			const content = boundContent(await expandAtImports(raw, filePath));
			return {
				path: filePath,
				message: {
					role: "custom",
					customType: NESTED_CONTEXT_MESSAGE_TYPE,
					content: prompt.render(nestedContextPrompt, {
						path: filePath,
						directory: dir,
						target,
						content,
					}),
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
		const content = await expandAtImports(raw, filePath);
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
		for (const [filePath, tracked] of this.#ambient) {
			const effective = delivered.has(filePath) ? (delivered.get(filePath) ?? null) : tracked.loadedHash;
			if (tracked.hash !== null) remaining++;
			if (tracked.hash === effective) continue;
			files.push({ path: filePath, hash: tracked.hash });
			if (tracked.hash === null) removed.push(filePath);
			else updated.push({ path: filePath, content: boundContent(tracked.content ?? "") });
		}
		if (files.length === 0) return undefined;
		return {
			role: "custom",
			customType: CONTEXT_FILE_UPDATE_MESSAGE_TYPE,
			content: prompt.render(contextFileUpdatePrompt, {
				updated,
				removed,
				allRemoved: remaining === 0,
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
