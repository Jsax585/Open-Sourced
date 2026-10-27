import { t } from "@oh-my-pi/pi-utils/i18n";
import { register } from "../config/registry";

export const cfgGoalEnabled = register({
	id: "goal.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: t("Goal Mode"),
		description: t("Enable per-session goal mode and the hidden goal tool"),
	},
});

export const cfgGoalStatusInFooter = register({
	id: "goal.statusInFooter",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: t("Goal Status in Footer"),
		description: t("Show token budget alongside the goal indicator in the status line"),
	},
});

const GOAL_CONTINUATION_MODES_DEFAULT: string[] = ["interactive"];

export const cfgGoalContinuationModes = register({
	id: "goal.continuationModes",
	type: "array",
	default: GOAL_CONTINUATION_MODES_DEFAULT,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: t("Goal Continuation Modes"),
		description: t("Run modes where active goals may auto-continue between turns (\"interactive\", \"rpc\")"),
	},
});
