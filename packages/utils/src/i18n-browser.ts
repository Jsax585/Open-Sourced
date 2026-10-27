import { createTranslator, type Messages } from "./i18n-core";
import korean from "./locales/ko.json" with { type: "json" };

interface BrowserLanguagePack {
	language: "ko" | "en";
	messages?: Messages;
}

const host = globalThis as typeof globalThis & { __OMP_I18N__?: BrowserLanguagePack };
// pi-utils also compiles in Node hosts whose ambient document type is deliberately minimal.
const browserHost = globalThis as unknown as {
	document?: {
		getElementById(id: string): { textContent: string | null } | null;
		documentElement: { lang: string };
	};
};
const browserDocument = browserHost.document;
const data = browserDocument?.getElementById("omp-i18n");
const selected: BrowserLanguagePack = data?.textContent
	? JSON.parse(data.textContent)
	: (host.__OMP_I18N__ ?? { language: "ko" });
if (selected.language !== "en" && selected.language !== "ko") {
	throw new Error("Browser language pack must select en or ko.");
}
if (browserDocument) browserDocument.documentElement.lang = selected.language;

/** The host selects the language before the application imports its UI modules. */
export function getLanguage(): "ko" | "en" {
	return selected.language;
}

export const t = createTranslator(selected.language === "en" ? {} : (selected.messages ?? korean));
