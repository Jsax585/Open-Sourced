import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createTranslator, type Messages } from "./i18n-core";
import korean from "./locales/ko.json" with { type: "json" };


/** Unknown languages use English until a matching language pack is supported. */
export function getLanguage(): "ko" | "en" {
	return (process.env.OMP_LANG ?? "ko").toLowerCase().split(/[-_.]/, 1)[0] === "ko" ? "ko" : "en";
}


function loadMessages(): unknown {
	if (getLanguage() !== "ko") return {};
	const directory = process.env.OMP_LOCALE_DIR ?? join(dirname(process.execPath), "locales");
	const file = join(directory, "ko.json");
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return korean;
		throw new Error(`Cannot read language pack ${file}`, { cause: error });
	}
	try {
		return JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch (error) {
		throw new Error(`Invalid JSON in language pack ${file}`, { cause: error });
	}
}

const messages = loadMessages();

/** Selected messages for browser bootstrap; missing keys retain English fallback. */
export function getMessages(): Messages {
	return messages as Messages;
}

/** OMP_LANG=ko (default) or en; OMP_LOCALE_DIR selects an editable external pack. */
export const t = createTranslator(messages);
