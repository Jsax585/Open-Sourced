import { t } from "@oh-my-pi/pi-utils/i18n";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { playHelp as commandHelp } from "../cli/command-help";
import { playRecording } from "../stream/player";
import { latestRecording, parseRecording, type Recording, recordingsDir } from "../stream/recording";

export default class Play extends Command {
	static description = commandHelp.description;

	static args = {
		file: Args.string({ description: t("Recording to play (default: the newest /record capture)") }),
	};

	static flags = {
		speed: Flags.string({ char: "s", description: t("Playback speed multiplier (default: 1)") }),
		"idle-limit": Flags.string({ char: "i", description: t("Cap pauses between frames to this many seconds") }),
	};

	static examples = ["omp play", "omp play /tmp/omp-recordings/2026-09-22T10-00-00-1a2b3c4d.ompcast -s 2 -i 1"];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Play);
		const speed = parsePositive("--speed", flags.speed) ?? 1;
		const idleLimit = parsePositive("--idle-limit", flags["idle-limit"]);
		if (!process.stdout.isTTY) throw new CliUsageError(t("omp play needs an interactive terminal"));

		const file = args.file ? path.resolve(args.file) : await latestRecording();
		if (!file) throw new CliUsageError(t("no recordings in {0}; start one with /record", `${recordingsDir()}`));
		let text: string;
		try {
			text = await Bun.file(file).text();
		} catch (error) {
			if (isEnoent(error)) throw new CliUsageError(t("recording not found: {0}", `${file}`));
			throw error;
		}
		let recording: Recording;
		try {
			recording = parseRecording(text);
		} catch (error) {
			throw new CliUsageError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
		await playRecording(recording, { speed, idleLimitMs: idleLimit === undefined ? undefined : idleLimit * 1000 });
	}
}

function parsePositive(flag: string, value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new CliUsageError(t("{0} must be a positive number", `${flag}`));
	return parsed;
}
