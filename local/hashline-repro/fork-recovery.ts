/**
 * Exercise the fork's fuzzy stale-anchor recovery path directly
 * (`tryRecoverHashlineWithCache`), which the earlier harness never reached
 * because it needs a populated FileReadCache.
 *
 * Question under test: when an anchor goes stale, does the 3-way fuzzy merge
 * ever land a hunk in the WRONG place (silently), rather than rejecting?
 */
import { FileReadCache } from "/Users/tfrench/Work/speedy/repos/oh-my-pi/packages/coding-agent/src/edit/file-read-cache.ts";
import {
	parseHashline,
	splitHashlineInput,
	tryRecoverHashlineWithCache,
} from "/Users/tfrench/Work/speedy/repos/oh-my-pi/packages/coding-agent/src/edit/modes/hashline.ts";

const PATH = "/tmp/hl-harness/work/w.ts";

function run(name: string, snapshot: string, current: string, patch: string, expected?: string) {
	const cache = new FileReadCache();
	cache.recordContiguous(PATH, 1, snapshot.split("\n"));
	const { diff } = splitHashlineInput(patch);
	const edits = parseHashline(diff);
	const recovered = tryRecoverHashlineWithCache({
		cache,
		absolutePath: PATH,
		currentText: current,
		edits,
		options: {},
	});
	if (recovered === null) {
		console.log(`${name}\n  -> null (no recovery; caller rethrows mismatch)`);
		return;
	}
	const verdict = expected === undefined ? "" : recovered.lines === expected ? "  [CORRECT]" : "  [WRONG PLACE]";
	console.log(`${name}\n  -> recovered${verdict}`);
	console.log(`     ${JSON.stringify(recovered.lines)}`);
	if (expected !== undefined && recovered.lines !== expected) {
		console.log(`     expected: ${JSON.stringify(expected)}`);
	}
}

const BASE = [
	'const DEF = "guest";',
	"",
	"export function label(name) {",
	"\tconst clean = name || DEF;",
	"\treturn clean.trim();",
	"}",
].join("\n");

// 1. Content shifted down by 2 (import prepended).
const SHIFTED = 'import path from "node:path";\n\n' + BASE;
run(
	"shift by 2 (prepended import)",
	BASE,
	SHIFTED,
	"@w.ts\n= 5xx\n~\treturn clean.trim().toUpperCase();\n",
	SHIFTED.replace("\treturn clean.trim();", "\treturn clean.trim().toUpperCase();"),
);

// 2. A DUPLICATE of the target line exists earlier. Fuzzy matching has two
//    equally plausible landing sites; only the later one is correct.
const DUPED = [
	'const DEF = "guest";',
	"",
	"export function other(name) {",
	"\tconst clean = name || DEF;",
	"\treturn clean.trim();",
	"}",
	"",
	"export function label(name) {",
	"\tconst clean = name || DEF;",
	"\treturn clean.trim();",
	"}",
].join("\n");
run(
	"duplicate target line earlier in file",
	BASE,
	DUPED,
	"@w.ts\n= 5xx\n~\treturn clean.trim().toUpperCase();\n",
	DUPED.split("\n").map((l, i) => (i === 9 ? "\treturn clean.trim().toUpperCase();" : l)).join("\n"),
);

// 3. The anchored line itself was REPLACED on disk with different content.
const REWRITTEN = BASE.replace("\treturn clean.trim();", "\treturn clean.normalize();");
run(
	"anchored line rewritten on disk",
	BASE,
	REWRITTEN,
	"@w.ts\n= 5xx\n~\treturn clean.trim().toUpperCase();\n",
);