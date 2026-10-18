import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { renderHtmlToText } from "@oh-my-pi/pi-coding-agent/tools/fetch";

describe("renderHtmlToText: collapsed hidden panels", () => {
	it("keeps display:none expander content while dropping script and template text", async () => {
		const settings = Settings.isolated({ "providers.fetch": "native" });
		const paragraphs = Array.from(
			{ length: 4 },
			(_, i) => `<p>Paragraph ${i + 1} holds real article text that the reader must keep intact for the model.</p>`,
		).join("");
		const html = `<!doctype html><html><body><article>
<h1>Wireless headphones</h1>
${paragraphs}
<a href="javascript:void(0)" class="a-expander-header">Item details</a>
<div class="a-expander-content" style="display:none"><table>
<tr><th>Country of Origin</th><td>India</td></tr>
<tr><th>Seat Height</th><td>8.89 Centimetres</td></tr>
</table></div>
<template><p>TEMPLATE_SECRET</p></template>
<script>var SCRIPT_SECRET=1</script>
</article></body></html>`;

		const result = await renderHtmlToText("https://example.com/product", html, 5, settings, undefined, null);

		expect(result.ok).toBe(true);
		expect(result.method).toBe("native");
		expect(result.content).toContain("Country of Origin");
		expect(result.content).toContain("India");
		expect(result.content).toContain("8.89 Centimetres");
		expect(result.content).not.toContain("TEMPLATE_SECRET");
		expect(result.content).not.toContain("SCRIPT_SECRET");
	});
});
