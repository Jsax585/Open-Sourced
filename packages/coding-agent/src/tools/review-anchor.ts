/**
 * Anchor validation for report_finding.
 *
 * A finding whose line range does not touch the patch is effectively invisible:
 * it renders against unrelated code and the reader cannot tell what it refers
 * to. The reviewer prompt already requires the range to overlap the diff, but
 * nothing enforced it.
 *
 * Validation is advisory by construction. The tool cannot know which review
 * mode produced the finding (uncommitted, a specific commit, or a base-branch
 * comparison), so ranges from every plausible source are unioned and a finding
 * is rejected only when it misses all of them. Anything that goes wrong —
 * outside a repo, untracked file, git failure, no context — accepts the
 * finding. A validator that eats real findings is worse than no validator.
 */
import { parseDiffHunks } from "../commit/git/diff";
import * as git from "../utils/git";

export interface LineRange {
	start: number;
	end: number;
}

/** Ranges touched by the patch, on the new side of the diff. */
export function changedRanges(diffText: string, filePath: string): LineRange[] {
	const ranges: LineRange[] = [];
	for (const file of parseDiffHunks(diffText)) {
		if (file.filename !== filePath || file.isBinary) continue;
		for (const hunk of file.hunks) {
			// A pure deletion has newLines === 0. Anchor it to the line the
			// removed code sat above, so findings about deletions have somewhere
			// to land.
			const start = hunk.newStart;
			const end = hunk.newLines === 0 ? hunk.newStart : hunk.newStart + hunk.newLines - 1;
			ranges.push({ start, end });
		}
	}
	return mergeRanges(ranges);
}

function mergeRanges(ranges: LineRange[]): LineRange[] {
	if (ranges.length <= 1) return ranges;
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	const merged: LineRange[] = [sorted[0]];
	for (const range of sorted.slice(1)) {
		const last = merged[merged.length - 1];
		if (range.start <= last.end + 1) {
			last.end = Math.max(last.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}

function overlaps(range: LineRange, ranges: LineRange[]): boolean {
	return ranges.some(r => range.start <= r.end && range.end >= r.start);
}

function formatRanges(ranges: LineRange[]): string {
	return ranges.map(r => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`)).join(", ");
}

/**
 * Collect changed ranges for a file from every diff the finding might be about.
 *
 * Returns an empty array when nothing could be determined, which the caller
 * MUST treat as "accept", not "reject everything".
 */
async function collectRanges(cwd: string, filePath: string, signal?: AbortSignal): Promise<LineRange[]> {
	const diffs = await Promise.all([
		// Uncommitted, unstaged and staged.
		git.diff(cwd, { files: [filePath], allowFailure: true, signal }),
		git.diff(cwd, { files: [filePath], cached: true, allowFailure: true, signal }),
		// The most recent commit, for reviews of a commit rather than a worktree.
		git.diff(cwd, { base: "HEAD~1", head: "HEAD", files: [filePath], allowFailure: true, signal }),
	]).catch(() => []);

	const ranges: LineRange[] = [];
	for (const diffText of diffs) {
		if (typeof diffText !== "string" || !diffText.trim()) continue;
		ranges.push(...changedRanges(diffText, filePath));
	}
	return mergeRanges(ranges);
}

/**
 * Short-lived cache. A reviewer files several findings against one file in
 * quick succession, and re-shelling git for each is wasteful. The TTL keeps
 * that benefit without letting a later review validate against a stale patch —
 * stale ranges would reject good findings, which is the one outcome this
 * module exists to avoid.
 */
const CACHE_TTL_MS = 30_000;

const rangeCache = new Map<string, { at: number; ranges: Promise<LineRange[]> }>();

export function clearAnchorCache(): void {
	rangeCache.clear();
}

export interface AnchorCheck {
	ok: boolean;
	/** Populated only when ok is false. */
	message?: string;
}

/**
 * Check a finding's line range against the patch.
 *
 * Accepts whenever the answer is unknown. Only an affirmative mismatch — the
 * file demonstrably has changed lines, and the finding points outside all of
 * them — produces a rejection.
 */
export async function checkAnchor(
	cwd: string | undefined,
	filePath: string,
	lineStart: number,
	lineEnd: number,
	signal?: AbortSignal,
): Promise<AnchorCheck> {
	if (!cwd) return { ok: true };

	const key = `${cwd}\0${filePath}`;
	const now = Date.now();
	let entry = rangeCache.get(key);
	if (!entry || now - entry.at > CACHE_TTL_MS) {
		entry = { at: now, ranges: collectRanges(cwd, filePath, signal).catch(() => []) };
		rangeCache.set(key, entry);
	}

	const ranges = await entry.ranges;
	// No ranges means the file is untracked, outside a repo, binary, or git
	// failed. None of those are evidence the finding is misplaced.
	if (ranges.length === 0) return { ok: true };

	const range = { start: Math.min(lineStart, lineEnd), end: Math.max(lineStart, lineEnd) };
	if (overlaps(range, ranges)) return { ok: true };

	return {
		ok: false,
		message:
			`Finding rejected: ${filePath}:${lineStart}-${lineEnd} does not overlap the patch. ` +
			`Changed lines in this file: ${formatRanges(ranges)}. ` +
			`Re-anchor the finding to the code the patch actually touched and call report_finding again. ` +
			`If the problem really is in unchanged code, report it against the changed line that exposes it.`,
	};
}
