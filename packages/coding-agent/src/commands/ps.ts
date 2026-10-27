/**
 * Inspect and control daemon-broker supervised processes from outside the harness.
 */

import { t } from "@oh-my-pi/pi-utils/i18n";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { psHelp as commandHelp } from "../cli/command-help";
import { type PsAction, type PsCommandArgs, runPsCommand } from "../cli/ps-cli";

const ACTIONS: PsAction[] = ["list", "info", "logs", "stop", "kill", "restart"];

export default class Ps extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: t("list (default), info, logs, stop, kill, or restart"),
			required: false,
			options: ACTIONS,
		}),
		name: Args.string({
			description: t("Process name (required for every action except list)"),
			required: false,
		}),
	};

	static flags = {
		all: Flags.boolean({ char: "a", description: t("Also list other projects and exited global services (list)") }),
		json: Flags.boolean({ char: "j", description: t("Emit machine-readable JSON") }),
		plain: Flags.boolean({ description: t("Static listing instead of the interactive monitor (list)") }),
		dir: Flags.string({ description: t("Target another project directory instead of the current one") }),
		global: Flags.string({ description: t("Target a machine-global service scope (e.g. browser-relay)") }),
		follow: Flags.boolean({ char: "f", description: t("Keep streaming new output (logs)") }),
		head: Flags.boolean({ description: t("Read from the beginning instead of the tail (logs)") }),
		lines: Flags.integer({ char: "n", description: t("Number of log lines, max 1000 (logs)") }),
		grep: Flags.string({ description: t("Regex filter applied to log lines (logs)") }),
		timeout: Flags.integer({ description: t("Grace period in seconds before hard kill (stop)") }),
	};

	static examples = [
		"omp ps",
		"omp ps --all",
		"omp ps logs web --follow",
		"omp ps stop web",
		"omp ps kill web",
		"omp ps info relay --global browser-relay",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Ps);
		const cmd: PsCommandArgs = {
			action: (args.action ?? "list") as PsAction,
			name: args.name,
			flags: {
				all: flags.all ?? false,
				json: flags.json ?? false,
				plain: flags.plain ?? false,
				dir: flags.dir,
				global: flags.global,
				follow: flags.follow ?? false,
				head: flags.head ?? false,
				lines: flags.lines,
				grep: flags.grep,
				timeout: flags.timeout,
			},
		};
		await runPsCommand(cmd);
	}
}
