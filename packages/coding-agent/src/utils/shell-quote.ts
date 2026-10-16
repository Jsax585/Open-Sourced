import { Buffer } from "node:buffer";

/** Quote one argument for use in a POSIX shell command. */
export function quotePosixArgument(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Quote argv for use as a POSIX shell command string. */
export function quotePosixArgv(argv: readonly string[]): string {
	return argv.map(quotePosixArgument).join(" ");
}

/** PowerShell treats ASCII and smart apostrophes as single-quote delimiters. */
export function quotePowerShellArgument(value: string): string {
	return `'${value.replace(/['\u2018-\u201b]/g, "$&$&")}'`;
}

export type InteractiveShell = "posix" | "fish" | "powershell" | "cmd" | "unknown";

/**
 * Best-effort command-hint selection, not parent-process detection: SHELL usually
 * names the login shell, and PowerShell/MSYS variables can survive nested shells.
 * Keep the inferred dialect visible to users rather than claiming certainty.
 */
export function detectInteractiveShell(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): InteractiveShell {
	const shell = (env.SHELL ?? "")
		.split(/[\\/]/)
		.at(-1)
		?.toLowerCase()
		.replace(/\.exe$/, "");
	if (shell === "pwsh" || shell === "powershell") return "powershell";
	// An explicit SHELL outranks inherited PowerShell environment variables.
	if (shell && /^(?:ba|z|da|k|a)?sh$/.test(shell)) return "posix";
	if (shell === "fish") return "fish";
	if (shell === "cmd") return "cmd";
	if (shell) return "unknown";
	if (env.PSModulePath || env.PSMODULEPATH || env.psmodulepath || env.POWERSHELL_DISTRIBUTION_CHANNEL) {
		return "powershell";
	}
	// Do not assume Windows means PowerShell. cmd needs a different quoting
	// strategy, and arbitrary interactive cmd arguments cannot be quoted safely.
	return platform === "win32" ? "cmd" : "unknown";
}

/** Quote one argument for an explicitly selected shell dialect. */
export function quoteShellArgument(value: string, shell: Exclude<InteractiveShell, "cmd" | "unknown">): string {
	// Restrict bare words to syntax shared by these shells (no PowerShell
	// splatting, commas, smart quotes, or POSIX expansions).
	if (/^[\w./:-]+$/.test(value)) return value;
	if (shell === "powershell") return quotePowerShellArgument(value);
	if (shell === "fish") return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
	return quotePosixArgument(value);
}

function quotePosixUtf8Run(value: string): string {
	const octalBytes = Array.from(Buffer.from(value, "utf8"), byte => `\\${byte.toString(8).padStart(3, "0")}`).join("");
	// This run has no ASCII newline byte, so command substitution preserves it.
	return `"$(printf '${octalBytes}')"`;
}

function quotePosixArgumentAsciiSafe(value: string): string {
	const pieces: string[] = [];
	let asciiRun = "";
	let utf8Run = "";
	for (const character of value) {
		if (character.charCodeAt(0) <= 0x7f) {
			if (utf8Run) {
				pieces.push(quotePosixUtf8Run(utf8Run));
				utf8Run = "";
			}
			asciiRun += character;
		} else {
			if (asciiRun) {
				pieces.push(quotePosixArgument(asciiRun));
				asciiRun = "";
			}
			utf8Run += character;
		}
	}
	if (asciiRun) pieces.push(quotePosixArgument(asciiRun));
	if (utf8Run) pieces.push(quotePosixUtf8Run(utf8Run));
	return pieces.join("") || quotePosixArgument("");
}

/**
 * Build a POSIX shell command without literal non-ASCII input.
 * The optional cwd is quoted and changed to before invoking the command.
 */
export function quotePosixArgvAsciiSafe(argv: readonly string[], cwd?: string): string {
	const command = argv.map(quotePosixArgumentAsciiSafe).join(" ");
	if (cwd === undefined) return command;
	return `cd ${quotePosixArgumentAsciiSafe(cwd)} && ${command}`;
}
