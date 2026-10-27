import { t } from "@oh-my-pi/pi-utils/i18n";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import type { SessionPersistenceNotice } from "../session/session-manager";

/**
 * First-failure notice. The store keeps the unlanded entries in memory and
 * retries the whole transcript on the next write, so this reports a retryable
 * condition and claims nothing about durability — the write may still land.
 * `sanitizeText` leaves tabs and newlines intact, so both are normalized here
 * to keep the result on one line.
 */
export function formatPersistenceFailure(message: string): string {
	const detail = truncateToWidth(replaceTabs(sanitizeText(message)).replace(/[\r\n]+/g, " "), TRUNCATE_LENGTHS.LINE);
	return t("Session persistence failed: {0}. Writes are retried; unsaved entries stay in memory until the store accepts them again.", `${detail}`);
}

/**
 * Teardown-time durability claim, emitted only while the store failure is
 * still latched at dispose: the retry never landed, so the transcript is not
 * durable and the in-memory entries are gone with the process.
 */
export function formatPersistenceDurabilityFailure(message: string): string {
	const detail = truncateToWidth(replaceTabs(sanitizeText(message)).replace(/[\r\n]+/g, " "), TRUNCATE_LENGTHS.LINE);
	return t("Session persistence is still failing at shutdown: {0}. The session transcript is not durable; unsaved entries are lost.", `${detail}`);
}

/**
 * A {@link SessionPersistenceNotice}: saving continues, so this claims no
 * failure. Not truncated, because the notice names the session files the user
 * may need to find.
 */
export function formatPersistenceNotice(notice: SessionPersistenceNotice): string {
	const from = shortenPath(notice.from);
	const to = shortenPath(notice.to);
	let message: string;
	switch (notice.reason) {
		case "open-elsewhere":
			message = t("Session {0} is open for writing in another omp process, so this session now saves to {1} instead of mixing its entries into that file.", `${from}`, `${to}`);
			break;
		case "replaced":
			message = t("Session {0} changed on disk and no longer reads as this session; it is left untouched and this session now saves to {1}.", `${from}`, `${to}`);
			break;
		case "contested":
			message = t("Another program kept writing to session {0}; it is left to that writer and this session now saves to {1}.", `${from}`, `${to}`);
			break;
	}
	return replaceTabs(sanitizeText(message)).replace(/[\r\n]+/g, " ");
}
