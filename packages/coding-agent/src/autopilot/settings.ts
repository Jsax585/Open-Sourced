import { register } from "../config/registry";
import type { AutopilotStrategy } from "./state";

/** Default for a new session with no persisted autopilot state. */
export const cfgAutopilotEnabled = register({
	id: "autopilot.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Autopilot",
		description: "Answer the agent's trailing questions automatically and continue (per-session toggle: /autopilot)",
	},
});

/** Hard cap on question→answer→continue cycles within one user turn. */
export const cfgAutopilotMaxCycles = register({
	id: "autopilot.maxCycles",
	type: "number",
	// Unlimited by default: the director stops on `done`, a repeated question, or
	// (goal-aware) a cycle without tool progress; a positive cap is opt-in.
	default: 0,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Autopilot Max Cycles",
		description: "Maximum automatic cycles per user prompt; 0 (default) = unlimited",
	},
});

/** How autopilot treats each settled main-agent turn. */
export const cfgAutopilotStrategy = register({
	id: "autopilot.strategy",
	type: "enum",
	values: ["answer", "continue", "goal-aware"] as const,
	default: "goal-aware",
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Autopilot Strategy",
		description:
			"answer = only closing questions; continue = also resolve question-free endings; goal-aware = continue plus goal/todos context and a no-progress stop",
		options: [
			{
				value: "answer",
				label: "Answer questions",
				description: "Respond only when the agent ends with a closing question",
			},
			{
				value: "continue",
				label: "Continue",
				description: "Also resolve question-free endings into the next action",
			},
			{
				value: "goal-aware",
				label: "Goal-aware director",
				description: "Continue with the goal and todos as context, stopping when a cycle makes no tool progress",
			},
		],
	},
});

/** Narrow the configured strategy to the supported union. */
export function autopilotStrategy(value: string): AutopilotStrategy {
	return value === "answer" || value === "continue" ? value : "goal-aware";
}
