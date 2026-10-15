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
import { InternalUrlRouter } from "../internal-urls/router";
import { approvalCacheKeyForPath } from "./approval-cache";
import { resolveToCwd } from "./path-utils";

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

/**
 * Cache key for an exec call (`bash`): the tool's name plus the exact command
 * text it would run, so approving one command never widens to a different one.
 * Only surrounding whitespace is ignored — everything inside is significant.
 * The working directory and execution plumbing (`pty`, `async`, service name)
 * are not part of the identity, matching `bash.patterns` allow rules, which are
 * also cwd-independent.
 */
export function approvalCommandKey(toolName: string, command: string): string | undefined {
	const trimmed = command.trim();
	if (trimmed.length === 0) return undefined;
	return `${toolName}: ${trimmed}`;
}
