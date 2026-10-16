import { Buffer } from "node:buffer";

/** Quote one argument for use in a POSIX shell command. */
export function quotePosixArgument(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Quote argv for use as a POSIX shell command string. */
export function quotePosixArgv(argv: readonly string[]): string {
	return argv.map(quotePosixArgument).join(" ");
}

/** Quote one argument for PowerShell: single quotes, with `'` doubled. */
export function quotePowerShellArgument(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Quote one argument for pasting into the user's interactive shell. Plain words
 * (including Windows drive paths) stay bare, which is valid in POSIX shells,
 * PowerShell, and cmd.exe alike. Anything else is quoted for PowerShell on
 * Windows (the only shell omp targets there, see `--alias`) and POSIX elsewhere.
 */
export function quoteShellArgument(value: string, platform: NodeJS.Platform = process.platform): string {
	const win32 = platform === "win32";
	const bare = win32 ? /^[\w@%+=:,./\\-]+$/ : /^[\w@%+=:,./-]+$/;
	if (bare.test(value)) return value;
	return win32 ? quotePowerShellArgument(value) : quotePosixArgument(value);
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
