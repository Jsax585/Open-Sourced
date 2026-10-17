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
