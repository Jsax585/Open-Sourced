/**
 * Compatibility surface for the terminal stderr guard released in 16.5.1
 * (`suppressTerminalStderr` / `restoreTerminalStderr` and helpers). The
 * unified terminal-output guard (terminal-output-guard.ts) now covers
 * inherited stdout as well and is what the TUI uses; these entry points keep
 * the released names working for external consumers with their original
 * fd-2-only semantics — calling them must never fence fd 1.
 *
 * When the unified guard is active it already owns both descriptors, so the
 * legacy calls report suppression and leave the descriptors alone; the
 * unified release path restores them.
 */
import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";
import { getLogPath } from "./dirs";
import { isTerminalOutputSuppressed, setTerminalOutputRedirectTarget } from "./terminal-output-guard";

interface LibcFdOps {
	dup(fd: number): number;
	dup2(oldFd: number, newFd: number): number;
}

let libcFdOpsCache: LibcFdOps | null = null;

function libcFdOps(): LibcFdOps | null {
	if (libcFdOpsCache !== null) return libcFdOpsCache;
	if (process.platform === "win32") return null;
	// Darwin: dyld resolves libSystem from the shared cache. Linux: glibc
	// first, then the generic soname for musl-style layouts.
	const candidates =
		process.platform === "darwin" ? ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc"];
	for (const candidate of candidates) {
		try {
			const libc = dlopen(candidate, {
				dup: { args: [FFIType.i32], returns: FFIType.i32 },
				dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			});
			libcFdOpsCache = libc.symbols as LibcFdOps;
			return libcFdOpsCache;
		} catch {
			// Try the next candidate; the guard stays inert if none load.
		}
	}
	return null;
}

/**
 * True when fd 2 writes would land on the same terminal the caller prints
 * stdout to: both descriptors are ttys backed by the same device file. A
 * stderr the caller already redirected (`2>file`, `2>/dev/null`, a different
 * tty) must keep flowing untouched — as in 16.5.1.
 */
function stderrSharesStdoutTerminal(): boolean {
	if (!process.stdout.isTTY || !process.stderr.isTTY) return false;
	try {
		const stdoutStat = fs.fstatSync(1);
		const stderrStat = fs.fstatSync(2);
		return stdoutStat.dev === stderrStat.dev && stdoutStat.ino === stderrStat.ino;
	} catch {
		return false;
	}
}

/** Saved dup of the real stderr while legacy suppression is active, else null. */
let savedStderrFd: number | null = null;

/** Newest log file the legacy guard knows about; see {@link setStderrRedirectTarget}. */
let redirectTarget: string | null = null;

export interface SuppressTerminalStderrOptions {
	/**
	 * Redirect target path; defaults to the log file the rotating sink last
	 * reported (see {@link setStderrRedirectTarget}), then today's omp log.
	 */
	redirectPath?: string;
	/** Bypass the same-terminal gate. Tests only, as in 16.5.1. */
	force?: boolean;
}

/**
 * Redirect fd 2 away from the terminal — fd 1 is never touched. Returns true
 * when suppression is (already) active: via this guard, or because the
 * unified terminal-output guard owns the descriptors. Returns false when
 * stderr does not share the stdout terminal or libc fd operations are
 * unavailable.
 */
export function suppressTerminalStderr(options?: SuppressTerminalStderrOptions): boolean {
	if (isTerminalOutputSuppressed()) return true;
	if (savedStderrFd !== null) return true;
	if (!options?.force && !stderrSharesStdoutTerminal()) return false;
	const libc = libcFdOps();
	if (!libc) return false;

	let redirectFd: number;
	try {
		const redirectPath = options?.redirectPath ?? redirectTarget ?? getLogPath();
		// The logger creates the logs directory lazily; on a fresh profile it
		// may not exist yet, so diagnostics land in the log instead of /dev/null.
		fs.mkdirSync(path.dirname(redirectPath), { recursive: true });
		redirectFd = fs.openSync(redirectPath, "a");
		redirectTarget = redirectPath;
	} catch {
		try {
			redirectFd = fs.openSync("/dev/null", "w");
		} catch {
			return false;
		}
	}

	const saved = libc.dup(2);
	if (saved === -1) {
		fs.closeSync(redirectFd);
		return false;
	}
	if (libc.dup2(redirectFd, 2) === -1) {
		fs.closeSync(redirectFd);
		fs.closeSync(saved);
		return false;
	}
	fs.closeSync(redirectFd);
	savedStderrFd = saved;
	return true;
}

/**
 * Point fd 2 at `logPath`, the log file the rotating sink is currently
 * writing; the logger calls this on every sink rotation. With the unified
 * guard active this forwards to it (both descriptors follow the live file).
 */
export function setStderrRedirectTarget(logPath: string): void {
	redirectTarget = logPath;
	if (isTerminalOutputSuppressed()) {
		setTerminalOutputRedirectTarget(logPath);
		return;
	}
	if (savedStderrFd === null) return;
	const libc = libcFdOps();
	if (!libc) return;
	let redirectFd: number;
	try {
		redirectFd = fs.openSync(logPath, "a");
	} catch {
		return;
	}
	libc.dup2(redirectFd, 2);
	fs.closeSync(redirectFd);
}

/**
 * Re-point fd 2 at the saved terminal stderr. Safe to call unconditionally:
 * no-op when this guard is inactive, and no-op while the unified guard owns
 * the descriptors (its own release path restores them).
 */
export function restoreTerminalStderr(): void {
	if (savedStderrFd === null) return;
	if (isTerminalOutputSuppressed()) return;
	const saved = savedStderrFd;
	savedStderrFd = null;
	libcFdOps()?.dup2(saved, 2);
	try {
		fs.closeSync(saved);
	} catch {
		// The dup'ed fd is process-owned; a close failure leaves nothing to recover.
	}
}

/**
 * Whether fd 2 is currently redirected away from the terminal, by this guard
 * or by the unified terminal-output guard.
 */
export function isTerminalStderrSuppressed(): boolean {
	return savedStderrFd !== null || isTerminalOutputSuppressed();
}
