/**
 * Manage plugins (install, uninstall, list, etc.).
 */

import { t } from "@oh-my-pi/pi-utils/i18n";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { pluginHelp as commandHelp } from "../cli/command-help";
import { type PluginAction, type PluginCommandArgs, runPluginCommand } from "../cli/plugin-cli";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const ACTIONS: PluginAction[] = [
	"install",
	"uninstall",
	"list",
	"link",
	"doctor",
	"features",
	"config",
	"enable",
	"disable",
	"marketplace",
	"discover",
	"upgrade",
];

export default class Plugin extends Command {
	static description = commandHelp.description;
	static aliases = ["plugins"];
	static args = {
		action: Args.string({
			description: t("Plugin action"),
			required: false,
			options: ACTIONS,
		}),
		targets: Args.string({
			description: t("Packages, paths, or plugin names"),
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: t("Output JSON") }),
		fix: Flags.boolean({ description: t("Attempt to fix issues (doctor)") }),
		force: Flags.boolean({ description: t("Force install") }),
		"dry-run": Flags.boolean({ description: t("Show actions without applying changes") }),
		local: Flags.boolean({ char: "l", description: t("Operate on local plugin directory") }),
		enable: Flags.string({ description: t("Enable a feature") }),
		disable: Flags.string({ description: t("Disable a feature") }),
		set: Flags.string({ description: t("Set plugin config (key=value)") }),
		scope: Flags.string({
			description: t("Install scope: \"user\" (default) or \"project\""),
			options: ["user", "project"],
		}),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Plugin);
		const action = (args.action ?? "list") as PluginAction;

		const targets = Array.isArray(args.targets) ? args.targets : args.targets ? [args.targets] : [];
		const cmd: PluginCommandArgs = {
			action,
			args: targets,
			flags: {
				json: flags.json,
				fix: flags.fix,
				force: flags.force,
				dryRun: flags["dry-run"],
				local: flags.local,
				enable: flags.enable,
				disable: flags.disable,
				set: flags.set,
				scope: flags.scope as "user" | "project" | undefined,
			},
		};

		await initTheme();
		await runPluginCommand(cmd);
	}
}
