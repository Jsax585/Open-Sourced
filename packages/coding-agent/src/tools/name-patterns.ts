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
	matches(name: string, sanitize?: (name: string) => string): boolean;
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
	const entries = Array.from(new Set(Array.from(patterns).flatMap(expandBraceAlternatives)));
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

/** A wildcard entry shaped as `mcp__<server>_*`, matched by owning server rather than by name. */
export interface ServerPatternEntry {
	readonly pattern: string;
	readonly segment: string;
	readonly segmentGlob: Bun.Glob;
	readonly matcher: NamePatternSet;
}

/**
 * Server segment of an `mcp__<server>_*` wildcard pattern (text after `mcp__`
 * up to the trailing `_` before the `*`). Applies to trailing-`*` entries only.
 * A pattern not starting with `mcp__` or not ending with the server/tool
 * boundary has no server segment.
 */
export function mcpWildcardServerSegment(pattern: string): string | undefined {
	if (!pattern.endsWith("*")) return undefined;
	const base = pattern.slice(0, -1);
	if (!base.startsWith("mcp__")) return undefined;
	// Only the bare `mcp__<server>_*` form (pattern ends with `_` before the
	// `*`) applies the ownership fallback. A tool-prefix wildcard like
	// `mcp__foo_query*` matches by name prefix alone — its last underscore is a
	// tool-name separator, not the server/tool boundary, and the fallback must
	// not overmatch the server's whole tool set.
	if (!base.endsWith("_")) return undefined;
	const afterPrefix = base.slice("mcp__".length);
	const sep = afterPrefix.lastIndexOf("_");
	return sep < 0 ? undefined : afterPrefix.slice(0, sep);
}

/** Split a compiled set into server-wildcard entries and the remaining name patterns. */
export function classifyServerPatterns(set: NamePatternSet): {
	servers: ServerPatternEntry[];
	plain: NamePatternSet;
} {
	const servers: ServerPatternEntry[] = [];
	const plain: string[] = [];
	for (const entry of set.entries) {
		const segment = mcpWildcardServerSegment(entry);
		if (segment !== undefined && segment.length > 0) {
			servers.push({
				pattern: entry,
				segment,
				segmentGlob: new Bun.Glob(segment.startsWith("!") ? `\\${segment}` : segment),
				matcher: compileNamePatterns([entry]),
			});
		} else {
			plain.push(entry);
		}
	}
	return { servers, plain: compileNamePatterns(plain) };
}

/**
 * Whether `name` matches a server-wildcard entry owned by `ownerSegment`, or any
 * plain name pattern. A bare `mcp__<server>_*` entry matches the whole server;
 * a longer prefix segment is owner-consistent only when it equals the owner or
 * extends it with `_`, so `mcp__foo_*` never strips tools from server `foo_bar`.
 */
export function matchesServerPatterns(
	servers: readonly ServerPatternEntry[],
	plain: NamePatternSet,
	ownerSegment: string,
	name: string,
): boolean {
	for (const entry of servers) {
		const isWholeServer = entry.pattern === `mcp__${entry.segment}_*` && entry.segmentGlob.match(ownerSegment);
		if (isWholeServer) return true;
		const isOwnerConsistent =
			entry.segmentGlob.match(ownerSegment) ||
			(!hasGlobChars(entry.segment) && entry.segment.startsWith(`${ownerSegment}_`));
		if (isOwnerConsistent && entry.matcher.matches(name)) return true;
	}
	return plain.matches(name);
}
