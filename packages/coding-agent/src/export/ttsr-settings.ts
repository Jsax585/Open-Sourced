/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { t } from "@oh-my-pi/pi-utils/i18n";
import { combine, register, type SettingValueOf } from "../config/registry";

// TTSR
export const cfgTtsrEnabled = register({
	id: "ttsr.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "Rules (TTSR)",
		label: "TTSR",
		description: t("Interrupt the agent mid-stream when output matches rule patterns (Time-Traveling Stream Rules)"),
	},
});

export const cfgTtsrJudge = register({
	id: "ttsr.judge",
	type: "enum",
	values: ["auto", "on", "off"] as const,
	default: "auto",
	ui: {
		tab: "context",
		group: "Rules (TTSR)",
		label: t("Judged Rules"),
		description:
			t("Ask the judge model role each `question` rule about completed replies, reasoning, and tool calls; a yes injects the rule as a warning"),
		options: [
			{
				value: "auto",
				label: t("Auto"),
				description: t("Judge only when the judge role resolves to a native TypeSafe jev model"),
			},
			{ value: "on", label: t("On"), description: t("Always judge, whichever model the judge role resolves to") },
			{ value: "off", label: t("Off"), description: t("Never judge; question rules stay inactive") },
		],
	},
});

export const cfgTtsrContextMode = register({
	id: "ttsr.contextMode",
	type: "enum",
	values: ["discard", "keep"] as const,
	default: "discard",
	ui: {
		tab: "context",
		group: "Rules (TTSR)",
		label: t("TTSR Context Mode"),
		description: t("What to do with partial output when TTSR triggers"),
		options: [
			{ value: "discard", label: t("discard\u0004packages/coding-agent/src/export/ttsr-settings.ts:cfgTtsrContextMode.ui.options.label") },
			{ value: "keep", label: t("keep") },
		],
	},
});

export const cfgTtsrInterruptMode = register({
	id: "ttsr.interruptMode",
	type: "enum",
	values: ["never", "prose-only", "tool-only", "always"] as const,
	default: "always",
	ui: {
		tab: "context",
		group: "Rules (TTSR)",
		label: t("TTSR Interrupt Mode"),
		description: t("When to interrupt mid-stream vs inject warning after completion"),
		options: [
			{ value: "always", label: t("always"), description: t("Interrupt on prose and tool streams") },
			{ value: "prose-only", label: t("prose-only"), description: t("Interrupt only on reply/thinking matches") },
			{ value: "tool-only", label: t("tool-only"), description: t("Interrupt only on tool-call argument matches") },
			{ value: "never", label: t("never"), description: t("Never interrupt; inject warning after completion") },
		],
	},
});

export const cfgTtsrRepeatMode = register({
	id: "ttsr.repeatMode",
	type: "enum",
	values: ["once", "after-gap"] as const,
	default: "once",
	ui: {
		tab: "context",
		group: "Rules (TTSR)",
		label: t("TTSR Repeat Mode"),
		description: t("How rules can repeat: once per session or after a message gap"),
		options: [
			{ value: "once", label: t("once") },
			{ value: "after-gap", label: t("after-gap") },
		],
	},
});

export const cfgTtsrRepeatGap = register({
	id: "ttsr.repeatGap",
	type: "number",
	default: 10,
	ui: {
		tab: "context",
		group: "Rules (TTSR)",
		label: t("TTSR Repeat Gap"),
		description: t("Messages before a rule can trigger again"),
		options: [
			{ value: "5", label: t("5 messages") },
			{ value: "10", label: t("10 messages") },
			{ value: "15", label: t("15 messages") },
			{ value: "20", label: t("20 messages") },
			{ value: "30", label: t("30 messages") },
		],
	},
});

export const cfgTtsrBuiltinRules = register({
	id: "ttsr.builtinRules",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "Rules (TTSR)",
		label: t("Built-in Rules"),
		description: t("Load the default rules shipped with the agent (override individually with ttsr.disabledRules)"),
	},
});

export const cfgTtsrDisabledRules = register({
	id: "ttsr.disabledRules",
	type: "array",
	default: [] as string[],
	ui: {
		tab: "context",
		group: "Rules (TTSR)",
		label: t("Disabled Rules"),
		description: t("Rule names to ignore entirely (applies to bundled defaults and your own rules)"),
	},
});

/** Time-traveling stream rules configuration (`ttsr.*`). */
export const cfgTtsr = combine({
	enabled: cfgTtsrEnabled,
	judge: cfgTtsrJudge,
	contextMode: cfgTtsrContextMode,
	interruptMode: cfgTtsrInterruptMode,
	repeatMode: cfgTtsrRepeatMode,
	repeatGap: cfgTtsrRepeatGap,
	builtinRules: cfgTtsrBuiltinRules,
	disabledRules: cfgTtsrDisabledRules,
});

/** Time-traveling stream rules configuration ({@link cfgTtsr}). */
export type TtsrSettings = SettingValueOf<typeof cfgTtsr>;
