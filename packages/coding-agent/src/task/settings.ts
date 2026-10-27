/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { t } from "@oh-my-pi/pi-utils/i18n";
import { type OAuthAccountPools, validateAgentAccountPools } from "../config/account-pools";
import {
	type AgentCompactionThresholdOverride,
	validateAgentCompactionThresholdOverrides,
} from "../config/compaction-threshold";
import { effect, register } from "../config/registry";
import { type ServiceTierInheritSettingValue, validateAgentServiceTierOverrides } from "../config/service-tier";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { isRecord, logger, setWorktreesDir } from "@oh-my-pi/pi-utils";
import { setFeedModelBadgeEnabled } from "@oh-my-pi/pi-tui/render/render-utils";
import { getThinkingLevelMetadata } from "@oh-my-pi/pi-tui/thinking";

const EMPTY_AGENT_SERVICE_TIER_OVERRIDES: Record<string, ServiceTierInheritSettingValue> = {};
const EMPTY_AGENT_COMPACTION_THRESHOLD_OVERRIDES: Record<string, AgentCompactionThresholdOverride> = {};
const EMPTY_AGENT_ACCOUNT_POOLS: Record<string, OAuthAccountPools> = {};
const EMPTY_AGENT_SOFT_REQUEST_BUDGET: Record<string, number | null> = {};

const DEFAULT_AGENT_MODEL_OVERRIDES: Record<string, string | string[]> = {};

// Delegation. Task and isolation settings declare `protocolDefault`: protocol hosts get neutral
// defaults instead of the local user's interactive preferences.
export const cfgTaskIsolationEnabled = register({
	id: "task.isolation.enabled",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: t("Allow Isolated Subagents"),
		description: t("Allow per-task isolation with `isolated: true`; tasks without it run in the shared checkout"),
	},
});

export const cfgIsolationBackend = register({
	id: "isolation.backend",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["auto", "apfs", "btrfs", "zfs", "reflink", "overlayfs", "projfs", "block-clone", "rcopy"] as const,
	default: "auto",
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: t("Isolation Backend"),
		description: t("Backend used for subagent isolation and worktree cloning"),
		options: [
			{ value: "auto", label: t("Auto"), description: t("Let the PAL pick the best available backend") },
			{ value: "apfs", label: "APFS", description: t("macOS clonefile reflink (APFS)") },
			{ value: "btrfs", label: "btrfs", description: t("btrfs subvolume snapshot") },
			{ value: "zfs", label: "ZFS", description: t("ZFS snapshot + clone") },
			{ value: "reflink", label: t("Reflink"), description: t("Linux FICLONE per-file reflink") },
			{
				value: "overlayfs",
				label: "Overlayfs",
				description: t("Linux kernel overlay (or fuse-overlayfs fallback)"),
			},
			{ value: "projfs", label: "ProjFS", description: t("Windows Projected File System") },
			{
				value: "block-clone",
				label: t("Block clone"),
				description: "Windows FSCTL_DUPLICATE_EXTENTS_TO_FILE (NTFS/ReFS)",
			},
			{
				value: "rcopy",
				label: t("Recursive copy"),
				description: t("git worktree if available, otherwise recursive copy"),
			},
		],
	},
});

export const cfgWorktreeClone = register({
	id: "worktree.clone",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: t("Clone Checkout into Worktrees"),
		description:
			t("New worktrees from `github pr_checkout` and `git worktree add` in bash start as a copy-on-write clone of the current checkout so ignored build artifacts (node_modules, target) carry over; falls back to a plain checkout when the filesystem cannot clone"),
	},
});

export const cfgWorktreeCleanSource = register({
	id: "worktree.cleanSource",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: t("Clean Source Checkout on /wt"),
		description:
			t("When creating a worktree with `/wt`, reset tracked changes and remove untracked files from the original checkout after carrying them over"),
	},
});

export const cfgWorktreeOnStart = register({
	id: "worktree.onStart",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["off", "ask", "create"] as const,
	default: "off",
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: t("Worktree on Start"),
		description: t("Whether fresh interactive sessions start in a new linked worktree"),
		options: [
			{ value: "off", label: t("Off"), description: t("Start in the current checkout") },
			{ value: "ask", label: t("Ask"), description: t("Ask at session start") },
			{ value: "create", label: t("Create"), description: t("Always start in a new worktree on a `wt/*` branch") },
		],
	},
});

export const cfgWorktreeOnExit = register({
	id: "worktree.onExit",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["keep", "ask", "remove"] as const,
	default: "keep",
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: t("Worktree on Exit"),
		description: t("What to do on exit with worktrees created since omp started (on start or with `/wt`)"),
		options: [
			{ value: "keep", label: t("Keep"), description: t("Leave worktrees in place") },
			{ value: "ask", label: t("Ask"), description: t("Ask on exit") },
			{
				value: "remove",
				label: t("Remove"),
				description:
					t("Remove clean worktrees; ask when they have uncommitted changes or new commits. Gitignored files (e.g. `.env`) are deleted too"),
			},
		],
	},
});

export const cfgTaskIsolationApply = register({
	id: "task.isolation.apply",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: t("Apply Isolated Changes"),
		description:
			t("Automatically apply successful isolated task changes to the parent checkout; disable to retain patch or branch artifacts"),
	},
});

export const cfgTaskIsolationMerge = register({
	id: "task.isolation.merge",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["patch", "branch"] as const,
	default: "patch",
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: t("Isolation Merge Strategy"),
		description: t("How isolated task changes are integrated (patch apply or branch merge)"),
		options: [
			{ value: "patch", label: t("Patch"), description: t("Combine diffs and git apply") },
			{ value: "branch", label: t("Branch"), description: t("Commit per task, merge with --no-ff") },
		],
	},
});

export const cfgTaskIsolationCommits = register({
	id: "task.isolation.commits",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["generic", "ai"] as const,
	default: "generic",
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: t("Isolation Commit Style"),
		description: t("Commit message style for nested repo changes (generic or AI-generated)"),
		options: [
			{ value: "generic", label: t("Generic"), description: t("Static commit message") },
			{ value: "ai", label: "AI", description: t("AI-generated commit message from diff") },
		],
	},
});

export const cfgWorktreeBase = register({
	id: "worktree.base",
	type: "string",
	default: undefined,
	ui: {
		tab: "tasks",
		group: "Isolation",
		label: t("Worktree Base Directory"),
		description:
			t("Base directory for agent-managed worktrees — task-isolation copies, `github` PR checkouts, and `omp worktree` cleanup all live here. Unset uses ~/.omp/wt. Must be an absolute or ~-relative path; relative paths are ignored. The OMP_WORKTREE_DIR env var overrides this."),
	},
});
effect(cfgWorktreeBase, value => {
	const dir = value?.trim() ? value : undefined;
	// Always applied, so an unset/empty value clears a previous override. setWorktreesDir expands `~`,
	// rejects relative paths, and returns the applied absolute path (undefined when cleared/rejected).
	if (!setWorktreesDir(dir) && dir) {
		logger.warn("Settings: worktree.base must be an absolute or ~-relative path; ignoring", { value: dir });
	}
});

export const cfgTaskEager = register({
	id: "task.eager",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["default", "preferred", "always"] as const,
	default: "default",
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: t("Prefer Task Delegation"),
		description: t("How strongly to push delegating work to subagents"),
		options: [
			{
				value: "default",
				label: t("Default\u0004packages/coding-agent/src/edit/settings.ts:cfgEditFuzzyThreshold.ui.options.description"),
				description: t("Uses the selected model's policy; some models require an explicit delegation request"),
			},
			{ value: "preferred", label: t("Preferred"), description: t("Adds delegation guidance to the system prompt") },
			{ value: "always", label: t("Always"), description: t("Prompt guidance plus a first-turn delegation reminder") },
		],
	},
});

export const cfgTaskBatch = register({
	id: "task.batch",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: t("Batch Task Calls"),
		description:
			t("Switch the task tool to its batch shape: one call carries { context, tasks[] } — one subagent per item, with an optional per-item agent (defaulting to the session spawn-policy agent), per-item isolation, and a required shared context prepended to every assignment. With async.enabled=true, each spawn runs as an independent background agent with the normal idle/parked lifecycle; otherwise the call blocks for merged results. Disable to restore the flat single-spawn schema."),
	},
});

export const cfgTaskStructured = register({
	id: "task.structured",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: t("Structured Task Results"),
		description:
			t("Expose outputSchema/schemaMode on the task tool and return subagent results through the yield tool, validated against caller or agent output schemas. Off: task subagents have no yield tool and return their final message as plain text, except agents whose definition sets structured: true. Eval agent()/workpool spawns always keep structured results."),
	},
});

export const cfgTaskSpeculativeLaunch = register({
	id: "task.speculativeLaunch",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: t("Speculative Task Launch"),
		description:
			t("Start each batch subagent as soon as its tasks[] item finishes streaming instead of waiting for the whole task call. Launched agents are aborted if the finished call fails validation, is blocked, or its arguments change. Requires auto-allowed task approval and no extension tool lifecycle handlers."),
	},
});

export const cfgTaskEnableEffort = register({
	id: "task.enableEffort",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: t("Per-Task Effort"),
		description:
			t("Expose the optional effort parameter on task spawns, allowing callers to override each subagent's thinking level"),
	},
});

export const cfgTaskMaxConcurrency = register({
	id: "task.maxConcurrency",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: 32,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: t("Max Concurrent Tasks"),
		description: t("Maximum number of subagents running concurrently"),
		options: [
			{ value: "0", label: t("Unlimited") },
			{ value: "1", label: t("1 task") },
			{ value: "2", label: t("2 tasks") },
			{ value: "4", label: t("4 tasks") },
			{ value: "8", label: t("8 tasks") },
			{ value: "16", label: t("16 tasks") },
			{ value: "32", label: t("32 tasks") },
			{ value: "64", label: t("64 tasks") },
		],
	},
});

export const cfgTaskEnableLsp = register({
	id: "task.enableLsp",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: t("LSP in Subagents"),
		description:
			t("Allow subagents spawned via the task tool to use the lsp tool. Off by default to keep subagents cheap; enable when LSP-aware delegation is worth the extra tokens."),
	},
});

export const cfgTaskMaxRecursionDepth = register({
	id: "task.maxRecursionDepth",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: 2,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: t("Max Task Recursion"),
		description: t("How many levels deep subagents can spawn their own subagents"),
		options: [
			{ value: "-1", label: t("Unlimited") },
			{ value: "0", label: t("None") },
			{ value: "1", label: t("Single") },
			{ value: "2", label: t("Double") },
			{ value: "3", label: t("Triple") },
		],
	},
});

export const cfgTaskMaxRuntimeMs = register({
	id: "task.maxRuntimeMs",
	type: "number",
	default: 0,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: t("Max Subagent Runtime"),
		description:
			t("Hard wall-clock limit per subagent (ms). 0 disables it. Defense-in-depth against provider-side stream hangs that escape the inference-layer watchdog; triggers a normal subagent abort with a 'timed out' reason."),
		options: [
			{ value: "0", label: t("Unlimited"), description: t("Default\u0004packages/coding-agent/src/edit/settings.ts:cfgEditFuzzyThreshold.ui.options.description") },
			{ value: "300000", label: t("5 minutes") },
			{ value: "900000", label: t("15 minutes") },
			{ value: "1800000", label: t("30 minutes") },
			{ value: "3600000", label: t("1 hour") },
		],
	},
});

export const cfgTaskCompletionProbe = register({
	id: "task.completionProbe",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: t("Subagent Completion Probe"),
		description:
			t("Ask a working subagent, through a cached side request like /btw, to estimate how complete its task is: after 2, 5, 10 and 30 more minutes, then hourly. The estimate shows next to the subagent in wait and task views. Only subagents spawned by the main agent of an interactive session are asked; print, RPC, ACP and SDK runs never probe."),
	},
});

export const cfgTaskAgentIdleTtlMs = register({
	id: "task.agentIdleTtlMs",
	type: "number",
	default: 420_000,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: t("Agent Idle TTL"),
		description:
			t("How long an idle subagent stays live in memory before being parked to disk (ms). Parked agents are revived automatically when messaged or resumed. 0 keeps idle agents live until exit."),
	},
});

export const cfgTaskSoftRequestBudget = register({
	id: "task.softRequestBudget",
	type: "number",
	default: 200,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: t("Soft Subagent Request Budget"),
		description:
			t("Soft per-subagent request budget (assistant requests per run). Crossing it injects a wrap-up steering notice (see task.softRequestBudgetNotice); at 1.5x the budget the run is force-stopped and the agent must hand back its partial findings. 0 disables the guard. Bundled scout/sonic agents cap out at a lower built-in budget, so a value below that cap still applies to them. A task.agentSoftRequestBudget entry replaces this budget for the agent it names."),
		options: [
			{ value: "0", label: t("Disabled\u0004packages/coding-agent/src/modes/settings.ts:cfgDisplayShimmer.ui.options.label") },
			{ value: "90", label: t("90 requests") },
			{ value: "150", label: t("150 requests") },
			{ value: "200", label: t("200 requests"), description: t("Default\u0004packages/coding-agent/src/edit/settings.ts:cfgEditFuzzyThreshold.ui.options.description") },
		],
	},
});

/**
 * Validates `task.agentSoftRequestBudget`: exact agent name → request budget,
 * a non-negative integer (0 disables that agent's guard). A `null` entry clears
 * one inherited from a lower-priority settings layer.
 */
function validateAgentSoftRequestBudget(value: unknown): void {
	if (value === undefined || value === null) return;
	if (!isRecord(value)) {
		const received = Array.isArray(value) ? t("an array") : t("a {0}", `${typeof value}`);
		throw new Error(
			t("Invalid task.agentSoftRequestBudget: expected a map of agent name to request budget, got {0}.", `${received}`),
		);
	}
	for (const [agentName, budget] of Object.entries(value)) {
		if (budget === null || (typeof budget === "number" && Number.isSafeInteger(budget) && budget >= 0)) continue;
		throw new Error(
			t("Invalid task.agentSoftRequestBudget.{0}: expected a non-negative integer request count (0 disables the guard), got {1}.", `${agentName}`, `${Bun.inspect(budget)}`),
		);
	}
}

export const cfgTaskAgentSoftRequestBudget = register({
	id: "task.agentSoftRequestBudget",
	type: "record",
	default: EMPTY_AGENT_SOFT_REQUEST_BUDGET,
	validate: validateAgentSoftRequestBudget,
});

export const cfgTaskSoftRequestBudgetNotice = register({
	id: "task.softRequestBudgetNotice",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: t("Soft Request Budget Notice"),
		description:
			t("Inject one steering notice when a subagent crosses its soft request budget, asking it to wrap up before the 1.5x forced-yield stop."),
	},
});

export const cfgTaskMaxEffort = register({
	id: "task.maxEffort",
	type: "enum",
	values: THINKING_EFFORTS,
	default: "max",
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: t("Maximum Per-Spawn Effort"),
		description:
			t("Maximum reasoning effort allowed for the task tool's per-spawn effort hint. Lower values prevent callers from escalating subagents above this ceiling; the default preserves the model's full range."),
		options: THINKING_EFFORTS.map(getThinkingLevelMetadata),
	},
});

export const cfgTaskDisabledAgents = register({
	id: "task.disabledAgents",
	protocolDefault: ["rpc", "acp"],
	type: "array",
	default: [] as string[],
});

export const cfgTaskAgentModelOverrides = register({
	id: "task.agentModelOverrides",
	protocolDefault: ["rpc", "acp"],
	type: "record",
	default: DEFAULT_AGENT_MODEL_OVERRIDES,
});

export const cfgTaskAgentServiceTierOverrides = register({
	id: "task.agentServiceTierOverrides",
	protocolDefault: ["rpc", "acp"],
	type: "record",
	default: EMPTY_AGENT_SERVICE_TIER_OVERRIDES,
	validate: validateAgentServiceTierOverrides,
});

export const cfgTaskAgentCompactionThresholdOverrides = register({
	id: "task.agentCompactionThresholdOverrides",
	protocolDefault: ["rpc", "acp"],
	type: "record",
	default: EMPTY_AGENT_COMPACTION_THRESHOLD_OVERRIDES,
	validate: validateAgentCompactionThresholdOverrides,
});

export const cfgTaskAgentAccountPools = register({
	id: "task.agentAccountPools",
	protocolDefault: ["rpc", "acp"],
	type: "record",
	default: EMPTY_AGENT_ACCOUNT_POOLS,
	validate: validateAgentAccountPools,
});

export const cfgTaskAgentPrewalk = register({
	id: "task.agentPrewalk",
	protocolDefault: ["rpc", "acp"],
	type: "record",
	default: {} as Record<string, string>,
});

export const cfgTaskAgentAdvisor = register({
	id: "task.agentAdvisor",
	protocolDefault: ["rpc", "acp"],
	type: "record",
	default: {} as Record<string, string>,
});

export const cfgTaskPrewalk = register({
	id: "task.prewalk",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: t("Generic Task Prewalk"),
		description:
			t("Arm prewalk for the bundled generic `task` subagent: it starts on its resolved model, plans and begins the implementation, then hands off to the 'smol' role at its first edit/write. Per-agent overrides (task.agentPrewalk, configured from the /agents hub) and user agent `prewalk` frontmatter apply regardless of this toggle."),
	},
});

export const cfgTaskShowResolvedModelBadge = register({
	id: "task.showResolvedModelBadge",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Show Resolved Model Badge"),
		description: t("Display the actual model ID used by each subagent in the task widget status line"),
	},
});
effect(cfgTaskShowResolvedModelBadge, setFeedModelBadgeEnabled);
