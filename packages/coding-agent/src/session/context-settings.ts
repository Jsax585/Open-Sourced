import { t } from "@oh-my-pi/pi-utils/i18n";
import {
	type AgentCompactionThresholdOverride,
	validateModelCompactionThresholds,
} from "../config/compaction-threshold";
import { combine, register, type SettingValueOf } from "../config/registry";
import { COMPACTION_METHOD_CHOICES, DEFAULT_COMPACTION_METHOD_ORDER } from "./compaction-methods";
import { SHAPE_VARIANT_NAMES } from "@oh-my-pi/snapcompact";

const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_MODEL_COMPACTION_THRESHOLDS: Record<string, AgentCompactionThresholdOverride> = {};

export const cfgWorkspaceAdditionalDirectories = register({
	id: "workspace.additionalDirectories",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "context",
		group: "General",
		label: t("Additional Workspace Dirs"),
		description:
			t("Extra workspace directories added to every session as additional roots (multi-root workspace). Managed live via /add-dir and /remove-dir. Paths resolve relative to cwd; absolute paths recommended. The agent is told these roots exist and can read/grep/glob them."),
	},
});

/** Built-in context filenames. Listing them in `contextFiles.extra` would load a second copy or bypass one-per-depth shadowing. */
const BUILTIN_CONTEXT_FILE_NAMES: Record<string, true> = {
	"agents.md": true,
	"claude.md": true,
	"gemini.md": true,
	"copilot-instructions.md": true,
};

/** Why `entry` is not a valid `contextFiles.extra` name; undefined for a plain, non-built-in file name. */
function contextFileNameError(entry: unknown): string | undefined {
	if (typeof entry !== "string") return t("contextFiles.extra entries must be strings ({0})", `${String(entry)}`);
	const name = entry.trim();
	if (name === "") return t("contextFiles.extra entries must not be empty");
	if (BUILTIN_CONTEXT_FILE_NAMES[name.toLowerCase()] === true) {
		return t("contextFiles.extra cannot list a built-in context file ({0})", `${name}`);
	}
	if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
		return t("contextFiles.extra entries must be file names, not paths ({0})", `${name}`);
	}
	return undefined;
}

/** Extra instruction filenames discovered in addition to AGENTS.md / CLAUDE.md / GEMINI.md. */
export const cfgContextFilesExtra = register({
	id: "contextFiles.extra",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "context",
		group: "General",
		label: t("Extra Context Files"),
		editor: "json",
		description:
			t("Extra instruction filenames loaded beside AGENTS.md. Use a JSON list of names, not paths, e.g. [\"AGENTS.local.md\"]; [] disables extras. Start a new session to load them."),
		condition: "contextFilesExtraNotProject",
	},
	validate: raw => {
		if (raw === undefined) return;
		if (!Array.isArray(raw)) throw new Error(t("contextFiles.extra must be a list of file names"));
		for (const entry of raw) {
			const error = contextFileNameError(entry);
			if (error !== undefined) throw new Error(error);
		}
	},
});

// ────────────────────────────────────────────────────────────────────────
// Context
// ────────────────────────────────────────────────────────────────────────

// Context promotion
export const cfgContextPromotionEnabled = register({
	id: "contextPromotion.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "General",
		label: t("Auto-Promote Context"),
		description:
			t("Promote to the model's contextPromotionTarget on context overflow instead of compacting. Retry fallback switches are controlled by Retry Model Fallback"),
	},
});

// Opt in to advertised maximum context windows and premium long-context
// tiers. Off preserves default windows and caps premium models before
// requests cross into their higher pricing tier.
export const cfgExtendedContext = register({
	id: "extendedContext",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "General",
		label: t("Extended Context"),
		description:
			t("Use larger context windows where supported; may incur premium pricing. Off keeps default or standard-pricing windows"),
	},
});

// Compaction
export const cfgCompactionEnabled = register({
	id: "compaction.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "Compaction",
		label: t("Auto-Compact"),
		description: t("Automatically compact context when it gets too large"),
	},
});

export const cfgCompactionExperimentalContextManagement = register({
	id: "compaction.experimentalContextManagement",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "Compaction",
		label: t("Notes-backed context windows (experimental)"),
		description: t("Keep persistent notes and searchable raw history across context windows."),
	},
});

export const cfgCompactionMidTurnEnabled = register({
	id: "compaction.midTurnEnabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "Compaction",
		label: t("Mid-Turn Compaction"),
		description:
			t("Check thresholds at safe mid-turn tool-loop boundaries before the next provider request; subagents always check, since their whole assignment is one turn"),
	},
});

export const cfgCompactionMethodOrder = register({
	id: "compaction.methodOrder",
	type: "array",
	default: [...DEFAULT_COMPACTION_METHOD_ORDER],
	ui: {
		tab: "context",
		group: "Compaction",
		label: t("Compaction Method Order"),
		description:
			t("Preferred fallback order for automatic context maintenance; unavailable or failed methods advance to the next choice"),
		options: COMPACTION_METHOD_CHOICES,
		ordered: true,
	},
});

export const cfgCompactionThresholdPercent = register({
	id: "compaction.thresholdPercent",
	type: "number",
	default: -1,
	ui: {
		tab: "context",
		group: "Compaction",
		label: t("Compaction Threshold"),
		description: t("Percent threshold for context maintenance; set to Default to use legacy reserve-based behavior"),
		options: [
			{ value: "default", label: t("Default\u0004packages/coding-agent/src/edit/settings.ts:cfgEditFuzzyThreshold.ui.options.description"), description: t("Legacy reserve-based threshold") },
			{ value: "10", label: "10%", description: t("Extremely early maintenance") },
			{ value: "20", label: "20%", description: t("Very early maintenance") },
			{ value: "30", label: "30%", description: t("Early maintenance") },
			{ value: "40", label: "40%", description: t("Moderately early maintenance") },
			{ value: "50", label: "50%", description: t("Halfway point") },
			{ value: "60", label: "60%", description: t("Moderate context usage") },
			{ value: "70", label: "70%", description: t("Balanced") },
			{ value: "75", label: "75%", description: t("Slightly aggressive") },
			{ value: "80", label: "80%", description: t("Typical threshold") },
			{ value: "85", label: "85%", description: t("Aggressive context usage") },
			{ value: "90", label: "90%", description: t("Very aggressive") },
			{ value: "95", label: "95%", description: t("Near context limit") },
		],
	},
});

export const cfgCompactionThresholdTokens = register({
	id: "compaction.thresholdTokens",
	type: "number",
	default: -1,
	ui: {
		tab: "context",
		group: "Compaction",
		label: t("Compaction Token Limit"),
		description: t("Fixed token limit for context maintenance; overrides percentage if set"),
		options: [
			{ value: "default", label: t("Default\u0004packages/coding-agent/src/edit/settings.ts:cfgEditFuzzyThreshold.ui.options.description"), description: t("Use percentage-based threshold") },
			{ value: "25000", label: t("25K tokens"), description: t("1/8 of a 200K window") },
			{ value: "50000", label: t("50K tokens"), description: t("1/4 of a 200K window") },
			{ value: "100000", label: t("100K tokens"), description: t("1/2 of a 200K window") },
			{ value: "150000", label: t("150K tokens"), description: t("3/4 of a 200K window") },
			{ value: "200000", label: t("200K tokens"), description: t("Full standard context window") },
			{ value: "300000", label: t("300K tokens"), description: t("Large context window") },
			{ value: "500000", label: t("500K tokens"), description: t("Very large context window") },
		],
	},
});

/**
 * Per-model compaction limits for the models they match: `provider/model-id`
 * exactly, else the longest `…*` prefix. A token entry is the base the
 * threshold policy scales in place of the window (see
 * `applyModelCompactionThreshold`); a percentage entry replaces both
 * `compaction.threshold*` fields. Edited from the /models hub; a per-agent
 * `task.agentCompactionThresholdOverrides` entry still wins. A token base past a
 * model's standard window opts that model into its extended window
 * (`ModelRegistry.contextWindowTiers`).
 */
export const cfgCompactionModelThresholds = register({
	id: "compaction.modelThresholds",
	type: "record",
	default: EMPTY_MODEL_COMPACTION_THRESHOLDS,
	validate: validateModelCompactionThresholds,
});

/**
 * Whether `compaction.modelThresholds` applies. Subagent spawn turns it off for an
 * agent whose `task.agentCompactionThresholdOverrides` entry applies, so that entry
 * outranks every model entry, including ones added while the agent runs.
 */
export const cfgCompactionModelThresholdsEnabled = register({
	id: "compaction.modelThresholdsEnabled",
	type: "boolean",
	default: true,
});

export const cfgCompactionHandoffSaveToDisk = register({
	id: "compaction.handoffSaveToDisk",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "Compaction",
		label: t("Save Handoff Docs"),
		description: t("Save generated handoff documents to markdown files for the auto-handoff flow"),
	},
});

export const cfgCompactionRemoteStreamingV2Enabled = register({
	id: "compaction.remoteStreamingV2Enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "Compaction",
		label: t("Remote Compaction V2"),
		description: t("Use Responses streaming compaction for compatible remote compaction models"),
	},
});

export const cfgCompactionAsyncEnabled = register({
	id: "compaction.asyncEnabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "Compaction",
		label: t("Async Compaction"),
		description:
			t("Speculatively summarize in the background as context nears the compaction threshold, then splice the ready result in when the threshold is crossed"),
	},
});

// No default: an unset reserve tells the compaction layer the user never
// chose one, so small-window recovery may swap in the proportional reserve
// (see resolveBudgetReserveTokens). A materialized 16384 here would make
// every session look explicitly configured.
export const cfgCompactionReserveTokens = register({
	id: "compaction.reserveTokens",
	type: "number",
	default: undefined,
});

export const cfgCompactionKeepRecentTokens = register({
	id: "compaction.keepRecentTokens",
	type: "number",
	default: 20000,
});

export const cfgCompactionAutoContinue = register({ id: "compaction.autoContinue", type: "boolean", default: true });

export const cfgCompactionRemoteEndpoint = register({
	id: "compaction.remoteEndpoint",
	type: "string",
	default: undefined,
});

export const cfgCompactionV2RetainedMessageBudget = register({
	id: "compaction.v2RetainedMessageBudget",
	type: "number",
	default: 64000,
});

// Idle compaction
export const cfgCompactionIdleEnabled = register({
	id: "compaction.idleEnabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "Compaction",
		label: t("Idle Compaction"),
		description: t("Compact context while idle when token count exceeds threshold"),
	},
});

export const cfgCompactionIdleThresholdTokens = register({
	id: "compaction.idleThresholdTokens",
	type: "number",
	default: 200000,
	ui: {
		tab: "context",
		group: "Compaction",
		label: t("Idle Compaction Threshold"),
		description: t("Token count above which idle compaction triggers"),
		options: [
			{ value: "100000", label: t("100K tokens") },
			{ value: "200000", label: t("200K tokens") },
			{ value: "300000", label: t("300K tokens") },
			{ value: "400000", label: t("400K tokens") },
			{ value: "500000", label: t("500K tokens") },
			{ value: "600000", label: t("600K tokens") },
			{ value: "700000", label: t("700K tokens") },
			{ value: "800000", label: t("800K tokens") },
			{ value: "900000", label: t("900K tokens") },
		],
	},
});

export const cfgCompactionIdleTimeoutSeconds = register({
	id: "compaction.idleTimeoutSeconds",
	type: "number",
	default: 300,
	ui: {
		tab: "context",
		group: "Compaction",
		label: t("Idle Compaction Delay"),
		description:
			t("Seconds to wait while idle before compacting; with a 1-hour prompt cache, compaction instead runs just before the cache expires"),
		options: [
			{ value: "60", label: t("1 minute") },
			{ value: "120", label: t("2 minutes") },
			{ value: "300", label: t("5 minutes") },
			{ value: "600", label: t("10 minutes") },
			{ value: "1800", label: t("30 minutes") },
			{ value: "3600", label: t("1 hour") },
		],
	},
});

export const cfgCompactionSupersedeReads = register({
	id: "compaction.supersedeReads",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "Compaction",
		label: t("Supersede Stale Reads"),
		description: t("Prune older read results when the same file is read again (cache-aware, runs every turn)"),
	},
});

export const cfgCompactionDropUseless = register({
	id: "compaction.dropUseless",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "Compaction",
		label: t("Elide Uneventful Results"),
		description:
			t("Prune tool results flagged contextually useless (no matches, timed-out waits) once consumed (cache-aware)"),
	},
});

/** Every `compaction.*` setting as one memoized snapshot (the configured compaction policy). */
export const cfgCompaction = combine({
	enabled: cfgCompactionEnabled,
	experimentalContextManagement: cfgCompactionExperimentalContextManagement,
	methodOrder: cfgCompactionMethodOrder,
	thresholdPercent: cfgCompactionThresholdPercent,
	thresholdTokens: cfgCompactionThresholdTokens,
	reserveTokens: cfgCompactionReserveTokens,
	keepRecentTokens: cfgCompactionKeepRecentTokens,
	midTurnEnabled: cfgCompactionMidTurnEnabled,
	asyncEnabled: cfgCompactionAsyncEnabled,
	handoffSaveToDisk: cfgCompactionHandoffSaveToDisk,
	autoContinue: cfgCompactionAutoContinue,
	remoteEndpoint: cfgCompactionRemoteEndpoint,
	remoteStreamingV2Enabled: cfgCompactionRemoteStreamingV2Enabled,
	v2RetainedMessageBudget: cfgCompactionV2RetainedMessageBudget,
	idleEnabled: cfgCompactionIdleEnabled,
	idleThresholdTokens: cfgCompactionIdleThresholdTokens,
	idleTimeoutSeconds: cfgCompactionIdleTimeoutSeconds,
	supersedeReads: cfgCompactionSupersedeReads,
	dropUseless: cfgCompactionDropUseless,
});

/**
 * Configured compaction policy ({@link cfgCompaction}). `baseWindowTokens` is
 * never configured directly: a `compaction.modelThresholds` token entry sets it
 * for its model (see `applyModelCompactionThreshold`).
 */
export type CompactionSettings = SettingValueOf<typeof cfgCompaction> & { baseWindowTokens?: number };

// Experimental: snapcompact inline imaging (transient, per-request; never persisted)
export const cfgSnapcompactSystemPrompt = register({
	id: "snapcompact.systemPrompt",
	type: "enum",
	values: ["none", "agents-md", "all"] as const,
	default: "none",
	ui: {
		tab: "context",
		group: "Experimental",
		label: t("Snapcompact System Prompt"),
		description:
			t("Experimental: render selected system prompt text as dense PNG image(s) and attach to the first user message (vision models only). Saves tokens; loses prompt caching for imaged text."),
		options: [
			{ value: "none", label: t("None"), description: t("Keep the system prompt as text.") },
			{
				value: "agents-md",
				label: "AGENTS.md",
				description: t("Only move loaded context-file instructions to images, when that saves tokens."),
			},
			{
				value: "all",
				label: t("All"),
				description: t("Move the full system prompt to images, when that saves tokens."),
			},
		],
	},
});

export const cfgSnapcompactToolResults = register({
	id: "snapcompact.toolResults",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "Experimental",
		label: t("Snapcompact Tool Results"),
		description:
			t("Experimental: render large tool results, the newest one included, as dense PNG image(s) instead of text (vision models only). Saves tokens on accumulated search and command output; read results stay text unless the model is known to edit exactly from images."),
	},
});

export const cfgToolsFormat = register({
	id: "tools.format",
	type: "enum",
	values: [
		"auto",
		"native",
		"glm",
		"hermes",
		"kimi",
		"xml",
		"anthropic",
		"deepseek",
		"harmony",
		"qwen3",
		"gemini",
		"gemma",
		"minimax",
	] as const,
	default: "auto",
	ui: {
		tab: "context",
		group: "Experimental",
		label: t("Tool Calling Mode"),
		description:
			t("Controls how tools are exposed to the model. Auto uses provider-native tool calls unless the selected model is marked as not supporting them, then falls back to the GLM owned dialect. Native forces provider-native tools; the other values force the named owned dialect."),
		options: [
			{
				value: "auto",
				label: t("Auto"),
				description: t("Use native tool calls unless the model is known not to support them."),
			},
			{ value: "native", label: t("Native"), description: t("Use provider-native tool calls.") },
			{ value: "glm", label: "GLM", description: t("Use GLM-style in-band tool calls.") },
			{ value: "hermes", label: "Hermes", description: t("Use Hermes-style in-band tool calls.") },
			{ value: "kimi", label: "Kimi", description: t("Use Kimi-style in-band tool calls.") },
			{ value: "xml", label: "XML", description: t("Use generic XML in-band tool calls.") },
			{ value: "anthropic", label: "Anthropic", description: t("Use Anthropic-style in-band tool calls.") },
			{ value: "deepseek", label: "DeepSeek", description: t("Use DeepSeek-style in-band tool calls.") },
			{ value: "harmony", label: "Harmony", description: t("Use Harmony-style in-band tool calls.") },
			{ value: "qwen3", label: "Qwen3", description: t("Use the Qwen3 owned dialect.") },
			{ value: "gemini", label: "Gemini", description: t("Use the Gemini owned dialect.") },
			{ value: "gemma", label: "Gemma", description: t("Use the Gemma owned dialect.") },
			{ value: "minimax", label: "MiniMax", description: t("Use the MiniMax owned dialect.") },
		],
	},
});

export const cfgSnapcompactShape = register({
	id: "snapcompact.shape",
	type: "enum",
	values: ["auto", ...SHAPE_VARIANT_NAMES] as const,
	default: "auto",
	ui: {
		tab: "context",
		group: "Experimental",
		label: t("Snapcompact Shape"),
		description:
			t("Frame shape snapcompact prints text with (compaction archive and inline imaging). Auto picks a shape tuned for the current model."),
		options: [
			{
				value: "auto",
				label: t("Auto"),
				description: t("Picks a shape tuned for the current model, falling back to its provider family."),
			},
			{
				value: "8x8r-bw",
				label: t("8x8 repeated, black"),
				description:
					t("unscii square cell, black ink, every line printed twice with the copy on a pale highlight band."),
			},
			{
				value: "8x8r-sent",
				label: t("8x8 repeated, sentence hues"),
				description: t("Repeated grid with ink cycling six hues at sentence boundaries."),
			},
			{
				value: "8x8u-bw",
				label: t("8x8, black"),
				description: t("Plain unscii square cell, single-printed lines, black ink."),
			},
			{
				value: "8x8u-sent",
				label: t("8x8, sentence hues"),
				description: t("Plain unscii square cell with sentence-hue ink."),
			},
			{
				value: "6x6u-bw",
				label: t("6x6 dense, black"),
				description: t("unscii squeezed to 6x6 — densest readable cell, fewest frames — in black ink."),
			},
			{
				value: "6x6u-sent",
				label: t("6x6 dense, sentence hues"),
				description: t("Densest cell with sentence-hue ink."),
			},
			{
				value: "5x8-bw",
				label: t("5x8 legacy, black"),
				description: t("Original X.org 5x8 glyphs on the 2576px frame, black ink."),
			},
			{
				value: "5x8-sent",
				label: t("5x8 legacy, sentence hues"),
				description: t("The original snapcompact shape (pre-shape-table sessions rendered this)."),
			},
			{
				value: "6x12-dim",
				label: t("6x12, dimmed stopwords"),
				description: t("X.org 6x12 glyphs, black ink, function words dimmed gray."),
			},
			{
				value: "8x13-bw",
				label: t("8x13, black"),
				description: t("X.org 8x13 glyphs, black ink."),
			},
			{
				value: "8on16-bw",
				label: t("8x13 on 16px pitch, black"),
				description: t("8x13 glyphs on an 8x16 cell (extra leading), black ink."),
			},
			{
				value: "8on22-bw",
				label: t("8x13 on 22px pitch (leading), black"),
				description:
					t("8x13 glyphs on an 8x22 cell — extra line spacing so rows don't crowd. Default for OpenAI/Google."),
			},
			{
				value: "11on16-bw",
				label: t("8x13 on 11px advance (tracking), black"),
				description:
					t("8x13 glyphs on an 11x16 cell — extra letter spacing so characters don't merge. Default for Anthropic."),
			},
			{
				value: "silver16-bw",
				label: "Silver 16, CJK",
				description: t("Embedded Silver TrueType font on a 16px grid for CJK and other non-Latin text."),
			},
			{
				value: "doc-8on16-bw",
				label: t("Doc 8on16, black"),
				description: t("Two word-wrapped newspaper columns of 8x13 glyphs on a 16px pitch, black ink."),
			},
			{
				value: "doc-8on16-sent",
				label: t("Doc 8on16, sentence hues"),
				description: t("Two-column doc layout with sentence-hue ink."),
			},
			{
				value: "doc-8on16-sent-dim",
				label: t("Doc 8on16, sentence hues + dimmed stopwords"),
				description: t("Two-column doc layout, sentence-hue ink, function words dimmed gray."),
			},
		],
	},
});

// Branch summaries
export const cfgBranchSummaryEnabled = register({
	id: "branchSummary.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "General",
		label: t("Branch Summaries"),
		description: t("Prompt to summarize when leaving a branch"),
	},
});

export const cfgBranchSummaryReserveTokens = register({
	id: "branchSummary.reserveTokens",
	type: "number",
	default: 16384,
});
