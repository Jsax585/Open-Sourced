/**
 * Cache-key derivation for `tools.approvalMode: always-ask-cached` grants.
 *
 * Shared by every path-based tool (`read`, `write`, `edit`) so one approved
 * target maps to one key: a filesystem path resolved against the session cwd
 * (case-folded on case-insensitive platforms via {@link approvalCacheKeyForPath}),
 * a registered internal URL (`xd://`, `local://`, …) kept in its normalized
 * form, or a readable web URL kept as written.
 */
import { isReadableUrlPath } from "@oh-my-pi/pi-tui/tools/read";
import * as fs from "node:fs";
import * as path from "node:path";
import { InternalUrlRouter } from "../internal-urls/router";
import { approvalCacheKeyForPath } from "./approval-cache";
import { resolveToCwd } from "./path-utils";

/**
 * Whether an exact grant target names a file rather than a directory or a
 * non-filesystem target (an internal or web URL) — the file-flavoured answer is
 * only named for a file. A path nothing occupies yet still counts as a file:
 * approving a write is how its file comes to exist.
 */
export function approvalTargetNamesFile(target: string): boolean {
	const router = InternalUrlRouter.instance();
	const normalized = router.normalize(target);
	if (router.canHandle(normalized) || isReadableUrlPath(target)) return false;
	try {
		return !fs.statSync(target).isDirectory();
	} catch {
		return true;
	}
}

/**
 * The directory an exact target covers for a folder answer: a directory target is
 * the folder itself (a directory read must offer its own directory, never the
 * parent that would grant every sibling), a file target's parent is, and a path
 * nothing occupies yet counts as a file so its parent is offered. `undefined`
 * when the target names no filesystem path.
 */
export function approvalTargetDirectory(target: string): string | undefined {
	const trimmed = target.replace(/[\\/]+$/, "");
	if (trimmed.length === 0) return undefined;
	const router = InternalUrlRouter.instance();
	if (router.canHandle(router.normalize(trimmed)) || isReadableUrlPath(trimmed)) return undefined;
	// A filesystem root is its own directory: stripping its separator leaves POSIX "" and Windows
	// "C:", which names the drive's current directory rather than the root.
	if (path.parse(target).root === target) return target;
	try {
		return fs.statSync(trimmed).isDirectory() ? trimmed : path.dirname(trimmed);
	} catch {
		return path.dirname(trimmed);
	}
}

/**
 * Normalize one tool argument into an approval-cache key, or `undefined` when
 * the argument is empty. Unresolvable-but-non-empty targets fall back to their
 * trimmed text so a grant still sticks to the exact target that was approved.
 */
export function approvalTargetKey(cwd: string, target: string): string | undefined {
	const trimmed = target.trim();
	if (trimmed.length === 0) return undefined;
	const router = InternalUrlRouter.instance();
	const normalized = router.normalize(trimmed);
	if (router.canHandle(normalized)) return normalized;
	if (isReadableUrlPath(trimmed)) return trimmed;
	try {
		return approvalCacheKeyForPath(resolveToCwd(trimmed, cwd));
	} catch {
		// resolveToCwd rejects registered internal URLs; those returned above.
		return trimmed;
	}
}

/** What a folder grant on a directory reaches: its own entries, `limit` of them named. */
export interface ApprovalFolderListing {
	/** Entry names in sort order, a trailing slash marking a folder, `limit` of them at most. */
	readonly entries: readonly string[];
	/** Entries past `limit`, counted but not named. */
	readonly rest: number;
	readonly folders: number;
	readonly files: number;
	readonly total: number;
}

/**
 * The entries directly inside `directory`, as a folder grant covers them — one
 * level deep, since that is as far as a folder grant reaches — for the approval
 * prompt to show what it is about to allow. Directories are marked with a
 * trailing slash (they need their own approval). `undefined` when `directory`
 * is not a readable directory.
 */
export function approvalFolderListing(directory: string, limit: number): ApprovalFolderListing | undefined {
	let dirents: fs.Dirent[];
	try {
		dirents = fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return undefined;
	}
	const sorted = [...dirents].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const entries: string[] = [];
	let folders = 0;
	for (const dirent of sorted) {
		const isFolder = dirent.isDirectory();
		if (isFolder) folders++;
		if (entries.length < limit) entries.push(isFolder ? `${dirent.name}/` : dirent.name);
	}
	return {
		entries,
		rest: sorted.length - entries.length,
		folders,
		files: sorted.length - folders,
		total: sorted.length,
	};
}
