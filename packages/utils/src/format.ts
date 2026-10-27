import { t } from "@oh-my-pi/pi-utils/i18n";
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Format a duration in milliseconds to a short human-readable string.
 * Examples: "123ms", "1.5s", "30m15s", "2h30m", "3d2h"
 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0ms";
	if (ms < SEC) return `${Math.floor(ms)}ms`;
	if (ms < MIN) {
		// Round to tenths first: `toFixed(1)` alone turns 59.95s+ into an impossible `60.0s`.
		const tenths = Math.round(ms / 100);
		return tenths < 600 ? `${(tenths / 10).toFixed(1)}s` : "1m";
	}
	if (ms < HOUR) {
		const mins = Math.floor(ms / MIN);
		const secs = Math.floor((ms % MIN) / SEC);
		return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
	}
	if (ms < DAY) {
		const hours = Math.floor(ms / HOUR);
		const mins = Math.floor((ms % HOUR) / MIN);
		return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
	}
	const days = Math.floor(ms / DAY);
	const hours = Math.floor((ms % DAY) / HOUR);
	return hours > 0 ? `${days}d${hours}h` : `${days}d`;
}

/**
 * Format a number with K/M/B suffix for compact display.
 * Uses 1 decimal for small leading digits when non-zero, rounded otherwise.
 * Values below 1,000 print as-is unless `maxFractionDigits` caps their decimals.
 * Examples: "999", "1K", "1.5K", "25K", "1M", "1.5M", "25M", "1.5B"
 */
export function formatNumber(n: number, maxFractionDigits?: number): string {
	if (n < 1_000) {
		if (maxFractionDigits === undefined || Number.isInteger(n)) return n.toString();
		return Number(n.toFixed(maxFractionDigits)).toString();
	}
	if (n < 10_000) return `${trim1(n / 1_000)}K`;
	if (n < 1_000_000) return `${Math.round(n / 1_000)}K`;
	if (n < 10_000_000) return `${trim1(n / 1_000_000)}M`;
	if (n < 1_000_000_000) return `${Math.round(n / 1_000_000)}M`;
	if (n < 10_000_000_000) return `${trim1(n / 1_000_000_000)}B`;
	return `${Math.round(n / 1_000_000_000)}B`;
}

/** Format with up to 1 decimal place, dropping trailing `.0`. */
function trim1(n: number): string {
	const s = n.toFixed(1);
	return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/**
 * Format a byte count to a human-readable string.
 * Examples: "512B", "1.5KB", "2.3MB", "1.2GB"
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/**
 * Count `\n` code units via native `indexOf` — no split array, roughly an
 * order of magnitude cheaper than a per-code-unit loop on multi-MiB text.
 * Line-count semantics are the caller's (empty text is 0 or 1 lines
 * depending on the contract).
 */
export function countNewlines(text: string): number {
	let count = 0;
	let pos = text.indexOf("\n");
	while (pos !== -1) {
		count++;
		pos = text.indexOf("\n", pos + 1);
	}
	return count;
}

/**
 * Truncate a string to maxLen characters, appending an ellipsis if truncated.
 * For display-width-aware truncation (terminals), use truncateToWidth from @oh-my-pi/pi-tui.
 */
export function truncate(str: string, maxLen: number, ellipsis = "…"): string {
	if (str.length <= maxLen) return str;
	const sliceLen = Math.max(0, maxLen - ellipsis.length);
	return `${str.slice(0, sliceLen)}${ellipsis}`;
}

const COUNT_LABELS: Readonly<Record<string, string>> = {
	file: t("file\u0004packages/collab-web/src/tool-render/tools/lsp.tsx:Body"),
	"more file": t("more file"),
	"more line": t("more line"),
	replacement: t("replacement\u0004packages/utils/src/format.ts:COUNT_LABELS.replacement"),
	match: t("match\u0004packages/utils/src/format.ts:COUNT_LABELS.match"),
	hit: t("Matches"),
	"more hit": t("more hit"),
	item: t("item"),
	field: t("field"),
	reference: t("reference"),
	source: t("Sources"),
	citation: t("citation"),
	question: t("Ask\u0004packages/coding-agent/src/tools/ask.ts:AskTool.label"),
	session: t("session"),
	msg: t("msg"),
	error: t("error"),
	warning: t("warning"),
	info: t("Info"),
	hint: t("hint"),
	"server failure": t("server failure"),
	line: t("line"),
	change: t("change"),
	yield: t("yield"),
	finding: t("finding"),
	todo: t("todo"),
	agent: t("agent"),
	recipient: t("recipient"),
	job: t("job"),
	process: t("process"),
};

/**
 * Format a count using the active language's display label.
 */
export function formatCount(label: string, count: number): string {
	const safeCount = Number.isFinite(count) ? count : 0;
	const noun = Object.hasOwn(COUNT_LABELS, label) ? COUNT_LABELS[label] : label;
	return t("{1} {2}", `${(noun)}`, `${(safeCount)}`, `${(pluralize(label, safeCount))}`);
}

/**
 * Format age from seconds to human-readable string.
 */
export function formatAge(ageSeconds: number | null | undefined): string {
	if (!ageSeconds) return "";
	const mins = Math.floor(ageSeconds / 60);
	const hours = Math.floor(mins / 60);
	const days = Math.floor(hours / 24);
	const weeks = Math.floor(days / 7);
	const months = Math.floor(days / 30);

	if (months > 0) return t("{0}mo ago", `${months}`);
	if (weeks > 0) return t("{0}w ago", `${weeks}`);
	if (days > 0) return t("{0}d ago", `${days}`);
	if (hours > 0) return t("{0}h ago", `${hours}`);
	if (mins > 0) return t("{0}m ago", `${mins}`);
	return t("just now");
}

/**
 * Pluralize a label based on the count.
 */
export function pluralize(label: string, count: number): string {
	if (count === 1) return label;
	if (/(?:ch|sh|s|x|z)$/i.test(label)) return `${label}es`;
	if (/[^aeiou]y$/i.test(label)) return `${label.slice(0, -1)}ies`;
	return `${label}s`;
}

/**
 * Format a ratio as a percentage.
 */
export function formatPercent(ratio: number): string {
	return `${(ratio * 100).toFixed(1)}%`;
}

/** Round premium-request counters without losing legitimate fractional requests. */
export function normalizePremiumRequests(value: number): number {
	return Math.round((value + Number.EPSILON) * 100) / 100;
}
