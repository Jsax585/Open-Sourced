/**
 * The ownership surface the MCP resource gates need: a tool's public name and
 * the raw config server that advertised it. Structurally satisfied by registry
 * `AgentTool`s and by the manager's own MCP tool records, so a caller can pass
 * every live source it holds instead of the deduplicated registry alone.
 */
export interface McpOwnedToolRef {
	readonly name?: string;
	readonly mcpServerName?: unknown;
}

/**
 * Whether a server's resources may be listed/read under a scope gate: no gate
 * configured (unrestricted), or at least one of the server's registered tools
 * is executable under it. Resource frames answer by server name and never run
 * a registry tool, so every adapter answering them (primary bridge AND the
 * advisor bridge, which shares the same adapter) must consult the gate —
 * otherwise a scoped subagent could still enumerate and read every connected
 * server's contents through an advisor. Ownership is matched via
 * `mcpServerName` (never a lossy sanitized name prefix), mirroring the
 * instructions filter.
 */
export function mcpServerScopedIn(
	tools: Iterable<McpOwnedToolRef>,
	isToolExecutable: ((name: string, mcpServerName?: string) => boolean) | undefined,
	serverName: string,
): boolean {
	if (!isToolExecutable) return true;
	return Array.from(tools).some(
		tool =>
			tool.mcpServerName === serverName &&
			isToolExecutable(tool.name ?? "", typeof tool.mcpServerName === "string" ? tool.mcpServerName : undefined),
	);
}

/**
 * Whether a server's resources may be surfaced at all under a scope gate:
 * the single decision shared by every resource-listing/read path (primary
 * handler, adapter `serverNames`, adapter `getServerResources`/`readServerResource`,
 * and the advisor bridge that shares the adapter).
 *
 * A server that owns registry tools is gated purely by tool executability (at
 * least one owned tool scoped in); resource-only servers (no owned tool at
 * all) survive only when the per-server predicate allows them, so an
 * MCP-targeting scope strips servers its `mcp__` disallow patterns name.
 */
export function mcpServerResourcesAllowed(
	/**
	 * Every live tool source the caller holds, read per call (never snapshotted):
	 * MCP discovery and `tools/list_changed` populate them after construction.
	 * A session passes both its registry (which also carries extension-owned MCP
	 * tools) and its manager's tool list. The latter is what keeps a server
	 * whose public name lost the registry's deduplication visible: reading only
	 * the registry makes that loser look resource-only, so an exact disallow of
	 * the shared name would strip the winner's resources while the loser's —
	 * whose only tool the same disallow matches — stayed listable and readable.
	 */
	sources: readonly Iterable<McpOwnedToolRef>[],
	isToolExecutable: ((name: string, mcpServerName?: string) => boolean) | undefined,
	allowToollessServers: ((serverName: string) => boolean) | undefined,
	serverName: string,
): boolean {
	if (!isToolExecutable) return true;
	// Materialize once per call: a source may be a single-shot iterator (e.g. a
	// Map's `.values()`), and the ownership pass below would read an exhausted
	// iterable as "owns no tools", rescuing gated-out servers.
	const roster = sources.flatMap(source => Array.from(source));
	if (mcpServerScopedIn(roster, isToolExecutable, serverName)) return true;
	const ownsAnyTool = roster.some(tool => tool.mcpServerName === serverName);
	return !ownsAnyTool && allowToollessServers?.(serverName) === true;
}
