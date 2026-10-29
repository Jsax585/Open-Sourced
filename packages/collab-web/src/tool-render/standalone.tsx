/**
 * Entry point for the self-contained tool-view bundle embedded in HTML
 * session exports (built by scripts/build-tool-views.ts; React included).
 * Importing registers `<omp-tool-view>`.
 */
import { initializeI18n } from "@oh-my-pi/pi-utils/i18n-browser";

// Exported HTML supplies its pack before the translated renderer modules load.
void initializeI18n().then(async () => {
	const { defineToolViewElement } = await import("./element");
	defineToolViewElement();
});
