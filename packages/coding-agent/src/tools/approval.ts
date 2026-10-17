/**
 * Tool approval resolution.
 *
 * Approval policy is declared by each tool. This module only knows how to:
 * - normalize user `tools.approval.<tool>: allow | deny | prompt` overrides,
 * - compare a tool capability tier against the active approval mode,
 * - format the generic approval prompt body.
 */
import type { AgentTool, ToolApprovalDecision, ToolTier } from "@oh-my-pi/pi-agent-core";
import * as path from "node:path";
import type { Settings } from "../config/settings";
import type { ExtensionUIContext } from "../extensibility/extensions/types";

import {
	type ApprovalGrantStore,
	type ApprovalGrants,
	type ApprovalTier,
	approvalAncestorDirectoryKeys,
	commonApprovalDirectoryKey,
	getApprovalGrants,
} from "./approval-cache";

import { cfgToolsApproval, cfgToolsApprovalMode } from "./settings";
import { approvalTargetNamesFile } from "./approval-targets";

export type { ToolApproval, ToolApprovalDecision, ToolTier } from "@oh-my-pi/pi-agent-core";
export type { ApprovalGrantStore, ApprovalGrant, ApprovalTier } from "./approval-cache";
export {
	approvalAncestorDirectoryKeys,
	approvalDirectoryCovers,
	approvalDirectoryKey,
	commonApprovalDirectoryKey,
	getApprovalGrants,
} from "./approval-cache";

export type ApprovalPolicy = "allow" | "deny" | "prompt";

/** Every approval mode: the type below and `isApprovalMode` read from one list. */
const APPROVAL_MODES = ["always-ask", "always-ask-cached", "write", "yolo"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** The slice of `AgentToolContext` that approval resolution actually reads. */
export type ApprovalContextSource = {
	autoApprove?: boolean;
	settings?: Settings;
};

export interface ResolvedExecuteTimeApproval {
	approvalMode: ApprovalMode;
	userPolicies: Record<string, unknown>;
}

type ApprovalSubject = Pick<
	AgentTool,
	"name" | "approval" | "formatApprovalDetails" | "approvalCacheTargets" | "approvalCacheScopes"
> & {
	/**
	 * Previous public name of this tool, when a rename changed how it mints.
	 * MCP tools minted before digits were kept carry their digit-stripped name
	 * here so user `deny`/`prompt` policies written against it still apply
	 * (`allow` is deliberately not inherited — see resolveApproval).
	 */
	readonly legacyName?: string;
};

/** Whether a runtime value names a supported approval mode. */
function isApprovalMode(value: unknown): value is ApprovalMode {
	return typeof value === "string" && APPROVAL_MODES.some(mode => mode === value);
}

function asPolicyMap(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/**
 * Resolve approval mode and per-tool user policies from the execute-time
 * `AgentToolContext`.
 *
 * Missing context (or context with no settings and no `--auto-approve`) is
 * fail-closed: `always-ask` with an empty policy map — no user grant. When
 * settings are present, the configured `tools.approvalMode` is used (schema
 * default remains `yolo`). `--auto-approve` still forces `yolo`.
 *
 * Shared by `ExtensionToolWrapper.execute`, `refuseByWritePolicy`,
 * `mcpApprovalPreflight`, and eval prelude host calls so those sites cannot
 * drift. `ExtensionToolWrapper.execute` still inherits the runner's session
 * settings when the caller omits context, so a live session keeps its
 * configured (schema-default `yolo`) grant.
 */
export function resolveApprovalFromContext(context?: ApprovalContextSource | null): ResolvedExecuteTimeApproval {
	if (context?.autoApprove === true) {
		return {
			approvalMode: "yolo",
			userPolicies: context.settings ? asPolicyMap(cfgToolsApproval.get(context.settings)) : {},
		};
	}
	const settings = context?.settings;
	if (!settings) {
		return { approvalMode: "always-ask", userPolicies: {} };
	}
	const configured: unknown = cfgToolsApprovalMode.get(settings);
	return {
		approvalMode: isApprovalMode(configured) ? configured : "yolo",
		userPolicies: asPolicyMap(cfgToolsApproval.get(settings)),
	};
}

export interface ResolvedApproval {
	policy: ApprovalPolicy;
	tier: ToolTier;
	reason?: string;
	override: boolean;
	source?: "tool" | "user" | "mode";
	/**
	 * User-policy key that produced `source: "user"` (defaults to the tool name), or the keyed
	 * sub-tool (an `xd://` device) a tool-owned or mode decision is about.
	 */
	policyKey?: string;
}

const POLICY_VALUES: ReadonlySet<ApprovalPolicy> = new Set(["allow", "deny", "prompt"]);
const TIER_VALUES: ReadonlySet<ToolTier> = new Set(["read", "write", "exec"]);

/** Ordering of capability tiers, least to most privileged. */
export const TIER_RANK: Readonly<Record<ToolTier, number>> = {
	read: 0,
	write: 1,
	exec: 2,
};

/**
 * Fold the per-target decisions of a multi-target write tool (`edit`, `ast_edit`): the first
 * `policy: "deny"` decision wins with its reason (a read-only URL target); otherwise the highest
 * tier, starting from "read".
 */
export function strictestApproval(decisions: Iterable<ToolApprovalDecision>): ToolApprovalDecision {
	let tier: ToolTier = "read";
	for (const decision of decisions) {
		if (typeof decision !== "string" && decision.policy === "deny") return decision;
		const decisionTier = typeof decision === "string" ? decision : decision.tier;
		if (TIER_RANK[decisionTier] > TIER_RANK[tier]) tier = decisionTier;
	}
	return tier;
}

const APPROVAL_MODE_MAX_TIER: Record<ApprovalMode, ToolTier> = {
	"always-ask": "read",
	"always-ask-cached": "read",
	write: "write",
	yolo: "exec",
};

/** Cache targets a tool reports for this call, blanks dropped; empty when the tool declares none. */
function approvalCacheTargets(tool: ApprovalSubject, args: unknown): string[] {
	const raw = tool.approvalCacheTargets?.(args);
	if (!raw) return [];
	const targets: string[] = [];
	for (const target of raw) {
		if (typeof target === "string" && target.length > 0) targets.push(target);
	}
	return targets;
}

/** Directory scopes a tool reports for this call (a tool scoping its approvals to a folder); blanks dropped. */
function approvalCacheScopes(tool: ApprovalSubject, args: unknown): string[] {
	const raw = tool.approvalCacheScopes?.(args);
	if (!raw) return [];
	const scopes: string[] = [];
	for (const scope of raw) {
		if (typeof scope === "string" && scope.length > 0) scopes.push(scope);
	}
	return scopes;
}

/** Whether a grant covers a target key: exact, or through a granted ancestor directory. */
function grantCovers(grants: ApprovalGrantStore, target: string): boolean {
	if (grants.has(target)) return true;
	return approvalAncestorDirectoryKeys(target).some(directory => grants.has(directory));
}

/**
 * Key of an "Approve <tool> for session" grant: the tool's name and nothing
 * else, so no argument or call shape ever enters it.
 */
export function approvalToolKey(toolName: string): string {
	return `tool:${toolName}`;
}

/**
 * Fallback decision for `always-ask-cached` (reached only when no tool or user
 * policy already decided). Grants remember the *file* a read/write touched or a
 * *folder*; command text is never remembered. A call runs without asking when
 * every cache target is approved, when the tool itself is approved by name for
 * the session, or — for tools that opt into directory scopes — when every scope
 * is covered by a folder grant. Anything else prompts, and the recording
 * helpers remember the targets (or the folder) when the user approves. Read-tier tools without cache targets (searches, listings) stay
 * auto-approved exactly as in `always-ask`. An `Approve <tool> for session`
 * grant (see {@link approvalToolKey}) allows every later call of that tool by
 * name; it never covers another tool's calls.
 */
function resolveCachedModeApproval(
	tool: ApprovalSubject,
	args: unknown,
	decision: Omit<ResolvedApproval, "policy"> & { policy?: ApprovalPolicy },
	grants: ApprovalGrantStore,
): ResolvedApproval {
	const base = {
		tier: decision.tier,
		override: false,
		source: "mode" as const,
		...(decision.policyKey ? { policyKey: decision.policyKey } : {}),
	};
	// The tool answer remembers the tool by name for this session, whatever the call.
	if (grants.has(approvalToolKey(tool.name))) return { ...base, policy: "allow" };
	const scopes = approvalCacheScopes(tool, args);
	if (scopes.length > 0 && scopes.every(scope => grantCovers(grants, scope))) {
		return { ...base, policy: "allow" };
	}
	const promptReason = decision.reason ?? (scopes.length > 0 ? "folder not yet approved" : "target not yet approved");
	const targets = approvalCacheTargets(tool, args);
	if (targets.length === 0) {
		if (decision.tier === "read") return { ...base, policy: "allow" };
		return { ...base, policy: "prompt", reason: promptReason };
	}
	if (targets.every(target => grantCovers(grants, target))) return { ...base, policy: "allow" };
	return { ...base, policy: "prompt", reason: promptReason };
}

/**
 * The folder a "remember this folder" approval would grant for this call: the
 * shared directory of its path targets, or the directory scope a tool reports
 * (a shell command's cwd). `undefined` when the call names no filesystem path.
 */
export function approvalFolderCandidate(
	tool: ApprovalSubject,
	args: unknown,
): { key: string; label: string } | undefined {
	const directories: string[] = approvalCacheScopes(tool, args).map(scope => scope.replace(/[\\/]+$/, ""));
	for (const target of approvalCacheTargets(tool, args)) {
		if (!path.isAbsolute(target)) continue;
		directories.push(path.dirname(target));
	}
	const key = commonApprovalDirectoryKey(directories);
	if (key === undefined) return undefined;
	return { key, label: key.replace(/[\\/]+$/, "") };
}

/**
 * Record every cache target of a call the user just approved into `tier`
 * (`session` for a plain approval, `global` for an "Always …" one). No-op for
 * tools without targets and for blank keys, so an approved call never widens a
 * grant beyond the target the prompt showed.
 */
export function recordApprovalCacheTargets(
	tool: ApprovalSubject,
	args: unknown,
	grants: ApprovalGrants,
	tier: ApprovalTier = "session",
): void {
	for (const target of approvalCacheTargets(tool, args)) grants.record(target, tool.name, undefined, tier);
}

/**
 * Record the folder grant a directory answer approved: every read or write
 * below that directory then skips its prompt. Returns the folder's label, or
 * `undefined` when the call names no filesystem path (the caller then falls
 * back to the exact targets).
 */
export function recordApprovalFolderGrant(
	tool: ApprovalSubject,
	args: unknown,
	grants: ApprovalGrants,
	tier: ApprovalTier = "session",
): string | undefined {
	const folder = approvalFolderCandidate(tool, args);
	if (folder === undefined) return undefined;
	grants.record(folder.key, tool.name, "directory", tier);
	return folder.label;
}

const DEFAULT_PROMPT_TRUNCATE_CHARS = 2000;

/** Best-effort conversion of an arbitrary user-supplied value to a policy. */
function normalizePolicy(value: unknown): ApprovalPolicy | undefined {
	if (typeof value !== "string") return undefined;
	const lowered = value.trim().toLowerCase();
	return POLICY_VALUES.has(lowered as ApprovalPolicy) ? (lowered as ApprovalPolicy) : undefined;
}

function isToolTier(value: unknown): value is ToolTier {
	return typeof value === "string" && TIER_VALUES.has(value as ToolTier);
}

function normalizeDecision(value: unknown): Omit<ResolvedApproval, "policy"> & { policy?: ApprovalPolicy } {
	if (isToolTier(value)) {
		return { tier: value, override: false };
	}

	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		const tier = isToolTier(record.tier) ? record.tier : "exec";
		const reason = typeof record.reason === "string" && record.reason.length > 0 ? record.reason : undefined;
		const policy = normalizePolicy(record.policy);
		const policyKey =
			typeof record.policyKey === "string" && record.policyKey.length > 0 ? record.policyKey : undefined;
		return {
			tier,
			override: record.override === true,
			...(policy ? { policy } : {}),
			...(reason ? { reason } : {}),
			...(policyKey ? { policyKey } : {}),
		};
	}

	return { tier: "exec", override: false };
}

function getToolDecision(
	tool: ApprovalSubject,
	args: unknown,
): Omit<ResolvedApproval, "policy"> & { policy?: ApprovalPolicy } {
	const approval = tool.approval;
	const decision: ToolApprovalDecision | undefined = typeof approval === "function" ? approval(args) : approval;
	return normalizeDecision(decision);
}

/**
 * Evaluate a tool's own approval declaration against `args` and return the
 * resulting capability tier, defaulting to `exec` when the tool omits an
 * approval. Unlike reading `tool.approval` directly, this runs function-valued
 * approvals — the write tool's `xd://` gate uses it to take a mounted device's
 * argument-dependent tier instead of falling back to `exec`.
 */
export function resolveToolTier(tool: ApprovalSubject, args: unknown): ToolTier {
	return getToolDecision(tool, args).tier;
}

function modeApprovesTier(mode: ApprovalMode, tier: ToolTier): boolean {
	return TIER_RANK[tier] <= TIER_RANK[APPROVAL_MODE_MAX_TIER[mode]];
}

/**
 * Resolve approval policy for a tool call.
 *
 * Resolution order:
 *  1. Tool `approval(args)` decision, defaulting to tier "exec" when omitted.
 *     A decision may carry a `policyKey` — `tools.approval.<policyKey>` is then
 *     the user override consulted instead of `tools.approval.<tool.name>`, with
 *     the invoking tool's own policy as the fallback when the user set none for
 *     the keyed sub-tool (e.g. an `xd://` device dispatch without a device
 *     policy still honors `tools.approval.write`).
 *  2. User per-tool override, if set and valid.
 *  3. Active mode tier comparison. In `always-ask-cached`, read/write calls and
 *     exec calls whose {@link ApprovalSubject.approvalCacheTargets} are all
 *     present in `grants` are allowed; other read/write/exec calls prompt and
 *     record their targets on approval (see {@link recordApprovalCacheTargets}).
 *
 * In yolo mode, override-based tool prompts are ignored; user `tools.approval`
 * settings remain authoritative.
 */
export function resolveApproval(
	tool: ApprovalSubject,
	args: unknown,
	mode: ApprovalMode,
	userConfig: Record<string, unknown> = {},
	grants: ApprovalGrantStore = getApprovalGrants(),
): ResolvedApproval {
	const decision = getToolDecision(tool, args);
	const policyKey = decision.policyKey ?? tool.name;
	const userPolicy = Object.hasOwn(userConfig, policyKey) ? normalizePolicy(userConfig[policyKey]) : undefined;
	const fallbackPolicy =
		policyKey !== tool.name && userPolicy === undefined && Object.hasOwn(userConfig, tool.name)
			? normalizePolicy(userConfig[tool.name])
			: undefined;
	const effectiveUserPolicy = userPolicy ?? fallbackPolicy;
	const userPolicyKey = userPolicy !== undefined ? policyKey : tool.name;

	// Legacy-name fallback for renamed tools (e.g. MCP mints that gained digits).
	// Fail-closed: only `deny`/`prompt` carry over from the old key, so a
	// forgotten restrictive policy keeps protecting the renamed tool, while a
	// stale `allow` cannot mask a `deny` another user sets under the new name.
	const legacyPolicy =
		effectiveUserPolicy === undefined &&
		typeof tool.legacyName === "string" &&
		tool.legacyName !== tool.name &&
		Object.hasOwn(userConfig, tool.legacyName)
			? normalizePolicy(userConfig[tool.legacyName])
			: undefined;
	const inheritedPolicy = legacyPolicy === "deny" || legacyPolicy === "prompt" ? legacyPolicy : undefined;
	const inheritedPolicyKey = inheritedPolicy !== undefined ? tool.legacyName : undefined;
	const combinedUserPolicy = effectiveUserPolicy ?? inheritedPolicy;
	const combinedUserPolicyKey = effectiveUserPolicy !== undefined ? userPolicyKey : inheritedPolicyKey;

	if (decision.policy === "deny") {
		return {
			policy: "deny",
			tier: decision.tier,
			override: decision.override,
			source: "tool",
			...(decision.policyKey ? { policyKey: decision.policyKey } : {}),
			...(decision.reason ? { reason: decision.reason } : {}),
		};
	}
	if (combinedUserPolicy === "deny") {
		return {
			policy: "deny",
			tier: decision.tier,
			override: decision.override,
			source: "user",
			...(combinedUserPolicyKey ? { policyKey: combinedUserPolicyKey } : {}),
		};
	}

	if (mode === "yolo") {
		if (decision.policy) {
			return {
				policy: decision.policy,
				tier: decision.tier,
				override: false,
				source: "tool",
				...(decision.policyKey ? { policyKey: decision.policyKey } : {}),
				...(decision.reason ? { reason: decision.reason } : {}),
			};
		}
		return {
			policy: combinedUserPolicy ?? "allow",
			tier: decision.tier,
			override: false,
			source: combinedUserPolicy ? "user" : "mode",
			...(combinedUserPolicyKey ? { policyKey: combinedUserPolicyKey } : {}),
		};
	}

	if (decision.override) {
		return {
			policy: decision.policy === "allow" ? "allow" : "prompt",
			tier: decision.tier,
			override: true,
			source: "tool",
			...(decision.policyKey ? { policyKey: decision.policyKey } : {}),
			...(decision.reason ? { reason: decision.reason } : {}),
		};
	}

	if (decision.policy === "allow" || decision.policy === "prompt") {
		return {
			policy: decision.policy,
			tier: decision.tier,
			override: false,
			source: "tool",
			...(decision.policyKey ? { policyKey: decision.policyKey } : {}),
			...(decision.reason ? { reason: decision.reason } : {}),
		};
	}

	if (combinedUserPolicy) {
		return {
			policy: combinedUserPolicy,
			tier: decision.tier,
			override: false,
			source: "user",
			...(combinedUserPolicyKey ? { policyKey: combinedUserPolicyKey } : {}),
		};
	}

	if (mode === "always-ask-cached") {
		return resolveCachedModeApproval(tool, args, decision, grants);
	}

	if (modeApprovesTier(mode, decision.tier)) {
		return { policy: "allow", tier: decision.tier, override: false, source: "mode" };
	}

	return {
		policy: "prompt",
		tier: decision.tier,
		override: false,
		source: "mode",
		...(decision.policyKey ? { policyKey: decision.policyKey } : {}),
		...(decision.reason ? { reason: decision.reason } : {}),
	};
}

/**
 * Error for a resolved deny. Distinguishes tool-owned policy from user config.
 */
export function denyError(resolved: ResolvedApproval, toolName: string): Error {
	const { source, reason, policyKey } = resolved;
	if (source === "tool") {
		return new Error(`Tool "${toolName}" is blocked by tool policy.${reason ? `\nReason: ${reason}` : ""}`);
	}
	return new Error(
		`Tool "${policyKey ?? toolName}" is blocked by user policy.\n` +
			`To allow: remove "tools.approval.${policyKey ?? toolName}: deny" from config.`,
	);
}

/**
 * Check if a tool call requires user approval.
 *
 * @throws Error if policy is 'deny'
 * @returns Object with required flag and optional reason for the prompt
 */
export function requiresApproval(
	tool: ApprovalSubject,
	args: unknown,
	mode: ApprovalMode,
	userConfig: Record<string, unknown> = {},
): { required: boolean; reason?: string } {
	const resolved = resolveApproval(tool, args, mode, userConfig);
	const { policy, reason } = resolved;

	if (policy === "deny") {
		throw denyError(resolved, tool.name);
	}

	if (policy === "prompt") return { required: true, reason };
	return { required: false };
}

export function truncateForPrompt(value: string, maxChars = DEFAULT_PROMPT_TRUNCATE_CHARS): string {
	if (value.length <= maxChars) return value;
	const omitted = value.length - maxChars;
	return `${value.slice(0, maxChars)}[…${omitted}ch elided…]`;
}

/** The prompt's header rows: tool name, MCP origin, and the reason it asks. */
function approvalHeader(tool: ApprovalSubject, reason?: string): string[] {
	const lines = [`Allow tool: ${tool.name}`];

	if (tool.name.startsWith("mcp__") && tool.approval === undefined) {
		lines.push("Origin: MCP server tool");
	}

	if (reason) {
		lines.push(`Reason: ${reason}`);
	}
	return lines;
}

/** The tool's own detail rows for `args` (command, path, content), blanks dropped. */
function approvalDetails(tool: ApprovalSubject, args: unknown): string[] {
	const details = tool.formatApprovalDetails?.(args);
	return (typeof details === "string" ? [details] : (details ?? [])).filter(detail => detail.length > 0);
}

/** Format the approval prompt body shown to the user: the header, then the tool's own details. */
export function formatApprovalPrompt(tool: ApprovalSubject, args: unknown, reason?: string): string {
	return [...approvalHeader(tool, reason), ...approvalDetails(tool, args)].join("\n");
}

/**
 * The details as one row for a prompt that must stay small: each detail's first line, joined
 * by ` · `, ending in `…` when any detail has more lines. A label alone (`Code:`, its body on
 * the following lines) takes the body's first line after it.
 */
function approvalSummary(details: readonly string[]): string | undefined {
	if (details.length === 0) return undefined;
	let omitted = false;
	const heads = details.map(detail => {
		const lines = detail.split("\n", 3);
		const head = lines[0]!.trimEnd();
		const labelOnly = head.endsWith(":") && lines.length > 1;
		if (lines.length > (labelOnly ? 2 : 1)) omitted = true;
		return labelOnly ? `${head} ${lines[1]!.trim()}` : head;
	});
	const row = heads.join(" · ");
	return omitted ? `${row} …` : row;
}

/** Label of the session-scoped answer for an exact target that is not a file (a directory or URL). */
export const APPROVAL_APPROVE_LABEL = "Approve";
/** Label of the cross-instance answer for an exact target that is not a file. */
export const APPROVAL_ALWAYS_LABEL = "Always Approve";
/** Label of the session-scoped answer for a file. */
export const APPROVAL_APPROVE_FILE_LABEL = "Approve File";
/** Label of the cross-instance answer for a file. */
export const APPROVAL_ALWAYS_FILE_LABEL = "Always Approve File";
/** Label of the session-scoped directory answer. */
export const APPROVAL_DIRECTORY_LABEL = "Approve Directory";
/** Label of the cross-instance directory answer. */
export const APPROVAL_ALWAYS_DIRECTORY_LABEL = "Always Approve Directory";
/** Label of the approve-once answer, which runs the call and records nothing. */
export const APPROVAL_ONCE_LABEL = "Approve Once";
/** Label of the denial option. */
export const APPROVAL_DENY_LABEL = "Deny";

/**
 * The exact answer's label: a file target is named for what the grant covers, other targets keep
 * the plain name, and the remember toggle names the cross-instance form in both cases.
 */
export function approvalApproveOptionLabel(fileTarget: boolean, always: boolean): string {
	if (!fileTarget) return always ? APPROVAL_ALWAYS_LABEL : APPROVAL_APPROVE_LABEL;
	return always ? APPROVAL_ALWAYS_FILE_LABEL : APPROVAL_APPROVE_FILE_LABEL;
}

/** Label of the directory answer, which approves the call and remembers its folder. */
export function approvalDirectoryOptionLabel(folderLabel: string, always: boolean): string {
	return `${always ? APPROVAL_ALWAYS_DIRECTORY_LABEL : APPROVAL_DIRECTORY_LABEL}: ${folderLabel}`;
}

/** Label of the tool answer, which approves every later call of that tool in this session. */
export function approvalToolOptionLabel(toolName: string): string {
	return `Approve ${toolName} for session`;
}

/** What an approval prompt answered: denied, or approved with where the grant goes. */
export interface ApprovalOutcome {
	approved: boolean;
	/**
	 * Where the approval's grant goes: `"folder"` for a directory answer, `"tool"` for the
	 * by-name session answer; absent means the call's exact targets are recorded.
	 */
	scope?: "target" | "folder" | "tool";
	/** The user chose an "Always …" answer: the grant goes to the global, persistent cache. */
	global?: boolean;
	/** The "Approve Once" answer: the call runs and no grant is recorded. */
	once?: boolean;
}

/**
 * Ask the user to approve a call: the host's approval dialog when it has one (it gets the full
 * prompt and a compact one with the details summarized to a row, so the composer beneath it
<<<<<<< HEAD
 * keeps its room), else an Approve/Deny select with the full prompt (RPC, ACP, extension hosts).
 * `appendix` lines follow the prompt on both.
 *
 * With `options.cacheAnswers`, the prompt also offers grant answers, each gated by what the call
 * can record: the directory answers need a folder candidate, the "Always …" answers need a
 * cache target, and the tool answer needs a call that is not a file read/write. Prompts a tool
 * or user policy forced pass `cacheAnswers: false` — they are never recorded, so they keep plain
 * Approve/Deny.
 */
export async function requestApproval(
	ui: Pick<ExtensionUIContext, "select" | "approve">,
	tool: ApprovalSubject,
	args: unknown,
	reason?: string,
	appendix: readonly string[] = [],
	options: { cacheAnswers?: boolean } = {},
): Promise<ApprovalOutcome> {
	const header = approvalHeader(tool, reason);
	const details = approvalDetails(tool, args);
	const cacheAnswers = options.cacheAnswers !== false;
	const folderLabel = cacheAnswers ? approvalFolderCandidate(tool, args)?.label : undefined;
	const targets = cacheAnswers ? approvalCacheTargets(tool, args) : [];
	const exactGrant = targets.length > 0;
	// The file name is for file targets only: a directory or URL target keeps the plain
	// "Approve" (it still remembers that target), and only a file names "Approve File".
	const fileGrant = exactGrant && targets.every(approvalTargetNamesFile);
	// A call that names only a directory answers through the directory itself; offering the
	// exact "Approve" beside it would only repeat that grant.
	const exactAnswer = exactGrant && (fileGrant || folderLabel === undefined);
	// Exec and other non-read/write calls without a directory of their own can be remembered by
	// tool name for this session; a command's folder answer already carries its grant.
	const toolName = cacheAnswers && !exactGrant && folderLabel === undefined ? tool.name : undefined;
	const full = [...header, ...details, ...appendix].join("\n");
	if (ui.approve) {
		const summary = approvalSummary(details);
		const compact = [...header, ...(summary === undefined ? [] : [summary]), ...appendix].join("\n");
		const answer = await ui.approve({
			full,
			compact,
			...(folderLabel === undefined ? {} : { folderLabel }),
			...(exactGrant ? { exactGrant, fileTarget: fileGrant, exactAnswer } : {}),
			...(toolName === undefined ? {} : { toolName }),
		});
		if (answer === true) return { approved: true };
		if (typeof answer === "object" && answer.approved === true) {
			return {
				approved: true,
				...(answer.scope === undefined ? {} : { scope: answer.scope }),
				...(answer.global === true ? { global: true } : {}),
			};
		}
		return { approved: false };
	}
	const approveOption = approvalApproveOptionLabel(fileGrant, false);
	if (folderLabel === undefined && !exactGrant && toolName === undefined) {
		return { approved: (await ui.select(full, [approveOption, APPROVAL_DENY_LABEL])) === approveOption };
	}
	const alwaysFileOption = exactAnswer ? approvalApproveOptionLabel(fileGrant, true) : undefined;
	const directoryOption = folderLabel === undefined ? undefined : approvalDirectoryOptionLabel(folderLabel, false);
	const alwaysDirectoryOption =
		folderLabel === undefined ? undefined : approvalDirectoryOptionLabel(folderLabel, true);
	const toolOption = toolName === undefined ? undefined : approvalToolOptionLabel(toolName);
	// "Approve Once" is the approve answer every prompt with grants carries: it records nothing,
	// where a plain "Approve" remembers the call's exact target.
	const onceOption =
		folderLabel !== undefined || exactGrant || toolName !== undefined ? APPROVAL_ONCE_LABEL : undefined;
	const choices = [
		...(directoryOption === undefined ? [] : [directoryOption]),
		...(toolOption === undefined ? [] : [toolOption]),
		...(exactAnswer ? [approveOption] : []),
		...(alwaysDirectoryOption === undefined ? [] : [alwaysDirectoryOption]),
		...(alwaysFileOption === undefined ? [] : [alwaysFileOption]),
		...(onceOption === undefined ? [] : [onceOption]),
		APPROVAL_DENY_LABEL,
	];
	const choice = await ui.select(full, choices);
	if (choice === approveOption) return { approved: true };
	if (onceOption !== undefined && choice === onceOption) return { approved: true, once: true };
	if (toolOption !== undefined && choice === toolOption) return { approved: true, scope: "tool" };
	if (directoryOption !== undefined && choice === directoryOption) return { approved: true, scope: "folder" };
	if (alwaysFileOption !== undefined && choice === alwaysFileOption) return { approved: true, global: true };
	if (alwaysDirectoryOption !== undefined && choice === alwaysDirectoryOption) {
		return { approved: true, scope: "folder", global: true };
	}
	return { approved: false };
}
