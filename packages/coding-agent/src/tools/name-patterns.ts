/**
 * A compiled set of tool-name patterns.
 *
 * One matcher for every declared name list in the harness — agent `tools:` /
 * `disallowedTools:` today, MCP per-server tool filters next — so a pattern
 * means the same thing everywhere. Semantics come from `Bun.Glob`, the matcher
 * the rule `agents` scope and skill include/ignore lists already use, plus
 * three deliberate rules:
 *
 * - exact equality is tested before any glob, so a literal name carrying glob
 *   metacharacters (`a{b`, `[a`) stays addressable — `Bun.Glob` never matches an
 *   unbalanced pattern;
 * - a leading `!` is escaped, because `Bun.Glob` treats it as negation (`!foo`
 *   would otherwise match everything but `foo`);
 * - a bare `*` or `**` is a blanket match. `Bun.Glob("*")` does not cross `/`, while
 *   tool names are opaque strings, so blanket-deny must not depend on it.
 */
export interface NamePatternSet {
	/** Entries as declared, in declaration order. */
	readonly entries: readonly string[];
	/** An entry is a bare `*` or `**`: every name matches, whatever its spelling. */
	readonly blanket: boolean;
	/** The set targets MCP tools (`*`, `**`, or an entry containing `mcp__`). */
	readonly targetsMcp: boolean;
	/**
	 * Whether `name` (or, when given, its `sanitize`d spelling) matches an entry.
	 * `sanitize` lets a caller match a raw identifier against the canonical one it
	 * was sanitized to (e.g. MCP advertised names against the filter domain).
	 */
	readonly matches: (name: string, sanitize?: (name: string) => string) => boolean;
	/**
	 * Entries as declared, before brace expansion. `entries` expands `a{b,c}` into
	 * `ab`/`ac`, which would otherwise make a brace alternative look like a
	 * literal name to `isNamedLiterally`.
	 */
	readonly declared: readonly string[];
}

/** Whether a pattern carries glob syntax; literal entries skip glob compilation. */
export function hasGlobChars(pattern: string): boolean {
	return /[*?[\]{}]/.test(pattern);
}

/** Expand one level of top-level brace alternatives: `a{b,c}d` → [`abd`, `acd`]. */
export function expandBraceAlternatives(pattern: string): string[] {
	const open = pattern.indexOf("{");
	if (open < 0) return [pattern];
	let depth = 0;
	for (let i = open; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) {
			const head = pattern.slice(0, open);
			const tail = pattern.slice(i + 1);
			return pattern
				.slice(open + 1, i)
				.split(",")
				.flatMap(alternative => expandBraceAlternatives(`${head}${alternative.trim()}${tail}`));
		}
	}
	return [pattern];
}

/** Compile a declarative name list once; matching is sync and allocation-light. */
export function compileNamePatterns(patterns: Iterable<string>): NamePatternSet {
	const declared = Array.from(new Set(patterns));
	const entries = Array.from(new Set(declared.flatMap(expandBraceAlternatives)));
	const blanket = entries.includes("*") || entries.includes("**");
	const compiled: { pattern: string; glob?: Bun.Glob }[] = [];
	for (const pattern of entries) {
		if (pattern === "*" || pattern === "**") continue;
		compiled.push({
			pattern,
			glob: hasGlobChars(pattern) ? new Bun.Glob(pattern.startsWith("!") ? `\\${pattern}` : pattern) : undefined,
		});
	}
	return {
		entries,
		declared,
		blanket,
		targetsMcp: blanket || entries.some(entry => entry.includes("mcp__")),
		matches(name, sanitize) {
			if (blanket) return true;
			const spellings = sanitize ? [name, sanitize(name)] : [name];
			for (const { pattern, glob } of compiled) {
				for (const spelling of spellings) {
					if (pattern === spelling || glob?.match(spelling) === true) return true;
				}
			}
			return false;
		},
	};
}
