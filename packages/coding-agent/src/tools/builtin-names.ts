import type { EvalBackendsAllowance } from "./eval-backends";
import { sanitizeNamePart } from "../mcp/name-sanitize";
import { compileNamePatterns, hasGlobChars } from "./name-patterns";

export const BUILTIN_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"ast_grep",
	"ast_edit",
	"ask",
	"debug",
	"ida",
	"eval",
	"github",
	"glob",
	"grep",
	"find",
	"lsp",
	"checkpoint",
	"rewind",
	"context_notes",
	"new_context",
	"security_scan",
	"task",
	"wait",
	"todo",
	"web_search",
	"write",
	"memory_edit",
	"retain",
	"recall",
	"reflect",
	"learn",
	"manage_skill",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export const HIDDEN_TOOL_NAMES = ["yield", "goal", "think"] as const;

export type HiddenToolName = (typeof HIDDEN_TOOL_NAMES)[number];

const LEGACY_BUILTIN_TOOL_NAME_ALIASES: ReadonlyMap<string, BuiltinToolName> = new Map([["search", "grep"]]);

const CANONICAL_TOOL_NAMES: Record<string, true> = Object.fromEntries(
	[...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES].map(name => [name, true]),
);

/** Canonicalize built-in IDs, legacy aliases, and MCP minted names. Leave plugin names unchanged. */
export function normalizeToolName(name: string): string {
	const lower = name.toLowerCase();
	return (
		LEGACY_BUILTIN_TOOL_NAME_ALIASES.get(lower) ??
		(Object.hasOwn(CANONICAL_TOOL_NAMES, lower) || lower.startsWith("mcp__") ? lower : name)
	);
}

/** Normalize and deduplicate tool names while preserving first-seen order. */
export function normalizeToolNames(names: Iterable<string>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		const normalized = normalizeToolName(name);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}

	return out;
}

/**
 * Tools that are unusable without their sister, so any list naming one must
 * name the other. `createTools` auto-registers the pair from either name, but a
 * caller-supplied allowlist would otherwise drop the sister from the ACTIVE
 * set — leaving an agent able to checkpoint yet unable to rewind (or vice
 * versa). Shared by the SDK's session construction and the cold-revive clamp so
 * a replayed allowlist cannot lose the pairing the original run had.
 *
 * Registration is not consulted: every consumer filters against its own
 * registry afterwards (`setActiveToolsByName` ignores unknown names), and the
 * revive path has no registry to consult before the session rebuild.
 */
const SIBLING_TOOL_PAIRS: readonly (readonly [string, string])[] = [["checkpoint", "rewind"]] as const;

/**
 * Add each sibling pair's sister for every member already named. Returns a new
 * array (input order, then added sisters), or the input when no pair applies.
 */
export function withSiblingTools(names: readonly string[]): string[] {
	let out: string[] | undefined;
	for (const [a, b] of SIBLING_TOOL_PAIRS) {
		for (const [present, sister] of [
			[a, b],
			[b, a],
		] as const) {
			if (names.includes(present) && !names.includes(sister)) {
				out ??= [...names];
				out.push(sister);
			}
		}
	}
	return out ?? [...names];
}

/**
 * The reverse of {@link withSiblingTools}: if either member of a pair is
 * disallowed, both are — half a pair is unusable, so honouring a deny on just
 * one would leave a tool whose sibling call is guaranteed to fail. Returns the
 * filtered list.
 */
export function withoutSiblingTools(names: readonly string[], isDisallowed: (name: string) => boolean): string[] {
	return names.filter(name => {
		if (isDisallowed(name)) return false;
		for (const [a, b] of SIBLING_TOOL_PAIRS) {
			if (name === a || name === b) return !isDisallowed(name === a ? b : a);
		}
		return true;
	});
}

/**
 * Expand the `exec` tool alias into its concrete backends: `eval` (kept only
 * when at least one eval backend is allowed per `backends`) and `bash`. A deny
 * on the alias itself blocks the whole expansion; a deny on a child is applied
 * by the caller's later disallow filter (callers must expand before matching;
 * `isToolDisallowed` does not re-expand). Shared by the executor spawn path and
 * read-only classification so both see the same effective set.
 */
export function expandDisallowedTools(patterns: readonly string[]): string[] {
	// Case-insensitive alias: `Exec`/`EXEC` must expand like `exec`, or the
	// execution tier silently survives (normalizeToolName preserves the case
	// of non-canonical names, so the later exact checks would miss too).
	if (!patterns.some(pattern => pattern.toLowerCase() === "exec")) return [...patterns];
	const set = new Set(patterns);
	set.add("eval");
	set.add("bash");
	return Array.from(set);
}

export function expandExecToolAlias(
	names: readonly string[],
	patterns: readonly string[],
	backends: EvalBackendsAllowance,
): string[] {
	// Owner metadata is unavailable here, so never judge an MCP name against
	// `mcp__<server>_*` patterns by its lossy public prefix: server `foo_bar`
	// mints names starting `mcp__foo_`, and the owner-aware scope decides later.
	const denied = (name: string): boolean => !isMCPToolName(name) && isToolDisallowed(name, patterns);
	if (!names.some(name => name.toLowerCase() === "exec")) return names.filter(name => !denied(name));
	const withoutAlias = names.filter(name => name.toLowerCase() !== "exec");
	// `exec` is an alias for eval+bash: a deny on the alias blocks the whole
	// expansion; an explicit deny on either child still wins downstream.
	if (isToolDisallowed("exec", patterns)) return withoutAlias.filter(name => !denied(name));
	const expanded = [...withoutAlias];
	if (backends.python || backends.js) expanded.push("eval");
	expanded.push("bash");
	return Array.from(new Set(expanded)).filter(name => !denied(name));
}

/** MCP tool names carry the `mcp__<server>_<tool>` prefix minted by `createMCPToolName`. */
export function isMCPToolName(name: string): boolean {
	return name.startsWith("mcp__");
}

/**
 * Server segment of an `mcp__<server>_*` wildcard pattern (text after `mcp__`
 * up to the trailing `_` before the star run). Applies to trailing-star
 * entries only: one `*` or several (`**` behaves like `*` — tool names carry
 * no `/`, so there is nothing for recursive glob to cross). Without this, a
 * `mcp__foo_**` entry would fall through to plain prefix matching and strip
 * (or grant) server `foo_bar`'s tools, reintroducing the collision the
 * owner-consistency guard exists to prevent.
 * A tool-prefix wildcard like `mcp__foo_query*` matches by name prefix alone —
 * its last underscore is a tool-name separator, not the server/tool boundary,
 * and the fallback must not overmatch the server's whole tool set.
 * A pattern not starting with `mcp__` or not ending with `*` has no server segment.
 */
export function mcpWildcardServerSegment(pattern: string): string | undefined {
	const base = pattern.replace(/\*+$/, "");
	if (base === pattern || base.length === 0) return undefined;
	if (!base.startsWith("mcp__")) return undefined;
	if (!base.endsWith("_")) return undefined;
	const afterPrefix = base.slice("mcp__".length);
	const sep = afterPrefix.lastIndexOf("_");
	return sep < 0 ? undefined : afterPrefix.slice(0, sep);
}
/** Whether a server-entry pattern is the whole-server form (`mcp__<segment>_` plus a star run). */
export function isWholeServerPattern(pattern: string, segment: string): boolean {
	return new RegExp(`^mcp__${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_\\*+$`).test(pattern);
}

/**
 * Match a tool name against disallow patterns using glob semantics:
 * `Bun.Glob` matching, exact-first, leading `!` escaped, bare `*` = deny all.
 *
 * Hidden protocol tools (`yield`, `goal`, `think`) are never disallowable:
 * stripping the subagent terminator would leave a `requireYieldTool` session
 * unable to yield.
 *
 * When the caller knows the tool's raw `mcpServerName` (registry metadata),
 * pass it as `mcpServerName`: `mcp__<server>_*` ownership is matched against
 * the sanitized raw server name when the caller knows it, preventing prefix collisions
 * between servers like `foo` and `foo_bar`.
 */
export interface ToolDisallowOptions {
	mcpServerName?: string;
	/** @deprecated Ignored: reserved protocol names are rejected at registration, so a hidden-named tool is always built-in. */
	isBuiltIn?: boolean;
}

export function isToolDisallowed(
	name: string,
	patterns: readonly string[],
	options?: string | ToolDisallowOptions,
): boolean {
	const mcpServerName = typeof options === "string" ? options : options?.mcpServerName;
	if (HIDDEN_TOOL_NAMES.includes(name as HiddenToolName)) return false;
	const compiledPatterns = compileNamePatterns(patterns);
	if (compiledPatterns.blanket) return true;

	const serverEntries: {
		pattern: string;
		segment: string;
		segmentGlob: Bun.Glob;
		matcher: ReturnType<typeof compileNamePatterns>;
	}[] = [];
	const plainEntries: string[] = [];

	for (const entry of compiledPatterns.entries) {
		const segment = mcpWildcardServerSegment(entry);
		if (segment !== undefined && segment.length > 0) {
			serverEntries.push({
				pattern: entry,
				segment,
				segmentGlob: new Bun.Glob(segment.startsWith("!") ? `\\${segment}` : segment),
				matcher: compileNamePatterns([entry]),
			});
		} else {
			plainEntries.push(entry);
		}
	}

	if (mcpServerName !== undefined) {
		const ownerSegment = sanitizeNamePart(mcpServerName, "server");
		for (const entry of serverEntries) {
			const isWholeServer =
				isWholeServerPattern(entry.pattern, entry.segment) && entry.segmentGlob.match(ownerSegment);
			if (isWholeServer) return true;
			const isOwnerConsistent =
				entry.segmentGlob.match(ownerSegment) ||
				(!hasGlobChars(entry.segment) && entry.segment.startsWith(`${ownerSegment}_`));
			if (isOwnerConsistent && entry.matcher.matches(name)) return true;
		}
		return compileNamePatterns(plainEntries).matches(name);
	}
	return compiledPatterns.matches(name);
}
