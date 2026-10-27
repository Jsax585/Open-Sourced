import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranslator } from "../src/i18n-core";

describe("language packs", () => {
	it("falls back to English for missing messages and inherited object properties", () => {
		const translate = createTranslator({ Known: "알려진 문구" });
		expect(translate("Known")).toBe("알려진 문구");
		expect(translate("New feature: {0}", "ready")).toBe("New feature: ready");
		expect(translate("toString")).toBe("toString");
	});

	it("reorders placeholders without interpreting replacement values", () => {
		const translate = createTranslator({ "{0} then {1}": "{1} 다음 {0}" });
		expect(translate("{0} then {1}", "$&{1}", "")).toBe(" 다음 $&{1}");
	});

	it("rejects malformed catalogs and foreign placeholders", () => {
		for (const invalid of [null, [], 3, { Ready: false }, { Ready: "{1}" }]) {
			expect(() => createTranslator(invalid)).toThrow();
		}
	});

	it("preserves contextual meanings and permits omitting English plural suffixes", () => {
		const translate = createTranslator({
			"Compact\u0004view": "간결",
			"Compact\u0004context": "압축",
			"{0} item{1}": "{0}개 항목",
		});
		expect(translate("Compact\u0004view")).toBe("간결");
		expect(translate("Compact\u0004context")).toBe("압축");
		expect(translate("Compact\u0004unknown")).toBe("Compact");
		expect(translate("{0} item{1}", "2", "s")).toBe("2개 항목");
	});

	it("keeps language-specific arguments even when English omits their indexes", () => {
		const translate = createTranslator({ "{1} {2}": "{0} {1}개" });
		expect(translate("{1} {2}", "파일", "2", "files")).toBe("파일 2개");
		expect(createTranslator({})("{1} {2}", "파일", "2", "files")).toBe("2 files");
	});

	it("loads an external Korean pack and falls back to English for its missing keys", () => {
		const directory = mkdtempSync(join(tmpdir(), "omp-language-pack-"));
		try {
			writeFileSync(join(directory, "ko.json"), '\uFEFF{"Known":"외부 번역"}');
			const modulePath = new URL("../src/i18n.ts", import.meta.url).href;
			const script = `import {t} from ${JSON.stringify(modulePath)}; console.log(JSON.stringify([t("Known"), t("New {0}", "value")]));`;
			const run = (language: string) => Bun.spawnSync([process.execPath, "-e", script], {
				env: { ...process.env, OMP_LANG: language, OMP_LOCALE_DIR: directory },
			});
			const korean = run("ko-KR");
			expect(korean.exitCode).toBe(0);
			expect(JSON.parse(korean.stdout.toString())).toEqual(["외부 번역", "New value"]);
			const english = run("en-US");
			expect(english.exitCode).toBe(0);
			expect(JSON.parse(english.stdout.toString())).toEqual(["Known", "New value"]);
			writeFileSync(join(directory, "ko.json"), "{broken");
			expect(run("ko").exitCode).not.toBe(0);
			expect(run("en").exitCode).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
