import { t } from "@oh-my-pi/pi-utils/i18n";
import { combine, effect, register, type SettingValueOf } from "../config/registry";
import {
	SERVICE_TIER_ANTHROPIC_OPTIONS,
	SERVICE_TIER_ANTHROPIC_VALUES,
	SERVICE_TIER_GOOGLE_OPTIONS,
	SERVICE_TIER_GOOGLE_VALUES,
	SERVICE_TIER_INHERIT_OPTIONS,
	SERVICE_TIER_INHERIT_SETTING_VALUES,
	SERVICE_TIER_OPENAI_OPTIONS,
	SERVICE_TIER_OPENAI_VALUES,
} from "../config/service-tier";
import {
	TINY_MODEL_DEVICE_DEFAULT,
	TINY_MODEL_DEVICE_SETTING_OPTIONS,
	TINY_MODEL_DEVICE_SETTING_VALUES,
} from "../tiny/device";
import {
	TINY_MODEL_DTYPE_DEFAULT,
	TINY_MODEL_DTYPE_SETTING_OPTIONS,
	TINY_MODEL_DTYPE_SETTING_VALUES,
} from "../tiny/dtype";
import { DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS, MAX_WEB_SEARCH_TIMEOUT_SECONDS } from "../web/search/types";
import { DEFAULT_USAGE_RESERVE_PCT } from "@oh-my-pi/pi-ai/auth-storage";
import { configureProviderStoreResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { configureProviderMaxInFlightRequests } from "@oh-my-pi/pi-ai/stream";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { formatKeyHint } from "@oh-my-pi/pi-tui/app-keybindings";
import { AUTO_THINKING, getConfiguredThinkingLevelMetadata, getThinkingLevelMetadata } from "@oh-my-pi/pi-tui/thinking";

const EMPTY_NUMBER_RECORD: Record<string, number> = {};
const EMPTY_STRING_ARRAYS_RECORD: Record<string, string[]> = {};
const DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS: string[] = ["wait"];

// Power assertions: macOS IOKit, Linux login1/ScreenSaver, Windows execution state.
export const cfgPowerSleepPrevention = register({
	id: "power.sleepPrevention",
	type: "enum",
	values: ["off", "idle", "display", "system"] as const,
	default: "idle",
	ui: {
		tab: "interaction",
		group: "Power",
		label: t("Sleep Prevention"),
		description:
			t("Prevent the system sleeping while the agent is running a turn; an idle session, including one waiting on background jobs, does not hold it. Each level is cumulative — it adds the flags of all lower levels."),
		options: [
			{
				value: "off",
				label: t("Off"),
				description: t("Do not prevent any sleep"),
			},
			{
				value: "idle",
				label: t("Prevent Idle Sleep"),
				description: t("Keep the system awake while the agent is running a turn (macOS `caffeinate -i`)"),
			},
			{
				value: "display",
				label: t("Prevent Display Sleep"),
				description: t("Also keep the display from idle-sleeping (macOS `caffeinate -i -d`)"),
			},
			{
				value: "system",
				label: t("Prevent System Sleep"),
				description:
					t("Also block all system sleep on AC and declare the user active (macOS `caffeinate -i -d -s -u`)"),
			},
		],
	},
});

export const cfgPrewalkEnabled = register({
	id: "prewalk.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Prewalk",
		label: t("Enable Prewalk"),
		description:
			t("Start on the active model, then switch to a fast/cheap model (default the 'smol' role) at the first edit/write after the plan nudge's todo list exists — the strong model plans, commits the todos, and starts the implementation before handing off. Overridable per session with --prewalk / --no-prewalk."),
	},
});

export const cfgPrewalkAuto = register({
	id: "prewalk.auto",
	type: "enum",
	values: ["off", "suggest", "on"] as const,
	default: "off",
	ui: {
		tab: "model",
		group: "Prewalk",
		label: t("Auto Prewalk"),
		description:
			t("Ask the native judge resolved through the 'judge' role whether each new top-level user task front-loads its hard reasoning. Needs a native judge; without one nothing is classified. Independent of Enable Prewalk."),
		options: [
			{ value: "off", label: t("Off"), description: t("Never classify prompts for prewalk") },
			{
				value: "suggest",
				label: t("Suggest"),
				description: t("Classify each task and report the decision without arming prewalk"),
			},
			{
				value: "on",
				label: t("On"),
				description:
					t("For confidently front-loaded tasks, arm a handoff from the active model to the auto target; the next task starts back on the planning model"),
			},
		],
	},
});

export const cfgPrewalkAutoTarget = register({
	id: "prewalk.autoTarget",
	type: "string",
	default: "@smol",
	ui: {
		tab: "model",
		group: "Prewalk",
		label: t("Auto-prewalk target"),
		description: t("Model or role (default '@smol') auto-prewalk hands off to at the first edit/write."),
	},
});

function isLimitRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveLimit(limit: unknown): limit is number {
	return typeof limit === "number" && Number.isFinite(limit) && limit > 0;
}

/** Per-provider request limits floored to whole numbers ≥ 1; non-positive or non-numeric entries are dropped. */
export function normalizeProviderMaxInFlightRequests(value: unknown): Record<string, number> {
	const normalized: Record<string, number> = {};
	if (!isLimitRecord(value)) return normalized;
	for (const provider in value) {
		const limit = value[provider];
		if (isPositiveLimit(limit)) normalized[provider] = Math.max(1, Math.floor(limit));
	}
	return normalized;
}

/**
 * Per-provider request limits floored to whole numbers ≥ 1.
 *
 * @throws Error naming every provider whose limit is not a positive number.
 */
export function validateProviderMaxInFlightRequests(value: unknown): Record<string, number> {
	if (isLimitRecord(value)) {
		const invalidProviders: string[] = [];
		for (const provider in value) if (!isPositiveLimit(value[provider])) invalidProviders.push(provider);
		if (invalidProviders.length > 0) {
			throw new Error(t("Provider request limits must be positive numbers: {0}", `${invalidProviders.join(", ")}`));
		}
	}
	return normalizeProviderMaxInFlightRequests(value);
}

export const cfgProvidersMaxInFlightRequests = register({
	id: "providers.maxInFlightRequests",
	type: "record",
	default: EMPTY_NUMBER_RECORD,
	validate: validateProviderMaxInFlightRequests,
	normalize: validateProviderMaxInFlightRequests,
	ui: {
		tab: "providers",
		group: "Services",
		label: t("Max In-Flight Requests"),
		description:
			t("Maximum concurrent LLM requests per provider id (for example \"openai\" or \"anthropic\"), shared across local OMP processes with this config root. Omitted providers are unlimited."),
	},
});
effect(cfgProvidersMaxInFlightRequests, limits =>
	configureProviderMaxInFlightRequests(normalizeProviderMaxInFlightRequests(limits)),
);

export const cfgImagesDescribeForTextModels = register({
	id: "images.describeForTextModels",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Vision",
		label: t("Describe Images for Text Models"),
		description:
			t("When an image is attached to a model without vision support, save it under local:// and inject a description from a vision-capable model instead of dropping it"),
	},
});

// ────────────────────────────────────────────────────────────────────────
// Model
// ────────────────────────────────────────────────────────────────────────

// Reasoning and prompts
export const cfgDefaultThinkingLevel = register({
	id: "defaultThinkingLevel",
	type: "enum",
	values: [...THINKING_EFFORTS, AUTO_THINKING],
	default: "high",
	ui: {
		tab: "model",
		group: "Thinking",
		label: t("Thinking Level"),
		description: t("Reasoning depth for thinking-capable models"),
		options: [getConfiguredThinkingLevelMetadata(AUTO_THINKING), ...THINKING_EFFORTS.map(getThinkingLevelMetadata)],
	},
});

export const cfgHideThinkingBlock = register({
	id: "hideThinkingBlock",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Thinking",
		label: t("Hide Thinking Blocks"),
		description: t("Hide thinking blocks in assistant responses"),
	},
});

export const cfgExpandThinkingBlocks = register({
	id: "expandThinkingBlocks",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Thinking",
		label: t("Expand Thinking Blocks"),
		description: t("Keep finished thinking blocks expanded instead of collapsing them when the turn ends"),
		condition: "nativeRendering",
	},
});

export const cfgProseOnlyThinking = register({
	id: "proseOnlyThinking",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Thinking",
		label: t("Prose Only Thinking"),
		description: t("Omit code blocks from thinking summaries and replace them with an ellipsis"),
	},
});

export const cfgOmitThinking = register({
	id: "omitThinking",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Thinking",
		label: t("Omit Thinking summaries"),
		description: t("Instruct upstream providers to completely omit thinking summaries from responses (where supported)"),
	},
});

export const cfgExternalThinking = register({
	id: "externalThinking",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Thinking",
		label: t("External Thinking"),
		description: t("Private scratchpad; not shown to user. Disables supported GPT, Claude, and Gemini reasoning"),
		warning: t("At your own risk: providers have flagged this request shape as abuse, up to account-level enforcement"),
	},
});

export const cfgModelLoopGuardEnabled = register({
	id: "model.loopGuard.enabled",
	type: "boolean",
	default: true,
	// Kill switch shared with pi-ai's stream-level guard (`utils/thinking-loop.ts`); only `1` disables.
	env: { name: "PI_NO_THINKING_LOOP_GUARD", parse: raw => (raw === "1" ? false : undefined) },
	ui: {
		tab: "model",
		group: "Thinking",
		label: t("Loop Guard"),
		description: t("Enable automatic stream loop detection for model reasoning and prose"),
	},
});

export const cfgModelLoopGuardCheckAssistantContent = register({
	id: "model.loopGuard.checkAssistantContent",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Thinking",
		label: t("Loop Guard Scan Prose"),
		description: t("Apply loop guard to assistant prose messages in addition to thinking logs"),
	},
});

export const cfgModelLoopGuardToolCallReminder = register({
	id: "model.loopGuard.toolCallReminder",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Thinking",
		label: t("Loop Guard Tool-Call Reminder"),
		description:
			t("When a Gemini reasoning stream emits many consecutive planning headers without calling a tool, interrupt it and inject a reminder to issue a tool call (requires Loop Guard)"),
	},
});

export const cfgModelToolCallLoopGuardEnabled = register({
	id: "model.toolCallLoopGuard.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Thinking",
		label: t("Tool-Call Loop Guard"),
		description: t("Detect consecutive identical tool calls across turns and inject a corrective steer"),
	},
});

export const cfgModelToolCallLoopGuardThreshold = register({
	id: "model.toolCallLoopGuard.threshold",
	type: "number",
	default: 5,
	ui: {
		tab: "model",
		group: "Thinking",
		label: t("Tool-Call Loop Threshold"),
		description: t("Consecutive identical tool calls required before the corrective steer is injected"),
	},
});

export const cfgModelToolCallLoopGuardExemptTools = register({
	id: "model.toolCallLoopGuard.exemptTools",
	type: "array",
	default: DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS,
	ui: {
		tab: "model",
		group: "Thinking",
		label: t("Tool-Call Loop Exempt Tools"),
		description: t("Tool names that may repeat consecutively without triggering the cross-turn loop guard"),
	},
});

export const cfgInlineToolDescriptors = register({
	id: "inlineToolDescriptors",
	type: "enum",
	values: ["auto", "on", "off"] as const,
	default: "auto",
	ui: {
		tab: "model",
		group: "Prompt",
		label: t("Inline Tool Descriptors"),
		description:
			t("Render full tool descriptors in the system prompt and strip top-level/nested descriptions from provider tool schemas so descriptor text is sent once. Auto enables this for Gemini models and disables it otherwise"),
		options: [
			{
				value: "auto",
				label: t("Auto"),
				description: t("Inline descriptors for Gemini models; keep them in tool schemas otherwise"),
			},
			{ value: "on", label: t("On"), description: t("Always inline descriptors in the system prompt") },
			{ value: "off", label: t("Off"), description: t("Keep descriptors in provider tool schemas only") },
		],
	},
});

export const cfgIncludeModelInPrompt = register({
	id: "includeModelInPrompt",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Prompt",
		label: t("Include Model in Prompt"),
		description: t("Surface the active model identifier in the system prompt so the agent knows which model it is"),
	},
});

export const cfgIncludeWorkspaceTree = register({
	id: "includeWorkspaceTree",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Prompt",
		label: t("Include Workspace Tree"),
		description:
			t("Render the workspace directory tree in the system prompt. WARNING: This can bust prompt caching across sessions when files are modified."),
	},
});

export const cfgSkillful = register({
	id: "skillful",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Prompt",
		label: t("List Skills in Prompt"),
		description:
			t("List available skills in the system prompt; disable to save context and toggle per-session with /skillful"),
	},
});

/** Personality preset. */
export type Personality = SettingValueOf<typeof cfgPersonality>;

export const cfgPersonality = register({
	id: "personality",
	type: "enum",
	values: ["default", "friendly", "pragmatic", "none"] as const,
	default: "default",
	ui: {
		tab: "model",
		group: "Prompt",
		label: t("Personality"),
		description: t("Communication style rendered into the system prompt's personality block"),
		options: [
			{
				value: "default",
				label: t("Default"),
				description: t("Terse, evidence-first engineer; dense, action-oriented replies"),
			},
			{
				value: "friendly",
				label: t("Friendly"),
				description: t("Warm, encouraging collaborator focused on momentum and morale"),
			},
			{
				value: "pragmatic",
				label: t("Pragmatic"),
				description: t("Direct, efficient engineer focused on clarity and rigor"),
			},
			{ value: "none", label: t("None"), description: t("Omit the personality block entirely") },
		],
	},
});

// Sampling
export const cfgTemperature = register({
	id: "temperature",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "Sampling",
		label: t("Temperature"),
		description: t("Sampling temperature (0 = deterministic, 1 = creative, -1 = provider default)"),
		options: [
			{ value: "-1", label: t("Default\u0004packages/coding-agent/src/edit/settings.ts:cfgEditFuzzyThreshold.ui.options.description"), description: t("Use provider default") },
			{ value: "0", label: "0", description: t("Deterministic") },
			{ value: "0.2", label: "0.2", description: t("Focused") },
			{ value: "0.5", label: "0.5", description: t("Balanced") },
			{ value: "0.7", label: "0.7", description: t("Creative") },
			{ value: "1", label: "1", description: t("Maximum variety") },
		],
	},
});

export const cfgTopP = register({
	id: "topP",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "Sampling",
		label: t("Top P"),
		description: t("Nucleus sampling cutoff (0-1, -1 = provider default)"),
		options: [
			{ value: "-1", label: t("Default\u0004packages/coding-agent/src/edit/settings.ts:cfgEditFuzzyThreshold.ui.options.description"), description: t("Use provider default") },
			{ value: "0.1", label: "0.1", description: t("Very focused") },
			{ value: "0.3", label: "0.3", description: t("Focused") },
			{ value: "0.5", label: "0.5", description: t("Balanced") },
			{ value: "0.9", label: "0.9", description: t("Broad") },
			{ value: "1", label: "1", description: t("No nucleus filtering") },
		],
	},
});

export const cfgTopK = register({
	id: "topK",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "Sampling",
		label: t("Top K"),
		description: t("Sample from top-K tokens (-1 = provider default)"),
		options: [
			{ value: "-1", label: t("Default\u0004packages/coding-agent/src/edit/settings.ts:cfgEditFuzzyThreshold.ui.options.description"), description: t("Use provider default") },
			{ value: "1", label: "1", description: t("Greedy top token") },
			{ value: "20", label: "20", description: t("Focused") },
			{ value: "40", label: "40", description: t("Balanced") },
			{ value: "100", label: "100", description: t("Broad") },
		],
	},
});

export const cfgMinP = register({
	id: "minP",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "Sampling",
		label: t("Min P"),
		description: t("Minimum probability threshold (0-1, -1 = provider default)"),
		options: [
			{ value: "-1", label: t("Default\u0004packages/coding-agent/src/edit/settings.ts:cfgEditFuzzyThreshold.ui.options.description"), description: t("Use provider default") },
			{ value: "0.01", label: "0.01", description: t("Very permissive") },
			{ value: "0.05", label: "0.05", description: t("Balanced") },
			{ value: "0.1", label: "0.1", description: t("Strict") },
		],
	},
});

export const cfgPresencePenalty = register({
	id: "presencePenalty",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "Sampling",
		label: t("Presence Penalty"),
		description: t("Penalty for introducing already-present tokens (-1 = provider default)"),
		options: [
			{ value: "-1", label: t("Default\u0004packages/coding-agent/src/edit/settings.ts:cfgEditFuzzyThreshold.ui.options.description"), description: t("Use provider default") },
			{ value: "0", label: "0", description: t("No penalty") },
			{ value: "0.5", label: "0.5", description: t("Mild novelty") },
			{ value: "1", label: "1", description: t("Encourage novelty") },
			{ value: "2", label: "2", description: t("Strong novelty") },
		],
	},
});

export const cfgRepetitionPenalty = register({
	id: "repetitionPenalty",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "Sampling",
		label: t("Repetition Penalty"),
		description: t("Penalty for repeated tokens (-1 = provider default)"),
		options: [
			{ value: "-1", label: t("Default\u0004packages/coding-agent/src/edit/settings.ts:cfgEditFuzzyThreshold.ui.options.description"), description: t("Use provider default") },
			{ value: "0.8", label: "0.8", description: t("Allow repetition") },
			{ value: "1", label: "1", description: t("No penalty") },
			{ value: "1.1", label: "1.1", description: t("Mild penalty") },
			{ value: "1.2", label: "1.2", description: t("Balanced") },
			{ value: "1.5", label: "1.5", description: t("Strong penalty") },
		],
	},
});

const providerDefaultWhenNegative = (value: number): number | undefined => (value >= 0 ? value : undefined);

/** Agent sampling options; a negative sampling setting means "provider default" (`undefined`). */
export const cfgSampling = combine(
	{
		temperature: cfgTemperature,
		topP: cfgTopP,
		topK: cfgTopK,
		minP: cfgMinP,
		presencePenalty: cfgPresencePenalty,
		repetitionPenalty: cfgRepetitionPenalty,
		hideThinkingSummary: cfgOmitThinking,
	},
	values => ({
		temperature: providerDefaultWhenNegative(values.temperature),
		topP: providerDefaultWhenNegative(values.topP),
		topK: providerDefaultWhenNegative(values.topK),
		minP: providerDefaultWhenNegative(values.minP),
		presencePenalty: providerDefaultWhenNegative(values.presencePenalty),
		repetitionPenalty: providerDefaultWhenNegative(values.repetitionPenalty),
		hideThinkingSummary: values.hideThinkingSummary,
	}),
);

export const cfgTextVerbosity = register({
	id: "textVerbosity",
	type: "enum",
	values: ["low", "medium", "high"] as const,
	default: "medium",
	ui: {
		tab: "model",
		group: "Sampling",
		label: t("Text Verbosity"),
		description: t("OpenAI Responses and Codex response verbosity (low, medium, or high)"),
		options: [
			{ value: "low", label: t("Low"), description: t("Prefer concise responses") },
			{ value: "medium", label: t("Medium"), description: t("Balance brevity and detail (default)") },
			{ value: "high", label: t("High"), description: t("Prefer detailed responses") },
		],
	},
});

export const cfgTierOpenai = register({
	id: "tier.openai",
	type: "enum",
	values: SERVICE_TIER_OPENAI_VALUES,
	default: "none",
	ui: {
		tab: "model",
		group: "Sampling",
		label: t("Service Tier — OpenAI"),
		description:
			t("Processing tier for OpenAI / OpenAI-Codex requests, and OpenAI-family models routed via OpenRouter (none = omit). Sent as `service_tier`."),
		options: SERVICE_TIER_OPENAI_OPTIONS,
	},
});

export const cfgTierAnthropic = register({
	id: "tier.anthropic",
	type: "enum",
	values: SERVICE_TIER_ANTHROPIC_VALUES,
	default: "none",
	ui: {
		tab: "model",
		group: "Sampling",
		label: t("Service Tier — Anthropic"),
		description:
			t("Processing tier for Claude requests. `priority` realizes fast mode (`speed: \"fast\"`) on supported direct Anthropic models; ignored on Bedrock/Vertex Claude and via OpenRouter."),
		options: SERVICE_TIER_ANTHROPIC_OPTIONS,
	},
});

export const cfgTierGoogle = register({
	id: "tier.google",
	type: "enum",
	values: SERVICE_TIER_GOOGLE_VALUES,
	default: "none",
	ui: {
		tab: "model",
		group: "Sampling",
		label: t("Service Tier — Google"),
		description:
			t("Processing tier for Gemini (Google AI Studio + Vertex) requests, and Google-family models routed via OpenRouter (none = omit). Sent as the top-level `serviceTier` field."),
		options: SERVICE_TIER_GOOGLE_OPTIONS,
	},
});

export const cfgTierSubagent = register({
	id: "tier.subagent",
	type: "enum",
	values: SERVICE_TIER_INHERIT_SETTING_VALUES,
	default: "inherit",
	ui: {
		tab: "model",
		group: "Sampling",
		label: t("Service Tier — Subagent"),
		description:
			t("Service Tier for spawned task/eval subagents. Inherit = match the main agent's live per-family tiers (tracks /fast); pick a value to apply it to whichever family the subagent's model belongs to."),
		options: SERVICE_TIER_INHERIT_OPTIONS,
	},
});

export const cfgTierAdvisor = register({
	id: "tier.advisor",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: SERVICE_TIER_INHERIT_SETTING_VALUES,
	default: "none",
	ui: {
		tab: "model",
		group: "Sampling",
		label: t("Service Tier — Advisor"),
		description:
			t("Service Tier for the advisor model. None = standard processing; Inherit = match the main agent's live per-family tiers; pick a value to apply it to the advisor model's family."),
		options: SERVICE_TIER_INHERIT_OPTIONS,
		condition: "advisorEnabled",
	},
});

// Retries
export const cfgRetryEnabled = register({ id: "retry.enabled", type: "boolean", default: true });

export const cfgRetryMaxRetries = register({
	id: "retry.maxRetries",
	type: "number",
	default: 10,
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: t("Retry Attempts"),
		description: t("Maximum retry attempts on API errors"),
		options: [
			{ value: "1", label: t("1 retry") },
			{ value: "2", label: t("2 retries") },
			{ value: "3", label: t("3 retries") },
			{ value: "5", label: t("5 retries") },
			{ value: "10", label: t("10 retries") },
		],
	},
});

export const cfgRetryBaseDelayMs = register({ id: "retry.baseDelayMs", type: "number", default: 500 });

export const cfgRetryMaxDelayMs = register({
	id: "retry.maxDelayMs",
	type: "number",
	default: 5 * 60 * 1000,
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: t("Max Retry Delay"),
		description:
			t("Maximum wait between retries, in ms. When the provider asks us to wait longer than this and no credential or model fallback succeeds, the request fails fast instead of sleeping (e.g. 3-hour Anthropic rate-limit windows). 0 disables the ceiling — to let the session auto-resume through provider-stated quota resets."),
	},
});

export const cfgRetryWaitForUsageReset = register({
	id: "retry.waitForUsageReset",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: t("Wait For Usage Reset"),
		get description() {
			return t("When a provider reports usage-limit exhaustion with a reset time (5-hour or weekly quota windows on any provider), sleep until the reset instead of failing fast past retry.maxDelayMs. Waits are abortable ({0}) but also hold subagents, so leave off for unattended runs.", `${formatKeyHint("escape")}`);
		},
	},
});

export const cfgRetryModelFallback = register({
	id: "retry.modelFallback",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: t("Retry Model Fallback"),
		description:
			t("Allow retry recovery to switch to models in retry.fallbackChains after provider errors. Independent of Auto-Promote Context"),
	},
});

export const cfgRetryFallbackOn = register({
	id: "retry.fallbackOn",
	type: "enum",
	values: ["any", "usage-limit", "except-usage-limit"] as const,
	default: "any",
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: t("Fallback Trigger"),
		description: t("Which failed requests may switch to a configured fallback model"),
		options: [
			{ value: "any", label: t("Any error"), description: t("Every provider error may switch models") },
			{
				value: "usage-limit",
				label: t("Usage limits only"),
				description: t("Switch only on a usage limit; retry other errors on the same model, then surface them"),
			},
			{
				value: "except-usage-limit",
				label: t("All but usage limits"),
				description: t("Wait out or surface a usage limit; switch on other errors"),
			},
		],
	},
});

export const cfgRetryUsageAwareFallback = register({
	id: "retry.usageAwareFallback",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: t("Usage-Aware Fallback"),
		description:
			t("Use reliable coding-plan quota reports to prefer same-provider accounts, then configured fallback models, before a hard usage limit. Ordinary configured API keys are excluded."),
	},
});

export const cfgRetryUsageReservePct = register({
	id: "retry.usageReservePct",
	type: "number",
	default: DEFAULT_USAGE_RESERVE_PCT,
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: t("Reserve Margin"),
		description:
			t("Treat a coding-plan model as near its limit below this remaining percentage. Unknown or unmapped usage keeps the primary model."),
		condition: "usageAwareFallbackEnabled",
		options: [
			{ value: "5", label: "5%", description: t("Act only when nearly exhausted") },
			{ value: "10", label: "10%", description: t("Balanced safety margin") },
			{ value: "15", label: "15%", description: t("Conservative") },
			{ value: "20", label: "20%", description: t("Early protection") },
			{ value: "25", label: "25%", description: t("Very conservative") },
		],
	},
});

export const cfgRetryUsageReservePolicy = register({
	id: "retry.usageReservePolicy",
	type: "enum",
	values: ["confirm", "auto", "fail-closed"] as const,
	default: "confirm",
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: t("Reserve Policy"),
		description: t("What to do when every same-provider coding-plan account is inside the reserve margin."),
		condition: "usageAwareFallbackEnabled",
		options: [
			{
				value: "confirm",
				label: t("Confirm interactively"),
				description: t("Keep interactive sessions on the primary until confirmed; background agents auto-fallback"),
			},
			{
				value: "auto",
				label: t("Auto-fallback"),
				description: t("Always select the next eligible configured fallback"),
			},
			{
				value: "fail-closed",
				label: t("Fail closed"),
				description: t("Do not spend reserve quota or select a fallback"),
			},
		],
	},
});

export const cfgRetryFallbackChains = register({
	id: "retry.fallbackChains",
	type: "record",
	default: EMPTY_STRING_ARRAYS_RECORD,
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: t("Retry Fallback Chains"),
		description:
			t("JSON object mapping model roles, model selectors (\"provider/model-id\"), or provider wildcards (\"provider/*\") to ordered fallback selectors, e.g. {\"default\":[\"openai/gpt-4o-mini\"],\"google-antigravity/*\":[\"google/*\",\"google-vertex/*\"]}. Model-oriented keys apply whenever that model/provider is active, regardless of role; a \"provider/*\" entry keeps the failing model's id and swaps the provider. An id-prefixed wildcard (\"openrouter/google/*\") re-prefixes the failing model's bare id (google-antigravity/gemini-x -> openrouter/google/gemini-x) and, used as a key, matches only that provider's ids under the prefix. A fallback entry may carry an explicit thinking suffix (\"provider/model:low\", \":high\", \":max\", \":off\"); a bare entry inherits the failing turn's effort, and \"provider/*\" entries always inherit."),
	},
});

export const cfgRetryFallbackRevertPolicy = register({
	id: "retry.fallbackRevertPolicy",
	type: "enum",
	values: ["cooldown-expiry", "never"] as const,
	default: "cooldown-expiry",
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: t("Fallback Revert Policy"),
		description: t("When to return to the primary model after a fallback"),
		options: [
			{
				value: "cooldown-expiry",
				label: t("Cooldown expiry"),
				description: t("Return to the primary model after its suppression window ends"),
			},
			{ value: "never", label: t("Never\u0004packages/coding-agent/src/session/settings.ts:cfgRetryFallbackRevertPolicy.ui.options.label"), description: t("Stay on the fallback model until manually changed") },
		],
	},
});

/** Retry/backoff and usage-aware fallback policy (`retry.*` except fallback chains/revert policy). */
export const cfgRetry = combine({
	enabled: cfgRetryEnabled,
	maxRetries: cfgRetryMaxRetries,
	baseDelayMs: cfgRetryBaseDelayMs,
	maxDelayMs: cfgRetryMaxDelayMs,
	waitForUsageReset: cfgRetryWaitForUsageReset,
	modelFallback: cfgRetryModelFallback,
	fallbackOn: cfgRetryFallbackOn,
	usageAwareFallback: cfgRetryUsageAwareFallback,
	usageReservePct: cfgRetryUsageReservePct,
	usageReservePolicy: cfgRetryUsageReservePolicy,
});

/** Retry/backoff policy ({@link cfgRetry}). */
export type RetrySettings = SettingValueOf<typeof cfgRetry>;

export const cfgProvidersAnthropicServerSideFallback = register({
	id: "providers.anthropic.serverSideFallback",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: t("Anthropic Server-Side Fallback (Fable 5)"),
		description:
			t("When a Claude Fable 5 / Mythos 5 request is blocked by Anthropic's safety classifier, retry it on Claude Opus 5 server-side (Anthropic `server-side-fallback-2026-06-01` beta). Opt-in — leaving this off preserves the pre-fallback behavior for every request."),
	},
});

/**
 * Anthropic subscription slow mode (`off` | `auto`). Deliberately has no
 * `/settings` UI: `/slow on|off` on an Anthropic model is the only switch.
 * `auto` switches to low priority automatically when a Claude subscription
 * hits its 5-hour limit and Anthropic offers it. Wrap-up allowance tracking
 * runs either way; this only gates the low-priority lane.
 */
export const cfgProvidersAnthropicSlowMode = register({
	id: "providers.anthropic.slowMode",
	type: "enum",
	values: ["off", "auto"] as const,
	default: "off" as const,
});

// Provider selection
export const cfgProvidersOllamaCloudMaxConcurrency = register({
	id: "providers.ollama-cloud.maxConcurrency",
	type: "number",
	default: 3,
	ui: {
		tab: "providers",
		group: "Services",
		label: t("Ollama Cloud Max Concurrency"),
		description: t("Maximum concurrent Ollama Cloud subagent runs per process; 0 disables the provider-specific limit"),
	},
});

export const cfgProvidersWebSearchTimeoutSeconds = register({
	id: "providers.webSearchTimeoutSeconds",
	type: "number",
	default: DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
	ui: {
		tab: "providers",
		group: "Services",
		label: t("Web Search Timeout"),
		description: t("Hard timeout for each provider's search transport before web_search advances to the next fallback, in seconds (maximum {0})", `${MAX_WEB_SEARCH_TIMEOUT_SECONDS}`),
		options: [
			{ value: "30", label: t("30 seconds") },
			{ value: "60", label: t("1 minute") },
			{ value: "120", label: t("2 minutes") },
			{ value: "180", label: t("3 minutes") },
			{ value: "300", label: t("5 minutes") },
		],
	},
});

export const cfgProvidersAntigravityEndpoint = register({
	id: "providers.antigravityEndpoint",
	type: "enum",
	values: ["auto", "production", "sandbox"] as const,
	default: "auto",
	ui: {
		tab: "providers",
		group: "Services",
		label: t("Antigravity Endpoint Mode"),
		description: t("Endpoint routing strategy for google-antigravity providers (chat, search, image, discovery)"),
		options: [
			{
				value: "auto",
				label: t("Auto"),
				description: t("Try production endpoint, fail over to sandbox on 5xx/429"),
			},
			{
				value: "production",
				label: t("Production Only"),
				description: t("Force production endpoint only"),
			},
			{
				value: "sandbox",
				label: t("Sandbox Only"),
				description: t("Force sandbox endpoint only"),
			},
		],
	},
});

export const cfgProvidersFireworksTier = register({
	id: "providers.fireworksTier",
	type: "enum",
	values: ["standard", "priority"] as const,
	default: "standard",
	ui: {
		tab: "providers",
		group: "Fireworks",
		label: t("Fireworks Tier"),
		description:
			t("Serving path for Fireworks requests. Priority sends `service_tier: \"priority\"` for higher reliability during peak traffic at a higher price; Standard omits it. Fast (`-fast`) models ignore this — Fast is its own serving path."),
		options: [
			{ value: "standard", label: t("Standard"), description: t("Default serving path (no service_tier)") },
			{
				value: "priority",
				label: t("Priority"),
				description: t("Priority serving path: higher reliability, premium per-token pricing"),
			},
		],
	},
});

export const cfgProvidersTinyModelDevice = register({
	id: "providers.tinyModelDevice",
	type: "enum",
	values: TINY_MODEL_DEVICE_SETTING_VALUES,
	default: TINY_MODEL_DEVICE_DEFAULT,
	env: {
		name: "PI_TINY_DEVICE",
		parse: raw => TINY_MODEL_DEVICE_SETTING_VALUES.find(value => value === raw.trim().toLowerCase()),
	},
	ui: {
		tab: "providers",
		group: "Tiny Model",
		label: t("Tiny Model Device"),
		description:
			t("Inference backend for local tiny models (titles + memory): an ONNX execution provider, or `mlx` to download MLX weights and run them through mlx-lm on Apple silicon. Default uses CPU-only ONNX. The PI_TINY_DEVICE env var overrides this."),
		options: TINY_MODEL_DEVICE_SETTING_OPTIONS,
	},
});

export const cfgProvidersTinyModelDtype = register({
	id: "providers.tinyModelDtype",
	type: "enum",
	values: TINY_MODEL_DTYPE_SETTING_VALUES,
	default: TINY_MODEL_DTYPE_DEFAULT,
	env: {
		name: "PI_TINY_DTYPE",
		parse: raw => TINY_MODEL_DTYPE_SETTING_VALUES.find(value => value === raw.trim().toLowerCase()),
	},
	ui: {
		tab: "providers",
		group: "Tiny Model",
		label: t("Tiny Model Precision"),
		description:
			t("ONNX quantization/precision for local tiny models. Default uses each model's shipped dtype (q4); lower precision is faster, higher is more faithful. Ignored by the MLX backend (its repos are pre-quantized 4-bit). The PI_TINY_DTYPE env var overrides this."),
		options: TINY_MODEL_DTYPE_SETTING_OPTIONS,
	},
});

export const cfgProvidersAutoThinkingMaxEffort = register({
	id: "providers.autoThinkingMaxEffort",
	type: "enum",
	values: ["xhigh", "max"] as const,
	default: "xhigh",
	ui: {
		tab: "model",
		group: "Thinking",
		label: t("Auto Thinking Ceiling"),
		description:
			t("Highest effort the `auto` classifier may resolve. `xhigh` keeps the classifier one tier below the top, so only an explicit `ultrathink` reaches `max`; `max` lets a turn the classifier judges exceptional bill the top tier on models that expose it."),
		condition: "autoThinkingActive",
		options: [
			{ value: "xhigh", label: "xhigh", description: t("Classifier stops at xhigh (default)") },
			{ value: "max", label: "max", description: t("Classifier may resolve max where the model supports it") },
		],
	},
});

export const cfgFeaturesUnexpectedStopDetection = register({
	id: "features.unexpectedStopDetection",
	type: "enum",
	values: ["none", "mechanical", "smart"] as const,
	default: "mechanical",
	ui: {
		tab: "interaction",
		group: "Agent",
		label: t("Unexpected Stops"),
		description:
			t("Automatically recover when the assistant stops without a visible message. Smart also classifies text-only stops with a small model."),
		options: [
			{ value: "none", label: t("None"), description: t("Disabled\u0004packages/coding-agent/src/modes/settings.ts:cfgDisplayShimmer.ui.options.label") },
			{
				value: "mechanical",
				label: t("Mechanical"),
				description: t("Retry stops with no visible assistant message; tool calls are excluded (default)"),
			},
			{
				value: "smart",
				label: t("Smart\u0004packages/coding-agent/src/session/settings.ts:cfgFeaturesUnexpectedStopDetection.ui.options.label"),
				description: t("Mechanical + small-model classification of text-only stops"),
			},
		],
	},
});

export const cfgProvidersKimiApiFormat = register({
	id: "providers.kimiApiFormat",
	type: "enum",
	values: ["auto", "openai", "anthropic"] as const,
	default: "auto",
	ui: {
		tab: "providers",
		group: "Protocol",
		label: t("Kimi API Format"),
		description: t("API format for Kimi Code provider (auto follows live model metadata)"),
		options: [
			{ value: "auto", label: t("Auto"), description: t("Use the model's server-declared protocol") },
			{ value: "openai", label: "OpenAI", description: "api.kimi.com" },
			{ value: "anthropic", label: "Anthropic", description: "api.moonshot.ai" },
		],
	},
});

export const cfgProvidersOpenaiWebsockets = register({
	id: "providers.openaiWebsockets",
	type: "enum",
	values: ["auto", "off", "on"] as const,
	default: "auto",
	ui: {
		tab: "providers",
		group: "Protocol",
		label: "OpenAI WebSocket",
		description: t("Websocket policy for OpenAI Codex models (auto uses model defaults, on forces, off disables)"),
		options: [
			{ value: "auto", label: t("Auto"), description: t("Use model/provider default websocket behavior") },
			{ value: "off", label: t("Off"), description: t("Disable websockets for OpenAI Codex models") },
			{ value: "on", label: t("On"), description: t("Force websockets for OpenAI Codex models") },
		],
	},
});

export const cfgProvidersOpenaiLiveSteering = register({
	id: "providers.openaiLiveSteering",
	type: "boolean",
	default: true,
	ui: {
		tab: "providers",
		group: "Protocol",
		label: t("OpenAI Live Steering"),
		description:
			t("Deliver messages typed while a GPT-6 response streams into that response over the Codex WebSocket, instead of waiting for the next tool boundary"),
	},
});

export const cfgProvidersMuseCodeStoreResponses = register({
	id: "providers.muse-code.storeResponses",
	type: "boolean",
	default: false,
	env: "PI_MUSE_STORE_RESPONSES",
	ui: {
		tab: "providers",
		group: "Protocol",
		label: t("Muse Code Stored Responses"),
		description:
			t("Store Muse Code results on Meta's servers so a turn whose connection drops is recovered instead of re-run. Stored runs keep prompts and outputs on Meta's side."),
	},
});
// Process-wide too, so side requests that call `completeSimple`/`streamSimple`
// directly (titles, commit messages, memories) follow the setting.
effect(cfgProvidersMuseCodeStoreResponses, enabled => configureProviderStoreResponses({ "muse-code": enabled }));

export const cfgProvidersCacheRetention = register({
	id: "providers.cacheRetention",
	type: "enum",
	values: ["auto", "short", "long", "none"] as const,
	default: "auto",
	ui: {
		tab: "providers",
		group: "Protocol",
		label: t("Prompt Cache Retention"),
		description:
			t("Prompt-cache retention forwarded to providers that support it (Anthropic, Bedrock, OpenRouter, OpenAI)"),
		options: [
			{
				value: "auto",
				label: t("Auto"),
				description:
					t("Provider default — Anthropic OAuth subscriber sessions default to 1h, API keys use 5m; PI_CACHE_RETENTION still applies"),
			},
			{
				value: "short",
				label: t("Short (5m)"),
				description: t("Cheapest cache writes; pair with cache warming to keep short entries alive while idle"),
			},
			{
				value: "long",
				label: t("Long (1h+)"),
				description:
					t("Longer TTL where supported (Anthropic/Bedrock 1h, OpenAI GPT-5.6+ Responses 12h); pricier writes, only warmed during active runs"),
			},
			{ value: "none", label: t("Off"), description: t("Disable prompt caching and cache-affinity routing") },
		],
	},
});

export const cfgProvidersCacheWarming = register({
	id: "providers.cacheWarming",
	type: "enum",
	values: ["off", "streaming", "idle"] as const,
	default: "idle",
	ui: {
		tab: "providers",
		group: "Protocol",
		label: t("Cache Warming"),
		description:
			t("Re-send the last request with a one-token output budget shortly before its prompt-cache entry expires"),
		options: [
			{ value: "off", label: t("Off"), description: t("Disable cache warming") },
			{
				value: "streaming",
				label: t("Streaming"),
				description: t("Protect expensive prefixes during long tool executions; stops when the agent settles"),
			},
			{
				value: "idle",
				label: t("Idle\u0004packages/coding-agent/src/session/settings.ts:cfgProvidersCacheWarming.ui.options.label"),
				description:
					t("Also refresh 5-minute entries between runs while the expected savings stay above the cost floor"),
			},
		],
	},
});

export const cfgProvidersStreamFirstEventTimeoutSeconds = register({
	id: "providers.streamFirstEventTimeoutSeconds",
	type: "number",
	default: -1,
	ui: {
		tab: "providers",
		group: "Timeouts",
		label: t("Stream First Event Timeout"),
		description:
			t("Seconds to wait for the first model stream event; -1 uses provider/env defaults, 0 disables the watchdog"),
		options: [
			{ value: "-1", label: t("Auto"), description: t("Use provider defaults and PI_* timeout env vars") },
			{ value: "0", label: t("Off"), description: t("Disable first-event timeout") },
			{ value: "300", label: t("5 minutes") },
			{ value: "600", label: t("10 minutes") },
			{ value: "1800", label: t("30 minutes") },
		],
	},
});

export const cfgProvidersStreamIdleTimeoutSeconds = register({
	id: "providers.streamIdleTimeoutSeconds",
	type: "number",
	default: -1,
	ui: {
		tab: "providers",
		group: "Timeouts",
		label: t("Stream Idle Timeout"),
		description:
			t("Seconds a model stream may stay silent between events; -1 uses provider/env defaults, 0 disables the watchdog"),
		options: [
			{ value: "-1", label: t("Auto"), description: t("Use provider defaults and PI_* timeout env vars") },
			{ value: "0", label: t("Off"), description: t("Disable idle timeout") },
			{ value: "300", label: t("5 minutes") },
			{ value: "600", label: t("10 minutes") },
			{ value: "1800", label: t("30 minutes") },
		],
	},
});

export const cfgProvidersOpenrouterVariant = register({
	id: "providers.openrouterVariant",
	type: "enum",
	values: ["default", "nitro", "floor", "online", "exacto"] as const,
	default: "default",
	ui: {
		tab: "providers",
		group: "Protocol",
		label: t("OpenRouter Routing"),
		description:
			t("Default routing-variant suffix appended to OpenRouter model IDs (overridden when the selector already names a variant)"),
		options: [
			{ value: "default", label: t("Default\u0004packages/coding-agent/src/edit/settings.ts:cfgEditFuzzyThreshold.ui.options.description"), description: t("No suffix; use OpenRouter's default routing") },
			{ value: "nitro", label: ":nitro", description: t("Prioritize throughput / lowest latency") },
			{ value: "floor", label: ":floor", description: t("Prioritize cheapest available provider") },
			{ value: "online", label: ":online", description: t("Enable OpenRouter's web-search plugin") },
			{
				value: "exacto",
				label: ":exacto",
				description: t("Cherry-picked high-quality providers (only defined for select models)"),
			},
		],
	},
});

export const cfgProvidersFetch = register({
	id: "providers.fetch",
	type: "enum",
	values: ["auto", "native", "trafilatura", "lynx", "parallel", "firecrawl", "jina"] as const,
	default: "auto",
	ui: {
		tab: "providers",
		group: "Services",
		label: t("Fetch Provider"),
		description: t("Reader backend priority for the fetch/read URL tool"),
		options: [
			{
				value: "auto",
				label: t("Auto"),
				description: t("Priority: native > trafilatura > lynx > parallel > firecrawl > jina"),
			},
			{ value: "native", label: t("Native"), description: t("In-process HTML→Markdown converter (always available)") },
			{ value: "trafilatura", label: "Trafilatura", description: t("Auto-installs via uv/pip") },
			{ value: "lynx", label: "Lynx", description: t("Requires lynx system package") },
			{ value: "parallel", label: "Parallel", description: t("Requires PARALLEL_API_KEY") },
			{ value: "firecrawl", label: "Firecrawl", description: t("Requires FIRECRAWL_API_KEY") },
			{ value: "jina", label: "Jina", description: t("Uses r.jina.ai reader (JINA_API_KEY optional)") },
		],
	},
});

// Codex saved rate-limit resets (auto-redeem)
export const cfgCodexResetsAutoRedeem = register({
	id: "codexResets.autoRedeem",
	type: "enum",
	values: ["unset", "yes", "no"] as const,
	default: "unset" as const,
	ui: {
		tab: "providers",
		group: "Services",
		label: t("Codex Auto-Redeem Saved Resets"),
		description:
			t("Spend saved Codex rate-limit resets automatically: restore an account blocked by an exhausted 5h or weekly window when a turn is stuck and no other account can take over, and salvage credits that are about to expire. unset asks before the first spend (with no prompt UI, it spends only a reset expiring within 5 minutes), yes spends without prompting, and no disables both checks."),
		options: [
			{
				value: "unset",
				label: t("Unset"),
				description:
					t("Check eligibility, then ask before spending the first saved reset. With no prompt UI, spend only a reset expiring within 5 minutes."),
			},
			{ value: "yes", label: t("Yes"), description: t("Spend eligible saved resets without prompting.") },
			{ value: "no", label: t("No"), description: t("Do not run the saved-reset auto-redeem check.") },
		],
	},
});

export const cfgCodexResetsMinBlockedMinutes = register({
	id: "codexResets.minBlockedMinutes",
	type: "number",
	default: 60,
	ui: {
		tab: "providers",
		group: "Services",
		label: t("Codex Auto-Redeem Min Block"),
		description:
			t("Only auto-redeem when the natural unblock — the latest reset among the exhausted 5h/weekly windows — is at least this many minutes away (don't spend a scarce credit to save a short wait). Raise it (e.g. 360) to ignore 5h-only blocks."),
	},
});

export const cfgCodexResetsKeepCredits = register({
	id: "codexResets.keepCredits",
	type: "number",
	default: 0,
	ui: {
		tab: "providers",
		group: "Services",
		label: t("Codex Auto-Redeem Reserve"),
		description:
			t("Never auto-spend below this many saved resets (0 = the last credit may be spent automatically). Credits about to expire are exempt — a reserved credit that expires preserves nothing."),
	},
});

export const cfgCodexResetsSalvageHorizonHours = register({
	id: "codexResets.salvageHorizonHours",
	type: "number",
	default: 12,
	ui: {
		tab: "providers",
		group: "Services",
		label: t("Codex Reset Salvage Horizon"),
		description:
			t("With auto-redeem enabled, spend a saved Codex reset within this many hours of expiry when either chat window has meaningful usage. 0 disables early salvage; credits expiring within 5 minutes are still attempted regardless of usage."),
	},
});

/** Codex saved-reset auto-redeem policy (`codexResets.*`). */
export const cfgCodexResets = combine({
	autoRedeem: cfgCodexResetsAutoRedeem,
	minBlockedMinutes: cfgCodexResetsMinBlockedMinutes,
	keepCredits: cfgCodexResetsKeepCredits,
	salvageHorizonHours: cfgCodexResetsSalvageHorizonHours,
});

/** Whether automatic reset redemption asks first, spends, or remains disabled. */
export type ResetAutoRedeemMode = SettingValueOf<typeof cfgCodexResetsAutoRedeem>;

// Claude Cedar/Juniper rate-limit resets (independent auto-redeem consent)
export const cfgClaudeResetsAutoRedeem = register({
	id: "claudeResets.autoRedeem",
	type: "enum",
	values: ["unset", "yes", "no"] as const,
	default: "unset" as const,
	ui: {
		tab: "providers",
		group: "Services",
		label: t("Claude Auto-Redeem Resets"),
		description:
			t("Spend eligible Claude Cedar or Juniper resets automatically. Cedar is spent only for covered limits; Juniper can only recover a sole 5-hour block. unset asks before the first spend (with no prompt UI, it spends only a reset expiring within 5 minutes), yes spends without prompting, and no disables blocked recovery and expiry salvage."),
		options: [
			{
				value: "unset",
				label: t("Unset"),
				description:
					t("Check live eligibility, then ask before spending the first Claude reset. With no prompt UI, spend only a reset expiring within 5 minutes."),
			},
			{ value: "yes", label: t("Yes"), description: t("Spend eligible Claude resets without prompting.") },
			{ value: "no", label: t("No"), description: t("Do not run Claude reset auto-redeem checks.") },
		],
	},
});

export const cfgClaudeResetsMinBlockedMinutes = register({
	id: "claudeResets.minBlockedMinutes",
	type: "number",
	default: 60,
	ui: {
		tab: "providers",
		group: "Services",
		label: t("Claude Auto-Redeem Min Block"),
		description:
			t("Only auto-redeem when the natural unblock — the latest reset among the exhausted covered windows — is at least this many minutes away. A 5-hour-only reset is never used for a weekly or model-scoped block."),
	},
});

export const cfgClaudeResetsKeepCredits = register({
	id: "claudeResets.keepCredits",
	type: "number",
	default: 0,
	ui: {
		tab: "providers",
		group: "Services",
		label: t("Claude Auto-Redeem Reserve"),
		description:
			t("Keep at least this many Claude resets banked (0 allows the last eligible reset to be spent automatically). The reserve applies to early salvage, but not to eligible resets expiring within 5 minutes."),
	},
});

export const cfgClaudeResetsSalvageHorizonHours = register({
	id: "claudeResets.salvageHorizonHours",
	type: "number",
	default: 12,
	ui: {
		tab: "providers",
		group: "Services",
		label: t("Claude Reset Salvage Horizon"),
		description:
			t("With auto-redeem enabled, use a server-selected Cedar reset within this many hours of expiry when its covered windows have meaningful usage. 0 disables early salvage; eligible Cedar or Juniper resets expiring within 5 minutes are still attempted regardless of usage or reserve. Provider limit requirements still apply."),
	},
});

/** Claude reset auto-redeem policy (`claudeResets.*`), independent of {@link cfgCodexResets}. */
export const cfgClaudeResets = combine({
	autoRedeem: cfgClaudeResetsAutoRedeem,
	minBlockedMinutes: cfgClaudeResetsMinBlockedMinutes,
	keepCredits: cfgClaudeResetsKeepCredits,
	salvageHorizonHours: cfgClaudeResetsSalvageHorizonHours,
});

export const cfgProviderAppendOnlyContext = register({
	id: "provider.appendOnlyContext",
	type: "enum",
	values: ["auto", "on", "off"] as const,
	default: "auto",
	ui: {
		tab: "providers",
		group: "Protocol",
		label: t("Append-Only Context"),
		description:
			t("Cache system prompt + tool specs and keep an append-only message log so provider prefix caches (DeepSeek, Xiaomi/SGLang, Anthropic) hit at maximum rate. Auto enables for known prefix-cache providers."),
		options: [
			{ value: "auto", label: t("Auto"), description: t("Enable for known prefix-cache providers (recommended)") },
			{ value: "on", label: t("On"), description: t("Always enable append-only context") },
			{ value: "off", label: t("Off"), description: t("Disable append-only context") },
		],
	},
});

export const cfgThinkingBudgetsMinimal = register({ id: "thinkingBudgets.minimal", type: "number", default: 1024 });

export const cfgThinkingBudgetsLow = register({ id: "thinkingBudgets.low", type: "number", default: 2048 });

export const cfgThinkingBudgetsMedium = register({ id: "thinkingBudgets.medium", type: "number", default: 8192 });

export const cfgThinkingBudgetsHigh = register({ id: "thinkingBudgets.high", type: "number", default: 16384 });

export const cfgThinkingBudgetsXhigh = register({ id: "thinkingBudgets.xhigh", type: "number", default: 32768 });

export const cfgThinkingBudgetsMax = register({ id: "thinkingBudgets.max", type: "number", default: 32768 });

/** Token budget per thinking level (`thinkingBudgets.*`) on transports that accept reasoning token budgets. */
export const cfgThinkingBudgets = combine({
	minimal: cfgThinkingBudgetsMinimal,
	low: cfgThinkingBudgetsLow,
	medium: cfgThinkingBudgetsMedium,
	high: cfgThinkingBudgetsHigh,
	xhigh: cfgThinkingBudgetsXhigh,
	max: cfgThinkingBudgetsMax,
});

/** Rejects a cost threshold that is not a positive USD amount. */
function validateCostThreshold(id: string): (raw: unknown) => void {
	return raw => {
		if (raw === undefined || raw === null || (typeof raw === "number" && Number.isFinite(raw) && raw > 0)) return;
		throw new Error(`Invalid ${id}: expected a positive USD amount, got ${Bun.inspect(raw)}.`);
	};
}

/** Session-tree spend (USD) at which omp warns once; `--warn-cost` overrides it for one run. */
export const cfgSessionWarnCost = register({
	id: "session.warnCost",
	type: "number",
	default: undefined,
	validate: validateCostThreshold("session.warnCost"),
});

/** Session-tree spend (USD) at which omp stops sending model requests; `--max-cost` overrides it for one run. */
export const cfgSessionMaxCost = register({
	id: "session.maxCost",
	type: "number",
	default: undefined,
	validate: validateCostThreshold("session.maxCost"),
});
