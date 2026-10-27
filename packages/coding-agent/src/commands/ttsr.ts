import { t } from "@oh-my-pi/pi-utils/i18n";
import { existsSync } from "node:fs";
import * as path from "node:path";
/**
 * `omp ttsr` — inspect and test Time-Traveling Stream Rules.
 *
 * `omp ttsr test` feeds a snippet (inline, --file, or stdin) through the real
 * TTSR matching pipeline and reports which rules would trigger. `omp ttsr list`
 * shows every TTSR-registered rule the current project/user config would load.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { ttsrHelp as commandHelp } from "../cli/command-help";
import {
	runTtsrCommand,
	TTSR_ACTIONS,
	TTSR_SOURCES,
	type TtsrCommandArgs,
	type TtsrScanArgs,
	type TtsrTestArgs,
} from "../cli/ttsr-cli";
import type { TtsrMatchSource } from "../export/ttsr";

export default class Ttsr extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: t("TTSR action"),
			required: false,
			options: TTSR_ACTIONS,
		}),
		snippet: Args.string({
			description: t("Inline snippet text to test (ttsr test) or directory to scan (ttsr scan)"),
			required: false,
		}),
	};

	static flags = {
		file: Flags.string({ description: t("Snippet file path, or - for stdin (ttsr test)") }),
		rule: Flags.string({
			char: "r",
			description: t("Rule markdown file to test in isolation (skips project rule loading)"),
		}),
		source: Flags.string({
			description: t("Match source: text, thinking, or tool (inferred from --file when omitted)"),
			options: TTSR_SOURCES,
		}),
		tool: Flags.string({
			description: t("Tool name when source is tool (e.g. edit, write); defaults to edit"),
		}),
		path: Flags.string({
			char: "p",
			description: t("Candidate file path for scope/glob matching and AST language inference"),
		}),
		agent: Flags.string({
			description: t("Agent name to evaluate rule `agents` scoping as (ttsr test); defaults to main"),
		}),
		verbose: Flags.boolean({ char: "v", description: t("Show every evaluated rule, not just triggered ones") }),
		json: Flags.boolean({ description: t("Output JSON\u0004packages/coding-agent/src/commands/ssh.ts:SSH.flags.json.description") }),
		"no-gitignore": Flags.boolean({ description: t("Include files excluded by .gitignore (ttsr scan)") }),
		"max-bytes": Flags.integer({
			description: t("Maximum file size to scan in bytes; 0 disables the limit (ttsr scan)"),
		}),
	};

	static examples = [
		"omp ttsr list",
		"omp ttsr test 'const x: any = 1'",
		"omp ttsr test src/foo.ts",
		"omp ttsr test --file src/foo.ts",
		"omp ttsr test --file src/foo.ts --source text",
		"omp ttsr test --rule .omp/rules/no-any.md --source tool --path src/foo.ts 'const x: any = 1'",
		"omp ttsr test --agent scout 'const x: any = 1'",
		"echo 'Box::leak(&mut v)' | omp ttsr test --file - --path src/lib.rs",
		"omp ttsr test --source tool --tool edit --path src/foo.ts 'const x: any = 1'",
		"omp ttsr scan",
		"omp ttsr scan src/",
		"omp ttsr scan -r .omp/rules/no-any.md src/",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Ttsr);
		const action = (args.action ?? "list") as (typeof TTSR_ACTIONS)[number];

		// A positional that resolves to an existing file is a snippet file, not
		// inline text — so `omp ttsr test src/foo.ts` works without --file.
		// --file always wins over the positional.
		let file = flags.file;
		let snippet = args.snippet;
		if (action === "test" && snippet && !file) {
			const resolved = path.resolve(snippet);
			if (existsSync(resolved)) {
				file = resolved;
				snippet = undefined;
			}
		}

		const test: TtsrTestArgs | undefined =
			action === "test"
				? {
						snippet,
						file,
						rule: flags.rule,
						source: flags.source as TtsrMatchSource | undefined,
						tool: flags.tool,
						filePath: flags.path,
						verbose: flags.verbose,
						agent: flags.agent,
					}
				: undefined;

		const scan: TtsrScanArgs | undefined =
			action === "scan"
				? {
						directory: args.snippet,
						rule: flags.rule,
						gitignore: !flags["no-gitignore"],
						maxBytes: flags["max-bytes"],
						verbose: flags.verbose,
					}
				: undefined;

		const cmd: TtsrCommandArgs = {
			action,
			test,
			scan,
			json: flags.json,
		};

		await runTtsrCommand(cmd);
	}
}
