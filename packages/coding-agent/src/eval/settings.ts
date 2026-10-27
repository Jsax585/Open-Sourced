/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { t } from "@oh-my-pi/pi-utils/i18n";
import { register } from "../config/registry";

// Eval (per-backend toggles; add more as new backends ship, e.g. eval.ts)
export const cfgEvalPy = register({
	id: "eval.py",
	type: "boolean",
	default: true,
	env: "PI_PY",
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: t("Python Eval Backend"),
		description: t("Allow the eval tool to dispatch Python cells to the IPython kernel"),
	},
});

export const cfgEvalJs = register({
	id: "eval.js",
	type: "boolean",
	default: true,
	env: "PI_JS",
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: t("JavaScript Eval Backend"),
		description: t("Allow the eval tool to dispatch JavaScript cells to the in-process runtime"),
	},
});

export const cfgEvalAutoProvision = register({
	id: "eval.autoProvision",
	type: "boolean",
	default: true,
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: t("Eval Environment Provisioning"),
		description: t("Automatically create the managed JavaScript eval package environment on first install"),
	},
});

export const cfgEvalToolsEnabled = register({
	id: "eval.tools.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: t("Eval-Defined Tools"),
		description:
			t("Let eval cells define tools (@tool in Python, tool(fn) in JS) that task, agent(), and workpool() subagents can call"),
	},
});

export const cfgEvalWorkpoolFreshAgents = register({
	id: "eval.workpool.freshAgents",
	type: "boolean",
	default: false,
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: t("Fresh Workpool Agents"),
		description: t("Spawn a new subagent for every workpool item instead of reusing workers or batching queued items"),
	},
});

export const cfgEvalAutoBackgroundEnabled = register({
	id: "eval.autoBackground.enabled",
	protocolDefault: ["rpc"],
	type: "boolean",
	default: false,
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: t("Eval Auto-Background"),
		description: t("Automatically background long-running eval cells and deliver the result later"),
	},
});

export const cfgEvalAutoBackgroundThresholdMs = register({
	id: "eval.autoBackground.thresholdMs",
	protocolDefault: ["rpc"],
	type: "number",
	default: 60_000,
});

// Runtime knobs (consumed by eval backends and the /python slash command)
export const cfgPythonKernelMode = register({
	id: "python.kernelMode",
	type: "enum",
	values: ["session", "per-call"] as const,
	default: "session",
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: t("Python Kernel Mode"),
		description: t("Keep the IPython kernel alive across eval calls or start fresh each time"),
		options: [
			{ value: "session", label: t("session\u0004packages/coding-agent/src/eval/settings.ts:cfgPythonKernelMode.ui.options.label"), description: t("Keep the kernel for the session") },
			{ value: "per-call", label: t("per-call"), description: t("Start a fresh kernel for each call") },
		],
	},
});

export const cfgPythonInterpreter = register({
	id: "python.interpreter",
	type: "string",
	default: "",
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: t("Python Interpreter"),
		description:
			t("Optional path to an exact Python executable. When set, automatic Python runtime discovery is skipped."),
	},
});
