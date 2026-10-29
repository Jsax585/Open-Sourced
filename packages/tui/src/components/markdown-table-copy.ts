import { decodeEntities } from "@oh-my-pi/pi-utils/dom/parser";
import type { Token, Tokens } from "@oh-my-pi/pi-utils/marked";

export type TableCopyFormat = "tsv" | "csv" | "markdown";

function inlineText(tokens: Token[]): string {
	let text = "";
	for (const token of tokens) {
		switch (token.type) {
			case "codespan":
			case "escape":
				text += token.text;
				break;
			case "br":
				text += "\n";
				break;
			case "html":
				if (/^<br\b[^>]*>$/i.test(token.raw)) text += "\n";
				break;
			default:
				if ("tokens" in token && token.tokens?.length) text += inlineText(token.tokens);
				else if ("text" in token && typeof token.text === "string") text += decodeEntities(token.text);
		}
	}
	return text;
}

/**
 * Serialize only this parsed table; clipboard writes belong to the host's copy action.
 *
 * `markdown` returns the table as the parser produced it, so CRLF is normalized to
 * LF and tabs are expanded: Marked rewrites the source before tokenizing, and the
 * table tokens carry no offsets back into it. TSV/CSV build from cell text.
 */
export function formatTableForClipboard(table: Tokens.Table, format: TableCopyFormat): string {
	if (format === "markdown") return table.raw.replace(/[\r\n]+$/, "");
	const delimiter = format === "csv" ? "," : "\t";
	const field = (cell: Tokens.TableCell): string => {
		const value = inlineText(cell.tokens);
		return value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
	};
	return [table.header, ...table.rows].map(row => row.map(field).join(delimiter)).join("\n");
}
