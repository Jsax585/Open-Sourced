import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("browser asset language packs", () => {
	it("localizes explicit markers safely while leaving browser expressions and user text intact", () => {
		const directory = mkdtempSync(join(tmpdir(), "omp-browser-language-"));
		const hostile = '</script><script>alert("pack")</script>\u2028';
		try {
			writeFileSync(join(directory, "ko.json"), JSON.stringify({
				"Label\u0004browser-assets": hostile,
				"Count: {0}\u0004browser-assets": "개수: {0}",
			}));
			const modulePath = new URL("../src/browser-i18n.ts", import.meta.url).href;
			const html = '<html lang="en"><title data-omp-i18n>Label</title><input title="Label" data-omp-i18n-attrs="title"><p>Label</p><span data-omp-i18n>Missing</span></html>';
			const scriptSource = 'const label = ompT("Label"); const count = ompT("Count: {0}", window.count); const user = "Label";';
			const script = `import {browserLanguagePackScript, localizeBrowserHtml, localizeBrowserScript, localizeBrowserManifest} from ${JSON.stringify(modulePath)};
console.log(JSON.stringify({pack: browserLanguagePackScript(), html: localizeBrowserHtml(${JSON.stringify(html)}), script: localizeBrowserScript(${JSON.stringify(scriptSource)}), manifest: JSON.parse(localizeBrowserManifest(${JSON.stringify(JSON.stringify({description: "Label", action: {default_title: "Missing"}}))}))}));`;
			const run = (language: string) => {
				const child = Bun.spawnSync([process.execPath, "-e", script], {
					env: { ...process.env, OMP_LANG: language, OMP_LOCALE_DIR: directory },
				});
				expect(child.exitCode, child.stderr.toString()).toBe(0);
				return JSON.parse(child.stdout.toString());
			};
			const korean = run("ko");
			expect(korean.html).toContain('<html lang="ko">');
			expect(korean.html).toContain("&lt;/script&gt;&lt;script&gt;alert(&quot;pack&quot;)&lt;/script&gt;");
			expect(korean.pack.match(/<\/script>/g)).toHaveLength(1);
			expect(korean.pack).toContain('"language":"ko"');
			expect(korean.pack).toContain("\\u003c/script>");
			expect(korean.html).toContain('<p>Label</p><span>Missing</span>');
			expect(korean.html).not.toContain("data-omp-i18n");
			expect(korean.script).not.toContain("</script>");
			expect(korean.script).toContain("\\u003c/script>");
			expect(korean.script).toContain('ompT("개수: {0}", window.count)');
			expect(korean.script).toContain('const user = "Label"');
			expect(korean.manifest).toEqual({description: hostile, action: {default_title: "Missing"}});
			const english = run("en");
			expect(english.html).toContain('<html lang="en"><title>Label</title>');
			expect(english.script).toBe(scriptSource);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
