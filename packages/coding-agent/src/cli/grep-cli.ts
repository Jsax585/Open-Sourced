/**
 * Grep CLI command handlers.
 *
 * Handles `omp grep` subcommand for testing grep tool on Windows.
 */
import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import * as path from "node:path";
import { GrepOutputMode, grep } from "@oh-my-pi/pi-natives";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { expandPath } from "../tools/path-utils";

export interface GrepCommandArgs {
	pattern: string;
	path: string;
	glob?: string;
	limit: number;
	context: number;
	mode: GrepOutputMode;
	gitignore: boolean;
}

/**
 * Parse grep subcommand arguments.
 * Returns undefined if not a grep command.
 */
export function parseGrepArgs(args: string[]): GrepCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "grep") {
		return undefined;
	}

	const result: GrepCommandArgs = {
		pattern: "",
		path: ".",
		limit: 20,
		context: 2,
		mode: GrepOutputMode.Content,
		gitignore: true,
	};

	const positional: string[] = [];

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--glob" || arg === "-g") {
			result.glob = args[++i];
		} else if (arg === "--limit" || arg === "-l") {
			result.limit = parseInt(args[++i], 10);
		} else if (arg === "--context" || arg === "-C") {
			result.context = parseInt(args[++i], 10);
		} else if (arg === "--files" || arg === "-f") {
			result.mode = GrepOutputMode.FilesWithMatches;
		} else if (arg === "--count" || arg === "-c") {
			result.mode = GrepOutputMode.Count;
		} else if (arg === "--no-gitignore") {
			result.gitignore = false;
		} else if (!arg.startsWith("-")) {
			positional.push(arg);
		}
	}

	if (positional.length >= 1) {
		result.pattern = positional[0];
	}
	if (positional.length >= 2) {
		result.path = positional[1];
	}

	return result;
}

export async function runGrepCommand(cmd: GrepCommandArgs): Promise<void> {
	if (!cmd.pattern) {
		console.error(chalk.red(__ompTranslate("Error: Pattern is required")));
		process.exit(1);
	}

	const searchPath = path.resolve(expandPath(cmd.path));
	console.log(chalk.dim(__ompTranslate("Searching in: {0}", `${searchPath}`)));
	console.log(chalk.dim(__ompTranslate("Pattern: {0}", `${cmd.pattern}`)));
	console.log(
		chalk.dim(
			__ompTranslate(
				"Mode: {0}, Limit: {1}, Context: {2}, Gitignore: {3}",
				`${cmd.mode}`,
				`${cmd.limit}`,
				`${cmd.context}`,
				`${cmd.gitignore}`,
			),
		),
	);

	console.log("");

	try {
		const result = await grep({
			pattern: cmd.pattern,
			path: searchPath,
			glob: cmd.glob,
			mode: cmd.mode,
			maxCount: cmd.limit,
			context: cmd.mode === GrepOutputMode.Content ? cmd.context : undefined,
			hidden: true,
			gitignore: cmd.gitignore,
		});

		console.log(chalk.green(__ompTranslate("Total matches: {0}", `${result.totalMatches}`)));
		console.log(chalk.green(__ompTranslate("Files with matches: {0}", `${result.filesWithMatches}`)));
		console.log(chalk.green(__ompTranslate("Files searched: {0}", `${result.filesSearched}`)));
		if (result.limitReached) {
			console.log(chalk.yellow(__ompTranslate("Limit reached: true")));
		}
		console.log("");

		for (const match of result.matches) {
			const displayPath = match.path.replace(/\\/g, "/");

			if (cmd.mode === GrepOutputMode.Content) {
				if (match.contextBefore) {
					for (const ctx of match.contextBefore) {
						console.log(chalk.dim(`${displayPath}-${ctx.lineNumber}- ${ctx.line}`));
					}
				}
				console.log(`${chalk.cyan(displayPath)}:${chalk.yellow(String(match.lineNumber))}: ${match.line}`);
				if (match.contextAfter) {
					for (const ctx of match.contextAfter) {
						console.log(chalk.dim(`${displayPath}-${ctx.lineNumber}- ${ctx.line}`));
					}
				}
				console.log("");
			} else if (cmd.mode === GrepOutputMode.Count) {
				console.log(__ompTranslate("{0}: {1} matches", `${chalk.cyan(displayPath)}`, `${match.matchCount ?? 0}`));
			} else {
				console.log(chalk.cyan(displayPath));
			}
		}
	} catch (err) {
		console.error(chalk.red(__ompTranslate("Error: {0}", `${err instanceof Error ? err.message : String(err)}`)));
		process.exit(1);
	}
}

export function printGrepHelp(): void {
	console.log(
		__ompTranslate(
			'{0} - Test grep tool\n\n{1}\n  {2} grep <pattern> [path] [options]\n\n{3}\n  pattern   Regex pattern to search for\n  path      Directory or file to search (default: .)\n\n{4}\n  -g, --glob <pattern>  Filter files by glob pattern\n  -l, --limit <n>       Max matches (default: 20)\n  -C, --context <n>     Context lines (default: 2)\n  -f, --files           Output file names only\n  -c, --count           Output match counts per file\n  -h, --help            Show this help\n  --no-gitignore        Include files excluded by .gitignore\n\n{5}\n  PI_WALK_WORKERS=N    Set filesystem walker workers (default 4, 0 = auto)\n\n{6}\n  {7} grep "import" src/\n  {8} grep "TODO" . --glob "*.ts"\n  {9} grep "function" --files\n',
			`${chalk.bold(`${APP_NAME} grep`)}`,
			`${chalk.bold(__ompTranslate("Usage:"))}`,
			`${APP_NAME}`,
			`${chalk.bold(__ompTranslate("Arguments:"))}`,
			`${chalk.bold(__ompTranslate("Options:"))}`,
			`${chalk.bold(__ompTranslate("Environment:"))}`,
			`${chalk.bold(__ompTranslate("Examples:\u0004help.search.examples"))}`,
			`${APP_NAME}`,
			`${APP_NAME}`,
			`${APP_NAME}`,
		),
	);
}
