import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { parseReviewDiffSnapshot, type ReviewDiffSnapshot } from "./diff";

export type LocalReviewKind = "base-branch" | "uncommitted" | "commit";

/** One resolved diff snapshot shared by the annotation view and reviewer prompt until explicit refresh. */
export interface ResolvedReviewTarget {
	/** `patch` is caller-supplied; `pr` keeps the remote diff as its review source. */
	kind: LocalReviewKind | "pr" | "patch";
	mode: string;
	rawDiff: string;
	snapshot: ReviewDiffSnapshot;
	emptyMessage: string;
	filteredMessage?: string;
	diffInstruction?: string;
	contextInstruction?: string;
	/** Reacquire a live source; immutable commit/patch targets omit this capability. */
	refresh?: () => Promise<ResolvedReviewTarget>;
}

export interface ReviewTargetUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export const LOCAL_REVIEW_CHOICES: ReadonlyArray<{ label: string; kind: LocalReviewKind }> = [
	{ label: "1. Review against a base branch (PR Style)", kind: "base-branch" },
	{ label: "2. Review uncommitted changes", kind: "uncommitted" },
	{ label: "3. Review a specific commit", kind: "commit" },
];

const GIT_UNCOMMITTED_DIFF_INSTRUCTION =
	"MUST run both `git diff -- <path>` and `git diff --cached -- <path>` for assigned files";
const JJ_UNCOMMITTED_DIFF_INSTRUCTION = "MUST run `jj --ignore-working-copy diff --git -- <path>` for assigned files";

export function createResolvedReviewTarget(
	kind: ResolvedReviewTarget["kind"],
	mode: string,
	rawDiff: string,
	emptyMessage: string,
	options: Pick<ResolvedReviewTarget, "filteredMessage" | "diffInstruction" | "contextInstruction" | "refresh"> = {},
): ResolvedReviewTarget {
	return {
		kind,
		mode,
		rawDiff,
		snapshot: parseReviewDiffSnapshot(rawDiff),
		emptyMessage,
		...options,
	};
}

/** Rebuild a target from an explicit refreshed patch without mutating its source snapshot. */
export function withRefreshedReviewDiff(target: ResolvedReviewTarget, rawDiff: string): ResolvedReviewTarget {
	return {
		...target,
		rawDiff,
		snapshot: parseReviewDiffSnapshot(rawDiff),
	};
}

export function getReviewTargetIssue(target: ResolvedReviewTarget): string | undefined {
	if (!target.rawDiff.trim()) return target.emptyMessage;
	if (target.snapshot.files.length === 0) {
		return target.filteredMessage ?? "No reviewable files (all changes filtered out)";
	}
	return undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Read staged + unstaged (or jj working-copy) changes; throws when no repository is available. */
export async function readUncommittedReviewTarget(cwd: string): Promise<ResolvedReviewTarget> {
	const repository = vcs.require(cwd);
	const diffText = await repository.uncommittedDiff([]);
	const isJj = repository.kind() === "jj";
	return createResolvedReviewTarget(
		"uncommitted",
		isJj ? "Reviewing JJ working-copy changes" : "Reviewing uncommitted changes (staged + unstaged)",
		diffText,
		isJj || !diffText.trim() ? "No uncommitted changes found" : "No diff content found",
		{
			diffInstruction: isJj ? JJ_UNCOMMITTED_DIFF_INSTRUCTION : GIT_UNCOMMITTED_DIFF_INSTRUCTION,
			refresh: () => readUncommittedReviewTarget(cwd),
		},
	);
}

async function listGitBranches(cwd: string): Promise<string[]> {
	try {
		return await vcs.requireGit(cwd).listBranches(true);
	} catch {
		return [];
	}
}

async function currentGitBranch(cwd: string): Promise<string> {
	try {
		return (await vcs.git(cwd)?.currentBranch()) ?? "HEAD";
	} catch {
		return "HEAD";
	}
}

async function recentCommits(cwd: string, count: number): Promise<string[]> {
	try {
		return await vcs.require(cwd).logOnelines(count);
	} catch {
		return [];
	}
}

async function readBaseBranchDiff(cwd: string, baseBranch: string, headBranch: string): Promise<string | undefined> {
	const repository = vcs.requireGit(cwd);
	const mergeBase = await repository.mergeBase(baseBranch, headBranch);
	if (!mergeBase) return undefined;
	return await repository.diffText({ base: mergeBase, head: headBranch });
}

export async function resolveLocalReviewTarget(
	kind: LocalReviewKind,
	cwd: string,
	ui: ReviewTargetUI,
): Promise<ResolvedReviewTarget | undefined> {
	switch (kind) {
		case "base-branch": {
			const branches = await listGitBranches(cwd);
			if (branches.length === 0) {
				ui.notify("No git branches found", "error");
				return undefined;
			}
			const baseBranch = await ui.select("Select base branch to compare against", branches);
			if (!baseBranch) return undefined;
			const currentBranch = await currentGitBranch(cwd);
			let diffText: string | undefined;
			try {
				diffText = await readBaseBranchDiff(cwd, baseBranch, currentBranch);
			} catch (error) {
				ui.notify(`Failed to get diff: ${errorMessage(error)}`, "error");
				return undefined;
			}
			if (diffText === undefined) {
				ui.notify(`No common history between ${baseBranch} and ${currentBranch}`, "error");
				return undefined;
			}
			const mode = `Reviewing changes between \`${baseBranch}\` and \`${currentBranch}\` (PR-style)`;
			const emptyMessage = `No changes between ${baseBranch} and ${currentBranch}`;
			const refresh = async (): Promise<ResolvedReviewTarget> => {
				const refreshedDiff = await readBaseBranchDiff(cwd, baseBranch, currentBranch);
				if (refreshedDiff === undefined) {
					throw new Error(`No common history between ${baseBranch} and ${currentBranch}`);
				}
				return createResolvedReviewTarget("base-branch", mode, refreshedDiff, emptyMessage, { refresh });
			};
			return createResolvedReviewTarget("base-branch", mode, diffText, emptyMessage, { refresh });
		}
		case "uncommitted":
			try {
				return await readUncommittedReviewTarget(cwd);
			} catch (error) {
				ui.notify(`Failed to get diff: ${errorMessage(error)}`, "error");
				return undefined;
			}
		case "commit": {
			const commits = await recentCommits(cwd, 20);
			if (commits.length === 0) {
				ui.notify("No commits found", "error");
				return undefined;
			}
			const selectedCommit = await ui.select("Select commit to review", commits);
			if (!selectedCommit) return undefined;
			const hash = selectedCommit.split(" ")[0];
			let diffText: string;
			try {
				diffText = (await vcs.requireGit(cwd).showCommit(hash)).data.toString("utf8");
			} catch (error) {
				ui.notify(`Failed to get commit: ${errorMessage(error)}`, "error");
				return undefined;
			}
			return createResolvedReviewTarget(
				"commit",
				`Reviewing commit \`${hash}\``,
				diffText,
				"Commit has no diff content",
				{
					filteredMessage: "No reviewable files in commit (all changes filtered out)",
				},
			);
		}
	}
}
