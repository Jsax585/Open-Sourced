import { getLanguage, t } from "@oh-my-pi/pi-utils/i18n-browser";
/** Small pure formatting helpers shared across collab-web components. */

const STATUS_LABELS: Readonly<Record<string, string>> = {
	pending: t("pending"),
	running: t("running"),
	idle: t("idle"),
	parked: t("parked"),
	aborted: t("aborted"),
	started: t("started"),
	completed: t("completed"),
	done: t("done"),
	failed: t("failed"),
	"merge failed": t("merge failed"),
	cancelled: t("cancelled"),
	queued: t("queued"),
	active: t("active"),
	complete: t("complete"),
	"budget-limited": t("budget-limited"),
	paused: t("paused"),
	dropped: t("dropped"),
	exited: t("exited"),
	stopped: t("stopped"),
	success: t("success"),
	failure: t("failure"),
	in_progress: t("in_progress"),
	waiting: t("waiting\u0004packages/collab-web/src/lib/format.ts:STATUS_LABELS.waiting"),
	requested: t("requested"),
	skipped: t("skipped"),
	timed_out: t("timed_out"),
	startup_failure: t("startup_failure"),
	action_required: t("action_required"),
	neutral: t("neutral"),
	stale: t("stale"),
	woken: t("woken"),
	revived: t("revived"),
	injected: t("injected"),
	error: t("error"),
	warning: t("warning"),
	info: t("info"),
	hint: t("hint"),
	not_found: t("not_found"),
	already_completed: t("already_completed"),
};

/** Display labels only; wire status values stay unchanged. */
export function formatStatus(status: string): string {
	return STATUS_LABELS[status] ?? status;
}

/** HTML-escape text destined for `dangerouslySetInnerHTML`. */
export function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

const TOKEN_FORMAT = new Intl.NumberFormat((getLanguage() === "ko" ? "ko-KR" : "en-US"), { notation: "compact", maximumFractionDigits: 1 });

/** Compact token counts in the selected language, tolerant of non-finite input. */
export function fmtTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	return TOKEN_FORMAT.format(Math.round(n));
}

/** "$0.004", "$0.42", "$4.20" — tolerant of non-finite input. */
export function fmtCost(usd: number): string {
	if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
	return `$${usd >= 1 ? usd.toFixed(2) : usd.toFixed(3)}`;
}

/** "847ms", "12.3s", "4m05s", "1h12m". */
export function fmtDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0ms";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return t("{0}s", `${s.toFixed(1)}`);
	const min = Math.floor(s / 60);
	if (min < 60) return t("{0}m{1}s", `${min}`, `${String(Math.round(s % 60)).padStart(2, "0")}`);
	const h = Math.floor(min / 60);
	return t("{0}h{1}m", `${h}`, `${String(min % 60).padStart(2, "0")}`);
}

/** "now", "42s ago", "5m ago", "3h ago", "2d ago". Input: epoch ms. */
export function relTime(tsMs: number): string {
	if (!Number.isFinite(tsMs)) return "";
	const delta = Date.now() - tsMs;
	if (delta < 10_000) return t("now");
	const s = Math.floor(delta / 1000);
	if (s < 60) return t("{0}s ago", `${s}`);
	const min = Math.floor(s / 60);
	if (min < 60) return t("{0}m ago", `${min}`);
	const h = Math.floor(min / 60);
	if (h < 24) return t("{0}h ago", `${h}`);
	return t("{0}d ago", `${Math.floor(h / 24)}`);
}

/** "73%" from a 0–100 percent; em dash for null/non-finite. */
export function fmtPercent(p: number | null | undefined): string {
	if (p === null || p === undefined || !Number.isFinite(p)) return "—";
	return `${Math.round(Math.min(100, Math.max(0, p)))}%`;
}

/** Home-relative, middle-elided path: "~/…/packages/collab-web". */
export function shortenPath(p: string): string {
	if (typeof p !== "string" || p.length === 0) return "";
	let out = p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
	const segs = out.split("/");
	if (segs.length > 4) out = `${segs[0]}/…/${segs.slice(-2).join("/")}`;
	return out;
}

/** Tolerant text extraction from string | content-block array | message-like objects. */
export function messageText(m: unknown): string {
	if (typeof m === "string") return m;
	if (m === null || m === undefined) return "";
	if (Array.isArray(m)) {
		const parts: string[] = [];
		for (const block of m) {
			if (typeof block === "string") {
				parts.push(block);
				continue;
			}
			if (block && typeof block === "object") {
				const rec = block as Record<string, unknown>;
				if (typeof rec.text === "string") parts.push(rec.text);
				else if (typeof rec.thinking === "string") parts.push(rec.thinking);
			}
		}
		return parts.join("\n");
	}
	if (typeof m === "object") {
		const rec = m as Record<string, unknown>;
		if (typeof rec.text === "string") return rec.text;
		if ("content" in rec) return messageText(rec.content);
	}
	return "";
}
