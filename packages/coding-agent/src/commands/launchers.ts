/**
 * List profiles, config overlays, and model presets.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { reportCliUsageError } from "../cli/args";
import { launchersHelp as commandHelp } from "../cli/command-help";
import { runLaunchersCommand } from "../cli/launchers-cli";

export default class Launchers extends Command {
	static description = commandHelp.description;

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		config: Flags.string({
			description: "Load an extra config.yml-style overlay and list it with its presets (repeatable)",
			multiple: true,
		}),
		"overlay-dir": Flags.string({
			description: "Also list the .yml/.yaml overlay files in this directory (omp has no default overlay directory)",
		}),
	};

	static examples = [
		`# List profiles, PI_CONFIG_FILES/--config overlays, and model presets\n  ${APP_NAME} launchers`,
		`# Include the presets defined by an overlay file\n  ${APP_NAME} launchers --config ~/overlays/deep.yml`,
		`# Also list the overlay files kept in a directory of your choice\n  ${APP_NAME} launchers --overlay-dir ~/overlays`,
		`# List what a named profile would see (its presets come from that profile's config)\n  ${APP_NAME} --profile work launchers`,
		`# Machine-readable output\n  ${APP_NAME} launchers --json`,
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Launchers);
		try {
			await runLaunchersCommand({
				flags: { json: flags.json, config: flags.config, overlayDir: flags["overlay-dir"] },
			});
		} catch (error) {
			if (!reportCliUsageError(error)) throw error;
			process.exitCode = 2;
		}
	}
}
