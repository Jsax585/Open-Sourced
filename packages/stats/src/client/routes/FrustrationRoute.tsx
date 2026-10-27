import { t } from "@oh-my-pi/pi-utils/i18n-browser";
import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	cancelFrustrationRun,
	getFrustrationDashboardStats,
	getFrustrationEstimate,
	startFrustrationRun,
} from "../api";
import { Chart, type ChartSeries, Legend, useHiddenSeries } from "../charts";
import { SERIES_COLORS } from "../data/colors";
import { formatCost, formatInteger, formatPercent } from "../data/formatters";
import { useQuery } from "../data/query";
import { rangeMeta } from "../data/range";
import type {
	FrustrationCounts,
	FrustrationEstimate,
	FrustrationJobStatus,
	FrustrationModelStats,
	TimeRange,
} from "../types";
import {
	Badge,
	Card,
	ChartSkeleton,
	type Column,
	Dot,
	EmptyState,
	KeyValues,
	Modal,
	PageHeader,
	QueryView,
	Segmented,
	Stat,
	StatGrid,
	Table,
	TableSkeleton,
} from "../ui";
import "./frustration.css";

export interface FrustrationRouteProps {
	active: boolean;
	range: TimeRange;
}

/** While a judge run is active every poll re-renders with the verdicts landed so far. */
const RUNNING_POLL_MS = 1_000;
/** Rows under this many messages are too noisy to compare; hidden unless asked for. */
const MIN_MESSAGES = 50;
/** Below this judged share a row is mostly classified by the regex fallback. */
const MIN_JUDGED_SHARE = 0.5;
/** Segmented-control value for "every model class". */
const ALL_CLASSES = "*";

export function FrustrationRoute({ active, range }: FrustrationRouteProps) {
	const [running, setRunning] = useState(false);
	const stats = useQuery(["frustration", range], ({ signal }) => getFrustrationDashboardStats(range, signal), {
		enabled: active,
		pollMs: running ? RUNNING_POLL_MS : undefined,
	});
	const meta = rangeMeta(range);

	const jobState = stats.data?.job.state;
	useEffect(() => {
		if (jobState !== undefined) setRunning(jobState === "running");
	}, [jobState]);

	const { refetch } = stats;
	const handleRunStarted = useCallback(() => {
		setRunning(true);
		refetch();
	}, [refetch]);

	return (
		<div className="page">
			<PageHeader
				title={t("Frustration")}
				description={t("How often your messages sound annoyed, per model version, in {0}.", `${meta.windowLabel}`)}
			/>

			<QueryView query={stats} skeleton={<ChartSkeleton height={96} />}>
				{data => (
					<div data-stale={stats.stale}>
						<FrustrationSummary overall={data.overall} />
					</div>
				)}
			</QueryView>

			<QueryView query={stats} skeleton={<ChartSkeleton height={120} />}>
				{data => (
					<JudgePanel
						active={active}
						range={range}
						judgeAvailable={data.judgeAvailable}
						job={data.job}
						onRunStarted={handleRunStarted}
						onRunChanged={refetch}
					/>
				)}
			</QueryView>

			<QueryView
				query={stats}
				skeleton={
					<Card index={2} title={t("Frustration by model version")}>
						<ChartSkeleton height={340} />
						<TableSkeleton rows={6} />
					</Card>
				}
			>
				{data => <FrustrationModelsSection models={data.byModel} stale={stats.stale} />}
			</QueryView>
		</div>
	);
}

/** `part / whole` as a percentage string; `–` when there is nothing to divide. */
function rate(part: number, whole: number): string {
	return whole > 0 ? formatPercent(part / whole) : "–";
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function FrustrationSummary({ overall }: { overall: FrustrationCounts }) {
	const regex = overall.messages - overall.judged;
	return (
		<StatGrid min={170}>
			<Stat
				label={t("User messages")}
				title={t("User messages with prose in range")}
				value={formatInteger(overall.messages)}
			/>
			<Stat
				label={t("Judge coverage")}
				title={t("Messages with a cached judge verdict; the rest use regex signals")}
				value={rate(overall.judged, overall.messages)}
				hint={t("{0} judged · {1} regex", `${formatInteger(overall.judged)}`, `${formatInteger(regex)}`)}
			/>
			<Stat
				label={t("Annoyed")}
				title={t("Messages annoyed at any target")}
				value={rate(overall.annoyed, overall.messages)}
				hint={t("{0} messages", `${formatInteger(overall.annoyed)}`)}
			/>
			<Stat
				label={t("At assistant")}
				title={t("Messages annoyed at the assistant")}
				value={rate(overall.atAssistant, overall.messages)}
				hint={t("{0} messages", `${formatInteger(overall.atAssistant)}`)}
			/>
			<Stat
				label={t("Angry")}
				title={t("Messages angry or hostile toward the assistant")}
				value={rate(overall.angry, overall.messages)}
				hint={t("{0} messages", `${formatInteger(overall.angry)}`)}
			/>
		</StatGrid>
	);
}

// ---------------------------------------------------------------------------
// Judge control
// ---------------------------------------------------------------------------

type EstimateState =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "ready"; estimate: FrustrationEstimate; range: TimeRange };

interface JudgePanelProps {
	active: boolean;
	range: TimeRange;
	judgeAvailable: boolean;
	job: FrustrationJobStatus;
	onRunStarted: () => void;
	onRunChanged: () => void;
}

const UNAVAILABLE_HINT =
	t("Judging needs the omp host process: open the dashboard with omp stats and configure a judge model. Until then messages are classified by regex signals.");

function JudgePanel({ active, range, judgeAvailable, job, onRunStarted, onRunChanged }: JudgePanelProps) {
	const [modalOpen, setModalOpen] = useState(false);
	const [estimate, setEstimate] = useState<EstimateState>({ status: "loading" });
	const [starting, setStarting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);
	const [cancelling, setCancelling] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const estimateAbortRef = useRef<AbortController | null>(null);

	const running = job.state === "running";

	const closeModal = useCallback(() => {
		estimateAbortRef.current?.abort();
		estimateAbortRef.current = null;
		setModalOpen(false);
	}, []);

	// A hidden route must not leave a dialog (portalled to <body>) on screen.
	useEffect(() => {
		if (!active) closeModal();
	}, [active, closeModal]);
	useEffect(() => () => estimateAbortRef.current?.abort(), []);

	const openEstimate = () => {
		estimateAbortRef.current?.abort();
		const controller = new AbortController();
		estimateAbortRef.current = controller;
		const quotedRange = range;
		setEstimate({ status: "loading" });
		setStartError(null);
		setActionError(null);
		setModalOpen(true);
		getFrustrationEstimate(quotedRange, controller.signal).then(
			result => {
				if (!controller.signal.aborted) setEstimate({ status: "ready", estimate: result, range: quotedRange });
			},
			(err: unknown) => {
				if (!controller.signal.aborted) setEstimate({ status: "error", message: errorMessage(err) });
			},
		);
	};

	const proceed = async () => {
		if (estimate.status !== "ready") return;
		setStarting(true);
		setStartError(null);
		try {
			// Judge exactly the range that was quoted, even if the picker moved meanwhile.
			await startFrustrationRun(estimate.range);
			closeModal();
			onRunStarted();
		} catch (err) {
			setStartError(errorMessage(err));
		} finally {
			setStarting(false);
		}
	};

	const cancelRun = async () => {
		setCancelling(true);
		setActionError(null);
		try {
			await cancelFrustrationRun();
			onRunChanged();
		} catch (err) {
			setActionError(errorMessage(err));
		} finally {
			setCancelling(false);
		}
	};

	const quote = estimate.status === "ready" ? estimate.estimate : null;
	const primaryAction =
		estimate.status === "loading"
			? { label: t("Proceed"), onClick: proceed, disabled: true }
			: quote?.available
				? {
						label: starting ? t("Starting…") : t("Proceed"),
						onClick: proceed,
						disabled: starting || quote.messages === 0,
					}
				: undefined;

	return (
		<Card
			index={1}
			title={
				<>{t("Judge classification ")}<JobBadge job={job} judgeAvailable={judgeAvailable} />
				</>
			}
			description={t("Cached LLM verdicts replace the regex heuristics; unjudged messages fall back to regex signals.")}
			actions={
				<button
					type="button"
					className="btn"
					data-variant="accent"
					data-size="sm"
					onClick={openEstimate}
					disabled={!judgeAvailable || running}
					title={
						!judgeAvailable
							? UNAVAILABLE_HINT
							: running
								? t("A judge run is in progress")
								: t("Quote the cost of judging every unjudged message in range")
					}
				>
					<Sparkles size={13} />{t(" Classify with judge")}</button>
			}
		>
			<div className="stack frustration-judge">
				{running ? (
					<JudgeProgress job={job} cancelling={cancelling} onCancel={cancelRun} />
				) : (
					<JudgeResultLine job={job} />
				)}
				{!judgeAvailable && <p className="micro dim">{UNAVAILABLE_HINT}</p>}
				{actionError && (
					<p className="micro tone-bad" role="alert">
						{actionError}
					</p>
				)}
			</div>

			<Modal open={modalOpen} title={t("Classify with judge")} onClose={closeModal} primaryAction={primaryAction}>
				<EstimateBody estimate={estimate} />
				{startError && (
					<p className="micro tone-bad" role="alert">
						{startError}
					</p>
				)}
			</Modal>
		</Card>
	);
}

function JobBadge({ job, judgeAvailable }: { job: FrustrationJobStatus; judgeAvailable: boolean }) {
	switch (job.state) {
		case "running":
			return (
				<Badge tone="ok">
					<Dot tone="live" pulse />{t(" Running")}</Badge>
			);
		case "done":
			return <Badge tone="ok">{t("Last run done")}</Badge>;
		case "cancelled":
			return <Badge tone="warn">{t("Last run cancelled")}</Badge>;
		case "failed":
			return <Badge tone="bad">{t("Last run failed")}</Badge>;
		case "idle":
			return <Badge>{judgeAvailable ? t("Not run yet") : t("Regex only")}</Badge>;
	}
}

function EstimateBody({ estimate }: { estimate: EstimateState }) {
	if (estimate.status === "loading") return <p className="muted">{t("Estimating cost…")}</p>;
	if (estimate.status === "error") return <p className="tone-bad">{estimate.message}</p>;
	const quote = estimate.estimate;
	if (!quote.available) return <p>{quote.reason}</p>;
	if (quote.messages === 0) {
		return <p>{t("Everything in this range is already judged. There is nothing left to classify.")}</p>;
	}
	return (
		<>
			<div className="frustration-quote">
				<span className="dim micro">{t("Estimated cost")}</span>
				<span className="num frustration-quote-value">≈ {formatCost(quote.cost)}</span>
			</div>
			<KeyValues
				items={[
					{ key: "messages", label: t("Unjudged unique messages"), value: formatInteger(quote.messages) },
					{ key: "chars", label: t("Prose characters"), value: formatInteger(quote.chars) },
					{ key: "tokens", label: t("Estimated input tokens"), value: formatInteger(quote.inputTokens) },
					{ key: "judge", label: t("Judge"), value: quote.judge },
				]}
			/>
			<p className="micro dim">{t("Identical messages share one verdict, and verdicts are cached, so later runs only pay for new messages. Nothing is spent until you proceed.")}</p>
		</>
	);
}

function JudgeProgress({
	job,
	cancelling,
	onCancel,
}: {
	job: FrustrationJobStatus;
	cancelling: boolean;
	onCancel: () => void;
}) {
	const finished = job.done + job.failed;
	const share = job.total > 0 ? Math.min(1, finished / job.total) : 0;
	return (
		<div className="stack frustration-progress">
			<div className="row frustration-progress-head">
				<span className="num">{t("{0}/{1} judged", `${formatInteger(job.done)}`, `${formatInteger(job.total)}`)}</span>
				<span className="num dim">{formatPercent(share)}</span>
				<span className="frustration-spacer" />
				<button
					type="button"
					className="btn"
					data-variant="danger"
					data-size="sm"
					onClick={onCancel}
					disabled={cancelling}
				>
					{cancelling ? t("Cancelling…") : t("Cancel run")}
				</button>
			</div>
			<div
				className="meter frustration-progress-track"
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={job.total}
				aria-valuenow={finished}
			>
				<div className="meter-fill frustration-progress-fill" style={{ width: `${share * 100}%` }} />
			</div>
			<div className="row micro muted frustration-progress-meta">
				<span className={job.failed > 0 ? "tone-bad" : undefined}>{t("{0} failed\u0004packages/stats/src/client/routes/FrustrationRoute.tsx:JudgeProgress", `${formatInteger(job.failed)}`)}</span>
				<span>{t("cost so far ")}<span className="num">{formatCost(job.cost)}</span>
				</span>
				{job.judge && <span className="mono">{job.judge}</span>}
				{job.startedAt !== null && <span>{t("elapsed {0}", `${formatElapsed(Date.now() - job.startedAt)}`)}</span>}
				{job.startedAt !== null && job.done > 0 && (
					<span className="num">{(job.done / Math.max(1, (Date.now() - job.startedAt) / 1000)).toFixed(0)}/s</span>
				)}
				{job.concurrency > 0 && <span className="num">{t("{0} in flight", `${formatInteger(job.concurrency)}`)}</span>}
			</div>
		</div>
	);
}

function JudgeResultLine({ job }: { job: FrustrationJobStatus }) {
	const progress = t("{0}/{1} messages", `${formatInteger(job.done)}`, `${formatInteger(job.total)}`);
	const failed = job.failed > 0 ? t(", {0} failed", `${formatInteger(job.failed)}`) : "";
	const judge = job.judge ? t(" with {0}", `${job.judge}`) : "";
	const elapsed =
		job.startedAt !== null && job.finishedAt !== null ? t(" in {0}", `${formatElapsed(job.finishedAt - job.startedAt)}`) : "";
	switch (job.state) {
		case "idle":
			return (
				<p className="muted">{t("No judge run yet. Classify the unjudged messages to replace regex estimates with verdicts.")}</p>
			);
		case "running":
			return null;
		case "done":
			return (
				<p className="muted">{t("Last run judged {0}{1}{2}{3} for ", `${progress}`, `${failed}`, `${judge}`, `${elapsed}`)}<span className="num">{formatCost(job.cost)}</span>.
				</p>
			);
		case "cancelled":
			return (
				<p className="muted">{t("Last run cancelled after {0}{1}; spent ", `${progress}`, `${failed}`)}<span className="num">{formatCost(job.cost)}</span>.
				</p>
			);
		case "failed":
			return (
				<p className="muted">{t("Last run failed after {0}{1}: ", `${progress}`, `${failed}`)}<span className="tone-bad">{job.error ?? t("unknown error")}</span>{t(". Spent{0}", `${" "}`)}<span className="num">{formatCost(job.cost)}</span>.
				</p>
			);
	}
}

// ---------------------------------------------------------------------------
// Per-model chart + table
// ---------------------------------------------------------------------------

/** Chart/filter identity of a model family: `class/family`. */
function familyKey(row: FrustrationModelStats): string {
	return `${row.modelClass}/${row.family ?? "unclassified"}`;
}

function isMostlyRegex(row: FrustrationModelStats): boolean {
	return row.messages > 0 && row.judged / row.messages < MIN_JUDGED_SHARE;
}

/** FNV-1a: a stable preferred palette slot per family, independent of range. */
function hashString(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Deterministic family → palette color. Each family starts at its hashed slot
 * and probes forward past taken slots, so families present together stay
 * distinct (until the palette runs out) and keep their hue across ranges.
 */
function assignFamilyColors(models: readonly FrustrationModelStats[]): Map<string, string> {
	const keys = [...new Set(models.map(familyKey))].sort();
	const taken = new Set<number>();
	const colors = new Map<string, string>();
	for (const key of keys) {
		let slot = hashString(key) % SERIES_COLORS.length;
		for (let probe = 0; probe < SERIES_COLORS.length && taken.has(slot); probe++) {
			slot = (slot + 1) % SERIES_COLORS.length;
		}
		taken.add(slot);
		colors.set(key, SERIES_COLORS[slot]);
	}
	return colors;
}

/**
 * Shades of one family hue for the three stacked layers. `color-mix` keeps
 * the faint layer see-through on both themes.
 */
function layerColor(hue: string, layer: Layer): string {
	if (layer === "angry") return `color-mix(in srgb, ${hue} 55%, black)`;
	if (layer === "other") return `color-mix(in srgb, ${hue} 32%, transparent)`;
	return hue;
}

/**
 * Stack layers, bottom first. `annoyed ⊇ atAssistant ⊇ angry`, so stacking the
 * differences draws each bar to the `annoyed` height with the subsets inside.
 */
const LAYERS = [
	{ key: "angry", label: t("Angry at assistant") },
	{ key: "assistant", label: t("At assistant, not angry") },
	{ key: "other", label: t("Annoyed at other targets") },
] as const;
type Layer = (typeof LAYERS)[number]["key"];

function layerCount(row: FrustrationModelStats, layer: Layer): number {
	if (layer === "angry") return row.angry;
	if (layer === "assistant") return row.atAssistant - row.angry;
	return row.annoyed - row.atAssistant;
}

function percent(part: number, whole: number): number {
	return whole > 0 ? (part / whole) * 100 : 0;
}

interface FamilyOption {
	key: string;
	label: string;
	messages: number;
}

function FrustrationModelsSection({ models, stale }: { models: FrustrationModelStats[]; stale: boolean }) {
	const [selectedClass, setSelectedClass] = useState<string | null>(null);
	const [hiddenFamilies, toggleFamily] = useHiddenSeries();
	const [showSmall, setShowSmall] = useState(false);
	const [hideRegex, setHideRegex] = useState(false);

	const familyColors = useMemo(() => assignFamilyColors(models), [models]);

	const classes = useMemo(() => {
		const totals = new Map<string, number>();
		for (const row of models) totals.set(row.modelClass, (totals.get(row.modelClass) ?? 0) + row.messages);
		return totals;
	}, [models]);

	const defaultClass = useMemo(() => {
		let best: string | null = null;
		let bestMessages = -1;
		for (const [modelClass, messages] of classes) {
			if (messages > bestMessages) {
				best = modelClass;
				bestMessages = messages;
			}
		}
		return best ?? ALL_CLASSES;
	}, [classes]);

	const activeClass =
		selectedClass !== null && (selectedClass === ALL_CLASSES || classes.has(selectedClass))
			? selectedClass
			: defaultClass;

	const classOptions = useMemo(
		() => [
			{ value: ALL_CLASSES, label: t("All"), title: t("Every model class") },
			...[...classes].map(([modelClass, messages]) => ({
				value: modelClass,
				label: modelClass,
				title: t("{0} messages", `${formatInteger(messages)}`),
			})),
		],
		[classes],
	);

	const inClass = useMemo(
		() => (activeClass === ALL_CLASSES ? models : models.filter(row => row.modelClass === activeClass)),
		[models, activeClass],
	);

	const families = useMemo(() => {
		const byKey = new Map<string, FamilyOption>();
		for (const row of inClass) {
			const key = familyKey(row);
			const existing = byKey.get(key);
			if (existing) {
				existing.messages += row.messages;
				continue;
			}
			const family = row.family ?? "unclassified";
			byKey.set(key, {
				key,
				label: activeClass === ALL_CLASSES ? `${row.modelClass} · ${family}` : family,
				messages: row.messages,
			});
		}
		return [...byKey.values()];
	}, [inClass, activeClass]);

	const visibleFamilies = useMemo(
		() => inClass.filter(row => !hiddenFamilies.has(familyKey(row))),
		[inClass, hiddenFamilies],
	);
	const smallCount = visibleFamilies.filter(row => row.messages < MIN_MESSAGES).length;
	const regexCount = visibleFamilies.filter(isMostlyRegex).length;
	const rows = useMemo(
		() =>
			visibleFamilies.filter(
				row => (showSmall || row.messages >= MIN_MESSAGES) && !(hideRegex && isMostlyRegex(row)),
			),
		[visibleFamilies, showSmall, hideRegex],
	);

	if (models.length === 0) {
		return (
			<Card index={2} title={t("Frustration by model version")} stale={stale}>
				<EmptyState title={t("No user messages in this range")} hint={t("Try a longer range.")} />
			</Card>
		);
	}

	const hasRegexRows = rows.some(isMostlyRegex);

	return (
		<>
			<Card
				index={2}
				title={t("Frustration by model version")}
				description={t("Share of user messages per model version. Each bar reaches the annoyed rate; the subsets aimed at the assistant stack inside it.")}
				stale={stale}
			>
				<div className="stack frustration-chart-body">
					<div className="frustration-classes">
						<Segmented
							size="sm"
							aria-label={t("Model class")}
							options={classOptions}
							value={activeClass}
							onChange={setSelectedClass}
						/>
					</div>
					<div className="row frustration-filters">
						<Legend
							items={families.map(family => ({
								key: family.key,
								label: family.label,
								color: familyColors.get(family.key) ?? SERIES_COLORS[0],
								value: formatInteger(family.messages),
							}))}
							hidden={hiddenFamilies}
							onToggle={toggleFamily}
						/>
						<span className="frustration-spacer" />
						<label className="check" title={t("Models with fewer than {0} messages have noisy rates", `${MIN_MESSAGES}`)}>
							<input type="checkbox" checked={showSmall} onChange={e => setShowSmall(e.target.checked)} />{t("Include < {0} messages{1}", `${MIN_MESSAGES}`, `${smallCount > 0 ? ` (${smallCount})` : ""}`)}</label>
						<label
							className="check"
							title={t("Hide models with under {0}% judged messages (rates from regex signals)", `${MIN_JUDGED_SHARE * 100}`)}
						>
							<input type="checkbox" checked={hideRegex} onChange={e => setHideRegex(e.target.checked)} />{t("Hide mostly regex{0}", `${regexCount > 0 ? ` (${regexCount})` : ""}`)}</label>
					</div>
					<EncodingKey hasRegexRows={hasRegexRows} />
					<FrustrationChart rows={rows} familyColors={familyColors} />
				</div>
			</Card>
			<FrustrationTable rows={rows} familyColors={familyColors} stale={stale} />
		</>
	);
}

/** What the marks mean: layer shades, hatching and the trend line (hue = family). */
function EncodingKey({ hasRegexRows }: { hasRegexRows: boolean }) {
	return (
		<div className="legend frustration-key">
			<span className="legend-item">
				<span className="swatch frustration-key-swatch" data-variant="angry" />{t("Angry at assistant")}</span>
			<span className="legend-item">
				<span className="swatch frustration-key-swatch" data-variant="assistant" />{t("At assistant")}</span>
			<span className="legend-item">
				<span className="swatch frustration-key-swatch" data-variant="other" />{t("Annoyed at other targets")}</span>
			<span className="legend-item">
				<span className="frustration-key-line" />{t("At assistant trend")}</span>
			<span
				className="legend-item frustration-key-wide"
				title={t("Under {0}% of these messages are judged; their rates come from regex signals", `${MIN_JUDGED_SHARE * 100}`)}
			>
				<span className="swatch frustration-key-swatch" data-variant="hatch" />{t("Hatched: mostly regex fallback{0}", `${hasRegexRows ? t(" (run the judge)") : ""}`)}</span>
			<span className="legend-item dim">{t("Hue = model family")}</span>
		</div>
	);
}

function FrustrationChart({
	rows,
	familyColors,
}: {
	rows: FrustrationModelStats[];
	familyColors: Map<string, string>;
}) {
	const series = useMemo((): ChartSeries[] => {
		// Bars take their family's hue, so every (layer, family, judged|regex)
		// combination is its own series with values only in that family's slots.
		const groups = new Map<string, { family: string; regex: boolean; slots: number[] }>();
		rows.forEach((row, i) => {
			const family = familyKey(row);
			const regex = isMostlyRegex(row);
			const id = `${family}|${regex ? "regex" : "judged"}`;
			const group = groups.get(id);
			if (group) group.slots.push(i);
			else groups.set(id, { family, regex, slots: [i] });
		});
		const out: ChartSeries[] = [];
		for (const layer of LAYERS) {
			for (const [id, group] of groups) {
				const values: (number | null)[] = rows.map(() => null);
				for (const i of group.slots) values[i] = percent(layerCount(rows[i], layer.key), rows[i].messages);
				out.push({
					key: `${layer.key}|${id}`,
					label: layer.label,
					color: layerColor(familyColors.get(group.family) ?? SERIES_COLORS[0], layer.key),
					values,
					pattern: group.regex ? "hatch" : undefined,
				});
			}
		}
		out.push({
			key: "trend",
			label: t("At assistant (total)"),
			color: "var(--ink-1)",
			values: rows.map(row => percent(row.atAssistant, row.messages)),
			kind: "line",
			// Repeats the two at-assistant bar layers; the tooltip already lists them.
			tooltip: false,
		});
		return out;
	}, [rows, familyColors]);

	if (rows.length === 0) {
		return (
			<div className="frustration-chart-empty">
				<EmptyState title={t("No model versions match the filters")} />
			</div>
		);
	}

	return (
		<Chart
			slots={rows.length}
			tickLabel={i => rows[i].label}
			series={series}
			height={340}
			format={v => `${v}%`}
			formatTooltip={v => `${v.toFixed(1)}%`}
			showTotal={false}
			emptyLabel={t("No frustrated messages for these models")}
			tooltipExtra={i => {
				const row = rows[i];
				return (
					<div className="frustration-tooltip-extra">
						<div className="chart-tooltip-row chart-tooltip-total">
							<span className="chart-tooltip-label">{t("Annoyed, any target")}</span>
							<span className="chart-tooltip-value">{rate(row.annoyed, row.messages)}</span>
						</div>
						<div className="micro dim">{t("{0} messages · judged {1} ({2}){3}", `${formatInteger(row.messages)}`, `${formatInteger(row.judged)}`, `${rate(row.judged, row.messages)}`, `${isMostlyRegex(row) ? " · mostly regex fallback" : ""}`)}</div>
					</div>
				);
			}}
		/>
	);
}

function FrustrationTable({
	rows,
	familyColors,
	stale,
}: {
	rows: FrustrationModelStats[];
	familyColors: Map<string, string>;
	stale: boolean;
}) {
	const columns = useMemo(
		(): Column<FrustrationModelStats>[] => [
			{
				key: "model",
				header: t("Model"),
				sort: row => row.label,
				render: row => (
					<span className="row" title={row.key}>
						<span
							className="swatch"
							style={{ background: familyColors.get(familyKey(row)) ?? SERIES_COLORS[0] }}
						/>
						<span className="cell-primary">{row.label}</span>
					</span>
				),
			},
			{
				key: "ids",
				header: t("Model IDs"),
				wrap: true,
				render: row => <span className="mono micro dim">{row.models.join(", ")}</span>,
			},
			{
				key: "messages",
				header: t("Messages"),
				align: "right",
				sort: row => row.messages,
				render: row => <span className="num">{formatInteger(row.messages)}</span>,
			},
			{
				key: "judged",
				header: t("Judged"),
				align: "right",
				sort: row => (row.messages > 0 ? row.judged / row.messages : 0),
				render: row =>
					isMostlyRegex(row) ? (
						<span
							className="row frustration-judged"
							title={t("Mostly regex fallback: run the judge for accurate rates")}
						>
							<Badge tone="warn">{t("regex")}</Badge>
							<span className="num dim">{rate(row.judged, row.messages)}</span>
						</span>
					) : (
						<span className="num">{rate(row.judged, row.messages)}</span>
					),
			},
			{
				key: "annoyed",
				header: t("Annoyed"),
				align: "right",
				sort: row => percent(row.annoyed, row.messages),
				render: row => (
					<span className="num" title={t("{0} messages", `${formatInteger(row.annoyed)}`)}>
						{rate(row.annoyed, row.messages)}
					</span>
				),
			},
			{
				key: "atAssistant",
				header: t("At assistant"),
				align: "right",
				sort: row => percent(row.atAssistant, row.messages),
				render: row => (
					<span className="num" title={t("{0} messages", `${formatInteger(row.atAssistant)}`)}>
						{rate(row.atAssistant, row.messages)}
					</span>
				),
			},
			{
				key: "angry",
				header: t("Angry"),
				align: "right",
				sort: row => percent(row.angry, row.messages),
				render: row => (
					<span className={row.angry > 0 ? "num tone-bad" : "num"} title={t("{0} messages", `${formatInteger(row.angry)}`)}>
						{rate(row.angry, row.messages)}
					</span>
				),
			},
		],
		[familyColors],
	);

	return (
		<Card
			index={3}
			title={t("Model versions")}
			description={t("Rates are shares of user messages; rows follow the chart filters.")}
			flush
			stale={stale}
		>
			<Table
				rows={rows}
				rowKey={row => row.key}
				columns={columns}
				dense
				empty={<EmptyState title={t("No model versions match the filters")} />}
			/>
		</Card>
	);
}
