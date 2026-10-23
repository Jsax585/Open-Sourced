import { sanitizeNamePart } from "../mcp/name-sanitize";
import {
	expandDisallowedTools,
	HIDDEN_TOOL_NAMES,
	type HiddenToolName,
	isWholeServerPattern,
	mcpWildcardServerSegment,
	normalizeToolNames,
} from "./builtin-names";
import { compileNamePatterns, hasGlobChars, type NamePatternSet } from "./name-patterns";

/**
 * Declaration inputs for constructing a {@link ToolScope}.
 */
export interface ToolScopeDeclaration {
	/** Declared `tools:` allowlist after sibling/exec auto-includes. Undefined = inherit everything; `[]` = protocol-only. */
	readonly allowedToolNames?: readonly string[];
	/** Declared `disallowedTools:` patterns (glob or exact). */
	readonly disallowedTools?: readonly string[];
	/** Resolves a declared entry in the Claude `mcp__<server>__<tool>` spelling to its live registry key. */
	readonly resolveAlias?: (entry: string) => string | undefined;
}

interface ServerEntry {
	readonly pattern: string;
	readonly segment: string;
	readonly segmentGlob: Bun.Glob;
	readonly matcher: NamePatternSet;
}

/** Server segment of a Claude-spelled `mcp__<server>__<tool>` entry. */
function claudeSpellingServerSegment(entry: string): string | undefined {
	if (!entry.startsWith("mcp__")) return undefined;
	const rest = entry.slice("mcp__".length);
	const separator = rest.indexOf("__");
	return separator > 0 ? rest.slice(0, separator) : undefined;
}

function matchServerEntries(entries: readonly ServerEntry[], ownerSegment: string, name: string): boolean {
	for (const entry of entries) {
		const isWholeServer = isWholeServerPattern(entry.pattern, entry.segment) && entry.segmentGlob.match(ownerSegment);
		if (isWholeServer) {
			return true;
		}
		const isOwnerConsistent =
			entry.segmentGlob.match(ownerSegment) ||
			(!hasGlobChars(entry.segment) && entry.segment.startsWith(`${ownerSegment}_`));
		if (isOwnerConsistent && entry.matcher.matches(name)) {
			return true;
		}
	}
	return false;
}

/**
 * Unified tool scoping and access control for agents.
 *
 * Scoping rules:
 * - Allowlist is a hard grant: When `tools:` is declared (even if empty `[]`),
 *   only tools explicitly matched by the allowlist are available. Hidden protocol
 *   tools (`yield`, `goal`, `think`) are auto-granted and can never be scoped out:
 *   subagent terminators and reasoning protocols must remain functional across all
 *   configurations.
 * - Allow-side ownership: Wildcard allow patterns (`mcp__<server>_*`) match an
 *   MCP tool by its server ownership segment when known, even if the minted tool
 *   name was length-capped or hash-suffixed.
 * - Literal naming: `isNamedLiterally` distinguishes tools explicitly addressed by
 *   exact declared names from those granted via glob patterns (`*`, `mcp__*`),
 *   ensuring activation/mount/pinning decisions are not over-triggered.
 * - Deny wins over allow: A tool matching any `disallowedTools` pattern or owning
 *   MCP server deny is excluded even if explicitly named in the allowlist.
 * - Glob semantics: Matching uses `Bun.Glob` with exact equality checked first
 *   (so literal patterns with glob metacharacters stay addressable), leading `!`
 *   escaped (negation is disabled), bare `*` or `**` acting as a blanket match across
 *   all tool names, and brace alternatives expanded before classification.
 * - Server ownership and owner consistency: Wildcard patterns with server segments
 *   (`mcp__<segment>_*`) are classified as server entries and decide by owner metadata.
 *   A bare `mcp__<server>_*` pattern matches the whole server, while a longer prefix
 *   segment is owner-consistent only when it equals the owner or extends it with `_`
 *   (`segment === owner || segment.startsWith(`${owner}_`)`). Non-consistent entries
 *   are skipped, preventing `mcp__foo_*` from stripping tools from server `foo_bar`.
 *   Whole-server denial requires the bare `mcp__<server>_*` form.
 * - Alias resolution: Minted MCP tool names (`mcp__<server>_<tool>`) are lossy
 *   and case-folded (lowercased, hyphens converted to underscores, non-alphanumeric
 *   characters collapsed). Declared entries in Claude Code spelling (`mcp__<server>__<tool>`)
 *   or with original casing resolve via `resolveAlias` to their live registry keys,
 *   guarded to resolve only literal entries without glob syntax.
 */
export class ToolScope {
	#allow: NamePatternSet | undefined;
	#allowPlain: NamePatternSet;
	#allowServerEntries: readonly ServerEntry[];
	#deny: NamePatternSet;
	#denyPlain: NamePatternSet;
	#denyServerEntries: readonly ServerEntry[];
	#resolveAlias: ((entry: string) => string | undefined) | undefined;

	constructor(declaration: ToolScopeDeclaration) {
		const normalizedAllows =
			declaration.allowedToolNames !== undefined ? normalizeToolNames(declaration.allowedToolNames) : undefined;
		this.#allow = normalizedAllows !== undefined ? compileNamePatterns(normalizedAllows) : undefined;

		const plainAllows: string[] = [];
		const allowServerEntries: ServerEntry[] = [];
		if (this.#allow !== undefined) {
			for (const entry of this.#allow.entries) {
				const segment = mcpWildcardServerSegment(entry);
				if (segment !== undefined && segment.length > 0) {
					allowServerEntries.push({
						pattern: entry,
						segment,
						segmentGlob: new Bun.Glob(segment.startsWith("!") ? `\\${segment}` : segment),
						matcher: compileNamePatterns([entry]),
					});
				} else {
					plainAllows.push(entry);
				}
			}
		}
		this.#allowPlain = compileNamePatterns(plainAllows);
		this.#allowServerEntries = allowServerEntries;

		const expandedDenies = normalizeToolNames(expandDisallowedTools(declaration.disallowedTools ?? []));
		this.#deny = compileNamePatterns(expandedDenies);

		const plainDenies: string[] = [];
		const denyServerEntries: ServerEntry[] = [];

		for (const entry of this.#deny.entries) {
			const segment = mcpWildcardServerSegment(entry);
			if (segment !== undefined && segment.length > 0) {
				denyServerEntries.push({
					pattern: entry,
					segment,
					segmentGlob: new Bun.Glob(segment.startsWith("!") ? `\\${segment}` : segment),
					matcher: compileNamePatterns([entry]),
				});
			} else {
				plainDenies.push(entry);
			}
		}

		this.#denyPlain = compileNamePatterns(plainDenies);
		this.#denyServerEntries = denyServerEntries;
		this.#resolveAlias = declaration.resolveAlias;
	}

	/** Set once the live registry exists; returns this. */
	setAliasResolver(resolveAlias: ((entry: string) => string | undefined) | undefined): this {
		this.#resolveAlias = resolveAlias;
		return this;
	}

	/** Whether a `tools:` allowlist is enforced (declared, even when empty). */
	get enforced(): boolean {
		return this.#allow !== undefined;
	}

	/** Whether anything is restricted at all: an enforced allowlist or at least one deny entry. */
	get restricted(): boolean {
		return this.enforced || this.#deny.entries.length > 0;
	}

	/** Whether every tool is denied (bare `*` or `**`; used to suppress non-tool-directed prompt blocks). */
	get deniesAllTools(): boolean {
		return this.#deny.blanket;
	}

	/**
	 * Whether a declared allowlist explicitly names this tool without glob syntax.
	 *
	 * Globs grant tools in {@link isExplicitlyAllowed} but never mark them as
	 * explicitly named here, so activation, mount, and pinning decisions built
	 * on "named" keep prior behavior. Unrestricted scopes return false.
	 */
	isNamedLiterally(name: string): boolean {
		if (this.#allow === undefined) return false;
		const resolve = this.#resolveAlias;
		for (const entry of this.#allow.declared) {
			if (!hasGlobChars(entry)) {
				if (entry === name) return true;
				if (resolve !== undefined && resolve(entry) === name) return true;
			}
		}
		return false;
	}

	/** Whether a declared allowlist names this tool (no hidden-tool exemption, no allow-all default). */
	isExplicitlyAllowed(name: string, mcpServerName?: string): boolean {
		if (this.#allow === undefined) return false;
		if (mcpServerName !== undefined) {
			const ownerSegment = sanitizeNamePart(mcpServerName, "server");
			if (matchServerEntries(this.#allowServerEntries, ownerSegment, name)) {
				return true;
			}
			if (this.#allowPlain.matches(name)) {
				return true;
			}
		} else if (this.#allow.matches(name)) {
			return true;
		}
		const resolve = this.#resolveAlias;
		if (resolve !== undefined) {
			// An alias resolves by minted name alone, but minted names are lossy:
			// `mcp__foo__bar_query` also resolves to `mcp__foo_bar_query` when that
			// key belongs to server `foo_bar`. The declared server must match the
			// tool's owning server before an alias grant applies.
			const ownerSegment = mcpServerName !== undefined ? sanitizeNamePart(mcpServerName, "server") : undefined;
			return this.#allow.entries.some(entry => {
				if (hasGlobChars(entry) || resolve(entry) !== name) return false;
				const declaredServer = claudeSpellingServerSegment(entry);
				return (
					declaredServer === undefined ||
					ownerSegment === undefined ||
					sanitizeNamePart(declaredServer, "server") === ownerSegment
				);
			});
		}
		return false;
	}

	/** Whether the declaration denies this tool by name or by its owning MCP server. */
	isDenied(name: string, mcpServerName?: string): boolean {
		if (HIDDEN_TOOL_NAMES.includes(name as HiddenToolName)) return false;
		if (this.#deny.blanket) return true;
		if (mcpServerName !== undefined) {
			const ownerSegment = sanitizeNamePart(mcpServerName, "server");
			if (matchServerEntries(this.#denyServerEntries, ownerSegment, name)) {
				return true;
			}
			// Owner-scoped entries were decided above. Judging them again by name
			// would let `mcp__foo_*` strip server `foo_bar`'s tools, whose public
			// names share the `mcp__foo_` prefix.
			if (this.#denyPlain.matches(name)) return true;
		} else if (this.#deny.matches(name)) {
			// No owner metadata (a tool that never carried `mcpServerName`): fall
			// back to matching the public name, as a caller-less declaration must.
			return true;
		}
		const resolve = this.#resolveAlias;
		if (resolve !== undefined) {
			// Same lossy-mint guard as the allow side: a Claude-spelled deny must
			// name the tool's owning server, or a mint collision lets one
			// server's deny strip another server's tool.
			const ownerSegment = mcpServerName !== undefined ? sanitizeNamePart(mcpServerName, "server") : undefined;
			return this.#deny.entries.some(entry => {
				if (hasGlobChars(entry) || resolve(entry) !== name) return false;
				const declaredServer = claudeSpellingServerSegment(entry);
				return (
					declaredServer === undefined ||
					ownerSegment === undefined ||
					sanitizeNamePart(declaredServer, "server") === ownerSegment
				);
			});
		}
		return false;
	}

	/** Effective grant: not denied, and allowed (or a hidden protocol tool) under an enforced allowlist. */
	isScopedIn(name: string, mcpServerName?: string): boolean {
		return (
			!this.isDenied(name, mcpServerName) &&
			(!this.enforced ||
				this.isExplicitlyAllowed(name, mcpServerName) ||
				HIDDEN_TOOL_NAMES.includes(name as HiddenToolName))
		);
	}

	/** Whether a whole MCP server is denied by name (`*`, `mcp__*`, or `mcp__<server>_*`). */
	deniesServer(serverName: string): boolean {
		if (this.#deny.blanket) return true;
		if (this.#deny.entries.includes("mcp__*") || this.#deny.entries.includes("mcp__**")) return true;
		const ownerSegment = sanitizeNamePart(serverName, "server");
		for (const entry of this.#denyServerEntries) {
			if (isWholeServerPattern(entry.pattern, entry.segment) && entry.segmentGlob.match(ownerSegment)) {
				return true;
			}
		}
		return false;
	}
}
