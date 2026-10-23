import { describe, expect, test } from "bun:test";
import { sanitizeNamePart } from "@oh-my-pi/pi-coding-agent/mcp/name-sanitize";
import { createMCPToolName } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import {
	expandDisallowedTools,
	expandExecToolAlias,
	isToolDisallowed,
	mcpWildcardServerSegment,
} from "@oh-my-pi/pi-coding-agent/tools/builtin-names";

// A raw config server name whose minted tool name exceeds the 64-char cap:
// `createMCPToolName` truncates the whole name and appends a hash suffix, so
// the `mcp__<server>_` prefix is no longer present in the registry key.
const LONG_SERVER_NAME = "very long server name that gets truncated at the 64 character cap boundary for testing";
const LONG_SERVER_PATTERN = `mcp__${sanitizeNamePart(LONG_SERVER_NAME, "server")}_*`;
const CAPPED_MINTED_NAME = createMCPToolName(LONG_SERVER_NAME, "query_special_tool_name");

describe("isToolDisallowed", () => {
	test("matches all MCP tools with mcp__*", () => {
		expect(isToolDisallowed("mcp__foo_bar", ["mcp__*"])).toBe(true);
		expect(isToolDisallowed("mcp__baz_qux", ["mcp__*"])).toBe(true);
	});

	test("matches one server with mcp__<server>_*", () => {
		expect(isToolDisallowed("mcp__foo_bar", ["mcp__foo_*"])).toBe(true);
		expect(isToolDisallowed("mcp__baz_qux", ["mcp__foo_*"])).toBe(false);
	});

	test("matches exact names without wildcard", () => {
		expect(isToolDisallowed("bash", ["bash"])).toBe(true);
		expect(isToolDisallowed("mcp__foo_bar", ["mcp__foo_bar"])).toBe(true);
		expect(isToolDisallowed("mcp__foo_bar", ["mcp__foo"])).toBe(false);
	});

	test("does not match non-wildcard prefix against longer names", () => {
		expect(isToolDisallowed("mcp__foo_bar", ["mcp__foo"])).toBe(false);
	});

	test("returns false for empty patterns", () => {
		expect(isToolDisallowed("bash", [])).toBe(false);
	});

	test("matches when any pattern matches", () => {
		expect(isToolDisallowed("mcp__foo_bar", ["bash", "mcp__foo_*"])).toBe(true);
		expect(isToolDisallowed("bash", ["mcp__*", "bash"])).toBe(true);
	});

	test("never disallows hidden protocol tools", () => {
		expect(isToolDisallowed("yield", ["yield"])).toBe(false);
		expect(isToolDisallowed("yield", ["*"])).toBe(false);
		expect(isToolDisallowed("goal", ["goal"])).toBe(false);
		expect(isToolDisallowed("think", ["think"])).toBe(false);
	});

	test("matches exec as an exact name without implicit eval/bash alias mapping", () => {
		expect(isToolDisallowed("exec", ["exec"])).toBe(true);
		expect(isToolDisallowed("eval", ["exec"])).toBe(false);
		expect(isToolDisallowed("bash", ["exec"])).toBe(false);
	});

	test("hidden protocol tools remain exempt even when isBuiltIn is false", () => {
		expect(isToolDisallowed("yield", ["*"], { isBuiltIn: false })).toBe(false);
		expect(isToolDisallowed("yield", ["yield"], { isBuiltIn: false })).toBe(false);
		expect(isToolDisallowed("goal", ["*"], { isBuiltIn: false })).toBe(false);
		expect(isToolDisallowed("think", ["*"], { isBuiltIn: false })).toBe(false);
		expect(isToolDisallowed("yield", ["*"], { isBuiltIn: true })).toBe(false);
	});

	test("matches glob patterns with single-char wildcard ? and brace expansion {a,b}", () => {
		expect(isToolDisallowed("mcp__db_1", ["mcp__db_?"])).toBe(true);
		expect(isToolDisallowed("mcp__db_a", ["mcp__db_?"])).toBe(true);
		expect(isToolDisallowed("mcp__db_10", ["mcp__db_?"])).toBe(false);

		expect(isToolDisallowed("read", ["{read,grep}"])).toBe(true);
		expect(isToolDisallowed("grep", ["{read,grep}"])).toBe(true);
		expect(isToolDisallowed("bash", ["{read,grep}"])).toBe(false);

		expect(isToolDisallowed("mcp__api_get", ["mcp__{api,web}_*"])).toBe(true);
		expect(isToolDisallowed("mcp__web_post", ["mcp__{api,web}_*"])).toBe(true);
		expect(isToolDisallowed("mcp__db_query", ["mcp__{api,web}_*"])).toBe(false);
	});

	test("bare * blanket denies names containing / and leading ! matches literal name only", () => {
		expect(isToolDisallowed("custom/tool", ["*"])).toBe(true);
		expect(isToolDisallowed("mcp/server/tool", ["*"])).toBe(true);

		expect(isToolDisallowed("!special", ["!special"])).toBe(true);
		expect(isToolDisallowed("other", ["!special"])).toBe(false);
		expect(isToolDisallowed("!special_tool", ["!special_*"])).toBe(true);
		expect(isToolDisallowed("other_tool", ["!special_*"])).toBe(false);
	});

	test("capped minted names need mcpServerName metadata to match a server wildcard", () => {
		// Sanity: the fixture really is a capped name whose prefix no longer matches.
		expect(CAPPED_MINTED_NAME.length).toBe(64);
		expect(CAPPED_MINTED_NAME.startsWith(`mcp__${sanitizeNamePart(LONG_SERVER_NAME, "server")}_`)).toBe(false);
		// Name-only: the truncated + hashed name misses the prefix match.
		expect(isToolDisallowed(CAPPED_MINTED_NAME, [LONG_SERVER_PATTERN])).toBe(false);
		// Ownership metadata (raw config server name) restores the one-server match.
		expect(isToolDisallowed(CAPPED_MINTED_NAME, [LONG_SERVER_PATTERN], LONG_SERVER_NAME)).toBe(true);
		// A different server's metadata does not match.
		expect(isToolDisallowed(CAPPED_MINTED_NAME, [LONG_SERVER_PATTERN], "other-server")).toBe(false);
		// An uncapped name whose metadata names the pattern's server matches —
		// through ownership, which is authoritative when present.
		expect(isToolDisallowed("mcp__foo_bar", ["mcp__foo_*"], "foo")).toBe(true);
		// Metadata naming a DIFFERENT server is a non-match even though the name
		// prefix coincides: the prefix is lossy (server `foo_bar` mints names
		// starting `mcp__foo_`), so ownership decides. Without metadata the prefix
		// remains the only available signal.
		expect(isToolDisallowed("mcp__foo_bar", ["mcp__foo_*"], "irrelevant-server")).toBe(false);
		expect(isToolDisallowed("mcp__foo_bar", ["mcp__foo_*"])).toBe(true);
	});

	test("mcpServerName metadata sanitizes the raw name against the pattern segment", () => {
		// `DB2` raw config name sanitizes to `db2` (digits kept, like the mint),
		// exactly the segment a `mcp__db2_*` pattern names.
		expect(isToolDisallowed("mcp__db2_query", ["mcp__db2_*"], "DB2")).toBe(true);
		// The match is by sanitized server, not by tool name prefix: another
		// tool owned by the same raw server still matches.
		expect(isToolDisallowed("mcp__other_tool", ["mcp__db2_*"], "DB2")).toBe(true);
		// A raw name with case/space differences sanitizes to the same segment.
		expect(isToolDisallowed("mcp__anything", ["mcp__foo_bar_*"], "Foo Bar")).toBe(true);
		// A pattern whose segment does not match the sanitized raw name stays inert.
		expect(isToolDisallowed("mcp__other_tool", ["mcp__db_*"], "DB2")).toBe(false);
	});

	test("mcpServerName metadata never affects non-mcp patterns", () => {
		expect(isToolDisallowed("bash", ["b*"], "server-name")).toBe(true);
		expect(isToolDisallowed("read", ["b*"], "server-name")).toBe(false);
		expect(isToolDisallowed("bash", ["bash"], "server-name")).toBe(true);
		expect(isToolDisallowed("bash", ["read"], "server-name")).toBe(false);
	});
	test("ownership fallback applies only to bare mcp__<server>_* wildcards", () => {
		// A tool-prefix wildcard (`mcp__foo_query*`) matches by name prefix
		// alone; its last underscore is a tool-name separator, and the ownership
		// fallback must not overmatch the server's whole tool set.
		expect(isToolDisallowed("mcp__foo_query_tool", ["mcp__foo_query*"], "foo")).toBe(true);
		expect(isToolDisallowed("mcp__foo_other", ["mcp__foo_query*"], "foo")).toBe(false);
		// The bare server wildcard keeps the ownership fallback.
		expect(isToolDisallowed("mcp__foo_other", ["mcp__foo_*"], "foo")).toBe(true);
	});

	test("owner-consistent matching for tool-prefix wildcards and neighbouring servers", () => {
		expect(isToolDisallowed("mcp__github_issue_search", ["mcp__github_issue_*"], "github")).toBe(true);
		expect(isToolDisallowed("mcp__github_repo_list", ["mcp__github_issue_*"], "github")).toBe(false);
		expect(isToolDisallowed("mcp__foo_bar_q", ["mcp__foo_*"], "foo_bar")).toBe(false);
		expect(isToolDisallowed("mcp__foo_bar_q", ["mcp__foo_*"], "foo")).toBe(true);
		expect(isToolDisallowed("mcp__foo_query_x", ["mcp__foo_query*"], "foo")).toBe(true);
	});

	test("a server wildcard decides by ownership before the lossy name prefix", () => {
		// Server `foo` and server `foo_bar` both mint names starting `mcp__foo_`,
		// so the prefix test alone stripped the unrelated server's tools — and its
		// resources and instructions with them.
		expect(isToolDisallowed("mcp__foo_query", ["mcp__foo_*"], "foo")).toBe(true);
		expect(isToolDisallowed("mcp__foo_bar_query", ["mcp__foo_*"], "foo_bar")).toBe(false);
		// An ownership mismatch must not stop the remaining patterns being judged.
		expect(isToolDisallowed("mcp__foo_bar_query", ["mcp__foo_*", "mcp__foo_bar_*"], "foo_bar")).toBe(true);
		// Without metadata the prefix remains the only available signal.
		expect(isToolDisallowed("mcp__foo_bar_query", ["mcp__foo_*"])).toBe(true);
	});

	test("mcp__* keeps matching every MCP tool regardless of metadata", () => {
		expect(isToolDisallowed("mcp__foo_bar", ["mcp__*"], "server-name")).toBe(true);
		expect(isToolDisallowed("bash", ["mcp__*"], "server-name")).toBe(false);
	});

	test("hidden protocol tools stay exempt even with mcpServerName metadata", () => {
		expect(isToolDisallowed("yield", ["*"], "server-name")).toBe(false);
		expect(isToolDisallowed("yield", ["mcp__*"], "server-name")).toBe(false);
		expect(isToolDisallowed("goal", [LONG_SERVER_PATTERN], LONG_SERVER_NAME)).toBe(false);
	});
});

describe("expandExecToolAlias", () => {
	test("leaves MCP names to the owner-aware scope when a deny targets a neighbouring server", () => {
		// Server `foo_bar` mints names starting `mcp__foo_`, so an ownerless
		// prefix match would reject a name the session scope allows.
		expect(expandExecToolAlias(["mcp__foo_bar_query"], ["mcp__foo_*"], { python: true, js: true })).toEqual([
			"mcp__foo_bar_query",
		]);
		// Non-MCP names still honor the same deny list here.
		expect(expandExecToolAlias(["bash", "read"], ["b*"], { python: true, js: true })).toEqual(["read"]);
	});
});

describe("expandDisallowedTools", () => {
	test("expands exec alias to include eval and bash", () => {
		const expanded = expandDisallowedTools(["exec", "mcp__*"]);
		expect(expanded).toContain("exec");
		expect(expanded).toContain("eval");
		expect(expanded).toContain("bash");
		expect(expanded).toContain("mcp__*");
	});

	test("leaves patterns without exec unchanged", () => {
		expect(expandDisallowedTools(["bash", "read"])).toEqual(["bash", "read"]);
		expect(expandDisallowedTools([])).toEqual([]);
	});
});

describe("mcpWildcardServerSegment", () => {
	test("identifies server wildcard segment only for trailing-* patterns", () => {
		expect(mcpWildcardServerSegment("mcp__github_a")).toBeUndefined();
		expect(mcpWildcardServerSegment("mcp__github_*")).toBe("github");
		expect(mcpWildcardServerSegment("mcp__foo_query*")).toBeUndefined();
		// `**` behaves like `*` (tool names carry no `/`): the entry must
		// classify as a server wildcard, or it falls through to plain prefix
		// matching and overmatches neighbouring servers.
		expect(mcpWildcardServerSegment("mcp__foo_**")).toBe("foo");
		expect(mcpWildcardServerSegment("mcp__*")).toBeUndefined();
	});
});
