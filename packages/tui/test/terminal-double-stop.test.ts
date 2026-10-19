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
	it("keeps the surviving instance's suppression across a repeated stop", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-double-stop-"));
		const state = path.join(root, "state.txt");
		const child = Bun.spawn(
			[process.execPath, path.resolve(import.meta.dir, "fixtures/terminal-double-stop-probe.ts"), state],
			{
				env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
				terminal: {},
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
			expect(lines["after-start"]).toBe("true");
			expect(lines["after-first-stop"]).toBe("true");
			expect(lines["after-double-stop"]).toBe("true");
			expect(lines["after-b-stop"]).toBe("false");
		} finally {
			child.kill();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
