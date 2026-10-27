import { describe, expect, it } from "bun:test";
import { collectTerminalState } from "@oh-my-pi/pi-tui/apps/debug/terminal-info";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { TERMINAL_MULTIPLEXER_ENV_KEYS } from "@oh-my-pi/pi-tui/terminal-multiplexer";

describe("collectTerminalState", () => {
	it("reports herdr from pane identity vars, not client-only socket paths", () => {
		const keys = [...TERMINAL_MULTIPLEXER_ENV_KEYS, "HERDR_SOCKET_PATH"];
		const previous = new Map<string, string | undefined>();
		for (const key of keys) {
			previous.set(key, Bun.env[key]);
			delete Bun.env[key];
		}
		const runtime = { columns: 80, rows: 24, synchronizedOutput: true };
		try {
			expect(collectTerminalState(runtime).multiplexer).toBeNull();
			Bun.env.HERDR_ENV = "1";
			expect(collectTerminalState(runtime).multiplexer).toBe("herdr");
			delete Bun.env.HERDR_ENV;
			Bun.env.HERDR_PANE_ID = "p1";
			expect(collectTerminalState(runtime).multiplexer).toBe("herdr");
			delete Bun.env.HERDR_PANE_ID;
			Bun.env.WMUX = "1";
			expect(collectTerminalState(runtime).multiplexer).toBe("wmux");
			delete Bun.env.WMUX;
			Bun.env.WMUX_SURFACE_ID = "3f2a";
			expect(collectTerminalState(runtime).multiplexer).toBe("wmux");
			delete Bun.env.WMUX_SURFACE_ID;
			Bun.env.HERDR_SOCKET_PATH = "/tmp/x";
			expect(collectTerminalState(runtime).multiplexer).toBeNull();
		} finally {
			for (const key of keys) {
				const value = previous.get(key);
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
		}
	});

	it("passes live geometry through and maps protocols to human-readable names (never raw escapes)", () => {
		const info = collectTerminalState({ columns: 88, rows: 25, synchronizedOutput: true });
		expect(info.columns).toBe(88);
		expect(info.rows).toBe(25);
		expect(info.synchronizedOutput).toBe(true);
		// The graphics/notify subprotocols are surfaced as readable labels, not the
		// enum's underlying escape sequences (\x1b_G, \x1b]99;;, …).
		expect(info.imageProtocol).not.toContain("\x1b");
		expect(info.notifyProtocol).not.toContain("\x1b");
		expect(info.imageProtocol.length).toBeGreaterThan(0);
		expect(info.notifyProtocol.length).toBeGreaterThan(0);
		// Capability booleans mirror the resolved TERMINAL singleton.
		expect(info.deccara).toBe(TERMINAL.deccara);
		expect(info.hyperlinks).toBe(TERMINAL.hyperlinks);
		expect(info.trueColor).toBe(TERMINAL.trueColor);
	});
});
