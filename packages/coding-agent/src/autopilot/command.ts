/** Parsed `/autopilot` arguments. */
export type AutopilotCommand =
	| { action: "toggle" }
	| { action: "on"; prompt?: string }
	| { action: "off" }
	| { action: "status" }
	| { action: "prompt"; prompt?: string; clear?: boolean }
	| { action: "max"; maxCycles?: number }
	| { action: "invalid"; reason: string };

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 2) return trimmed;
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === "“" && last === "”")) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

/**
 * `/autopilot` accepts:
 * - nothing: toggle
 * - `on [directive]`, `off`, `status`
 * - `prompt [directive|clear]`
 * - `max|cycles [n|unlimited]`
 * - a bare multi-word or quoted directive: enables and stores it
 */
export function parseAutopilotCommand(args: string | undefined): AutopilotCommand {
	const raw = (args ?? "").trim();
	if (raw.length === 0) return { action: "toggle" };
	const [head = "", ...rest] = raw.split(/\s+/);
	const tail = rest.join(" ").trim();
	const keyword = head.toLowerCase();

	if (keyword === "on") return tail ? { action: "on", prompt: stripQuotes(tail) } : { action: "on" };
	if (keyword === "toggle") {
		return tail ? { action: "invalid", reason: "Usage: /autopilot toggle" } : { action: "toggle" };
	}
	if (keyword === "off") {
		return tail ? { action: "invalid", reason: "Usage: /autopilot off" } : { action: "off" };
	}
	if (keyword === "status") {
		return tail ? { action: "invalid", reason: "Usage: /autopilot status" } : { action: "status" };
	}
	if (keyword === "max" || keyword === "cycles") {
		if (!tail) return { action: "max" };
		if (tail.toLowerCase() === "unlimited" || tail.toLowerCase() === "ilimitado") {
			return { action: "max", maxCycles: 0 };
		}
		if (!/^\d+$/.test(tail)) {
			return {
				action: "invalid",
				reason: "Usage: /autopilot max <n> (0 or unlimited = no cap)",
			};
		}
		return { action: "max", maxCycles: Number(tail) };
	}
	if (keyword === "prompt") {
		if (tail.length === 0) return { action: "prompt" };
		if (tail.toLowerCase() === "clear") return { action: "prompt", clear: true };
		return { action: "prompt", prompt: stripQuotes(tail) };
	}
	const unquoted = stripQuotes(raw);
	if (unquoted !== raw || /\s/.test(raw)) return { action: "on", prompt: unquoted };
	return {
		action: "invalid",
		reason: `Unknown autopilot argument "${raw}". Use on, off, status, prompt, max, or a directive.`,
	};
}
