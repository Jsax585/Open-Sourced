/**
 * Fork TypeScript hashline engine, run ALONE (no second native addon in the
 * process, so no double-load segfault). Emits JSON for offline comparison
 * against the Rust engine's output from `cargo test`.
 */
import {
	applyHashlineEdits,
	parseHashline,
	splitHashlineInput,
} from "/Users/tfrench/Work/speedy/repos/oh-my-pi/packages/coding-agent/src/edit/modes/hashline.ts";

const BASE = [
	'const DEF = "guest";',
	"",
	"export function label(name) {",
	"\tconst clean = name || DEF;",
	"\treturn clean.trim();",
	"}",
].join("\n");

const SHIFTED = 'import path from "node:path";\n\n' + BASE;

const cases = [
	{ name: "baseline replace", text: BASE, patch: "@work.ts\n= 5xx\n~\treturn clean.trim().toUpperCase();\n" },
	{ name: "stale anchor after shift", text: SHIFTED, patch: "@work.ts\n= 5xx\n~\treturn clean.trim().toUpperCase();\n" },
	{ name: "insert after line", text: BASE, patch: "@work.ts\n+ 4wg\n~\tif (clean.length === 0) return DEF;\n" },
	{ name: "delete single line", text: BASE, patch: "@work.ts\n- 2nd\n" },
];

for (const c of cases) {
	try {
		const { diff } = splitHashlineInput(c.patch);
		const edits = parseHashline(diff);
		const result = applyHashlineEdits(c.text, edits, {});
		console.log(JSON.stringify({ name: c.name, ok: true, text: result.lines, warnings: result.warnings ?? [] }));
	} catch (err) {
		console.log(JSON.stringify({ name: c.name, ok: false, error: err instanceof Error ? err.message.split("\n")[0] : String(err) }));
	}
}