import { describe, expect, test } from "bun:test";
import { sanitizeNamePart } from "@oh-my-pi/pi-coding-agent/mcp/name-sanitize";
import { expandBraceAlternatives } from "@oh-my-pi/pi-coding-agent/tools/name-patterns";
import { ToolScope } from "@oh-my-pi/pi-coding-agent/tools/tool-scope";

describe("ToolScope", () => {
	test("unrestricted scope leaves tools unconstrained", () => {
		const scope = new ToolScope({});

		expect(scope.enforced).toBe(false);
		expect(scope.restricted).toBe(false);

		expect(scope.isExplicitlyAllowed("read")).toBe(false);
		expect(scope.isExplicitlyAllowed("mcp__db_q")).toBe(false);

		expect(scope.isScopedIn("read")).toBe(true);
		expect(scope.isScopedIn("mcp__db_q")).toBe(true);
	});

	test("hard allowlist grants only named tools, while empty allowlist allows only hidden tools", () => {
		const scope = new ToolScope({ allowedToolNames: ["read", "grep"] });

		expect(scope.enforced).toBe(true);
		expect(scope.restricted).toBe(true);
		expect(scope.isScopedIn("read")).toBe(true);
		expect(scope.isScopedIn("bash")).toBe(false);
		expect(scope.isExplicitlyAllowed("grep")).toBe(true);
		expect(scope.isExplicitlyAllowed("bash")).toBe(false);

		const emptyScope = new ToolScope({ allowedToolNames: [] });
		expect(emptyScope.enforced).toBe(true);
		expect(emptyScope.isScopedIn("read")).toBe(false);
		expect(emptyScope.isScopedIn("bash")).toBe(false);
		expect(emptyScope.isScopedIn("mcp__db_q")).toBe(false);
		expect(emptyScope.isExplicitlyAllowed("read")).toBe(false);
		expect(emptyScope.isExplicitlyAllowed("yield")).toBe(false);

		// Hidden protocol tools remain available even under empty allowlist
		expect(emptyScope.isScopedIn("yield")).toBe(true);
		expect(emptyScope.isScopedIn("goal")).toBe(true);
		expect(emptyScope.isScopedIn("think")).toBe(true);
	});

	test("allow-side globs support wildcards including blanket *", () => {
		const globScope = new ToolScope({ allowedToolNames: ["mcp__db_*"] });
		expect(globScope.isScopedIn("mcp__db_2_query")).toBe(true);
		expect(globScope.isExplicitlyAllowed("mcp__db_2_query")).toBe(true);
		expect(globScope.isScopedIn("mcp__other_query")).toBe(false);
		expect(globScope.isExplicitlyAllowed("mcp__other_query")).toBe(false);

		const blanketScope = new ToolScope({ allowedToolNames: ["*"] });
		expect(blanketScope.isScopedIn("read")).toBe(true);
		expect(blanketScope.isExplicitlyAllowed("read")).toBe(true);
		expect(blanketScope.isScopedIn("custom_plugin_tool")).toBe(true);
		expect(blanketScope.isExplicitlyAllowed("custom_plugin_tool")).toBe(true);
	});

	test("deny wins over allowlist for conflicting tools", () => {
		const scope = new ToolScope({
			allowedToolNames: ["read", "bash"],
			disallowedTools: ["bash"],
		});

		expect(scope.isExplicitlyAllowed("bash")).toBe(true);
		expect(scope.isExplicitlyAllowed("read")).toBe(true);
		expect(scope.isDenied("bash")).toBe(true);
		expect(scope.isDenied("read")).toBe(false);
		expect(scope.isScopedIn("bash")).toBe(false);
		expect(scope.isScopedIn("read")).toBe(true);
	});

	test("glob grammar handles ?, braces, exact-first metacharacters, and leading ! literals", () => {
		const questionScope = new ToolScope({ disallowedTools: ["?ead"] });
		expect(questionScope.isDenied("read")).toBe(true);
		expect(questionScope.isDenied("lead")).toBe(true);
		expect(questionScope.isDenied("bread")).toBe(false);

		const braceScope = new ToolScope({ disallowedTools: ["{read,grep}"] });
		expect(braceScope.isDenied("read")).toBe(true);
		expect(braceScope.isDenied("grep")).toBe(true);
		expect(braceScope.isDenied("bash")).toBe(false);

		// Unbalanced glob syntax matches literal name first without throwing
		const exactFirstScope = new ToolScope({ disallowedTools: ["a{b"] });
		expect(exactFirstScope.isDenied("a{b")).toBe(true);
		expect(exactFirstScope.isDenied("ab")).toBe(false);

		// Leading ! is escaped so it denies literal !foo instead of negating
		const bangScope = new ToolScope({ disallowedTools: ["!foo"] });
		expect(bangScope.isDenied("!foo")).toBe(true);
		expect(bangScope.isDenied("bar")).toBe(false);
		expect(bangScope.isDenied("foo")).toBe(false);
	});

	test("blanket deny blocks normal tools, keeps hidden protocol tools, and denies all servers", () => {
		const scope = new ToolScope({ disallowedTools: ["*"] });

		expect(scope.restricted).toBe(true);

		expect(scope.isDenied("read")).toBe(true);
		expect(scope.isDenied("mcp__db_q")).toBe(true);
		expect(scope.isScopedIn("read")).toBe(false);
		expect(scope.isScopedIn("mcp__db_q")).toBe(false);

		// Hidden protocol tool is never denied and remains scoped in
		expect(scope.isDenied("yield")).toBe(false);
		expect(scope.isScopedIn("yield")).toBe(true);

		expect(scope.deniesServer("anything")).toBe(true);
		expect(scope.deniesServer("other_server")).toBe(true);
	});

	test("owner scoping checks owning server metadata and denies whole servers", () => {
		const scope = new ToolScope({ disallowedTools: ["mcp__foo_*"] });

		// When metadata is provided, matching server owner denies
		expect(scope.isDenied("mcp__foo_bar_q", "foo")).toBe(true);
		// Different server owner skips the pattern even if public name shares the prefix
		expect(scope.isDenied("mcp__foo_bar_q", "foo_bar")).toBe(false);
		// Without server metadata, matching falls back to tool name
		expect(scope.isDenied("mcp__foo_bar_q")).toBe(true);

		expect(scope.deniesServer("foo")).toBe(true);
		expect(scope.deniesServer("bar")).toBe(false);

		const allMcpScope = new ToolScope({ disallowedTools: ["mcp__*"] });
		expect(allMcpScope.deniesServer("foo")).toBe(true);
		expect(allMcpScope.deniesServer("bar")).toBe(true);
		expect(allMcpScope.deniesServer("any_server")).toBe(true);
		expect(allMcpScope.isDenied("mcp__arbitrary_tool", "any_server")).toBe(true);
	});

	test("capped minted keys match by owner metadata even when name prefix was truncated", () => {
		const longServerName = "very long server name that gets truncated at the 64 character cap boundary for testing";
		const sanitizedServer = sanitizeNamePart(longServerName, "server");
		const longServerPattern = `mcp__${sanitizedServer}_*`;

		// Build a 64-char capped minted name mirroring the MCP minting cap logic:
		const fullMintedName = `mcp__${sanitizedServer}_query_special_tool_name`;
		const hash = Bun.hash(fullMintedName).toString(36).slice(0, 8);
		const cappedName = `${fullMintedName.slice(0, 64 - hash.length - 1)}_${hash}`;

		// Sanity check on the capped name structure
		expect(cappedName.length).toBe(64);
		expect(cappedName.startsWith(`mcp__${sanitizedServer}_`)).toBe(false);

		const scope = new ToolScope({ disallowedTools: [longServerPattern] });

		// Owner metadata matches despite the truncated name prefix
		expect(scope.isDenied(cappedName, longServerName)).toBe(true);
		// Unrelated owner metadata does not match
		expect(scope.isDenied(cappedName, "someone_else")).toBe(false);
		// Name-only fallback fails to match because the prefix was truncated away
		expect(scope.isDenied(cappedName)).toBe(false);
	});

	test("alias resolution maps Claude-spelled MCP entries to minted registry keys", () => {
		const allowScope = new ToolScope({ allowedToolNames: ["mcp__srv-x__tool"] });

		// Before alias resolver is set
		expect(allowScope.isExplicitlyAllowed("mcp__srv_x_tool")).toBe(false);
		expect(allowScope.isScopedIn("mcp__srv_x_tool")).toBe(false);

		// After alias resolver is set
		allowScope.setAliasResolver(entry => (entry === "mcp__srv-x__tool" ? "mcp__srv_x_tool" : undefined));
		expect(allowScope.isExplicitlyAllowed("mcp__srv_x_tool")).toBe(true);
		expect(allowScope.isScopedIn("mcp__srv_x_tool")).toBe(true);
		expect(allowScope.isExplicitlyAllowed("mcp__other_tool")).toBe(false);

		// Same for a deny entry
		const denyScope = new ToolScope({ disallowedTools: ["mcp__srv-x__tool"] });

		// Before alias resolver is set
		expect(denyScope.isDenied("mcp__srv_x_tool")).toBe(false);
		expect(denyScope.isScopedIn("mcp__srv_x_tool")).toBe(true);

		// After alias resolver is set
		denyScope.setAliasResolver(entry => (entry === "mcp__srv-x__tool" ? "mcp__srv_x_tool" : undefined));
		expect(denyScope.isDenied("mcp__srv_x_tool")).toBe(true);
		expect(denyScope.isScopedIn("mcp__srv_x_tool")).toBe(false);
		expect(denyScope.isDenied("mcp__other_tool")).toBe(false);
	});

	test("alias grants do not cross server ownership for minted name collisions", () => {
		const scope = new ToolScope({ allowedToolNames: ["mcp__foo__bar_query"] });
		scope.setAliasResolver(entry => (entry === "mcp__foo__bar_query" ? "mcp__foo_bar_query" : undefined));

		// The declared server owns the key: `foo` / `bar_query`.
		expect(scope.isExplicitlyAllowed("mcp__foo_bar_query", "foo")).toBe(true);
		// Same minted key, different owner: `foo_bar` / `query`. The lossy mint
		// must not hand `foo`'s grant to a neighbouring server.
		expect(scope.isExplicitlyAllowed("mcp__foo_bar_query", "foo_bar")).toBe(false);
		// Without owner metadata the minted name stays the only signal.
		expect(scope.isExplicitlyAllowed("mcp__foo_bar_query")).toBe(true);
	});

	test("exec deny entry expands at construction to deny eval and bash while keeping read", () => {
		const scope = new ToolScope({ disallowedTools: ["exec"] });

		expect(scope.isDenied("exec")).toBe(true);
		expect(scope.isDenied("eval")).toBe(true);
		expect(scope.isDenied("bash")).toBe(true);
		expect(scope.isDenied("read")).toBe(false);

		expect(scope.isScopedIn("eval")).toBe(false);
		expect(scope.isScopedIn("bash")).toBe(false);
		expect(scope.isScopedIn("read")).toBe(true);
	});

	test("exact MCP name is not a server wildcard", () => {
		const scope = new ToolScope({ disallowedTools: ["mcp__github_a"] });
		expect(scope.isDenied("mcp__github_a")).toBe(true);
		expect(scope.isDenied("mcp__github_b")).toBe(false);
		expect(scope.deniesServer("github")).toBe(false);
		expect(scope.isDenied("mcp__github_a", "github")).toBe(true);
	});

	test("uppercase deny normalizes to lowercase", () => {
		const scope = new ToolScope({ disallowedTools: ["MCP__*"] });
		expect(scope.isDenied("mcp__db_q")).toBe(true);
		expect(scope.isScopedIn("read")).toBe(true);
	});

	test("** is a blanket deny across all tools and MCP servers", () => {
		const scope = new ToolScope({ disallowedTools: ["**"] });
		expect(scope.isDenied("read")).toBe(true);
		expect(scope.deniesServer("any")).toBe(true);
		expect(scope.deniesAllTools).toBe(true);
		expect(scope.isScopedIn("yield")).toBe(true);
	});

	test("brace glob targets MCP and matches server namespaces", () => {
		const scope = new ToolScope({ disallowedTools: ["{mcp__foo_*,mcp__bar_*}"] });
		expect(scope.deniesServer("foo")).toBe(true);
		expect(scope.deniesServer("baz")).toBe(false);
		expect(scope.isDenied("mcp__foo_q", "foo")).toBe(true);
	});

	test("allow-side owner match for capped names using server wildcard pattern", () => {
		const longServerName = "very long server name that gets truncated at the 64 character cap boundary for testing";
		const segment = sanitizeNamePart(longServerName, "server");
		const fullMintedName = `mcp__${segment}_query_special_tool_name`;
		const hash = Bun.hash(fullMintedName).toString(36).slice(0, 8);
		const capped = `${fullMintedName.slice(0, 64 - hash.length - 1)}_${hash}`;

		const scope = new ToolScope({ allowedToolNames: [`mcp__${segment}_*`] });
		expect(scope.isExplicitlyAllowed(capped, longServerName)).toBe(true);
		expect(scope.isScopedIn(capped, longServerName)).toBe(true);
		expect(scope.isExplicitlyAllowed(capped, "other_server")).toBe(false);
	});

	test("isNamedLiterally distinguishes literal entries from globs and resolves aliases", () => {
		const starScope = new ToolScope({ allowedToolNames: ["*"] });
		expect(starScope.isNamedLiterally("read")).toBe(false);

		const literalScope = new ToolScope({ allowedToolNames: ["read"] });
		expect(literalScope.isNamedLiterally("read")).toBe(true);

		const aliasScope = new ToolScope({ allowedToolNames: ["mcp__srv-x__t"] });
		expect(aliasScope.isNamedLiterally("mcp__srv_x_t")).toBe(false);
		aliasScope.setAliasResolver(entry => (entry === "mcp__srv-x__t" ? "mcp__srv_x_t" : undefined));
		expect(aliasScope.isNamedLiterally("mcp__srv_x_t")).toBe(true);

		// Brace alternatives expand into plain-looking names but are not literal
		// declarations: they must not enable defaultInactive/hidden tools.
		const braceScope = new ToolScope({ allowedToolNames: ["{read,default_inactive_tool}"] });
		expect(braceScope.isExplicitlyAllowed("default_inactive_tool")).toBe(true);
		expect(braceScope.isNamedLiterally("default_inactive_tool")).toBe(false);
	});

	test("owner-consistent matching for tool-prefix wildcards and neighbouring servers", () => {
		const githubScope = new ToolScope({ disallowedTools: ["mcp__github_issue_*"] });
		expect(githubScope.isDenied("mcp__github_issue_search", "github")).toBe(true);
		expect(githubScope.isDenied("mcp__github_repo_list", "github")).toBe(false);
		expect(githubScope.deniesServer("github")).toBe(false);

		const fooScope = new ToolScope({ disallowedTools: ["mcp__foo_*"] });
		expect(fooScope.isDenied("mcp__foo_bar_q", "foo_bar")).toBe(false);
		expect(fooScope.isDenied("mcp__foo_bar_q", "foo")).toBe(true);

		const braceScope = new ToolScope({ disallowedTools: ["{mcp__a_*,mcp__b_*}"] });
		expect(braceScope.isDenied("mcp__a_tool", "a")).toBe(true);
		expect(braceScope.deniesServer("a")).toBe(true);
		expect(braceScope.deniesServer("b")).toBe(true);
		expect(braceScope.deniesServer("c")).toBe(false);

		const queryPrefixScope = new ToolScope({ disallowedTools: ["mcp__foo_query*"] });
		expect(queryPrefixScope.deniesServer("foo")).toBe(false);
		expect(queryPrefixScope.isDenied("mcp__foo_query_x", "foo")).toBe(true);
		expect(queryPrefixScope.isDenied("mcp__foo_bar_x", "foo")).toBe(false);

		const embeddedBraceScope = new ToolScope({ disallowedTools: ["mcp__{foo,bar}_*"] });
		expect(embeddedBraceScope.isDenied("mcp__foo_q", "foo")).toBe(true);
		expect(embeddedBraceScope.deniesServer("foo")).toBe(true);
		expect(embeddedBraceScope.deniesServer("bar")).toBe(true);
		expect(embeddedBraceScope.deniesServer("baz")).toBe(false);

		const nonServerDenyPatterns = new ToolScope({
			disallowedTools: ["mcp__*_tool", "mcp__foo_tool*", "mcp__github_tool"],
		});
		expect(nonServerDenyPatterns.deniesServer("github")).toBe(false);
		expect(nonServerDenyPatterns.deniesServer("foo")).toBe(false);
	});
	test("runtime scope keeps an enforced half-pair the startup scope kept", () => {
		// `tools: [checkpoint]` lists no `rewind`, but the sister is unlisted —
		// not denied — so startup keeps the half-pair. A runtime filter pairing
		// on `!isScopedIn` would drop it (`rewind` reads as not scoped in);
		// pairing must judge `isDenied`, matching startup.
		const scope = new ToolScope({ allowedToolNames: ["checkpoint"] });
		expect(scope.isScopedIn("checkpoint")).toBe(true);
		expect(scope.isScopedIn("rewind")).toBe(false);
		expect(scope.isDenied("checkpoint")).toBe(false);
		expect(scope.isDenied("rewind")).toBe(false);
	});

	test("trailing-** server entries judge by owner like trailing-*", () => {
		// Without ownership classification, `mcp__foo_**` falls through to plain
		// prefix matching and grants/strips server `foo_bar`'s tools.
		const allowScope = new ToolScope({ allowedToolNames: ["mcp__foo_**"] });
		expect(allowScope.isExplicitlyAllowed("mcp__foo_q", "foo")).toBe(true);
		expect(allowScope.isExplicitlyAllowed("mcp__foo_bar_q", "foo_bar")).toBe(false);
		const denyScope = new ToolScope({ disallowedTools: ["mcp__foo_**"] });
		expect(denyScope.isDenied("mcp__foo_q", "foo")).toBe(true);
		expect(denyScope.isDenied("mcp__foo_bar_q", "foo_bar")).toBe(false);
		expect(denyScope.deniesServer("foo")).toBe(true);
		expect(denyScope.deniesServer("foo_bar")).toBe(false);
	});

	test("deny-side alias resolution requires the declared owning server", () => {
		// `mcp__foo__bar_query` (Claude spelling: server `foo`, tool `bar_query`)
		// mints to `mcp__foo_bar_query`, which may belong to server `foo_bar`
		// (tool `query`). The deny must not strip the other server's tool.
		const scope = new ToolScope({ disallowedTools: ["mcp__foo__bar_query"] }).setAliasResolver(entry =>
			entry === "mcp__foo__bar_query" ? "mcp__foo_bar_query" : undefined,
		);
		expect(scope.isDenied("mcp__foo_bar_query", "foo")).toBe(true);
		expect(scope.isDenied("mcp__foo_bar_query", "foo_bar")).toBe(false);
	});

	test("brace-spelled allow entries resolve aliases after expansion", () => {
		// `mcp__{a,b}__tool` must grant both minted keys, matching the deny
		// side — skipping alias resolution on unexpanded entries grants neither.
		const scope = new ToolScope({ allowedToolNames: ["mcp__{a,b}__tool"] }).setAliasResolver(entry =>
			entry === "mcp__a__tool" ? "mcp__a_tool" : entry === "mcp__b__tool" ? "mcp__b_tool" : undefined,
		);
		expect(scope.isExplicitlyAllowed("mcp__a_tool")).toBe(true);
		expect(scope.isExplicitlyAllowed("mcp__b_tool")).toBe(true);
	});

	test("expandBraceAlternatives expands brace alternatives and ignores unbalanced braces", () => {
		expect(expandBraceAlternatives("a{b,c}d")).toEqual(["abd", "acd"]);
		expect(expandBraceAlternatives("mcp__{a,b}_*")).toEqual(["mcp__a_*", "mcp__b_*"]);
		expect(expandBraceAlternatives("{mcp__a_*,mcp__b_*}")).toEqual(["mcp__a_*", "mcp__b_*"]);
		expect(expandBraceAlternatives("plain")).toEqual(["plain"]);
		expect(expandBraceAlternatives("unclosed{a,b")).toEqual(["unclosed{a,b"]);
		// Nested alternatives recurse through top-level commas; splitting every
		// comma shreds `a{b,{c,d}}e` into `abe` plus garbage literals.
		expect(expandBraceAlternatives("a{b,{c,d}}e")).toEqual(["abe", "ace", "ade"]);
	});
});
