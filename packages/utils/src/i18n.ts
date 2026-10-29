import { dirname, join } from "node:path";
import { createTranslator, type Messages } from "./i18n-core";

let language: "ko" | "en" = "en";
let messages: Messages = {};
export let t = createTranslator(messages);

/** Imports remain English and perform no language-pack I/O, including in SDKs and workers. */
export function getLanguage(): "ko" | "en" {
	return language;
}

/** The CLI initializes before loading UI modules; source runs never search beside Bun. */
export async function initializeI18n(): Promise<void> {
	language = "en";
	messages = {};
	t = createTranslator(messages);
	if (!/^ko(?:-kr)?$/i.test(process.env.OMP_LANG ?? "")) return;

	try {
		// Keep packs external so English binaries, SDKs, and workers do not bundle Korean.
		const directory =
			process.env.OMP_LOCALE_DIR ??
			(process.env.PI_COMPILED === "true"
				? join(dirname(process.execPath), "locales")
				: join(import.meta.dir, "locales"));
		const text = await Bun.file(join(directory, "ko.json")).text();
		const selected: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
		const next = createTranslator(selected);
		messages = selected as Messages;
		t = next;
		language = "ko";
	} catch {
		// Pack contents and exception details may contain user secrets.
		console.error("Could not load Korean language pack; using English.");
	}
}

/** Selected messages for browser bootstrap; missing keys retain English fallback. */
export function getMessages(): Messages {
	return messages;
}
