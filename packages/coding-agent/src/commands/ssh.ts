/**
 * Manage SSH host configurations.
 */

import { t } from "@oh-my-pi/pi-utils/i18n";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { sshHelp as commandHelp } from "../cli/command-help";
import { runSSHCommand, type SSHAction, type SSHCommandArgs } from "../cli/ssh-cli";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const ACTIONS: SSHAction[] = ["add", "remove", "list"];

export default class SSH extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: t("SSH action"),
			required: false,
			options: ACTIONS,
		}),
		targets: Args.string({
			description: t("Host name or arguments"),
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: t("Output JSON\u0004packages/coding-agent/src/commands/ssh.ts:SSH.flags.json.description") }),
		host: Flags.string({ description: t("Host address") }),
		user: Flags.string({ description: t("Username") }),
		port: Flags.string({ description: t("Port number") }),
		key: Flags.string({ description: t("Identity key path") }),
		desc: Flags.string({ description: t("Host description") }),
		compat: Flags.boolean({ description: t("Enable compatibility mode") }),
		scope: Flags.string({ description: t("Config scope (project|user)"), options: ["project", "user"] }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(SSH);
		const action = (args.action ?? "list") as SSHAction;
		const targets = Array.isArray(args.targets) ? args.targets : args.targets ? [args.targets] : [];

		const cmd: SSHCommandArgs = {
			action,
			args: targets,
			flags: {
				json: flags.json,
				host: flags.host,
				user: flags.user,
				port: flags.port,
				key: flags.key,
				desc: flags.desc,
				compat: flags.compat,
				scope: flags.scope as "project" | "user" | undefined,
			},
		};

		await initTheme();
		await runSSHCommand(cmd);
	}
}
