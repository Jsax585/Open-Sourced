/**
 * Headline tiles for one trace: wall time split into model/tool/idle, then
 * turns, requests, tool calls, agents, tokens, cost.
 */

import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n-browser";
import { formatCompact, formatElapsed, formatEstimatedCost, formatInteger, formatPercent } from "../data/formatters";
import type { TraceSummary } from "../types";
import { Stat, StatGrid } from "../ui";

export interface SummaryStripProps {
	summary: TraceSummary;
}

export function SummaryStrip({ summary }: SummaryStripProps) {
	const share = (ms: number) =>
		summary.wallMs > 0 ? __ompTranslate("{0} of wall", `${formatPercent(ms / summary.wallMs)}`) : undefined;
	return (
		<StatGrid min={112}>
			<Stat size="sm" label={__ompTranslate("Wall time")} value={formatElapsed(summary.wallMs)} />
			<Stat
				size="sm"
				label={__ompTranslate("Model time")}
				value={formatElapsed(summary.modelMs)}
				hint={share(summary.modelMs)}
			/>
			<Stat
				size="sm"
				label={__ompTranslate("Tool time")}
				value={formatElapsed(summary.toolMs)}
				hint={share(summary.toolMs)}
			/>
			<Stat
				size="sm"
				label={__ompTranslate("Idle")}
				value={formatElapsed(summary.idleMs)}
				hint={share(summary.idleMs)}
			/>
			<Stat size="sm" label={__ompTranslate("Turns")} value={formatInteger(summary.turns)} />
			<Stat
				size="sm"
				label={__ompTranslate("Requests")}
				value={formatInteger(summary.requests)}
				hint={__ompTranslate("{0} tool calls", `${formatInteger(summary.toolCalls)}`)}
			/>
			<Stat size="sm" label={__ompTranslate("Agents")} value={formatInteger(summary.subagents)} />
			<Stat size="sm" label={__ompTranslate("Tokens")} value={formatCompact(summary.totalTokens)} />
			<Stat
				size="sm"
				label={__ompTranslate("Cost")}
				value={formatEstimatedCost(summary.costTotal, summary.unpricedRequests)}
			/>
		</StatGrid>
	);
}
