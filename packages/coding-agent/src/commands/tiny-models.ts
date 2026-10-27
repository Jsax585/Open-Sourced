import { t } from "@oh-my-pi/pi-utils/i18n";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { tinyModelsHelp as commandHelp } from "../cli/command-help";
import { runTinyModelsCommand, type TinyModelsAction, type TinyModelsCommandArgs } from "../cli/tiny-models-cli";

const ACTIONS: TinyModelsAction[] = ["download", "list"];

export default class TinyModels extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: t("Action to perform"),
			required: false,
			options: ACTIONS,
		}),
		model: Args.string({
			description: t("Model key (`smollm` = word completion), or all"),
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: t("Output JSON\u0004packages/coding-agent/src/commands/ssh.ts:SSH.flags.json.description") }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(TinyModels);
		const command: TinyModelsCommandArgs = {
			action: (args.action ?? "download") as TinyModelsAction,
			model: args.model,
			flags: {
				json: flags.json,
			},
		};
		await runTinyModelsCommand(command);
	}
}
