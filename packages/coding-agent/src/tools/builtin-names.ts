import type { EvalBackendsAllowance } from "./eval-backends";
import { sanitizeNamePart } from "../mcp/name-sanitize";
import { classifyServerPatterns, compileNamePatterns, matchesServerPatterns } from "./name-patterns";

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
	if (!names.some(name => name.toLowerCase() === "exec"))
		return names.filter(name => !isToolDisallowed(name, patterns));
	const withoutAlias = names.filter(name => name.toLowerCase() !== "exec");
	// `exec` is an alias for eval+bash: a deny on the alias blocks the whole
	// expansion; an explicit deny on either child still wins downstream.
	if (isToolDisallowed("exec", patterns)) return withoutAlias.filter(name => !isToolDisallowed(name, patterns));
	const expanded = [...withoutAlias];
	if (backends.python || backends.js) expanded.push("eval");
	expanded.push("bash");
	return Array.from(new Set(expanded)).filter(name => !isToolDisallowed(name, patterns));
}

/** MCP tool names carry the `mcp__<server>_<tool>` prefix minted by `createMCPToolName`. */
export function isMCPToolName(name: string): boolean {
	return name.startsWith("mcp__");
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
export function isToolDisallowed(name: string, patterns: readonly string[], mcpServerName?: string): boolean {
	if (HIDDEN_TOOL_NAMES.includes(name as HiddenToolName)) return false;
	const compiledPatterns = compileNamePatterns(patterns);
	if (compiledPatterns.blanket) return true;
	if (mcpServerName === undefined) return compiledPatterns.matches(name);
	const { servers, plain } = classifyServerPatterns(compiledPatterns);
	const ownerSegment = sanitizeNamePart(mcpServerName, "server", { domain: "mint" });
	return matchesServerPatterns(servers, plain, ownerSegment, name);
}
