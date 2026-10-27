import { t } from "@oh-my-pi/pi-utils/i18n";
import { computeSessionContextBreakdown } from "../../session/context-usage-runtime";
import type { SlashCommandRuntime } from "../types";
import { renderAsciiBar } from "@oh-my-pi/pi-tui/chrome/format";
import { padToWidth } from "@oh-my-pi/pi-tui/render/utils";

/**
 * Build the `/context` ACP-mode text. Tries the rich breakdown first
 * (categories + auto-compact buffer + free slack) and falls back to the
 * minimal "window/used" lines when the breakdown helper throws.
 */
export function buildContextReportText(runtime: SlashCommandRuntime): string {
	try {
		const breakdown = computeSessionContextBreakdown(runtime.session, { snapcompactSavings: true });
		if (breakdown.contextWindow <= 0) {
			return t("Context usage is unavailable: no model is selected for this session.");
		}
		const usedPct = Math.round((breakdown.usedTokens / breakdown.contextWindow) * 100);
		const lines = [t("Context window: {0} tokens ({1}% used)", `${breakdown.contextWindow}`, `${usedPct}`)];
		for (const category of breakdown.categories) {
			if (category.tokens === 0) continue;
			const fraction = category.tokens / breakdown.contextWindow;
			lines.push(t("  {0} {1}  {2} tokens", `${(padToWidth(category.label, 16))}`, `${(renderAsciiBar(fraction))}`, `${(category.tokens)}`));
		}
		if (breakdown.autoCompactBufferTokens > 0) {
			const fraction = breakdown.autoCompactBufferTokens / breakdown.contextWindow;
			lines.push(
				t("  {0} {1}  {2} tokens", `${(padToWidth(t("Auto-compact buf"), 16))}`, `${(renderAsciiBar(fraction))}`, `${(breakdown.autoCompactBufferTokens)}`),
			);
		}
		if (breakdown.freeTokens > 0) {
			const fraction = breakdown.freeTokens / breakdown.contextWindow;
			lines.push(t("  {0} {1}  {2} tokens", `${(padToWidth(t("Free"), 16))}`, `${(renderAsciiBar(fraction))}`, `${(breakdown.freeTokens)}`));
		}
		const snap = breakdown.snapcompact;
		if (snap) {
			if (!snap.visionCapable) {
				lines.push(t("Snapcompact: inactive (model has no image input)"));
			} else {
				lines.push(t("Snapcompact (estimated wire savings):"));
				if (snap.systemPrompt) {
					const sp = snap.systemPrompt;
					lines.push(
						sp.applied
							? t("  System prompt: {0} text tokens → {1} frame{4} ≈ {2} tokens (saves ~{3})", `${sp.textTokens}`, `${sp.frames}`, `${sp.imageTokens}`, `${sp.savedTokens}`, `${sp.frames === 1 ? "" : "s"}`)
							: t("  System prompt: stays text (no net savings)"),
					);
				}
				if (snap.toolResults) {
					const tr = snap.toolResults;
					lines.push(
						tr.swapped > 0
							? t("  Tool results: {1} of {0} imaged, {2} text tokens → {3} frames ≈ {4} tokens (saves ~{5})", `${tr.total}`, `${tr.swapped}`, `${tr.textTokens}`, `${tr.frames}`, `${tr.imageTokens}`, `${tr.savedTokens}`)
							: t("  Tool results: none imaged ({0} in history)", `${tr.total}`),
					);
				}
				if (snap.savedTokens > 0) {
					lines.push(t("  Estimated next request: ~{0} tokens on the wire", `${breakdown.usedTokens - snap.savedTokens}`));
				}
			}
		}
		return lines.join("\n");
	} catch {
		const fallback = runtime.session.getContextUsage();
		if (!fallback) return t("Context usage is unavailable.");
		return [t("Context"), t("Window: {0}", `${fallback.contextWindow}`), t("Used: {0}", `${fallback.tokens ?? 0}`)].join("\n");
	}
}
