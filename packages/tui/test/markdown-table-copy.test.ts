import { describe, expect, it } from "bun:test";
import { formatTableForClipboard } from "@oh-my-pi/pi-tui/components/markdown-table-copy";
import { Lexer, type Tokens } from "@oh-my-pi/pi-utils/marked";

function tableFrom(source: string): Tokens.Table {
	const table = Lexer.lex(source).find((token): token is Tokens.Table => token.type === "table");
	if (!table) throw new Error("Expected a parsed Markdown table");
	return table;
}

describe("Markdown table clipboard formats", () => {
	it("copies inline labels, Unicode and empty cells without Markdown syntax or link destinations", () => {
		const table = tableFrom(
			[
				"| **姓名** | *符号* | Empty |",
				"| --- | --- | --- |",
				"| [猫 &amp; 犬][pet] | `a\\|b` \\*literal\\* \\| &#x1f680; | |",
				"| ~~旧~~ ![图 &copy;](https://example.test/image) | `&amp;` \\&amp; | |",
				"",
				"[pet]: https://example.test/pet",
			].join("\n"),
		);

		expect(formatTableForClipboard(table, "tsv")).toBe(
			"姓名\t符号\tEmpty\n猫 & 犬\ta|b *literal* | 🚀\t\n旧 图 ©\t&amp; &amp;\t",
		);
	});

	it("quotes only delimiter, quote and line-break fields so spreadsheet consumers retain cell boundaries", () => {
		const table = tableFrom(
			[
				"| Name | Note | Tab | CRLF |",
				"| --- | --- | --- | --- |",
				"| Doe, Jane | He said &quot;hi&quot;<BR />next | a&#9;b | x&#13;&#10;y |",
			].join("\n"),
		);

		expect(formatTableForClipboard(table, "csv")).toBe(
			'Name,Note,Tab,CRLF\n"Doe, Jane","He said ""hi""\nnext",a\tb,"x\r\ny"',
		);
		expect(formatTableForClipboard(table, "tsv")).toBe(
			'Name\tNote\tTab\tCRLF\nDoe, Jane\t"He said ""hi""\nnext"\t"a\tb"\t"x\r\ny"',
		);
	});

	it("retains hard and soft line breaks supplied by parsed cell tokens inside one quoted field", () => {
		const table = tableFrom("| Lines |\n| --- |\n| initial |");
		const source = "one  \ntwo\nthree";
		table.rows[0]![0] = { ...table.rows[0]![0]!, text: source, tokens: Lexer.lexInline(source) };

		expect(formatTableForClipboard(table, "csv")).toBe('Lines\n"one\ntwo\nthree"');
		expect(formatTableForClipboard(table, "tsv")).toBe('Lines\n"one\ntwo\nthree"');
	});

	it("copies only the selected table's original Markdown, not neighboring prose or tables", () => {
		const source = "Left | Right\n:--- | ---:\n*x* | a\\|b";
		const table = tableFrom(`Before\n\n${source}\n\nAfter\n\n| Other |\n| --- |\n| table |\n`);

		expect(formatTableForClipboard(table, "markdown")).toBe(source);
	});

	it("returns Markdown as parsed, so CRLF and tabs from the source are normalized", () => {
		const table = tableFrom("| H |\r\n| --- |\r\n| a\tb |");

		// The parser rewrites the source before tokenizing; table tokens carry no
		// offsets back into it, so the normalized form is the documented contract.
		expect(formatTableForClipboard(table, "markdown")).toBe("| H |\n| --- |\n| a    b |");
	});

	it("keeps an empty last header cell without adding an empty body row or a trailing record separator", () => {
		const table = tableFrom("| A | |\n| --- | --- |\n");

		expect(formatTableForClipboard(table, "tsv")).toBe("A\t");
		expect(formatTableForClipboard(table, "csv")).toBe("A,");
	});
});
