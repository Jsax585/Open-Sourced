/**
 * Regression: cancelling the startup `--resume` session picker (e.g. pressing
 * Esc) must terminate the process cleanly. Startup arms long-lived handles
 * (theme/appearance listeners via initTheme, settings save timer, model
 * registry), so the previous bare `return` left the event loop with live
 * handles and the process hung after the picker left the alternate screen.
 *
 * The fix exits via `process.exit(0)` — matching the `--version`/`--export`
 * early-exit convention in the same function. Only this startup call site
 * exits; the in-session `/resume` picker (selector-controller.ts) keeps its own
 * onCancel that just closes the overlay.
 */
import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

class ProcessExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
		this.name = "ProcessExitSignal";
	}
}

describe("runRootCommand — startup --resume picker cancellation", () => {
	it("exits cleanly (process.exit 0) when the picker is cancelled instead of returning and hanging", async () => {
		using tempDir = TempDir.createSync("@omp-resume-cancel-");
		const sessionDir = tempDir.path();
		// One answered session so folderSessions is non-empty and the picker (not the
		// "No sessions found" probe) is the path under test.
		await Bun.write(
			path.join(sessionDir, "existing.jsonl"),
			[
				JSON.stringify({
					type: "session",
					id: "existing-session",
					cwd: sessionDir,
					timestamp: new Date().toISOString(),
				}),
				JSON.stringify({
					type: "message",
					id: "e1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "assistant", content: "prior work" },
				}),
			].join("\n"),
		);

		const authStorage = await AuthStorage.create(path.join(sessionDir, "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });

		// --print keeps initTheme non-interactive so no global appearance/SIGWINCH
		// listeners leak into the rest of the suite; the picker branch is gated on
		// `resume === true`, not on interactivity, so it still runs.
		const parsed = parseArgs(["--resume", "--print"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = sessionDir;

		const exitCodes: number[] = [];
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
			throw new ProcessExitSignal(code ?? 0);
		}) as typeof process.exit);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		let pickerCalled = false;
		let thrown: unknown;
		try {
			await runRootCommand(parsed, ["--resume", "--print"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				selectSession: async () => {
					pickerCalled = true;
					return null; // user cancelled (Esc)
				},
			});
		} catch (err) {
			thrown = err;
		} finally {
			vi.restoreAllMocks();
			authStorage.close();
		}

		expect(pickerCalled).toBe(true);
		expect(thrown).toBeInstanceOf(ProcessExitSignal);
		// Exactly one clean exit — proves the cancel branch terminates instead of
		// falling through to session creation or returning into a hang.
		expect(exitCodes).toEqual([0]);
	}, 15_000);

	it("handles DeepSeek empty/cancelled pickers, conflicts, and source errors before loading", async () => {
		using tempDir = TempDir.createSync("@omp-deepseek-picker-");
		const cwd = tempDir.path();
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const info = {
			source: "deepseek" as const,
			id: "source-session",
			path: "deepseek:fixture",
			cwd,
			created: new Date(0),
			modified: new Date(0),
		};
		const cases = [
			{ flags: [], empty: true, code: 0, picker: false, notice: "No DeepSeek Harness sessions found" },
			{ flags: [], code: 0, picker: true, notice: "No DeepSeek Harness session selected" },
			{ flags: ["--from-claude"], code: 1, picker: false, notice: "cannot be used together" },
			{ flags: ["--from-codex"], code: 1, picker: false, notice: "cannot be used together" },
			{ flags: ["--continue"], code: 1, picker: false, notice: "cannot be combined" },
			{ flags: ["--resume", "existing"], code: 1, picker: false, notice: "cannot be combined" },
			{ flags: ["--fork", "existing"], code: 1, picker: false, notice: "cannot be combined" },
			{ flags: ["--no-session"], code: 1, picker: false, notice: "requires session persistence" },
			{ flags: ["--mode", "acp"], code: 1, picker: false, notice: "not supported in acp mode" },
			{
				flags: [],
				failList: true,
				code: 1,
				picker: false,
				notice: "Failed to list DeepSeek Harness sessions: fixture read failure",
			},
		];
		try {
			for (const testCase of cases) {
				const rawArgs = ["--from-deepseek", "--print", ...testCase.flags];
				const parsed = parseArgs(rawArgs);
				Object.assign(parsed, {
					noExtensions: true,
					noSkills: true,
					noRules: true,
					noTools: true,
					noLsp: true,
					sessionDir: cwd,
				});
				const exits: number[] = [];
				let output = "";
				let pickerCalled = false;
				vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
					exits.push(code ?? 0);
					throw new ProcessExitSignal(code ?? 0);
				}) as typeof process.exit);
				const capture = (chunk: string | Uint8Array) => {
					output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
					return true;
				};
				vi.spyOn(process.stdout, "write").mockImplementation(capture);
				vi.spyOn(process.stderr, "write").mockImplementation(capture);
				try {
					await expect(
						runRootCommand(parsed, rawArgs, {
							discoverAuthStorage: async () => authStorage,
							settings,
							createForeignSessionStore: source => {
								expect(source).toBe("deepseek");
								return {
									source,
									list: async () => {
										if (testCase.failList) throw new Error("fixture read failure");
										return testCase.empty ? [] : [info];
									},
									load: async () => {
										throw new Error("Cancelled/conflicting import must not load");
									},
								};
							},
							selectSession: async (sessions, options) => {
								pickerCalled = true;
								expect(sessions[0]?.cwd).toBe(cwd);
								expect(options).toMatchObject({
									title: "Import DeepSeek Harness Session",
									allowDelete: false,
									allowGlobalScope: false,
									historySearch: false,
								});
								return null;
							},
						}),
					).rejects.toBeInstanceOf(ProcessExitSignal);
				} finally {
					vi.restoreAllMocks();
				}
				expect(exits).toEqual([testCase.code]);
				expect(pickerCalled).toBe(testCase.picker);
				expect(output).toContain(testCase.notice);
			}
		} finally {
			authStorage.close();
		}
	}, 60_000);
});
