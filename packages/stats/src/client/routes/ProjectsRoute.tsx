import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n-browser";
import { useDeferredValue, useMemo, useState } from "react";
import { getFolderStats } from "../api";
import { BarList } from "../charts";
import {
	formatCompact,
	formatDurationMs,
	formatErrorRate,
	formatEstimatedCost,
	formatFolder,
	formatInteger,
	formatPercent,
	formatRelativeTime,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { rangeMeta } from "../data/range";
import { buildFolderRows, type FolderRowView } from "../data/view-models";
import type { TimeRange } from "../types";
import {
	Badge,
	Card,
	ChartSkeleton,
	type Column,
	EmptyState,
	errorRateTone,
	MeterCell,
	PageHeader,
	QueryView,
	SearchInput,
	Stat,
	StatGrid,
	Table,
	TableSkeleton,
} from "../ui";
import "./projects.css";

export interface ProjectsRouteProps {
	active: boolean;
	range: TimeRange;
}

/** Rows rendered before "Show all": keeps the first paint cheap with tens of thousands of folders. */
const TABLE_LIMIT = 100;
const TOP_LIMIT = 8;

export function ProjectsRoute({ active, range }: ProjectsRouteProps) {
	const folders = useQuery(["projects", range], ({ signal }) => getFolderStats(range, signal), { enabled: active });
	const [search, setSearch] = useState("");
	// Benchmarks and scratch sessions can leave tens of thousands of one-off temp folders; hide them by default.
	const [hideTemporary, setHideTemporary] = useState(true);
	const query = useDeferredValue(search.trim().toLowerCase());
	const meta = rangeMeta(range);

	const view = useMemo(() => buildFolderRows(folders.data ?? []), [folders.data]);
	const scoped = useMemo(
		() => (hideTemporary ? view.rows.filter(row => !row.temporary) : view.rows),
		[view, hideTemporary],
	);
	const matching = useMemo(
		() => (query ? scoped.filter(row => row.folder.toLowerCase().includes(query)) : scoped),
		[scoped, query],
	);
	const top = useMemo(
		() => ({
			cost: [...scoped].sort((a, b) => b.totalCost - a.totalCost).slice(0, TOP_LIMIT),
			requests: [...scoped].sort((a, b) => b.totalRequests - a.totalRequests).slice(0, TOP_LIMIT),
		}),
		[scoped],
	);
	const topEmpty = (
		<EmptyState
			title={
				view.rows.length === 0
					? __ompTranslate("No project folders in this range")
					: __ompTranslate("Only temporary folders in this range")
			}
		/>
	);
	// Meter scales follow the whole range so a bar's length does not change while filtering.
	const columns = useMemo(() => folderColumns(view.maxRequests, view.maxCost), [view]);

	return (
		<div className="page">
			<PageHeader
				title={__ompTranslate("Projects")}
				description={__ompTranslate("Usage by session folder in {0}.", `${meta.windowLabel}`)}
			/>

			<QueryView query={folders} skeleton={<ChartSkeleton height={96} />}>
				{() => (
					<div data-stale={folders.stale}>
						<StatGrid min={180}>
							<Stat
								label={__ompTranslate("Folders")}
								value={formatInteger(view.rows.length)}
								hint={
									view.temporaryCount > 0
										? __ompTranslate("{0} temporary", `${formatInteger(view.temporaryCount)}`)
										: undefined
								}
							/>
							<Stat
								label={__ompTranslate("Requests")}
								value={formatInteger(view.totalRequests)}
								hint={__ompTranslate(
									"{0} failed\u0004stats.project.failed",
									`${formatInteger(view.failedRequests)}`,
								)}
							/>
							<Stat
								label={__ompTranslate("API-equivalent cost")}
								title={__ompTranslate("What this usage would cost at public API rates")}
								value={formatEstimatedCost(view.totalCost, view.unpricedRequests)}
								hint={
									view.unpricedRequests > 0
										? __ompTranslate("{0} unpriced", `${formatInteger(view.unpricedRequests)}`)
										: undefined
								}
							/>
							<Stat
								label={__ompTranslate("Conversation tokens")}
								title={__ompTranslate("Uncached input + cache reads + cache writes + output")}
								value={formatCompact(view.conversationTokens)}
							/>
							<Stat
								label={__ompTranslate("Cache rate")}
								title={__ompTranslate("Cache reads ÷ (uncached input + cache reads), across every folder")}
								value={formatPercent(view.cacheRate)}
							/>
						</StatGrid>
					</div>
				)}
			</QueryView>

			<div className="grid grid-2">
				<Card
					index={1}
					title={__ompTranslate("Top by cost")}
					description={__ompTranslate("Share of API-equivalent cost")}
					stale={folders.stale}
				>
					<QueryView
						query={folders}
						skeleton={<ChartSkeleton height={236} />}
						isEmpty={() => top.cost.length === 0}
						empty={topEmpty}
					>
						{() => (
							<BarList
								items={top.cost.map(row => ({
									key: row.folder,
									label: <span className="mono">{formatFolder(row.folder)}</span>,
									value: row.totalCost,
									display: `${formatEstimatedCost(row.totalCost, row.unpricedRequests)} · ${formatPercent(row.costShare)}`,
									color: "var(--chart-secondary)",
								}))}
								onSelect={setSearch}
							/>
						)}
					</QueryView>
				</Card>
				<Card
					index={2}
					title={__ompTranslate("Top by requests")}
					description={__ompTranslate("Share of all requests")}
					stale={folders.stale}
				>
					<QueryView
						query={folders}
						skeleton={<ChartSkeleton height={236} />}
						isEmpty={() => top.requests.length === 0}
						empty={topEmpty}
					>
						{() => (
							<BarList
								items={top.requests.map(row => ({
									key: row.folder,
									label: <span className="mono">{formatFolder(row.folder)}</span>,
									value: row.totalRequests,
									display: `${formatInteger(row.totalRequests)} · ${formatPercent(row.requestShare)}`,
								}))}
								onSelect={setSearch}
							/>
						)}
					</QueryView>
				</Card>
			</div>

			<Card
				index={3}
				title={__ompTranslate("Folders")}
				description={
					folders.data
						? matching.length === view.rows.length
							? __ompTranslate("{0} folders", `${formatInteger(view.rows.length)}`)
							: ((__ompTranslateValue0, __ompTranslateValue1) =>
									__ompTranslate("{1} of {0} folders", __ompTranslateValue1, __ompTranslateValue0))(
									`${formatInteger(matching.length)}`,
									`${formatInteger(view.rows.length)}`,
								)
						: undefined
				}
				actions={
					<>
						{view.temporaryCount > 0 && (
							<label className="check" title={__ompTranslate("Session folders under /tmp or /var/folders")}>
								<input
									type="checkbox"
									checked={hideTemporary}
									onChange={e => setHideTemporary(e.target.checked)}
								/>
								Hide temporary ({formatInteger(view.temporaryCount)})
							</label>
						)}
						<SearchInput
							value={search}
							onChange={setSearch}
							placeholder={__ompTranslate("Filter folders…")}
							width={240}
						/>
					</>
				}
				flush
				stale={folders.stale}
			>
				<QueryView query={folders} skeleton={<TableSkeleton rows={10} />}>
					{() => (
						<Table
							rows={matching}
							rowKey={row => row.folder}
							columns={columns}
							initialSort={{ key: "cost", dir: "desc" }}
							limit={TABLE_LIMIT}
							dense
							empty={
								<EmptyState
									title={
										view.rows.length === 0
											? __ompTranslate("No project folders in this range")
											: __ompTranslate("No folders match")
									}
									hint={
										view.rows.length === 0
											? __ompTranslate("Try a longer range.")
											: hideTemporary && view.temporaryCount > 0
												? __ompTranslate("Temporary folders are hidden.")
												: undefined
									}
								/>
							}
						/>
					)}
				</QueryView>
			</Card>
		</div>
	);
}

function folderColumns(maxRequests: number, maxCost: number): Column<FolderRowView>[] {
	return [
		{
			key: "folder",
			header: __ompTranslate("Folder"),
			sort: row => row.folder,
			render: row => (
				<span className="row projects-folder" title={row.folder || __ompTranslate("(root)")}>
					<span className="mono truncate">{formatFolder(row.folder)}</span>
					{row.temporary && <Badge>{__ompTranslate("temp")}</Badge>}
				</span>
			),
		},
		{
			key: "requests",
			header: __ompTranslate("Requests"),
			align: "right",
			sort: row => row.totalRequests,
			render: row => (
				<span title={__ompTranslate("{0} of all requests", `${formatPercent(row.requestShare)}`)}>
					<MeterCell value={row.totalRequests} max={maxRequests} display={formatInteger(row.totalRequests)} />
				</span>
			),
		},
		{
			key: "cost",
			header: __ompTranslate("Cost"),
			title: __ompTranslate("API-equivalent cost at public API rates"),
			align: "right",
			sort: row => row.totalCost,
			render: row => (
				<span title={__ompTranslate("{0} of all cost", `${formatPercent(row.costShare)}`)}>
					<MeterCell
						value={row.totalCost}
						max={maxCost}
						display={formatEstimatedCost(row.totalCost, row.unpricedRequests)}
						color="var(--chart-secondary)"
					/>
				</span>
			),
		},
		{
			key: "tokens",
			header: __ompTranslate("Tokens"),
			title: __ompTranslate("Uncached input + cache reads + cache writes + output"),
			align: "right",
			sort: row => row.conversationTokens,
			render: row => (
				<span className="num" title={formatInteger(row.conversationTokens)}>
					{formatCompact(row.conversationTokens)}
				</span>
			),
		},
		{
			key: "cacheRate",
			header: __ompTranslate("Cache rate"),
			title: __ompTranslate("Cache reads ÷ (uncached input + cache reads)"),
			align: "right",
			sort: row => row.cacheRate,
			render: row => <span className="num">{formatPercent(row.cacheRate)}</span>,
		},
		{
			key: "cacheSavings",
			header: __ompTranslate("Cache savings"),
			title: __ompTranslate("Prompt-input cost saved versus billing the same tokens uncached"),
			align: "right",
			sort: row => row.cacheSavings,
			render: row => (
				<span className={`num ${row.cacheSavings < 0 ? "tone-bad" : "muted"}`}>
					{formatPercent(row.cacheSavings)}
				</span>
			),
		},
		{
			key: "errorRate",
			header: __ompTranslate("Errors"),
			align: "right",
			sort: row => row.errorRate,
			render: row => (
				<span
					title={__ompTranslate("{0} failed\u0004stats.project.failed", `${formatInteger(row.failedRequests)}`)}
				>
					<Badge tone={row.failedRequests > 0 ? errorRateTone(row.errorRate) : "neutral"} mono>
						{formatErrorRate(row.errorRate)}
					</Badge>
				</span>
			),
		},
		{
			key: "duration",
			header: __ompTranslate("Avg duration"),
			align: "right",
			sort: row => row.avgDuration ?? -1,
			render: row => <span className="num">{formatDurationMs(row.avgDuration)}</span>,
		},
		{
			key: "last",
			header: __ompTranslate("Last active"),
			align: "right",
			sort: row => row.lastTimestamp,
			render: row => <span className="dim">{formatRelativeTime(row.lastTimestamp)}</span>,
		},
	];
}
