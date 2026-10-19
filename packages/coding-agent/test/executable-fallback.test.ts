import * as fs from "node:fs";
import * as path from "node:path";
import * as utils from "@oh-my-pi/pi-utils";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { resolveCliEntryCmd, resolveExecutablePath, resolveWorkerSpawnCmd } from "../src/subprocess/worker-client";

describe("executable path resolution", () => {
	const originalExecPathDesc = Object.getOwnPropertyDescriptor(process, "execPath");
	const originalArgv0Desc = Object.getOwnPropertyDescriptor(process, "argv0");

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalExecPathDesc) {
			Object.defineProperty(process, "execPath", originalExecPathDesc);
		}
		if (originalArgv0Desc) {
			Object.defineProperty(process, "argv0", originalArgv0Desc);
		}
	});

	function setProcessProp(prop: "execPath" | "argv0", value: string): void {
		Object.defineProperty(process, prop, {
			value,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}

	it("keeps execPath when no launcher resolves to the same binary", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		vi.spyOn(utils, "isExecutable").mockReturnValue(true);
		vi.spyOn(utils, "$which").mockReturnValue(null);
		// No launcher resolves to execPath (bun test's own execPath is bun's,
		// so realpathSync never matches a fake candidate anyway).
		vi.spyOn(fs.realpathSync, "native").mockImplementation((p: fs.PathLike) => String(p));

		expect(resolveCliEntryCmd()).toEqual([process.execPath]);
		expect(resolveWorkerSpawnCmd("__omp_worker_test")).toEqual({
			cmd: [process.execPath, "__omp_worker_test"],
		});
	});

	it("re-enters through a launcher symlink that resolves to the running binary", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const versionedBinary = "/Users/x/Library/Application Support/Tern/omp/versions/18.8.9";
		const launcher = "/Users/x/.local/bin/omp";
		setProcessProp("execPath", versionedBinary);
		setProcessProp("argv0", "omp");

		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => (cmd === "omp" ? launcher : null));
		vi.spyOn(utils, "isExecutable").mockReturnValue(true);
		// realpath collapses the launcher to the versioned binary: identity holds,
		// so workers spawn via the launcher and get `comm` = "omp" instead of "18.8.9".
		vi.spyOn(fs.realpathSync, "native").mockImplementation((p: fs.PathLike) =>
			String(p) === launcher ? versionedBinary : String(p),
		);

		expect(resolveCliEntryCmd()).toEqual([launcher]);
		expect(resolveWorkerSpawnCmd("__omp_worker_test")).toEqual({
			cmd: [launcher, "__omp_worker_test"],
		});
	});

	it("does not re-enter a launcher repointed at a different binary after upgrade", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const runningBinary = "/Users/x/Library/Application Support/Tern/omp/versions/18.8.9";
		const nextBinary = "/Users/x/Library/Application Support/Tern/omp/versions/18.9.0";
		const launcher = "/Users/x/.local/bin/omp";
		setProcessProp("execPath", runningBinary);
		setProcessProp("argv0", "omp");

		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => (cmd === "omp" ? launcher : null));
		vi.spyOn(utils, "isExecutable").mockReturnValue(true);
		vi.spyOn(fs.realpathSync, "native").mockImplementation((p: fs.PathLike) =>
			String(p) === launcher ? nextBinary : String(p),
		);

		// The link now names a different file: re-entering it would silently
		// swap the worker's version, so the running binary wins.
		expect(resolveExecutablePath()).toBe(runningBinary);
	});

	it("prefers original absolute launcher path over generic PATH match when executable", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		// The launcher must be fully qualified on the host platform: on Windows a rooted path
		// without a drive letter is drive-relative and intentionally not trusted.
		const root = process.platform === "win32" ? "C:" : "";
		const missingPath = `${root}/opt/homebrew/Cellar/omp/18.1.8/bin/omp`;
		const originalLauncher = `${root}/opt/homebrew/bin/omp`;
		const otherOmpInPath = `${root}/usr/local/bin/omp`;

		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", originalLauncher);

		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => {
			if (cmd === "omp") return otherOmpInPath;
			return null;
		});
		vi.spyOn(utils, "isExecutable").mockImplementation((p: string) => {
			return p === originalLauncher || p === otherOmpInPath;
		});

		expect(resolveCliEntryCmd()).toEqual([originalLauncher]);
		expect(resolveWorkerSpawnCmd("__omp_worker_test")).toEqual({
			cmd: [originalLauncher, "__omp_worker_test"],
		});
	});

	it("falls back to PATH when original absolute launcher exists but is not executable", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/omp/18.1.8/bin/omp";
		const originalLauncher = "/opt/homebrew/bin/omp";
		const otherOmpInPath = "/usr/local/bin/omp";

		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", originalLauncher);

		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => {
			if (cmd === "omp") return otherOmpInPath;
			return null;
		});
		vi.spyOn(utils, "isExecutable").mockImplementation((p: string) => {
			// Launcher is not executable (e.g. root-owned, mode 0644, or directory)
			return p === otherOmpInPath;
		});

		expect(resolveCliEntryCmd()).toEqual([otherOmpInPath]);
		expect(resolveWorkerSpawnCmd("__omp_worker_test")).toEqual({
			cmd: [otherOmpInPath, "__omp_worker_test"],
		});
	});

	it("does not resolve relative argv0 against the working tree", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/omp/18.1.8/bin/omp";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "./omp");

		const cwdRogueBinary = path.resolve("./omp");
		vi.spyOn(utils, "$which").mockReturnValue(null);
		vi.spyOn(utils, "isExecutable").mockImplementation((p: string) => {
			return p === cwdRogueBinary;
		});

		// Relative argv0 must never resolve against cwd; falls back to missingPath gracefully
		expect(resolveExecutablePath()).toBe(missingPath);
	});

	it("does not treat Windows drive-relative paths (e.g. C:omp) as bare commands", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "C:\\Tools\\omp.exe";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "C:omp");

		let whichCalledWith: string | undefined;
		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => {
			whichCalledWith = cmd;
			return null;
		});
		vi.spyOn(utils, "isExecutable").mockReturnValue(false);

		resolveExecutablePath();

		// Should not pass "C:omp" to which as a bare name; only "omp" generic fallback is queried
		expect(whichCalledWith).toBe("omp");
	});

	it("falls back to $which('omp') when original execPath was unlinked and argv0 has no path", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/omp/18.1.8/bin/omp";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "omp");

		const mockUpgradedPath = "/opt/homebrew/bin/omp";
		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => {
			if (cmd === "omp") return mockUpgradedPath;
			return null;
		});
		vi.spyOn(utils, "isExecutable").mockImplementation((p: string) => {
			return p === mockUpgradedPath;
		});

		expect(resolveCliEntryCmd()).toEqual([mockUpgradedPath]);
		expect(resolveWorkerSpawnCmd("__omp_worker_test")).toEqual({
			cmd: [mockUpgradedPath, "__omp_worker_test"],
		});
	});

	it("falls back to process.argv0 when $which('omp') is unavailable", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/custom/install/bin/omp";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "my-omp");

		const mockCustomPath = "/usr/local/bin/my-omp";
		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => {
			if (cmd === "my-omp") return mockCustomPath;
			return null;
		});
		vi.spyOn(utils, "isExecutable").mockImplementation((p: string) => {
			return p === mockCustomPath;
		});

		expect(resolveExecutablePath()).toBe(mockCustomPath);
	});

	it("does not perform fallback lookup when isCompiledBinary is false", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(false);
		const missingPath = "/opt/homebrew/Cellar/omp/18.1.8/bin/omp";
		setProcessProp("execPath", missingPath);

		const whichSpy = vi.spyOn(utils, "$which");
		vi.spyOn(utils, "isExecutable").mockReturnValue(false);

		const resolved = resolveExecutablePath();
		expect(whichSpy).not.toHaveBeenCalled();
		expect(resolved).toBe(missingPath);
	});

	it("returns original execPath gracefully if no fallback candidate exists", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/nonexistent/omp";
		setProcessProp("execPath", missingPath);
		vi.spyOn(utils, "$which").mockReturnValue(null);
		vi.spyOn(utils, "isExecutable").mockReturnValue(false);

		expect(resolveExecutablePath()).toBe(missingPath);
	});
});
