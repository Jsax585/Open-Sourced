/**
 * Persistent per-path approval cache for `tools.approvalMode: always-ask-cached`.
 *
 * The first read/write operation on a target prompts. When the user approves it,
 * the resolved target key is recorded in `approval-cache.json` under the active
 * agent directory (e.g. `~/.omp/agent/approval-cache.json`) so later operations
 * on the same target run without asking again. Exec-tier calls are never cached:
 * they keep prompting on every call, like `always-ask`.
 *
 * IO is best-effort: a corrupt or unreadable file degrades to "nothing approved"
 * and a failed write logs and leaves the in-memory grants intact, so the cache
 * can never block a tool call.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger, normalizePathForComparison } from "@oh-my-pi/pi-utils";

/** File name of the approval cache inside the agent directory. */
export const APPROVAL_CACHE_FILENAME = "approval-cache.json";

/** On-disk shape of the cache file. */
export interface ApprovalCacheFile {
	version: 1;
	/** Normalized target key → grant metadata. */
	paths: Record<string, ApprovalGrant>;
}

export interface ApprovalGrant {
	/** Tool whose call the user approved for this target (`read`, `write`, `edit`, …). */
	tool: string;
	/** ISO timestamp of the approving decision. */
	approvedAt: string;
}

/**
 * Read/write surface `resolveApproval` (checks) and the tool wrapper (records
 * after an interactive approval) share, so both halves of `always-ask-cached`
 * agree on one store.
 */
export interface ApprovalGrantStore {
	readonly filePath: string;
	has(key: string): boolean;
	record(key: string, tool?: string): void;
}

/** Parse a cache file's contents; anything unrecognized yields an empty cache. */
function parseCacheFile(raw: string): ApprovalCacheFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { version: 1, paths: {} };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { version: 1, paths: {} };
	if (
		!("paths" in parsed) ||
		parsed.paths === null ||
		typeof parsed.paths !== "object" ||
		Array.isArray(parsed.paths)
	) {
		return { version: 1, paths: {} };
	}
	const entries: Record<string, ApprovalGrant> = {};
	for (const [key, value] of Object.entries(parsed.paths)) {
		if (key.length === 0 || value === null || typeof value !== "object" || Array.isArray(value)) continue;
		const tool = "tool" in value && typeof value.tool === "string" ? value.tool : "";
		const approvedAt = "approvedAt" in value && typeof value.approvedAt === "string" ? value.approvedAt : "";
		entries[key] = { tool, approvedAt };
	}
	return { version: 1, paths: entries };
}

/** Read a cache file, tolerating a missing file and logging other IO failures. */
function readCacheFile(filePath: string): ApprovalCacheFile {
	try {
		return parseCacheFile(fs.readFileSync(filePath, "utf8"));
	} catch (err) {
		if (!isEnoent(err)) logger.debug("approval cache: unreadable file ignored", { err: String(err), path: filePath });
		return { version: 1, paths: {} };
	}
}

/**
 * JSON-file-backed grant store for one agent directory. Entries load lazily on
 * the first check; writes merge with the on-disk file first so a grant another
 * process recorded since this one loaded is never dropped.
 */
export class ApprovalCache implements ApprovalGrantStore {
	readonly filePath: string;
	#entries: Map<string, ApprovalGrant> | undefined;

	constructor(agentDir: string = getAgentDir()) {
		this.filePath = path.join(agentDir, APPROVAL_CACHE_FILENAME);
	}

	has(key: string): boolean {
		return this.#load().has(key);
	}

	record(key: string, tool = ""): void {
		if (key.length === 0) return;
		const entries = this.#load();
		if (entries.has(key)) return;
		entries.set(key, { tool, approvedAt: new Date().toISOString() });
		this.#persist(entries);
	}

	/** Number of in-memory grants; loads the file on first use. */
	get size(): number {
		return this.#load().size;
	}

	#load(): Map<string, ApprovalGrant> {
		if (this.#entries) return this.#entries;
		this.#entries = new Map(Object.entries(readCacheFile(this.filePath).paths));
		return this.#entries;
	}

	#persist(entries: Map<string, ApprovalGrant>): void {
		try {
			const merged = new Map(Object.entries(readCacheFile(this.filePath).paths));
			for (const [key, grant] of entries) merged.set(key, grant);
			fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
			const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
			const payload: ApprovalCacheFile = { version: 1, paths: Object.fromEntries(merged) };
			fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`);
			fs.renameSync(temporaryPath, this.filePath);
		} catch (err) {
			logger.debug("approval cache: failed to persist", { err: String(err), path: this.filePath });
		}
	}
}

const cachesByDir = new Map<string, ApprovalCache>();

/**
 * Shared grant store for an agent directory. Defaults to the active
 * `getAgentDir()` (honoring `PI_CODING_AGENT_DIR` and named profiles), so the
 * resolver's checks and the wrapper's records land in one file.
 */
export function getApprovalCache(agentDir: string = getAgentDir()): ApprovalCache {
	const resolved = path.resolve(agentDir);
	// String-only key: cheap on the per-call path, and a symlinked agent dir
	// still yields one store because callers pass the directory they resolved.
	const directoryKey = process.platform === "win32" ? resolved.toLowerCase() : resolved;
	let cache = cachesByDir.get(directoryKey);
	if (!cache) {
		cache = new ApprovalCache(resolved);
		cachesByDir.set(directoryKey, cache);
	}
	return cache;
}

/**
 * Cache key for a filesystem target: absolute, symlink-resolved when it exists,
 * and case-folded on case-insensitive platforms, so different spellings of one
 * file hit one grant.
 */
export function approvalCacheKeyForPath(target: string): string {
	return normalizePathForComparison(path.resolve(target));
}
