import { t } from "@oh-my-pi/pi-utils/i18n-browser";
import { RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { formatInteger } from "../data/formatters";
import { useLiveStatus } from "../data/live";
import { Dot } from "../ui";

/** Topbar ingest status; click to sync now. */
export function LiveChip() {
	const { sync, indexingHours, connected, requestSync } = useLiveStatus();
	const now = useNow(sync.phase === "idle" ? 15_000 : null);

	let body: ReactNode;
	let title: string;
	if (!connected) {
		body = (
			<>
				<Dot tone="warn" />
				<span>{t("Reconnecting")}</span>
			</>
		);
		title = t("Lost the live connection to the stats server; retrying");
	} else if (sync.phase === "syncing") {
		body = (
			<>
				<RefreshCw size={13} className="spin" />
				<span>{t("Syncing")}</span>
				{sync.total > 0 && (
					<span className="live-chip-count">
						{formatInteger(sync.current)}/{formatInteger(sync.total)}
					</span>
				)}
			</>
		);
		title = t("Ingesting session files");
	} else if (sync.phase === "error") {
		body = (
			<>
				<Dot tone="bad" />
				<span>{t("Sync failed")}</span>
			</>
		);
		title = t("{0} — click to retry", `${sync.error ?? t("Sync failed")}`);
	} else if (indexingHours > INDEXING_VISIBLE_HOURS) {
		body = (
			<>
				<RefreshCw size={13} className="spin" />
				<span>{t("Indexing")}</span>
				<span className="live-chip-count">{t("{0}h left", `${formatInteger(indexingHours)}`)}</span>
			</>
		);
		title = t("Building hourly rollups; older ranges fill in as it goes");
	} else {
		body = (
			<>
				<Dot tone="live" pulse />
				<span>{t("Live")}</span>
				{sync.lastSyncedAt !== null && <span className="live-chip-count">{ago(now - sync.lastSyncedAt)}</span>}
			</>
		);
		title = t("Click to sync session files now");
	}

	return (
		<button
			type="button"
			className="live-chip"
			onClick={requestSync}
			disabled={sync.phase === "syncing"}
			title={title}
		>
			{body}
		</button>
	);
}

/** A handful of dirty hours is normal live churn; only a real backlog is worth showing. */
const INDEXING_VISIBLE_HOURS = 24;

function useNow(intervalMs: number | null): number {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (intervalMs === null) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return now;
}

function ago(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 45) return t("just now");
	const m = Math.round(s / 60);
	if (m < 60) return t("{0}m ago", `${m}`);
	const h = Math.round(m / 60);
	return h < 24 ? t("{0}h ago", `${h}`) : t("{0}d ago", `${Math.round(h / 24)}`);
}
