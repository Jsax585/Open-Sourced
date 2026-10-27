import { t } from "@oh-my-pi/pi-utils/i18n";
import { Args, type CommandMetadata, Flags } from "@oh-my-pi/pi-utils/cli";
import { APP_NAME } from "@oh-my-pi/pi-utils/dirs";
import { formatKeyHint } from "@oh-my-pi/pi-tui/key-hint-format";
import { CLI_THINKING_LEVELS } from "@oh-my-pi/pi-tui/thinking";
import { SERVICE_TIER_OPENAI_VALUES } from "../config/service-tier";

export const launchHelp = {
	description: t("AI coding assistant"),
	hidden: true,
	args: {
		messages: Args.string({
			description: t("Messages to send (prefix files with @)"),
			required: false,
			multiple: true,
		}),
	},
	flags: {
		model: Flags.string({
			description: t("Model to use (fuzzy match: \"opus\", \"gpt-5.2\", or \"openai/gpt-5.2\")"),
		}),
		smol: Flags.string({ description: t("Smol/fast model for lightweight tasks (or PI_SMOL_MODEL env)") }),
		slow: Flags.string({ description: t("Slow/reasoning model for thorough analysis (or PI_SLOW_MODEL env)") }),
		plan: Flags.string({ description: t("Plan model for architectural planning (or PI_PLAN_MODEL env)") }),
		goal: Flags.string({
			description:
				t("Start fresh in goal mode (interactive only; bypasses autoResume; no positional prompt, startup plan mode, or explicit resume)"),
		}),
		prewalk: Flags.boolean({
			description:
				t("Switch from the active model to a fast/cheap model at the first edit/write after the plan's todo list exists (default off; see prewalk.enabled)"),
		}),
		"no-prewalk": Flags.boolean({
			description: t("Disable prewalk, including prewalk.auto, even if prewalk.enabled is set"),
		}),
		"prewalk-into": Flags.string({ description: t("Target model for prewalk (default the \"smol\" role)") }),
		"plan-yolo": Flags.boolean({
			description:
				t("Force read-only plan mode at start, auto-approve the plan on the model's first resolve call, then switch to --plan-yolo-into to implement it"),
		}),
		"plan-yolo-into": Flags.string({ description: t("Target model for plan-yolo execution (default the \"smol\" role)") }),
		provider: Flags.string({ description: t("Provider to use (legacy; prefer --model)") }),
		"api-key": Flags.string({ description: t("API key (defaults to env vars)") }),
		"system-prompt": Flags.string({ description: t("System prompt (default: coding assistant prompt)") }),
		"system-prompt-template": Flags.string({
			description: t("Handlebars system prompt template (mutually exclusive with --system-prompt)"),
		}),
		"append-system-prompt": Flags.string({ description: t("Append text or file contents to the system prompt") }),
		"allow-home": Flags.boolean({ description: t("Allow starting in ~ without auto-switching to a temp dir") }),
		profile: Flags.string({ description: t("Use an isolated profile for auth, sessions, settings, and caches") }),
		alias: Flags.string({ description: t("Create a shell shortcut for the selected profile and exit") }),
		cwd: Flags.string({ description: t("Directory to start in (overrides the launch cwd)") }),
		mode: Flags.string({
			description: t("Output mode: text (default), json, rpc, or rpc-ui"),
			options: ["text", "json", "rpc", "acp", "rpc-ui"],
		}),
		config: Flags.string({
			description: t("Load an extra config.yml-style overlay for this run (repeatable)"),
			multiple: true,
		}),
		"add-dir": Flags.string({
			description: t("Add a workspace directory beyond the working directory (repeatable)"),
			multiple: true,
		}),
		print: Flags.boolean({ char: "p", description: t("Non-interactive mode: process prompt and exit") }),
		continue: Flags.boolean({ char: "c", description: t("Continue previous session") }),
		resume: Flags.string({ char: "r", description: t("Resume a session (by ID prefix, path, or picker if omitted)") }),
		restore: Flags.string({
			description:
				t("Resume a session as --resume does, then go on with what its last process left unfinished (the interrupted turn and the subagents it was running)"),
		}),
		"from-claude": Flags.boolean({ description: t("Import a Claude Code session into OMP") }),
		"from-codex": Flags.boolean({ description: t("Import a Codex session into OMP") }),
		"session-dir": Flags.string({ description: t("Directory for session storage and lookup") }),
		"no-session": Flags.boolean({ description: t("Don't save session (ephemeral)") }),
		models: Flags.string({ description: t("Comma-separated model patterns for {0} cycling", `${formatKeyHint("ctrl+p")}`) }),
		"no-tools": Flags.boolean({ description: t("Disable all built-in tools") }),
		"no-lsp": Flags.boolean({ description: t("Disable LSP tools, formatting, and diagnostics") }),
		"no-pty": Flags.boolean({ description: t("Disable PTY-based interactive bash execution") }),
		tools: Flags.string({ description: t("Comma-separated list of tools to enable (default: all)") }),
		thinking: Flags.string({
			description: t("Set thinking level: {0}", `${CLI_THINKING_LEVELS.join(", ")}`),
			options: [...CLI_THINKING_LEVELS],
		}),
		"service-tier": Flags.string({
			description: t("OpenAI service tier for this session (none omits service_tier)"),
			options: [...SERVICE_TIER_OPENAI_VALUES],
		}),
		"hide-thinking": Flags.boolean({
			description: t("Hide thinking blocks in TUI output (display only, does not disable model thinking)"),
		}),
		advisor: Flags.boolean({
			description: t("Enable the advisor runtime (passively reviews each turn and injects notes)"),
		}),
		"wait-async": Flags.boolean({
			description:
				t("Print mode: before exiting, wait for this run's background jobs and wake the session with each result (async.printWake); no time limit unless --max-time is set"),
		}),
		"external-thinking": Flags.boolean({
			description:
				t("Use a private scratchpad while disabling supported GPT, Claude, and Gemini reasoning (at your own risk: providers have flagged this request shape as abuse)"),
		}),
		hook: Flags.string({ description: t("Load a hook/extension file (can be used multiple times)"), multiple: true }),
		extension: Flags.string({
			char: "e",
			description: t("Load an extension file (can be used multiple times)"),
			multiple: true,
		}),
		"no-extensions": Flags.boolean({
			description: t("Disable extension discovery (explicit -e paths still work)"),
		}),
		"no-skills": Flags.boolean({ description: t("Disable skills discovery and loading") }),
		skills: Flags.string({ description: t("Comma-separated glob patterns to filter skills (e.g., git-*,docker)") }),
		"no-rules": Flags.boolean({ description: t("Disable rules discovery and loading") }),
		"no-context-files": Flags.boolean({ description: t("Disable context files (AGENTS.md, CLAUDE.md, ...)") }),
		export: Flags.string({ description: t("Export session file to HTML and exit") }),
		"no-title": Flags.boolean({ description: t("Disable title auto-generation") }),
		"no-ui": Flags.boolean({
			description: t("With --mode rpc or rpc-ui: run extensions headless (rpc-ui tool UI remains enabled)"),
		}),
		"print-thoughts": Flags.boolean({ description: t("Include thinking blocks in print mode text output") }),
		"max-time": Flags.string({ description: t("Stop the session after this duration (e.g., 600, 10m, 1h)") }),
		"warn-cost": Flags.string({
			description: t("Warn once when the session's spend, subagents included, reaches this many USD"),
		}),
		"max-cost": Flags.string({
			description:
				t("Stop sending model requests once the session's spend reaches this many USD; requests already in flight can finish past it (print mode exits 3)"),
		}),
		"auto-approve": Flags.boolean({
			aliases: ["yolo"],
			description: t("Auto-approve all tool calls (skip approval prompts)"),
		}),
		"approval-mode": Flags.string({
			options: ["always-ask", "always-ask-cached", "write", "yolo"],
			description: t("Override tools.approvalMode for this session (always-ask|always-ask-cached|write|yolo)"),
		}),
	},
	examples: [
		t("# Interactive mode\n  {0}", `${APP_NAME}`),
		t("# Interactive mode with initial prompt\n  {0} \"List all .ts files in src/\"", `${APP_NAME}`),
		t("# Start working on a goal immediately\n  {0} --goal \"Investigate the importer\"", `${APP_NAME}`),
		t("# Include files in initial message\n  {0} @prompt.md @image.png \"What color is the sky?\"", `${APP_NAME}`),
		t("# Non-interactive mode (process and exit)\n  {0} -p \"List all .ts files in src/\"", `${APP_NAME}`),
		t("# Continue previous session\n  {0} --continue \"What did we discuss?\"", `${APP_NAME}`),
		t("# Pick a session back up after a crash, subagents included\n  {0} --restore ~/.omp/agent/sessions/--path--/session.jsonl", `${APP_NAME}`),
		t("# Create a shell shortcut for a work profile\n  {0} --profile work --alias omp-work", `${APP_NAME}`),
		t("# Use different model (fuzzy matching)\n  {0} --model opus \"Help me refactor this code\"", `${APP_NAME}`),
		t("# Limit model cycling to specific models\n  {0} --models claude-sonnet,claude-haiku,gpt-4o", `${APP_NAME}`),
		t("# Export a session file to HTML\n  {0} --export ~/.omp/agent/sessions/--path--/session.jsonl", `${APP_NAME}`),
	],
} satisfies CommandMetadata;
