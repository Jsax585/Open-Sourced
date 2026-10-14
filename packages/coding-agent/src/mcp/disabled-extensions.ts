import type { SourceMeta } from "../capability/types";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { type LoadMCPConfigsOptions, loadAllMCPConfigs } from "./config";
import type { MCPManager } from "./manager";
import type { McpConnectionStatusEvent } from "./startup-events";
import type { MCPServerConfig } from "./types";

const MCP_EXTENSION_PREFIX = "mcp:";

function mcpServerNames(extensionIds: readonly string[]): Set<string> {
	const names = new Set<string>();
	for (const id of extensionIds) {
		if (id.startsWith(MCP_EXTENSION_PREFIX)) names.add(id.slice(MCP_EXTENSION_PREFIX.length));
	}
	return names;
}

export interface ReconcileMcpDisabledExtensionsOptions {
	/** Resolved `disabledExtensions` before the change. */
	before: readonly string[];
	/** Resolved `disabledExtensions` after the change. */
	after: readonly string[];
	/** The session's working directory after the change. */
	cwd: string;
	manager: Pick<MCPManager, "setCwd" | "getConnectionStatus" | "disconnectServer" | "connectServers" | "getTools">;
	session: { refreshMCPTools(tools: CustomTool[]): Promise<void> | void };
	/** Same discovery filters as session startup. */
	discovery?: LoadMCPConfigsOptions;
	onStatus?: (event: McpConnectionStatusEvent) => void;
}

/**
 * Bring live MCP connections in line with a change of the resolved
 * `disabledExtensions` list — a `/move` or cross-project resume into or out of a
 * directory whose path-scoped entry blocks `mcp:<name>`, or a config edit.
 * Retargets the manager to `cwd` first, so servers connected here are
 * discovered from and advertised the session's current directory. Newly
 * disabled servers disconnect and lose their tools; newly allowed servers are
 * rediscovered and connect. Returns connection errors by server name.
 */
export async function reconcileMcpDisabledExtensions(
	options: ReconcileMcpDisabledExtensionsOptions,
): Promise<Map<string, string>> {
	const { before, after, cwd, manager, session, discovery, onStatus } = options;
	manager.setCwd(cwd);
	const wasDisabled = mcpServerNames(before);
	const isDisabled = mcpServerNames(after);
	const blocked = [...isDisabled].filter(name => !wasDisabled.has(name));
	const allowed = [...wasDisabled].filter(
		name => !isDisabled.has(name) && manager.getConnectionStatus(name) === "disconnected",
	);
	if (blocked.length === 0 && allowed.length === 0) return new Map();

	for (const name of blocked) await manager.disconnectServer(name);

	let errors = new Map<string, string>();
	if (allowed.length > 0) {
		const loaded = await loadAllMCPConfigs(cwd, discovery);
		const configs: Record<string, MCPServerConfig> = {};
		const sources: Record<string, SourceMeta> = {};
		for (const name of allowed) {
			const config = loaded.configs[name];
			if (!config) continue;
			configs[name] = config;
			const source = loaded.sources[name];
			if (source) sources[name] = source;
		}
		if (Object.keys(configs).length > 0) errors = (await manager.connectServers(configs, sources, onStatus)).errors;
	}
	await session.refreshMCPTools(manager.getTools());
	return errors;
}
