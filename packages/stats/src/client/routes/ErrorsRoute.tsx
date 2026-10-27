import { t } from "@oh-my-pi/pi-utils/i18n-browser";
import { ArrowUpRight, X } from "lucide-react";
import { useMemo, useState } from "react";
import { getRecentErrors } from "../api";
import { BarList } from "../charts";
import { modelKey } from "../data/colors";
import {
	formatCompact,
	formatFolder,
	formatInteger,
	formatMessageCost,
	formatRelativeTime,
	formatTimestamp,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { rangeMeta } from "../data/range";
import { type ErrorGroupView, errorSignature, groupErrorsBySignature } from "../data/view-models";
import type { MessageStats, TimeRange } from "../types";
import {
	Card,
	type Column,
	EmptyState,
	LabelCell,
	MeterCell,
	PageHeader,
	QueryView,
	SearchInput,
	Skeleton,
	Stat,
	StatGrid,
	Table,
	TableSkeleton,
} from "../ui";
import "./errors.css";

export interface ErrorsRouteProps {
	active: boolean;
	range: TimeRange;
	onRequestClick: (id: number) => void;
}

/** How many of the newest failures to load; "Load more" steps through these. */
const LOAD_STEPS = [50, 200, 1_000] as const;

export function ErrorsRoute({ active, range, onRequestClick }: ErrorsRouteProps) {
	const [step, setStep] = useState(0);
	const limit = LOAD_STEPS[step];
	const errors = useQuery(["errors", range, limit], ({ signal }) => getRecentErrors(range, limit, signal), {
		enabled: active,
	});
	const [selectedSignature, setSelectedSignature] = useState<string | null>(null);
	const [selectedModel, setSelectedModel] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const meta = rangeMeta(range);

	const view = useMemo(() => {
		const rows = (errors.data ?? []).map(row => ({ row, signature: errorSignature(row.errorMessage) }));
		const groups = groupErrorsBySignature(errors.data ?? []);
		const byModel = new Map<string, { model: string; provider: string; count: number }>();
		for (const { row } of rows) {
			const key = modelKey(row.model, row.provider);
			const entry = byModel.get(key);
			if (entry) entry.count++;
			else byModel.set(key, { model: row.model, provider: row.provider, count: 1 });
		}
		const models = [...byModel.entries()]
			.map(([key, entry]) => ({ key, ...entry }))
			.sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
		const newest = rows.reduce<MessageStats | null>(
			(best, { row }) => (!best || row.timestamp > best.timestamp ? row : best),
			null,
		);
		return { rows, groups, models, newest };
	}, [errors.data]);

	// Selections that no longer exist in this range's data are ignored.
	const signature = view.groups.some(g => g.signature === selectedSignature) ? selectedSignature : null;
	const model = view.models.some(m => m.key === selectedModel) ? selectedModel : null;

	const filtered = useMemo(() => {
		const needle = search.trim().toLowerCase();
		return view.rows
			.filter(
				entry =>
					(signature === null || entry.signature === signature) &&
					(model === null || modelKey(entry.row.model, entry.row.provider) === model) &&
					(needle === "" ||
						entry.row.model.toLowerCase().includes(needle) ||
						entry.row.provider.toLowerCase().includes(needle) ||
						entry.row.folder.toLowerCase().includes(needle) ||
						(entry.row.errorMessage ?? "").toLowerCase().includes(needle)),
			)
			.map(entry => entry.row);
	}, [view.rows, signature, model, search]);

	const loaded = errors.data?.length ?? 0;
	// The server applies the range; fewer rows than the limit means we have them all.
	const complete = !errors.stale && loaded < limit;
	const nextStep = step + 1 < LOAD_STEPS.length ? LOAD_STEPS[step + 1] : null;
	const footer =
		errors.data !== null && !complete ? (
			<>
				<span>{t("Showing the latest {1} failures in {0}; older ones are not loaded.", `${meta.windowLabel}`, `${formatInteger(loaded)}`)}</span>
				{nextStep !== null && (
					<button
						type="button"
						className="btn"
						data-size="sm"
						disabled={errors.refreshing}
						onClick={() => setStep(step + 1)}
					>
						{errors.refreshing && errors.stale ? t("Loading…") : t("Load latest {0}", `${formatInteger(nextStep)}`)}
					</button>
				)}
			</>
		) : undefined;

	const maxGroup = view.groups[0]?.count ?? 0;
	const groupColumns = useMemo(() => buildGroupColumns(maxGroup), [maxGroup]);
	const selectedModelInfo = view.models.find(m => m.key === model);

	return (
		<div className="page">
			<PageHeader
				title={t("Errors")}
				description={t("Failed model requests in {0}, grouped by error signature. Open a failure for its full payload.", `${meta.windowLabel}`)}
			/>

			<QueryView query={errors} skeleton={<Skeleton height={96} style={{ borderRadius: 12 }} />}>
				{() => (
					<div data-stale={errors.stale}>
						<StatGrid min={170}>
							<Stat
								label={t("Failures")}
								value={formatInteger(loaded)}
								hint={complete ? t("in {0}\u0004packages/stats/src/client/routes/ErrorsRoute.tsx:ErrorsRoute", `${meta.windowLabel}`) : t("latest {0} loaded", `${formatInteger(loaded)}`)}
							/>
							<Stat
								label={t("Signatures")}
								title={t("Distinct error messages after normalizing ids and numbers")}
								value={formatInteger(view.groups.length)}
								hint={view.groups[0] ? t("top: {0} failures", `${formatInteger(view.groups[0].count)}`) : undefined}
							/>
							<Stat
								label={t("Affected models")}
								value={formatInteger(view.models.length)}
								hint={view.models[0]?.model}
							/>
							<Stat
								label={t("Last failure")}
								value={view.newest ? formatRelativeTime(view.newest.timestamp) : "–"}
								hint={view.newest ? formatTimestamp(view.newest.timestamp) : t("none in {0}", `${meta.windowLabel}`)}
							/>
						</StatGrid>
					</div>
				)}
			</QueryView>

			<div className="grid grid-main-side">
				<Card
					index={1}
					title={t("Error signatures")}
					description={t("Same message with ids and counters normalized. Select one to filter the failures below.")}
					flush
					stale={errors.stale}
				>
					<QueryView
						query={errors}
						skeleton={<TableSkeleton rows={8} />}
						isEmpty={rows => rows.length === 0}
						empty={
							<EmptyState
								title={t("No failures in {0}", `${meta.windowLabel}`)}
								hint={t("Every request succeeded or was aborted.")}
							/>
						}
					>
						{() => (
							<Table
								rows={view.groups}
								rowKey={group => group.signature}
								columns={groupColumns}
								onRowClick={group =>
									setSelectedSignature(signature === group.signature ? null : group.signature)
								}
								selectedKey={signature}
								expanded={group =>
									group.signature === signature ? (
										<SignatureDetail group={group} onRequestClick={onRequestClick} />
									) : null
								}
								limit={12}
							/>
						)}
					</QueryView>
				</Card>

				<Card
					index={2}
					title={t("By model")}
					description={t("Failures per model. Select one to filter.")}
					stale={errors.stale}
				>
					<QueryView
						query={errors}
						skeleton={<Skeleton height={180} />}
						isEmpty={rows => rows.length === 0}
						empty={<EmptyState title={t("No affected models")} />}
					>
						{() => (
							<BarList
								items={view.models.slice(0, 12).map(m => ({
									key: m.key,
									label: (
										<span className="row" style={{ gap: 6, minWidth: 0 }}>
											<span className="mono truncate">{m.model}</span>
											<span className="dim truncate">{m.provider}</span>
										</span>
									),
									value: m.count,
									color: m.key === model ? "var(--bad)" : "color-mix(in srgb, var(--bad) 45%, transparent)",
								}))}
								onSelect={key => setSelectedModel(model === key ? null : key)}
							/>
						)}
					</QueryView>
				</Card>
			</div>

			<Card
				index={3}
				title={t("Failures")}
				description={
					errors.data === null
						? t("Loading failures…")
						: t("{1} of {0} failures, newest first", `${formatInteger(loaded)}`, `${formatInteger(filtered.length)}`)
				}
				actions={
					<>
						{signature !== null && (
							<button
								type="button"
								className="btn errors-filter"
								data-size="sm"
								onClick={() => setSelectedSignature(null)}
								title={signature}
							>
								<span className="mono truncate">{signature}</span>
								<X size={12} />
							</button>
						)}
						{selectedModelInfo && (
							<button
								type="button"
								className="btn errors-filter"
								data-size="sm"
								onClick={() => setSelectedModel(null)}
							>
								<span className="mono truncate">{selectedModelInfo.model}</span>
								<X size={12} />
							</button>
						)}
						<SearchInput value={search} onChange={setSearch} placeholder={t("Message, model or project")} />
					</>
				}
				flush
				stale={errors.stale}
				footer={footer}
			>
				<QueryView
					query={errors}
					skeleton={<TableSkeleton rows={10} />}
					isEmpty={rows => rows.length === 0}
					empty={<EmptyState title={t("No failures in {0}", `${meta.windowLabel}`)} />}
				>
					{() => (
						<Table
							rows={filtered}
							rowKey={row => row.id ?? `${row.sessionFile}:${row.entryId}`}
							onRowClick={row => row.id !== undefined && onRequestClick(row.id)}
							columns={FAILURE_COLUMNS}
							initialSort={{ key: "time", dir: "desc" }}
							limit={50}
							dense
							empty={<EmptyState title={t("No failures match")} hint={t("Clear the search or the selected filters.")} />}
						/>
					)}
				</QueryView>
			</Card>
		</div>
	);
}

function buildGroupColumns(maxCount: number): Column<ErrorGroupView>[] {
	return [
		{
			key: "signature",
			header: t("Signature"),
			wrap: true,
			sort: group => group.signature,
			render: group => (
				<span className="errors-signature" title={group.latest.errorMessage ?? undefined}>
					{group.signature}
				</span>
			),
		},
		{
			key: "models",
			header: t("Models"),
			sort: group => group.models.length,
			render: group => (
				<LabelCell
					primary={<span className="mono">{group.models[0]?.model}</span>}
					secondary={group.models.length > 1 ? t("+{0} more", `${group.models.length - 1}`) : group.models[0]?.provider}
				/>
			),
		},
		{
			key: "last",
			header: t("Last seen"),
			sort: group => group.lastSeen,
			render: group => (
				<span className="muted" title={formatTimestamp(group.lastSeen)}>
					{formatRelativeTime(group.lastSeen)}
				</span>
			),
		},
		{
			key: "count",
			header: t("Failures"),
			align: "right",
			width: 120,
			sort: group => group.count,
			render: group => (
				<MeterCell value={group.count} max={maxCount} display={formatInteger(group.count)} color="var(--bad)" />
			),
		},
	];
}

function SignatureDetail({ group, onRequestClick }: { group: ErrorGroupView; onRequestClick: (id: number) => void }) {
	const latestId = group.latest.id;
	return (
		<div className="errors-detail">
			<pre className="code-block errors-detail-message">{group.latest.errorMessage ?? t("Unknown error")}</pre>
			<div className="errors-detail-meta">
				<span className="muted">{t("{0} failures · first {1} · last{2}{3}", `${formatInteger(group.count)}`, `${formatTimestamp(group.firstSeen)}`, `${" "}`, `${formatTimestamp(group.lastSeen)}`)}</span>
				{latestId !== undefined && (
					<button type="button" className="btn" data-size="sm" onClick={() => onRequestClick(latestId)}>{t("Open latest ")}<ArrowUpRight size={13} />
					</button>
				)}
			</div>
			<div className="errors-detail-models">
				{group.models.map(m => (
					<span key={modelKey(m.model, m.provider)} className="badge" data-mono="true">
						{m.model} <span className="dim">{m.provider}</span>{" "}
						<span className="num">{formatCompact(m.count)}</span>
					</span>
				))}
			</div>
		</div>
	);
}

const FAILURE_COLUMNS: readonly Column<MessageStats>[] = [
	{
		key: "time",
		header: t("When"),
		width: 120,
		sort: row => row.timestamp,
		render: row => (
			<span className="muted" title={formatTimestamp(row.timestamp)}>
				{formatRelativeTime(row.timestamp)}
			</span>
		),
	},
	{
		key: "model",
		header: t("Model"),
		sort: row => row.model,
		render: row => <LabelCell primary={<span className="mono">{row.model}</span>} secondary={row.provider} />,
	},
	{
		key: "error",
		header: t("Error"),
		sort: row => row.errorMessage ?? "",
		render: row => (
			<span className="errors-message" title={row.errorMessage ?? undefined}>
				{row.errorMessage ?? t("Unknown error")}
			</span>
		),
	},
	{
		key: "project",
		header: t("Project"),
		sort: row => row.folder,
		render: row => (
			<span className="mono muted" title={row.folder}>
				{formatFolder(row.folder)}
			</span>
		),
	},
	{
		key: "tokens",
		header: t("Tokens"),
		align: "right",
		sort: row => row.usage.totalTokens,
		render: row => <span className="num">{formatInteger(row.usage.totalTokens)}</span>,
	},
	{
		key: "cost",
		header: t("Cost"),
		title: t("API-equivalent estimate"),
		align: "right",
		sort: row => row.usage.cost.total,
		render: row => <span className="num">{formatMessageCost(row, 4)}</span>,
	},
];
