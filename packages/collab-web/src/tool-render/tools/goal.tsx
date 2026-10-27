/** `goal` — goal-mode lifecycle: set/check/complete/resume/drop an objective with an optional token budget. */
import { t } from "@oh-my-pi/pi-utils/i18n-browser";
import type { ReactNode } from "react";
import { fmtTokens, formatStatus } from "../../lib/format";
import type { Tone } from "../parts";
import { Badge, InvalidArg, Kv, KvGrid, Note, Output, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, num, str, truncate } from "../util";

interface GoalView {
	objective: string;
	status: string;
	tokenBudget: number | null;
	tokensUsed: number | null;
	timeUsedSeconds: number | null;
}

/** Narrow `details.goal` (untrusted JSON) to the fields we render. */
function goalOf(details: Record<string, unknown> | null): GoalView | null {
	const g = details?.goal;
	if (!isRecord(g)) return null;
	const objective = str(g.objective);
	const status = str(g.status);
	if (objective === null || status === null) return null;
	return {
		objective,
		status,
		tokenBudget: num(g.tokenBudget),
		tokensUsed: num(g.tokensUsed),
		timeUsedSeconds: num(g.timeUsedSeconds),
	};
}

/** Mirrors the TUI's describeOp: "create" reads as "set", "get" as "check". */
function describeOp(op: string | null): string {
	switch (op) {
		case "create":
			return t("set");
		case "get":
			return t("check");
		default:
			return op ?? "?";
	}
}

function statusTone(status: string): Tone | undefined {
	switch (status) {
		case "complete":
			return "ok";
		case "budget-limited":
			return "warn";
		case "paused":
		case "dropped":
			return undefined;
		default:
			return "accent";
	}
}

/** Coarse duration label from seconds: 45s, 12m, 3h, 2d. */
function fmtDuration(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	if (s < 60) return t("{0}s", `${s}`);
	const m = Math.round(s / 60);
	if (m < 60) return t("{0}m", `${m}`);
	const h = Math.round(m / 60);
	if (h < 48) return t("{0}h", `${h}`);
	return t("{0}d", `${Math.round(h / 24)}`);
}

/** "12K / 100K tokens (88K left)" or "12K tokens" without a budget. */
function tokensLine(goal: GoalView): string {
	const used = fmtTokens(goal.tokensUsed ?? 0);
	if (goal.tokenBudget === null) return t("{0} tokens", `${used}`);
	const left = Math.max(0, goal.tokenBudget - (goal.tokensUsed ?? 0));
	return t("{0} / {1} tokens ({2} left)", `${used}`, `${fmtTokens(goal.tokenBudget)}`, `${fmtTokens(left)}`);
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const goal = goalOf(details);
	const op = str(details?.op) ?? str(args.op);
	const objective = goal?.objective ?? str(args.objective);
	const budget = num(args.token_budget);
	return (
		<>
			{op === null && args.op !== undefined ? <InvalidArg what="op" /> : <span>{describeOp(op)}</span>}
			{goal && <Badge tone={statusTone(goal.status)}>{formatStatus(goal.status)}</Badge>}
			{objective !== null && objective.trim() !== "" && (
				<span className="tv-muted">“{truncate(normalizeWs(objective), 64)}”</span>
			)}
			{budget !== null && <span className="tv-faint">{t("budget {0}", `${fmtTokens(budget)}`)}</span>}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const goal = goalOf(details);
	const op = str(details?.op) ?? str(args.op);
	const objective = goal?.objective ?? str(args.objective);
	const budgetArg = num(args.token_budget);
	const report = str(details?.completionBudgetReport);
	const hasTokens = goal !== null && (goal.tokensUsed !== null || goal.tokenBudget !== null);
	return (
		<>
			<KvGrid>
				<Kv k={t("op")}>{describeOp(op)}</Kv>
				{goal && (
					<Kv k={t("status")}>
						<Badge tone={statusTone(goal.status)}>{formatStatus(goal.status)}</Badge>
					</Kv>
				)}
				{objective !== null && objective.trim() !== "" && <Kv k={t("objective")}>{objective.trim()}</Kv>}
				{hasTokens && goal ? (
					<Kv k={t("tokens")}>{tokensLine(goal)}</Kv>
				) : (
					budgetArg !== null && <Kv k={t("budget")}>{t("{0} tokens", `${fmtTokens(budgetArg)}`)}</Kv>
				)}
				{goal !== null && goal.timeUsedSeconds !== null && goal.timeUsedSeconds > 0 && (
					<Kv k={t("elapsed")}>{fmtDuration(goal.timeUsedSeconds)}</Kv>
				)}
			</KvGrid>
			{details !== null && goal === null && !result?.isError && <Note tone="warn">{t("no active goal")}</Note>}
			{report !== null && report !== "" && <Output text={report} title={t("Report")} maxLines={12} />}
			{(goal === null || result?.isError) && <ResultText result={result} maxLines={10} />}
		</>
	);
}

export const goalRenderer: ToolRenderer = { Summary, Body };
