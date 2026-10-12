/**
 * Bank ID derivation, project-tag scoping, and first-use bank setup.
 *
 * Three scoping modes (`HindsightConfig.scoping`):
 *   - `global`              — single shared bank, no per-project filter.
 *   - `per-project`         — one bank per cwd basename, hard isolation.
 *   - `per-project-tagged`  — single shared bank, retains carry a `project:<name>`
 *                              tag and recall filters on it but still surfaces
 *                              untagged ("global") memories alongside.
 *
 * The base bank id is `bankIdPrefix-bankId` (default `omp`). Per-project mode
 * appends `-<project>`; tagged mode leaves the bank untouched and uses tags.
 *
 * Bank existence is idempotent at module level — a banksSet keeps track of
 * banks we've already PUT so each session boundary doesn't fire a fresh
 * `createBank` call. The PUT is idempotent server-side, so re-firing on a hot
 * path would only burn round-trips. Failures are swallowed: missing the
 * mission patch is an optimisation, but the bank ITSELF must exist before
 * mental-model bootstrap or the first retain, otherwise the very first POST
 * lands against a missing bank.
 */

import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { logger } from "@oh-my-pi/pi-utils";
import type { HindsightApi } from "./client";
import type { HindsightConfig } from "./config";

const DEFAULT_BANK_NAME = "omp";
/** `{harness}` value: this runtime, matching the coding-agents harness id convention. */
const HARNESS_NAME = "omp";
const PROJECT_TAG_PREFIX = "project:";
const UNKNOWN_PROJECT = "unknown";
const MISSION_SET_CAP = 10_000;

export type RecallTagsMatch = "any" | "all" | "any_strict" | "all_strict";

/**
 * Resolved bank target for a session: which bank to talk to, plus optional
 * tags to attach to retains and to filter recalls by.
 */
export interface BankScope {
	bankId: string;
	/** Tags applied to every retain. Undefined when scoping does not use tags. */
	retainTags?: string[];
	/** Tags filter for recall/reflect. Undefined when scoping does not use tags. */
	recallTags?: string[];
	/** Match mode for `recallTags`. Defaults to `any` so untagged ("global") memories surface too. */
	recallTagsMatch?: RecallTagsMatch;
}

/** Compose the prefixed base bank id (no project segment). */
function baseBankId(config: HindsightConfig): string {
	const base = config.bankId?.trim() || DEFAULT_BANK_NAME;
	const prefix = config.bankIdPrefix?.trim() || "";
	return prefix ? `${prefix}-${base}` : base;
}

/** Placeholder syntax shared with the coding-agents runtime (`core/template.ts`). */
const TEMPLATE_PLACEHOLDER = /\{([a-zA-Z_]+)\}/g;

/** A template carrying one of these has a project axis; without one its bank is shared by design. */
const PROJECT_PLACEHOLDER = /\{(?:gitProject|project)\}/;

/** Repo basename (case preserved) for `{gitProject}`, or null when nothing is nameable. */
function gitProjectName(directory: string): string | null {
	if (!directory) return null;
	const primary = vcs.repo(directory)?.primaryRoot() ?? null;
	return path.basename(primary ?? directory) || null;
}

/**
 * Placeholders `hindsight.bankIdTemplate` understands — the same names the coding-agents
 * runtime resolves, so a template copied from there means the same bank here.
 */
const TEMPLATE_RESOLVERS: Record<string, (directory: string) => string> = {
	/** Worktree-aware repository name: every linked worktree shares one bank. */
	gitProject: directory => gitProjectName(directory) ?? UNKNOWN_PROJECT,
	/** Working-directory basename, no git involved. */
	project: directory => (directory ? path.basename(directory) : "") || UNKNOWN_PROJECT,
	harness: () => HARNESS_NAME,
};

/** Misconfigurations already reported, so a bad setting warns once per process, not per turn. */
const reportedMisconfigurations = new Set<string>();

/** Report a misconfiguration once per process: `computeBankScope` sits on the session hot path. */
function warnOnce(key: string, message: string): void {
	if (reportedMisconfigurations.has(key)) return;
	reportedMisconfigurations.add(key);
	logger.warn(message);
}

/**
 * Expand a `hindsight.bankIdTemplate` so an omp session can address the bank another coding
 * agent already reads — nobody shares memory by guessing a name.
 *
 * `{gitProject}` keeps the name's case: bank ids are matched literally, so lowercasing here
 * would silently fork `General` from `general`. An unknown placeholder resolves to `unknown`
 * and is reported once, because a silent empty string points the session at a bank nobody
 * reads and says nothing about why.
 */
function applyBankIdTemplate(template: string, directory: string): string {
	return template.replace(TEMPLATE_PLACEHOLDER, (token, name: string) => {
		const resolve = TEMPLATE_RESOLVERS[name];
		if (resolve) return resolve(directory);
		const valid = Object.keys(TEMPLATE_RESOLVERS)
			.map(key => `{${key}}`)
			.join(", ");
		warnOnce(
			`unknown-placeholder:${name}`,
			`Hindsight: unknown hindsight.bankIdTemplate placeholder "${token}" — valid: ${valid}`,
		);
		return UNKNOWN_PROJECT;
	});
}

/**
 * Best-effort project label from a working-directory path.
 *
 * When `directory` lives inside a repository we resolve the primary
 * checkout root (or the shared common dir for bare-repo worktrees) via
 * the native VCS adapter and basename that, so every linked
 * worktree of one repo shares the same `project:<name>` tag.
 * Outside a repo (or when resolution fails), fall back to the cwd basename.
 *
 * The basename is lowercased. The label becomes a tag, and Hindsight matches
 * tags literally, so a checkout at `.../General` would otherwise retain into a
 * `project:General` scope that never meets the `project:general` scope every
 * other client of the same bank reads and writes.
 *
 * Sync only: this runs on the hot path of `computeBankScope`, which is
 * exposed as a sync API to callers like `backend.ts` and must stay sync.
 * Native repository discovery never launches a subprocess.
 */
function projectLabel(directory: string): string {
	return gitProjectName(directory)?.toLowerCase() ?? UNKNOWN_PROJECT;
}

/** The tag triple every `per-project-tagged` session retains and recalls with. */
function projectTagScope(directory: string): Pick<BankScope, "retainTags" | "recallTags" | "recallTagsMatch"> {
	const tag = `${PROJECT_TAG_PREFIX}${projectLabel(directory)}`;
	return {
		retainTags: [tag],
		recallTags: [tag],
		// `any` keeps untagged "global" memories visible alongside the
		// project-tagged ones; flip to `*_strict` to harden isolation.
		recallTagsMatch: "any",
	};
}

/**
 * Resolve the active bank target plus optional tag scoping.
 *
 * Always returns a non-empty `bankId`. Tag fields are populated only for
 * `per-project-tagged`.
 */
export function computeBankScope(config: HindsightConfig, directory: string): BankScope {
	const template = config.bankIdTemplate?.trim() || undefined;
	if (template !== undefined && config.scoping === "per-project" && !PROJECT_PLACEHOLDER.test(template)) {
		// `per-project` promises one bank per project, and a template without a project
		// placeholder cannot keep that promise — it would put every project on one untagged
		// bank. Refuse the template for this mode instead of silently dropping the isolation.
		warnOnce(
			`per-project-template:${template}`,
			`Hindsight: hindsight.bankIdTemplate "${template}" has no {gitProject}/{project} placeholder, so per-project scoping ignores it and keeps one bank per project`,
		);
	} else if (template !== undefined) {
		// A template IS the bank id: it supersedes `bankId`/`bankIdPrefix` and the per-project
		// suffix, because it names the project itself — `coding-agent::{gitProject}` with a
		// second segment appended would address a bank that no other agent shares.
		const bankId = applyBankIdTemplate(template, directory);
		return config.scoping === "per-project-tagged" ? { bankId, ...projectTagScope(directory) } : { bankId };
	}
	const base = baseBankId(config);
	switch (config.scoping) {
		case "global":
			return { bankId: base };
		case "per-project":
			return { bankId: `${base}-${projectLabel(directory)}` };
		case "per-project-tagged":
			return { bankId: base, ...projectTagScope(directory) };
	}
}

/**
 * Backwards-compatible thin wrapper: just return the bank id portion of the
 * scope. New code should prefer `computeBankScope` directly so it can also
 * apply the tag fields.
 */
export function deriveBankId(config: HindsightConfig, directory: string): string {
	return computeBankScope(config, directory).bankId;
}

/**
 * Ensure a bank exists, and patch its reflect/retain mission on first use.
 *
 * Idempotent: skips the PUT when the bank id is already in the supplied set.
 * The mission body is optional — when `bankMission` is blank we still PUT to
 * make sure the bank itself is created, so mental-model bootstrap and the
 * first retain don't land against a non-existent bank.
 *
 * The set is capped; on overflow we drop the oldest half so it cannot grow
 * unboundedly across long-lived processes.
 */
export async function ensureBankExists(
	client: HindsightApi,
	bankId: string,
	config: HindsightConfig,
	banksSet: Set<string>,
): Promise<void> {
	if (banksSet.has(bankId)) return;

	const mission = config.bankMission?.trim();
	const retainMission = config.retainMission?.trim();

	try {
		await client.createBank(bankId, {
			reflectMission: mission || undefined,
			retainMission: retainMission || undefined,
		});
		banksSet.add(bankId);
		if (banksSet.size > MISSION_SET_CAP) {
			const keys = [...banksSet].sort();
			for (const key of keys.slice(0, keys.length >> 1)) {
				banksSet.delete(key);
			}
		}
		if (config.debug) {
			logger.debug("Hindsight: ensured bank", { bankId, mission: Boolean(mission) });
		}
	} catch (err) {
		// Bank creation is best-effort; the server may already have it, or the
		// API may reject the call. Either way, downstream retain/recall calls
		// will surface a clearer error if the bank really is missing.
		logger.debug("Hindsight: ensureBankExists failed", { bankId, error: String(err) });
	}
}
