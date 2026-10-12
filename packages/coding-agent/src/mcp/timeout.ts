import { logger, MAX_TIMER_DELAY_MS } from "@oh-my-pi/pi-utils";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const MCP_TIMEOUT_ENV = "OMP_MCP_TIMEOUT_MS";
const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 250;
const MCP_STARTUP_TIMEOUT_ENV = "OMP_MCP_STARTUP_TIMEOUT_MS";

let neverAbortController: AbortController | undefined;

/** Which part of the MCP lifecycle a deadline guards. */
export type MCPTimeoutPhase = "connect" | "catalog" | "execution";

/** Per-phase deadlines in milliseconds; `0` disables that phase's deadline. */
export interface MCPTimeoutPhases {
	/** Transport connect and `initialize` handshake. */
	connect?: number;
	/** Listing tools, prompts, resources and resource templates. */
	catalog?: number;
	/** Tool calls, prompt retrieval, resource reads and every other request. */
	execution?: number;
}

/** A bare number applies to every phase; an object sets phases individually. */
export type MCPTimeoutConfig = number | MCPTimeoutPhases;

export const MCP_TIMEOUT_PHASES: readonly MCPTimeoutPhase[] = ["connect", "catalog", "execution"];

/** Process-wide defaults from the `mcp.timeout.*` settings; a server's own `timeout` wins. */
let globalTimeouts: MCPTimeoutPhases = {};

export function setMCPGlobalTimeouts(timeouts: MCPTimeoutPhases): void {
	globalTimeouts = timeouts;
}

const CATALOG_METHODS: Record<string, true> = {
	"tools/list": true,
	"prompts/list": true,
	"resources/list": true,
	"resources/templates/list": true,
};

/** Phase whose deadline guards a JSON-RPC request or notification. */
export function mcpTimeoutPhaseForMethod(method: string): MCPTimeoutPhase {
	if (method === "initialize" || method === "notifications/initialized") return "connect";
	if (Object.hasOwn(CATALOG_METHODS, method)) return "catalog";
	return "execution";
}

/** A non-negative integer of milliseconds that a timer can represent: larger delays overflow to ~1 ms in Bun. */
export function isValidTimeoutMs(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMER_DELAY_MS;
}

/**
 * Parse an MCP `timeout` config value: a non-negative integer (ms, `0` disables) or an object with
 * `connect`/`catalog`/`execution` integers. Invalid values and unknown keys are dropped with a
 * warning that names the key; numeric strings are accepted because env expansion yields strings.
 * `label` prefixes warnings (for example `MCP server "foo"`).
 */
export function parseMCPTimeoutConfig(value: unknown, label: string): MCPTimeoutConfig | undefined {
	if (value === undefined || value === null) return undefined;
	const coerce = (raw: unknown): number | undefined => {
		const candidate = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
		return isValidTimeoutMs(candidate) ? candidate : undefined;
	};
	const expected = `expected a non-negative integer number of milliseconds, at most ${MAX_TIMER_DELAY_MS} (0 disables)`;
	if (typeof value !== "object" || Array.isArray(value)) {
		const parsed = coerce(value);
		if (parsed === undefined)
			logger.warn(`${label}: invalid timeout ${JSON.stringify(value)}, ${expected}; ignoring`);
		return parsed;
	}
	const phases: MCPTimeoutPhases = {};
	for (const [key, raw] of Object.entries(value)) {
		if (!MCP_TIMEOUT_PHASES.includes(key as MCPTimeoutPhase)) {
			logger.warn(`${label}: unknown timeout key "${key}", ignoring (valid keys: ${MCP_TIMEOUT_PHASES.join(", ")})`);
			continue;
		}
		const parsed = coerce(raw);
		if (parsed === undefined) {
			logger.warn(`${label}: invalid timeout.${key} ${JSON.stringify(raw)}, ${expected}; ignoring`);
			continue;
		}
		phases[key as MCPTimeoutPhase] = parsed;
	}
	return Object.keys(phases).length > 0 ? phases : undefined;
}

/**
 * Resolve one phase's deadline. Precedence: `OMP_MCP_TIMEOUT_MS` (every phase), the server's
 * `timeout` (bare number or its phase key), the `mcp.timeout.*` global for that phase, then 30s.
 */
export function resolveMCPTimeoutMs(configTimeout: MCPTimeoutConfig | undefined, phase: MCPTimeoutPhase): number {
	const raw = Bun.env[MCP_TIMEOUT_ENV]?.trim();
	if (raw) {
		const value = Number(raw);
		if (Number.isFinite(value) && value >= 0 && value <= MAX_TIMER_DELAY_MS) return value;
		logger.warn(
			"Ignoring invalid OMP_MCP_TIMEOUT_MS env value; expected a non-negative number within the timer range",
			{
				value: raw,
			},
		);
	}
	const candidate = typeof configTimeout === "number" ? configTimeout : configTimeout?.[phase];
	// SDK callers can pass a typed config that never went through parseMCPTimeoutConfig.
	const serverValue = isValidTimeoutMs(candidate) ? candidate : undefined;
	return serverValue ?? globalTimeouts[phase] ?? DEFAULT_MCP_TIMEOUT_MS;
}

/** A resolved request deadline with the phase that produced it, for error text. */
export interface MCPRequestTimeout {
	ms: number;
	phase: MCPTimeoutPhase;
}

export function resolveMCPRequestTimeout(
	configTimeout: MCPTimeoutConfig | undefined,
	method: string,
): MCPRequestTimeout {
	const phase = mcpTimeoutPhaseForMethod(method);
	return { ms: resolveMCPTimeoutMs(configTimeout, phase), phase };
}

/** `50ms (catalog timeout, tools/list)`; the phase tells the user which `timeout` key to raise. */
export function describeMCPRequestTimeout(timeout: MCPRequestTimeout, method: string): string {
	return `${describeMCPTimeout(timeout.ms)} (${timeout.phase} timeout, ${method})`;
}

/**
 * Print-mode readiness barrier. A server connects and then lists its catalog one after the other,
 * so its worst case is `connect + catalog`; the barrier waits for the slowest server, using each
 * server's own `timeout` when it has one. It is unbounded (`0`) when any server disables either
 * phase. With no servers it falls back to the global deadlines.
 */
export function resolveMCPReadinessTimeoutMs(serverTimeouts: readonly (MCPTimeoutConfig | undefined)[]): number {
	let budget = 0;
	for (const config of serverTimeouts.length > 0 ? serverTimeouts : [undefined]) {
		const connect = resolveMCPTimeoutMs(config, "connect");
		const catalog = resolveMCPTimeoutMs(config, "catalog");
		if (connect === 0 || catalog === 0) return 0;
		budget = Math.max(budget, Math.min(connect + catalog, MAX_TIMER_DELAY_MS));
	}
	return budget;
}

/** Resolve the non-blocking discovery window; zero waits for initial connections to settle. */
export function resolveMCPStartupTimeoutMs(configTimeout?: number): number {
	const raw = Bun.env[MCP_STARTUP_TIMEOUT_ENV]?.trim();
	if (raw) {
		const value = Number(raw);
		if (Number.isFinite(value) && value >= 0) return value;
		logger.warn("Ignoring invalid OMP_MCP_STARTUP_TIMEOUT_MS env value; expected a non-negative number", {
			value: raw,
		});
	}
	return configTimeout ?? DEFAULT_MCP_STARTUP_TIMEOUT_MS;
}

export function isMCPTimeoutEnabled(timeoutMs: number): boolean {
	return timeoutMs > 0;
}

export function describeMCPTimeout(timeoutMs: number): string {
	return isMCPTimeoutEnabled(timeoutMs) ? `${timeoutMs}ms` : "disabled";
}

export function getNeverAbortSignal(): AbortSignal {
	neverAbortController ??= new AbortController();
	return neverAbortController.signal;
}

/** Tracks a request deadline separately from caller and transport cancellation. */
export interface MCPTimeoutOperation {
	signal?: AbortSignal;
	/** Clear the deadline while preserving cancellation of any still-open response stream. */
	clear: () => void;
	isTimeoutAbort: (error: unknown) => boolean;
	/** True when this operation's own timer fired (regardless of what error a consumer saw). */
	timedOut: () => boolean;
}

/** Apply a deadline without allowing a later abort source to overwrite the first one. */
export function createMCPTimeout(timeoutMs: number, signal?: AbortSignal): MCPTimeoutOperation {
	if (!isMCPTimeoutEnabled(timeoutMs)) {
		return {
			signal,
			clear: () => {},
			isTimeoutAbort: () => false,
			timedOut: () => false,
		};
	}

	const abortController = new AbortController();
	// Track which abort source fired first so neither a later caller abort nor
	// a later timer can overwrite the earlier one. Without this:
	// - Timer fires during response.json(), caller aborts before catch →
	//   both signals aborted, old `!signal?.aborted` was false → timeout
	//   leaked as SyntaxError ("Unexpected end of JSON input").
	// - Caller aborts first, body-read rejects after timeoutMs → timer still
	//   fires → caller cancellation misreported as timeout.
	let timerFired = false;
	let callerAborted = false;
	let timeoutId: NodeJS.Timeout | undefined;
	const onCallerAbort = (): void => {
		callerAborted = true;
		clearTimeout(timeoutId);
	};
	if (signal?.aborted) {
		callerAborted = true;
		abortController.abort(signal.reason);
	} else {
		timeoutId = setTimeout(() => {
			if (callerAborted) return;
			timerFired = true;
			abortController.abort();
		}, timeoutMs);
		signal?.addEventListener("abort", onCallerAbort, { once: true });
	}
	const operationSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;

	return {
		signal: operationSignal,
		clear: () => {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", onCallerAbort);
		},
		isTimeoutAbort: error =>
			timerFired &&
			(error instanceof Error
				? error.name === "AbortError" || (error.name === "SyntaxError" && operationSignal.aborted)
				: false),
		timedOut: () => timerFired,
	};
}
