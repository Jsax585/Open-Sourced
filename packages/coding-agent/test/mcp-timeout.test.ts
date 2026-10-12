import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { bindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	createMCPTimeout,
	isMCPTimeoutEnabled,
	mcpTimeoutPhaseForMethod,
	parseMCPTimeoutConfig,
	resolveMCPReadinessTimeoutMs,
	resolveMCPTimeoutMs,
	setMCPGlobalTimeouts,
} from "@oh-my-pi/pi-coding-agent/mcp/timeout";
import { logger } from "@oh-my-pi/pi-utils";

const ORIGINAL_TIMEOUT = process.env.OMP_MCP_TIMEOUT_MS;

afterEach(() => {
	setMCPGlobalTimeouts({});
	if (ORIGINAL_TIMEOUT === undefined) {
		delete process.env.OMP_MCP_TIMEOUT_MS;
	} else {
		process.env.OMP_MCP_TIMEOUT_MS = ORIGINAL_TIMEOUT;
	}
});

describe("MCP timeout configuration", () => {
	test("uses the default timeout when no config or env override is set", () => {
		delete process.env.OMP_MCP_TIMEOUT_MS;

		expect(resolveMCPTimeoutMs(undefined, "execution")).toBe(30_000);
	});

	test("uses per-server timeout when env override is unset", () => {
		delete process.env.OMP_MCP_TIMEOUT_MS;

		expect(resolveMCPTimeoutMs(120_000, "execution")).toBe(120_000);
	});

	test("allows the env override to disable MCP client-side timeouts", () => {
		process.env.OMP_MCP_TIMEOUT_MS = "0";

		const timeout = resolveMCPTimeoutMs(30_000, "execution");
		expect(timeout).toBe(0);
		expect(isMCPTimeoutEnabled(timeout)).toBe(false);
	});

	test("allows the env override to set one timeout for every server", () => {
		process.env.OMP_MCP_TIMEOUT_MS = "180000";

		expect(resolveMCPTimeoutMs(30_000, "execution")).toBe(180_000);
	});

	test("rejects negative env values and warns, falling back to the default", () => {
		process.env.OMP_MCP_TIMEOUT_MS = "-1";
		const warn = spyOn(logger, "warn").mockImplementation(() => {});

		try {
			expect(resolveMCPTimeoutMs(120_000, "execution")).toBe(120_000);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain("OMP_MCP_TIMEOUT_MS");
		} finally {
			warn.mockRestore();
		}
	});

	test("rejects non-numeric env values and falls back to the default", () => {
		process.env.OMP_MCP_TIMEOUT_MS = "not-a-number";
		const warn = spyOn(logger, "warn").mockImplementation(() => {});

		try {
			expect(resolveMCPTimeoutMs(undefined, "execution")).toBe(30_000);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("createMCPTimeout abort-source tracking", () => {
	test("reports timedOut when the timer fires", async () => {
		const op = createMCPTimeout(50);
		try {
			expect(op.signal).toBeDefined();
			expect(op.timedOut()).toBe(false);
			// Wait for the timer to fire
			await Bun.sleep(60);
			expect(op.timedOut()).toBe(true);
			expect(op.isTimeoutAbort(new DOMException("aborted", "AbortError"))).toBe(true);
		} finally {
			op.clear();
		}
	});
	test("preserves timeout when caller signal aborts after the timer fires", async () => {
		const caller = new AbortController();
		const op = createMCPTimeout(50, caller.signal);
		try {
			await Bun.sleep(60);
			// Timer fired, caller hasn't aborted yet
			expect(op.timedOut()).toBe(true);
			// Now the caller aborts — simulating the race where the caller's
			// signal becomes aborted after the timer but before the catch block
			caller.abort();
			expect(op.timedOut()).toBe(true);
			expect(op.isTimeoutAbort(new DOMException("aborted", "AbortError"))).toBe(true);
			// A SyntaxError from a truncated body read is also a timeout consequence
			expect(op.isTimeoutAbort(new SyntaxError("Unexpected end of JSON input"))).toBe(true);
		} finally {
			op.clear();
		}
	});

	test("does not treat a SyntaxError as timeout when the signal is not aborted", () => {
		const op = createMCPTimeout(10_000);
		try {
			// Timer hasn't fired, signal not aborted — a SyntaxError is a
			// genuinely malformed response, not a timeout
			expect(op.isTimeoutAbort(new SyntaxError("Unexpected token"))).toBe(false);
			expect(op.timedOut()).toBe(false);
		} finally {
			op.clear();
		}
	});

	test("immediately aborts when the caller signal is already aborted", () => {
		const caller = new AbortController();
		caller.abort();
		const op = createMCPTimeout(10_000, caller.signal);
		try {
			// Timer never started; not a timeout
			expect(op.timedOut()).toBe(false);
			expect(op.isTimeoutAbort(new DOMException("aborted", "AbortError"))).toBe(false);
			expect(op.signal?.aborted).toBe(true);
		} finally {
			op.clear();
		}
	});

	test("disabled timeout never reports timed out", () => {
		const op = createMCPTimeout(0);
		try {
			expect(op.timedOut()).toBe(false);
			expect(op.isTimeoutAbort(new DOMException("aborted", "AbortError"))).toBe(false);
		} finally {
			op.clear();
		}
	});

	test("does not report timeout when caller aborts before the timer fires", async () => {
		const caller = new AbortController();
		const op = createMCPTimeout(10_000, caller.signal);
		try {
			// Caller aborts first — timer is cancelled, not a timeout
			caller.abort();
			expect(op.timedOut()).toBe(false);
			expect(op.isTimeoutAbort(new DOMException("aborted", "AbortError"))).toBe(false);
			// Even if we wait past the timeoutMs, the timer was cancelled and
			// must not fire
			await Bun.sleep(20);
			expect(op.timedOut()).toBe(false);
		} finally {
			op.clear();
		}
	});
});

describe("MCP phase timeouts", () => {
	test("routes each JSON-RPC method to the phase that guards it", () => {
		expect(mcpTimeoutPhaseForMethod("initialize")).toBe("connect");
		expect(mcpTimeoutPhaseForMethod("notifications/initialized")).toBe("connect");
		for (const method of ["tools/list", "prompts/list", "resources/list", "resources/templates/list"]) {
			expect(mcpTimeoutPhaseForMethod(method)).toBe("catalog");
		}
		for (const method of ["tools/call", "prompts/get", "resources/read", "resources/subscribe", "ping"]) {
			expect(mcpTimeoutPhaseForMethod(method)).toBe("execution");
		}
	});

	test("per-server phase beats global setting beats the 30s default", () => {
		delete process.env.OMP_MCP_TIMEOUT_MS;
		setMCPGlobalTimeouts({ catalog: 2_000, execution: 3_000 });

		const server = { catalog: 500 };
		expect(resolveMCPTimeoutMs(server, "catalog")).toBe(500);
		expect(resolveMCPTimeoutMs(server, "execution")).toBe(3_000);
		expect(resolveMCPTimeoutMs(server, "connect")).toBe(30_000);
	});

	test("a bare per-server number applies to every phase and beats globals", () => {
		delete process.env.OMP_MCP_TIMEOUT_MS;
		setMCPGlobalTimeouts({ connect: 1, catalog: 2, execution: 3 });

		for (const phase of ["connect", "catalog", "execution"] as const) {
			expect(resolveMCPTimeoutMs(750, phase)).toBe(750);
		}
	});

	test("per-server 0 disables only that phase", () => {
		delete process.env.OMP_MCP_TIMEOUT_MS;

		expect(resolveMCPTimeoutMs({ execution: 0 }, "execution")).toBe(0);
		expect(resolveMCPTimeoutMs({ execution: 0 }, "catalog")).toBe(30_000);
	});

	test("OMP_MCP_TIMEOUT_MS still overrides every phase", () => {
		process.env.OMP_MCP_TIMEOUT_MS = "123";
		setMCPGlobalTimeouts({ catalog: 2_000 });

		expect(resolveMCPTimeoutMs({ catalog: 500 }, "catalog")).toBe(123);
		expect(resolveMCPTimeoutMs(900, "execution")).toBe(123);
	});

	test("mcp.timeout.* settings feed the global phase defaults", () => {
		delete process.env.OMP_MCP_TIMEOUT_MS;
		const release = bindEffects(Settings.isolated({ "mcp.timeout.catalogMs": 77, "mcp.timeout.executionMs": 0 }));
		try {
			expect(resolveMCPTimeoutMs(undefined, "catalog")).toBe(77);
			expect(resolveMCPTimeoutMs(undefined, "execution")).toBe(0);
			expect(resolveMCPTimeoutMs(undefined, "connect")).toBe(30_000);
		} finally {
			release();
		}
	});

	test("invalid mcp.timeout.* settings warn with the key and fall back to the default", () => {
		delete process.env.OMP_MCP_TIMEOUT_MS;
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const release = bindEffects(Settings.isolated({ "mcp.timeout.catalogMs": -5, "mcp.timeout.connectMs": 1.5 }));
		try {
			expect(resolveMCPTimeoutMs(undefined, "catalog")).toBe(30_000);
			expect(resolveMCPTimeoutMs(undefined, "connect")).toBe(30_000);
			const messages = warn.mock.calls.map(call => String(call[0]));
			expect(messages.some(m => m.includes("mcp.timeout.catalogMs"))).toBe(true);
			expect(messages.some(m => m.includes("mcp.timeout.connectMs"))).toBe(true);
		} finally {
			release();
			warn.mockRestore();
		}
	});

	test("readiness barrier covers connect then catalog, per server, and is unbounded if either is disabled", () => {
		delete process.env.OMP_MCP_TIMEOUT_MS;
		setMCPGlobalTimeouts({ connect: 50_000, catalog: 20_000 });
		expect(resolveMCPReadinessTimeoutMs([])).toBe(70_000);
		expect(resolveMCPReadinessTimeoutMs([undefined])).toBe(70_000);

		// A larger per-server deadline is not cut off by the global ones; the slowest server sets the budget.
		expect(resolveMCPReadinessTimeoutMs([undefined, { connect: 100_000 }, 5_000])).toBe(120_000);

		setMCPGlobalTimeouts({ connect: 0, catalog: 9_000 });
		expect(resolveMCPReadinessTimeoutMs([])).toBe(0);
		expect(resolveMCPReadinessTimeoutMs([{ connect: 1_000 }, undefined])).toBe(0);
	});
});

describe("parseMCPTimeoutConfig", () => {
	function withWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const result = fn();
			return { result, warnings: warn.mock.calls.map(call => String(call[0])) };
		} finally {
			warn.mockRestore();
		}
	}

	test("accepts a non-negative integer, an integer string, and a phase object", () => {
		const { result, warnings } = withWarnings(() => [
			parseMCPTimeoutConfig(1500, "s"),
			parseMCPTimeoutConfig("2500", "s"),
			parseMCPTimeoutConfig(0, "s"),
			parseMCPTimeoutConfig({ connect: 10, catalog: "20", execution: 0 }, "s"),
			parseMCPTimeoutConfig(undefined, "s"),
		]);

		expect(result).toEqual([1500, 2500, 0, { connect: 10, catalog: 20, execution: 0 }, undefined]);
		expect(warnings).toEqual([]);
	});

	test("rejects negative, fractional and non-numeric scalars with a warning", () => {
		for (const bad of [-1, 1.5, "soon", true, [100], Number.NaN]) {
			const { result, warnings } = withWarnings(() => parseMCPTimeoutConfig(bad, 'MCP server "x"'));
			expect(result).toBeUndefined();
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain('MCP server "x"');
			expect(warnings[0]).toContain("invalid timeout");
		}
	});

	test("drops only the bad phase key and names it in the warning", () => {
		const { result, warnings } = withWarnings(() =>
			parseMCPTimeoutConfig({ connect: 100, catalog: -1, execution: "forever" }, 'MCP server "x"'),
		);

		expect(result).toEqual({ connect: 100 });
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("timeout.catalog");
		expect(warnings[1]).toContain("timeout.execution");
	});

	test("ignores unknown phase keys with a warning that lists the valid ones", () => {
		const { result, warnings } = withWarnings(() => parseMCPTimeoutConfig({ catalog: 5, startup: 9 }, "s"));

		expect(result).toEqual({ catalog: 5 });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('"startup"');
		expect(warnings[0]).toContain("connect, catalog, execution");
	});

	test("rejects an all-digit string that overflows to a non-finite number", () => {
		const { result, warnings } = withWarnings(() => parseMCPTimeoutConfig("9".repeat(400), "s"));

		expect(result).toBeUndefined();
		expect(warnings).toHaveLength(1);
	});

	test("an object with no usable key yields undefined so the global default applies", () => {
		const { result } = withWarnings(() => parseMCPTimeoutConfig({ catalog: -3 }, "s"));
		expect(result).toBeUndefined();
	});
});
