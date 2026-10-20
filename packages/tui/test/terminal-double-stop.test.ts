import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Two ProcessTerminals share the reference-counted output guard. When one
// instance is stopped twice — emergency cleanup followed by its owner's
// normal teardown — the second stop must not release the surviving
// instance's acquisition: fd 1/2 stay isolated until that instance stops,
// otherwise unmanaged output corrupts its live frame.

describe.skipIf(process.platform === "win32")("ProcessTerminal double stop", () => {
	for (const order of ["older", "newest", "emergency"] as const) {
		it(
			order === "emergency"
				? "restores every overlapping owner during emergency shutdown"
				: `preserves the survivor's modes, input and ordered control output when the ${order} owner stops twice`,
			async () => {
				const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-double-stop-"));
				const state = path.join(root, "state.txt");
				const chunks: Buffer[] = [];
				const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
				delete env.PI_TEST_RUNTIME;
				delete env.BUN_ENV;
				delete env.NODE_ENV;
				const child = Bun.spawn(
					[
						process.execPath,
						path.resolve(import.meta.dir, "fixtures/terminal-double-stop-probe.ts"),
						state,
						order,
					],
					{
						env,
						terminal: {
							data(_terminal, data) {
								chunks.push(Buffer.from(data));
							},
						},
						timeout: 10_000,
					},
				);
				try {
					expect(await child.exited).toBe(0);
					const lines = Object.fromEntries(
						fs
							.readFileSync(state, "utf8")
							.split("\n")
							.filter(Boolean)
							.map(line => line.split("=") as [string, string]),
					);
					if (order === "emergency") {
						expect(lines["emergency-isolated"]).toBe("false");
						expect(lines["emergency-raw"]).toBe("false");
						expect(Buffer.concat(chunks).toString()).toContain("EMERGENCY_BOTH_RESTORED");
						return;
					}
					expect(lines["after-start"]).toBe("true");
					expect(lines["after-first-stop"]).toBe("true");
					expect(lines["after-double-stop"]).toBe("true");
					expect(lines["after-final-stop"]).toBe("false");
					expect(lines["survivor-raw"]).toBe("true");
					expect(lines["final-raw"]).toBe("false");
					expect(lines["survivor-paused"]).toBe("false");
					const stream = Buffer.concat(chunks).toString();
					const begin = stream.indexOf("\x1b]0;STOP_OWNER_BEGIN\x07");
					const end = stream.indexOf("\x1b]0;STOP_OWNER_END\x07");
					expect(begin).toBeGreaterThanOrEqual(0);
					expect(end).toBeGreaterThan(begin);
					const olderStop = stream.slice(begin, end);
					expect(olderStop).toContain("\x1b]0;SURVIVING_OWNER_SEQUENCE\x07");
					expect(olderStop).not.toContain("\x1b[?2004l");
					expect(olderStop).not.toContain("\x1b[?1006l");
					expect(olderStop).not.toContain("\x1b[?2031l");
				} finally {
					child.kill();
					fs.rmSync(root, { recursive: true, force: true });
				}
			},
		);
	}
});
