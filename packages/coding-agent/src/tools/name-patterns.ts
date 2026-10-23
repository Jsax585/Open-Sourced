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
	/** Whether `name` matches an entry (exact-first, then `Bun.Glob`). */
	readonly matches: (name: string) => boolean;
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
			// Split the body on top-level commas only: a nested `a{b,{c,d}}e`
			// must expand through recursion (`abe`/`ace`/`ade`), not shred
			// into garbage literals (`a{ce`, `ad}e`) that silently mis-grant.
			const alternatives: string[] = [];
			let alternativeDepth = 0;
			let start = open + 1;
			for (let j = open + 1; j < i; j++) {
				if (pattern[j] === "{") alternativeDepth++;
				else if (pattern[j] === "}") alternativeDepth--;
				else if (pattern[j] === "," && alternativeDepth === 0) {
					alternatives.push(pattern.slice(start, j));
					start = j + 1;
				}
			}
			alternatives.push(pattern.slice(start, i));
			return alternatives.flatMap(alternative => expandBraceAlternatives(`${head}${alternative.trim()}${tail}`));
		}
	}
	return [pattern];
}

/** A bare star run (`*`, `**`, `***`, …) matches every name, whatever its spelling. */
export function isBlanketPattern(pattern: string): boolean {
	return /^\*+$/.test(pattern);
}

/** A bare `mcp__` star run (`mcp__*`, `mcp__**`, …) matches every MCP tool. */
export function isMcpBlanketPattern(pattern: string): boolean {
	return /^mcp__\*+$/.test(pattern);
}

/** Compile a declarative name list once; matching is sync and allocation-light. */
export function compileNamePatterns(patterns: Iterable<string>): NamePatternSet {
	const declared = Array.from(new Set(patterns));
	const entries = Array.from(new Set(declared.flatMap(expandBraceAlternatives)));
	const blanket = entries.some(isBlanketPattern);
	const compiled: { pattern: string; glob?: Bun.Glob }[] = [];
	for (const pattern of entries) {
		if (isBlanketPattern(pattern)) continue;
		compiled.push({
			pattern,
			glob: hasGlobChars(pattern) ? new Bun.Glob(pattern.startsWith("!") ? `\\${pattern}` : pattern) : undefined,
		});
	}
	return {
		entries,
		declared,
		blanket,
		matches(name) {
			if (blanket) return true;
			for (const { pattern, glob } of compiled) {
				if (pattern === name || glob?.match(name) === true) return true;
			}
			return false;
		},
	};
}
