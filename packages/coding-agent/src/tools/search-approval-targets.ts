/**
 * Cache-target keys for the read-tier search tools (`grep`, `glob`) under
 * `tools.approvalMode: always-ask-cached`.
 *
 * Neither tool names one file the way `read`/`write`/`edit` do: a call is
 * scoped to one or more search roots — a folder, a file, or a glob whose
 * non-glob base is the folder actually walked. With no targets reported, the
 * cached mode auto-allowed both tools, so the file contents a `read` would
 * prompt for leaked through a search of the same path. One key per root closes
 * that: a folder root reports the folder key (so one grant covers every file
 * below it), a file root reports the file key a `read` of it mints, and a grant
 * recorded from either tool covers the other.
 */
import { isReadableUrlPath } from "@oh-my-pi/pi-tui/tools/read";
import * as fs from "node:fs";
import { InternalUrlRouter } from "../internal-urls/router";
import { approvalDirectoryKey } from "./approval-cache";
import { approvalTargetKey } from "./approval-targets";
import { normalizePathLikeInput, resolveToCwd } from "./path-utils";

/**
 * Approval-cache keys for one search call, or `undefined` when no root resolves
 * to anything rememberable.
 *
 * `splitBase` is the calling tool's own root parser ({@link parseSearchPath} for
 * `grep`, {@link parseFindPattern} for `glob`), so a glob root reports the
 * folder the tool actually walks instead of the pattern. Nothing here expands a
 * glob, materializes an archive member, or walks a directory: each root costs at
 * most one `statSync`. An omitted `path` makes the tool search the session cwd,
 * so that folder is reported too; a supplied root that resolves to nothing —
 * a public web URL (whose contents are public already, the contract `read`
 * follows), an unreadable target, or a missing path — contributes no key.
 */
export function searchApprovalCacheTargets(
	roots: readonly string[],
	cwd: string,
	splitBase: (root: string) => string,
): readonly string[] | undefined {
	const keys = new Set<string>();
	// Both tools search `.` when no path argument was supplied, so the fallback
	// root below is the folder the call really runs in.
	for (const rawRoot of roots.length > 0 ? roots : ["."]) {
		const root = normalizePathLikeInput(rawRoot);
		if (root.length === 0) continue;
		const key = searchRootApprovalKey(normalizePathLikeInput(splitBase(root)), cwd);
		if (key !== undefined) keys.add(key);
	}
	return keys.size > 0 ? [...keys] : undefined;
}

/**
 * One cache key for a resolution-ready search root: a directory reports the
 * directory key (a trailing separator, so a grant on it covers every target
 * below it), a file reports the file key a `read` of it would mint, and a
 * registered internal URL keeps its normalized form. `undefined` for anything
 * else — a public web URL, or a root that does not resolve or does not exist.
 */
function searchRootApprovalKey(root: string, cwd: string): string | undefined {
	if (root.length === 0 || isReadableUrlPath(root)) return undefined;
	const router = InternalUrlRouter.instance();
	if (router.canHandle(router.normalize(root))) return approvalTargetKey(cwd, root);
	let absolute: string;
	try {
		absolute = resolveToCwd(root, cwd);
	} catch {
		// resolveToCwd rejects unknown URL schemes; there is no filesystem target to key.
		return undefined;
	}
	try {
		return fs.statSync(absolute).isDirectory() ? approvalDirectoryKey(absolute) : approvalTargetKey(cwd, root);
	} catch {
		// The search of a path that does not exist finds nothing and errors out;
		// nothing about it is worth remembering.
		return undefined;
	}
}
