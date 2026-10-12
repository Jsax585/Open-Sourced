/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { setMcpRenderMarkdownResults } from "@oh-my-pi/pi-tui/tools/mcp";
import { combine, effect, register } from "../config/registry";
import { type MCPTimeoutPhases, setMCPGlobalTimeouts } from "./timeout";

// MCP
export const cfgMcpEnableProjectConfig = register({
	id: "mcp.enableProjectConfig",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Project Config",
		description: "Load .mcp.json/mcp.json from project root",
	},
});

export const cfgMcpStartupTimeoutMs = register({
	id: "mcp.startupTimeoutMs",
	type: "number",
	default: 250,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Startup Window",
		description: "Wait this many milliseconds for initial MCP tool discovery; 0 waits until connections settle",
	},
});

export const cfgMcpTimeoutStartupMs = register({
	id: "mcp.timeout.startupMs",
	type: "number",
	default: 30_000,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Connect Timeout",
		description:
			"Milliseconds allowed for an MCP server to connect and finish initialize; 0 disables. A server's mcp.json timeout (number or { startup }) overrides it",
	},
});

export const cfgMcpTimeoutCatalogMs = register({
	id: "mcp.timeout.catalogMs",
	type: "number",
	default: 30_000,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Catalog Timeout",
		description:
			"Milliseconds allowed for listing an MCP server's tools, prompts and resources; 0 disables. A server's mcp.json timeout (number or { catalog }) overrides it",
	},
});

export const cfgMcpTimeoutExecutionMs = register({
	id: "mcp.timeout.executionMs",
	type: "number",
	default: 30_000,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Call Timeout",
		description:
			"Milliseconds allowed for MCP tool calls, prompt retrieval and resource reads; 0 disables. A server's mcp.json timeout (number or { execution }) overrides it",
	},
});
effect(
	combine({ startup: cfgMcpTimeoutStartupMs, catalog: cfgMcpTimeoutCatalogMs, execution: cfgMcpTimeoutExecutionMs }),
	timeouts => {
		const valid: MCPTimeoutPhases = {};
		for (const [phase, value] of Object.entries(timeouts) as [keyof MCPTimeoutPhases, unknown][]) {
			if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) valid[phase] = value;
			else
				logger.warn(`Ignoring invalid mcp.timeout.${phase}Ms setting; expected a non-negative integer`, { value });
		}
		setMCPGlobalTimeouts(valid);
	},
);

export const cfgMcpRenderMarkdownResults = register({
	id: "mcp.renderMarkdownResults",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Markdown Results",
		description: "Render non-JSON MCP text results as Markdown in the transcript",
	},
});
effect(cfgMcpRenderMarkdownResults, setMcpRenderMarkdownResults);

export const cfgMcpNotifications = register({
	id: "mcp.notifications",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Update Injection",
		description: "Inject MCP resource updates into the agent conversation",
	},
});

export const cfgMcpNotificationDebounceMs = register({
	id: "mcp.notificationDebounceMs",
	type: "number",
	default: 500,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Notification Debounce",
		description:
			"Debounce window in milliseconds for MCP resource updates before injecting them into the conversation",
	},
});
