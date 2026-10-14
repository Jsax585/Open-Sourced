import type { SourceMeta } from "../../../capability/types";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import { type LoadMCPConfigsOptions, loadAllMCPConfigs } from "../../../mcp/config";
import type { MCPLoadResult } from "../../../mcp/manager";
import type { McpConnectionStatusEvent } from "../../../mcp/startup-events";
import type { MCPServerConfig } from "../../../mcp/types";

/** Manager methods `/extensions` needs to match `/mcp enable` / `/mcp disable`. */
export interface MCPToggleManager {
	getConnectionStatus(name: string): "connected" | "connecting" | "disconnected";
	getTools(): CustomTool[];
	disconnectServer(name: string): Promise<void>;
	connectServers(
		configs: Record<string, MCPServerConfig>,
		sources: Record<string, SourceMeta>,
		onStatus?: (event: McpConnectionStatusEvent) => void,
	): Promise<Pick<MCPLoadResult, "errors"> | MCPLoadResult>;
}

export interface MCPToggleSession {
	refreshMCPTools(tools: CustomTool[]): Promise<void> | void;
}

export interface ApplyMcpToggleRuntimeOptions {
	name: string;
	enabled: boolean;
	cwd: string;
	manager?: MCPToggleManager;
	session?: MCPToggleSession;
	/** Same discovery filters as session startup (`sdk.ts` / `/mcp reload`). */
	discovery?: LoadMCPConfigsOptions;
	loadConfigs?: typeof loadAllMCPConfigs;
	onStatus?: (event: McpConnectionStatusEvent) => void;
}

/**
 * After `/extensions` persists an MCP enable/disable, apply the same live
 * connect/disconnect + session tool refresh that `/mcp enable` / `/mcp disable`
 * already do. Config persistence stays in `setMcpServerEnabled`.
 */
export async function applyMcpToggleRuntime(options: ApplyMcpToggleRuntimeOptions): Promise<void> {
	const { name, enabled, cwd, manager, session, discovery, loadConfigs = loadAllMCPConfigs, onStatus } = options;
	if (!manager) return;

	if (!enabled) {
		await manager.disconnectServer(name);
		await session?.refreshMCPTools(manager.getTools());
		return;
	}

	if (manager.getConnectionStatus(name) !== "disconnected") {
		await session?.refreshMCPTools(manager.getTools());
		return;
	}

	const { configs, sources } = await loadConfigs(cwd, discovery);
	const config = configs[name];
	if (!config) {
		await session?.refreshMCPTools(manager.getTools());
		return;
	}
	const source = sources[name];
	await manager.connectServers({ [name]: config }, source ? { [name]: source } : {}, onStatus);
	await session?.refreshMCPTools(manager.getTools());
}

const MCP_EXTENSION_PREFIX = "mcp:";

function disabledMcpServerNames(disabledExtensions: readonly string[]): Set<string> {
	const names = new Set<string>();
	for (const id of disabledExtensions) {
		if (id.startsWith(MCP_EXTENSION_PREFIX)) names.add(id.slice(MCP_EXTENSION_PREFIX.length));
	}
	return names;
}

export interface ReconcileMcpDisabledExtensionsOptions extends Omit<ApplyMcpToggleRuntimeOptions, "name" | "enabled"> {
	/** Resolved `disabledExtensions` before the change (e.g. before a cwd rescope). */
	before: readonly string[];
	/** Resolved `disabledExtensions` after the change. */
	after: readonly string[];
}

/**
 * Bring live MCP connections in line with a change of the resolved
 * `disabledExtensions` list — e.g. a `/move` into or out of a directory whose
 * path-scoped entry blocks `mcp:<name>`. Newly disabled servers disconnect and
 * lose their tools; newly allowed servers are rediscovered at `cwd` and connect.
 */
export async function reconcileMcpDisabledExtensions(options: ReconcileMcpDisabledExtensionsOptions): Promise<void> {
	const { before, after, ...runtime } = options;
	const wasDisabled = disabledMcpServerNames(before);
	const isDisabled = disabledMcpServerNames(after);
	for (const name of isDisabled) {
		if (!wasDisabled.has(name)) await applyMcpToggleRuntime({ ...runtime, name, enabled: false });
	}
	for (const name of wasDisabled) {
		if (!isDisabled.has(name)) await applyMcpToggleRuntime({ ...runtime, name, enabled: true });
	}
}
