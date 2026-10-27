/**
 * Semantic search from the shell: `omp find "<query>" [path]`.
 */

import { t } from "@oh-my-pi/pi-utils/i18n";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { findHelp as commandHelp } from "../cli/command-help";
import { runFindCommand } from "../cli/find-cli";

export default class Find extends Command {
	static description = commandHelp.description;
	static args = {
		query: Args.string({ description: t("What to find, in plain language"), required: false }),
		path: Args.string({ description: t("Directory or omp:// docs scope to search"), required: false }),
	};

	static flags = {
		keyword: Flags.string({
			char: "k",
			description: t("Extra lexical keyword (repeatable, or comma-separated)"),
			multiple: true,
		}),
		hidden: Flags.boolean({ description: t("Include dot-files and dot-folders") }),
		json: Flags.boolean({ description: t("Emit the full result as JSON") }),
		quiet: Flags.boolean({ char: "q", description: t("Suppress progress on stderr") }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Find);
		await runFindCommand({
			query: args.query ?? "",
			path: args.path ?? ".",
			keywords: (flags.keyword ?? []).flatMap(value => value.split(",")),
			hidden: flags.hidden ?? false,
			json: flags.json ?? false,
			quiet: flags.quiet ?? false,
		});
	}
}
