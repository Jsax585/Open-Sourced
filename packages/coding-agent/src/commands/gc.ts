/**
 * Run on-disk storage maintenance.
 */

import { t } from "@oh-my-pi/pi-utils/i18n";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { gcHelp as commandHelp } from "../cli/command-help";
import { collectGcErrors, type GcCommandArgs, runGcCommand } from "../cli/gc-cli";

export default class Gc extends Command {
	static description = commandHelp.description;
	static flags = {
		apply: Flags.boolean({ description: t("Apply changes (default is dry-run)") }),
		json: Flags.boolean({ description: t("Output JSON") }),
		"agent-dir": Flags.string({ description: t("Agent directory to maintain") }),
		blobs: Flags.boolean({ description: t("Sweep unreferenced blobs") }),
		archive: Flags.boolean({ description: t("Archive cold sessions") }),
		wal: Flags.boolean({ description: t("Checkpoint history/model database WAL files") }),
		stale: Flags.boolean({
			description: t("Prune dangling session markers/breadcrumbs and old debug reports and collab replicas"),
		}),
		compress: Flags.boolean({
			description: t("Store idle sessions with filesystem compression in place (APFS, NTFS)"),
		}),
		"cold-archive-after-days": Flags.integer({ description: t("Minimum session age before archiving") }),
		"retain-newest-global": Flags.integer({ description: t("Always keep this many newest sessions active") }),
		"retain-newest-per-cwd": Flags.integer({ description: t("Always keep this many newest sessions per cwd active") }),
		"stale-retain-newest": Flags.integer({
			description: t("Always keep this many newest debug reports and collab replicas"),
		}),
		"stale-retain-days": Flags.integer({ description: t("Minimum debug report/collab replica age before pruning") }),
		"compress-after-days": Flags.integer({ description: t("Minimum idle days before compressing a session") }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Gc);
		const cmd: GcCommandArgs = {
			flags: {
				apply: flags.apply,
				json: flags.json,
				agentDir: flags["agent-dir"],
				blobs: flags.blobs,
				archive: flags.archive,
				wal: flags.wal,
				stale: flags.stale,
				compress: flags.compress,
				coldArchiveAfterDays: flags["cold-archive-after-days"],
				retainNewestGlobal: flags["retain-newest-global"],
				retainNewestPerCwd: flags["retain-newest-per-cwd"],
				staleRetainNewest: flags["stale-retain-newest"],
				staleRetainDays: flags["stale-retain-days"],
				compressAfterDays: flags["compress-after-days"],
			},
		};
		const result = await runGcCommand(cmd);
		const errors = collectGcErrors(result);
		if (errors.length > 0) {
			process.stderr.write(
				t("GC completed with {0} error{2}:\n{1}\n", `${errors.length}`, `${errors.map(error => `- ${error}`).join("\n")}`, `${errors.length === 1 ? "" : "s"}`),
			);
			process.exitCode = 1;
		}
	}
}
