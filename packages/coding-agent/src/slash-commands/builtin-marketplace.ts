import { t } from "@oh-my-pi/pi-utils/i18n";
import { clearSubmittedText } from "./helpers/draft";
import { reset as resetCapabilities } from "../capability";
import {
	clearPluginRootsAndCaches,
	resolveActiveProjectRegistryPath,
	resolveOrDefaultProjectRegistryPath,
} from "../discovery/helpers.js";
import { PluginManager } from "../extensibility/plugins";
import { setInstalledPluginEnabled } from "../extensibility/plugins/toggle";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../extensibility/plugins/marketplace";
import { MCPCommandController } from "../modes/controllers/mcp-command-controller";
import type { InteractiveModeContext } from "../modes/types";
import { refreshAgentDiscovery } from "../task";
import { createMarketplaceManager } from "./helpers/marketplace-manager";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import { parseMarketplaceInstallArgs, parsePluginScopeArgs } from "./marketplace-install-parser";
import type { SlashCommandSpec } from "./types";

/**
 * Reload the interactive session's plugin runtime: invalidate fs/plugin-root
 * caches, rediscover skills, file slash commands, and task agents, reset the
 * capability cache, and reconnect MCP servers (rebinding the session's MCP
 * tools). Shared by `/reload-plugins`'s TUI handler and the `handle`-adapter's
 * `reloadPlugins` hook so both honor the command's documented reload scope.
 */
export async function reloadTuiPluginState(ctx: InteractiveModeContext): Promise<void> {
	const projectPath = await resolveActiveProjectRegistryPath(ctx.sessionManager.getCwd());
	clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
	await refreshAgentDiscovery(ctx.sessionManager.getCwd(), ctx.session.effectiveExtensionRoots);
	await ctx.refreshSkillState();
	await ctx.refreshSlashCommandState();
	resetCapabilities();
	if (ctx.mcpManager) {
		await new MCPCommandController(ctx).reloadServers();
	}
}

export const BUILTIN_MARKETPLACE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "marketplace",
		icon: "cart",
		description: t("Manage marketplace plugin sources and installed plugins"),
		acpDescription: t("Manage plugins from marketplaces"),
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "add", description: t("Add a marketplace source"), usage: "<source>" },
			{ name: "remove", description: t("Remove a marketplace source"), usage: "<name>" },
			{ name: "update", description: t("Update marketplace catalog(s)"), usage: "[name]" },
			{ name: "list", description: t("List configured marketplaces") },
			{ name: "discover", description: t("Browse available plugins"), usage: "[marketplace]" },
			{
				name: "install",
				description: t("Install a plugin (interactive browser if no args)"),
				usage: "[--force] [name@marketplace]",
			},
			{ name: "uninstall", description: t("Uninstall a plugin (selector if no args)"), usage: "[name@marketplace]" },
			{ name: "installed", description: t("List installed marketplace plugins") },
			{ name: "upgrade", description: t("Upgrade outdated plugins"), usage: "[name@marketplace]" },
			{ name: "help", description: t("Show usage guide") },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb) {
				try {
					const manager = await createMarketplaceManager(runtime);
					const marketplaces = await manager.listMarketplaces();
					if (marketplaces.length === 0) {
						await runtime.output(
							t("No marketplaces configured.\n\nGet started:\n  /marketplace add anthropics/claude-plugins-official\n\nThen browse with /marketplace discover"),
						);
					} else {
						const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
						await runtime.output(
							t("Marketplaces:\n{0}\n\nUse /marketplace discover to browse plugins, or /marketplace help for all commands", `${lines.join("\n")}`),
						);
					}
					return commandConsumed();
				} catch (err) {
					return usage(t("Marketplace error: {0}", `${errorMessage(err)}`), runtime);
				}
			}
			if (verb === "help") {
				await runtime.output(
					[
						t("Marketplace commands:"),
						t("  /marketplace                              List configured marketplaces"),
						t("  /marketplace add <source>                  Add a marketplace (e.g. owner/repo)"),
						t("  /marketplace remove <name>                 Remove a marketplace"),
						t("  /marketplace update [name]                 Re-fetch catalog(s)"),
						t("  /marketplace list                          List configured marketplaces"),
						t("  /marketplace discover [marketplace]        Browse available plugins"),
						t("  /marketplace install <name@marketplace>    Install a plugin"),
						t("  /marketplace uninstall <name@marketplace>  Uninstall a plugin"),
						t("  /marketplace installed                     List installed plugins"),
						t("  /marketplace upgrade [name@marketplace]    Upgrade plugin(s)"),
						"",
						t("Quick start:"),
						"  /marketplace add anthropics/claude-plugins-official",
					].join("\n"),
				);
				return commandConsumed();
			}
			if ((verb === "install" || verb === "uninstall") && !rest) {
				return usage(
					t("Interactive plugin pickers are TUI-only. Pass an explicit name@marketplace argument."),
					runtime,
				);
			}
			try {
				const manager = await createMarketplaceManager(runtime);
				switch (verb) {
					case "add": {
						if (!rest) return usage(t("Usage: /marketplace add <source>"), runtime);
						const entry = await manager.addMarketplace(rest);
						await runtime.output(t("Added marketplace: {0}", `${entry.name}`));
						return commandConsumed();
					}
					case "remove":
					case "rm": {
						if (!rest) return usage(t("Usage: /marketplace remove <name>"), runtime);
						await manager.removeMarketplace(rest);
						await runtime.output(t("Removed marketplace: {0}", `${rest}`));
						return commandConsumed();
					}
					case "update": {
						if (rest) {
							await manager.updateMarketplace(rest);
							await runtime.output(t("Updated marketplace: {0}", `${rest}`));
						} else {
							const results = await manager.updateAllMarketplaces();
							await runtime.output(t("Updated {0} marketplace(s)", `${results.length}`));
						}
						return commandConsumed();
					}
					case "list": {
						const marketplaces = await manager.listMarketplaces();
						if (marketplaces.length === 0) {
							await runtime.output(t("No marketplaces configured."));
						} else {
							const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
							await runtime.output(t("Marketplaces:\n{0}", `${lines.join("\n")}`));
						}
						return commandConsumed();
					}
					case "discover": {
						const plugins = await manager.listAvailablePlugins(rest || undefined);
						if (plugins.length === 0) {
							const marketplaces = await manager.listMarketplaces();
							await runtime.output(
								marketplaces.length === 0
									? t("No marketplaces configured. Try:\n  /marketplace add anthropics/claude-plugins-official")
									: t("No plugins available in configured marketplaces"),
							);
							return commandConsumed();
						}
						const lines = [t("Available plugins:")];
						for (const plugin of plugins) {
							lines.push(`  - ${plugin.name}${plugin.version ? `@${plugin.version}` : ""}`);
							if (plugin.description) lines.push(`      ${plugin.description}`);
						}
						await runtime.output(lines.join("\n"));
						return commandConsumed();
					}
					case "install": {
						const parsed = parseMarketplaceInstallArgs(rest);
						if ("error" in parsed) return usage(parsed.error, runtime);
						const atIndex = parsed.installSpec.lastIndexOf("@");
						const pluginName = parsed.installSpec.slice(0, atIndex);
						const marketplace = parsed.installSpec.slice(atIndex + 1);
						await manager.installPlugin(pluginName, marketplace, { force: parsed.force, scope: parsed.scope });
						await runtime.reloadPlugins();
						await runtime.output(t("Installed {1} from {0}\u0004packages/coding-agent/src/slash-commands/builtin-marketplace.ts:BUILTIN_MARKETPLACE_SLASH_COMMANDS.handle", `${marketplace}`, `${pluginName}`));
						return commandConsumed();
					}
					case "uninstall": {
						const parsed = parsePluginScopeArgs(
							rest,
							t("Usage: /marketplace uninstall [--scope user|project] <name@marketplace>"),
						);
						if ("error" in parsed) return usage(parsed.error, runtime);
						await manager.uninstallPlugin(parsed.pluginId, parsed.scope);
						await runtime.reloadPlugins();
						await runtime.output(t("Uninstalled {0}\u0004packages/coding-agent/src/slash-commands/builtin-marketplace.ts:BUILTIN_MARKETPLACE_SLASH_COMMANDS.handle", `${parsed.pluginId}`));
						return commandConsumed();
					}
					case "installed": {
						const installed = await manager.listInstalledPlugins();
						if (installed.length === 0) {
							await runtime.output(t("No marketplace plugins installed"));
						} else {
							const lines = installed.map(
								p => t("  {0} [{1}]{2} ({3} entry)", `${p.id}`, `${p.scope}`, `${p.shadowedBy ? t(" [shadowed]\u0004packages/coding-agent/src/slash-commands/builtin-marketplace.ts:BUILTIN_MARKETPLACE_SLASH_COMMANDS.handle.lines") : ""}`, `${p.entries.length}`),
							);
							await runtime.output(t("Installed plugins:\n{0}", `${lines.join("\n")}`));
						}
						return commandConsumed();
					}
					case "upgrade": {
						if (rest) {
							const parsed = parsePluginScopeArgs(
								rest,
								t("Usage: /marketplace upgrade [--scope user|project] <name@marketplace>"),
							);
							if ("error" in parsed) return usage(parsed.error, runtime);
							const result = await manager.upgradePlugin(parsed.pluginId, parsed.scope);
							await runtime.reloadPlugins();
							await runtime.output(t("Upgraded {0} to {1}", `${parsed.pluginId}`, `${result.version}`));
							return commandConsumed();
						}
						const results = await manager.upgradeAllPlugins();
						if (results.length === 0) {
							await runtime.output(t("All marketplace plugins are up to date"));
						} else {
							await runtime.reloadPlugins();
							const lines = results.map(r => `  ${r.pluginId}: ${r.from} -> ${r.to}`);
							await runtime.output(t("Upgraded {0} plugin(s):\n{1}", `${results.length}`, `${lines.join("\n")}`));
						}
						return commandConsumed();
					}
					default:
						return usage(
							t("Unknown /marketplace subcommand: {0}. Use /marketplace help for available commands.", `${verb}`),
							runtime,
						);
				}
			} catch (err) {
				return usage(t("Marketplace error: {0}", `${errorMessage(err)}`), runtime);
			}
		},
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const args = command.args.trim().split(/\s+/);
			const sub = args[0] || "install";
			const rest = args.slice(1).join(" ").trim();

			// /marketplace (no args) or /marketplace install (no args) → interactive browser
			if ((sub === "install" && !rest) || (!args[0] && !command.args.trim())) {
				try {
					runtime.ctx.showPluginSelector("install");
				} catch (err) {
					runtime.ctx.showStatus(t("Marketplace error: {0}", `${err}`));
				}
				return;
			}

			const mgr = new MarketplaceManager({
				marketplacesRegistryPath: getMarketplacesRegistryPath(),
				installedRegistryPath: getInstalledPluginsRegistryPath(),
				projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(
					runtime.ctx.sessionManager.getCwd(),
				),
				marketplacesCacheDir: getMarketplacesCacheDir(),
				pluginsCacheDir: getPluginsCacheDir(),
				clearPluginRootsCache: clearPluginRootsAndCaches,
			});

			try {
				switch (sub) {
					case "add": {
						if (!rest) {
							runtime.ctx.showStatus(t("Usage: /marketplace add <source>"));
							return;
						}
						const entry = await mgr.addMarketplace(rest);
						runtime.ctx.showStatus(t("Added marketplace: {0}", `${entry.name}`));
						break;
					}
					case "remove":
					case "rm": {
						if (!rest) {
							runtime.ctx.showStatus(t("Usage: /marketplace remove <name>"));
							return;
						}
						await mgr.removeMarketplace(rest);
						runtime.ctx.showStatus(t("Removed marketplace: {0}", `${rest}`));
						break;
					}
					case "update": {
						if (rest) {
							await mgr.updateMarketplace(rest);
							runtime.ctx.showStatus(t("Updated marketplace: {0}", `${rest}`));
						} else {
							const results = await mgr.updateAllMarketplaces();
							runtime.ctx.showStatus(t("Updated {0} marketplace(s)", `${results.length}`));
						}
						break;
					}
					case "discover": {
						const plugins = await mgr.listAvailablePlugins(rest || undefined);
						if (plugins.length === 0) {
							const marketplaces = await mgr.listMarketplaces();
							if (marketplaces.length === 0) {
								runtime.ctx.showStatus(
									t("No marketplaces configured. Try:\n  /marketplace add anthropics/claude-plugins-official"),
								);
							} else {
								runtime.ctx.showStatus(t("No plugins available in configured marketplaces"));
							}
						} else {
							const lines = plugins.map(
								p =>
									`  ${p.name}${p.version ? `@${p.version}` : ""}${p.description ? ` - ${p.description}` : ""}`,
							);
							runtime.ctx.showStatus(t("Available plugins:\n{0}", `${lines.join("\n")}`));
						}
						break;
					}
					case "install": {
						// Parse: /marketplace install [--force] [--scope user|project] name@marketplace
						const parsed = parseMarketplaceInstallArgs(rest);
						if ("error" in parsed) {
							runtime.ctx.showStatus(parsed.error);
							return;
						}
						const atIdx = parsed.installSpec.lastIndexOf("@");
						const name = parsed.installSpec.slice(0, atIdx);
						const marketplace = parsed.installSpec.slice(atIdx + 1);
						await mgr.installPlugin(name, marketplace, { force: parsed.force, scope: parsed.scope });
						runtime.ctx.showStatus(`Installed ${name} from ${marketplace}`);
						break;
					}
					case "uninstall": {
						if (!rest) {
							// No args → open interactive uninstall selector
							runtime.ctx.showPluginSelector("uninstall");
							return;
						}
						const uninstArgs = parsePluginScopeArgs(
							rest,
							t("Usage: /marketplace uninstall [--scope user|project] <name@marketplace>"),
						);
						if ("error" in uninstArgs) {
							runtime.ctx.showStatus(uninstArgs.error);
							return;
						}
						await mgr.uninstallPlugin(uninstArgs.pluginId, uninstArgs.scope);
						runtime.ctx.showStatus(`Uninstalled ${uninstArgs.pluginId}`);
						break;
					}
					case "installed": {
						const installed = await mgr.listInstalledPlugins();
						if (installed.length === 0) {
							runtime.ctx.showStatus(t("No marketplace plugins installed"));
						} else {
							const lines = installed.map(
								p => t("  {0} [{1}]{2} ({3} entry)", `${p.id}`, `${p.scope}`, `${p.shadowedBy ? t(" [shadowed]\u0004packages/coding-agent/src/slash-commands/builtin-marketplace.ts:BUILTIN_MARKETPLACE_SLASH_COMMANDS.handle.lines") : ""}`, `${p.entries.length}`),
							);
							runtime.ctx.showStatus(t("Installed plugins:\n{0}", `${lines.join("\n")}`));
						}
						break;
					}
					case "upgrade": {
						if (rest) {
							const upArgs = parsePluginScopeArgs(
								rest,
								t("Usage: /marketplace upgrade [--scope user|project] <name@marketplace>"),
							);
							if ("error" in upArgs) {
								runtime.ctx.showStatus(upArgs.error);
								return;
							}
							const result = await mgr.upgradePlugin(upArgs.pluginId, upArgs.scope);
							runtime.ctx.showStatus(`Upgraded ${upArgs.pluginId} to ${result.version}`);
						} else {
							const results = await mgr.upgradeAllPlugins();
							if (results.length === 0) {
								runtime.ctx.showStatus(t("All marketplace plugins are up to date"));
							} else {
								const lines = results.map(r => `  ${r.pluginId}: ${r.from} -> ${r.to}`);
								runtime.ctx.showStatus(t("Upgraded {0} plugin(s):\n{1}", `${results.length}`, `${lines.join("\n")}`));
							}
						}
						break;
					}
					case "help": {
						runtime.ctx.showStatus(
							[
								t("Marketplace commands:"),
								t("  /marketplace                              Browse and install plugins"),
								t("  /marketplace add <source>                  Add a marketplace (e.g. owner/repo)"),
								t("  /marketplace remove <name>                 Remove a marketplace"),
								t("  /marketplace update [name]                 Re-fetch catalog(s)"),
								t("  /marketplace list                          List configured marketplaces"),
								t("  /marketplace discover [marketplace]        Browse available plugins"),
								t("  /marketplace install <name@marketplace>    Install a plugin"),
								t("  /marketplace uninstall <name@marketplace>  Uninstall a plugin"),
								t("  /marketplace installed                     List installed plugins"),
								t("  /marketplace upgrade [name@marketplace]    Upgrade plugin(s)"),
								"",
								t("Quick start:"),
								"  /marketplace add anthropics/claude-plugins-official",
								t("  /marketplace                               (opens interactive browser)"),
							].join("\n"),
						);
						break;
					}
					default: {
						const marketplaces = await mgr.listMarketplaces();
						if (marketplaces.length === 0) {
							runtime.ctx.showStatus(
								t("No marketplaces configured.\n\nGet started:\n  /marketplace add anthropics/claude-plugins-official\n\nThen browse plugins with /marketplace or /marketplace discover"),
							);
						} else {
							const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
							runtime.ctx.showStatus(
								t("Marketplaces:\n{0}\n\nUse /marketplace discover to browse plugins, or /marketplace help for all commands", `${lines.join("\n")}`),
							);
						}
						break;
					}
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				runtime.ctx.showStatus(t("Marketplace error: {0}", `${msg}`));
			}
		},
	},
	{
		name: "plugins",
		aliases: ["plugin"],
		icon: "package",
		description: t("View and manage installed plugins"),
		acpDescription: t("Manage plugins"),
		acpInputHint: "[list|enable|disable]",
		subcommands: [
			{ name: "list", description: t("List all installed plugins (npm + marketplace)") },
			{ name: "enable", description: t("Enable an installed plugin"), usage: "<plugin>" },
			{ name: "disable", description: t("Disable an installed plugin"), usage: "<plugin>" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			try {
				if (verb === "enable" || verb === "disable") {
					const parsed = parsePluginScopeArgs(rest, t("Usage: /plugins {0} [--scope user|project] <plugin>", `${verb}`));
					if ("error" in parsed) return usage(parsed.error, runtime);
					const marketplace = await createMarketplaceManager(runtime);
					const marketplaceIds = new Set((await marketplace.listInstalledPlugins()).map(plugin => plugin.id));
					await setInstalledPluginEnabled(parsed.pluginId, {
						enabled: verb === "enable",
						scope: parsed.scope,
						marketplaceIds,
						marketplace,
						npm: new PluginManager(),
					});
					await runtime.reloadPlugins();
					await runtime.output(`${verb === "enable" ? "Enabled" : "Disabled"} ${parsed.pluginId}`);
					return commandConsumed();
				}
				// Default: list
				const lines: string[] = [];
				const npmManager = new PluginManager();
				const npmPlugins = await npmManager.list();
				if (npmPlugins.length > 0) {
					lines.push(t("npm plugins:"));
					for (const plugin of npmPlugins) {
						const status = plugin.enabled === false ? t(" (disabled)") : "";
						lines.push(`  ${plugin.name}@${plugin.version}${status}`);
					}
				}

				const marketplaceManager = await createMarketplaceManager(runtime);
				const marketplacePlugins = await marketplaceManager.listInstalledPlugins();
				if (marketplacePlugins.length > 0) {
					if (lines.length > 0) lines.push("");
					lines.push(t("marketplace plugins:"));
					for (const plugin of marketplacePlugins) {
						const entry = plugin.entries[0];
						const status = entry?.enabled === false ? t(" (disabled)") : "";
						const shadowed = plugin.shadowedBy ? " [shadowed]" : "";
						lines.push(`  ${plugin.id} v${entry?.version ?? "?"}${status} [${plugin.scope}]${shadowed}`);
					}
				}

				await runtime.output(lines.length === 0 ? t("No plugins installed") : lines.join("\n"));
				return commandConsumed();
			} catch (err) {
				return usage(t("Plugin error: {0}", `${errorMessage(err)}`), runtime);
			}
		},
	},
	{
		name: "reload-plugins",
		icon: "restart",
		description: t("Reload all plugins (skills, commands, hooks, tools, agents, MCP)"),
		acpDescription: t("Reload all plugins"),
		handle: async (_command, runtime) => {
			await runtime.reloadPlugins();
			await runtime.output(t("Plugins reloaded."));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await reloadTuiPluginState(runtime.ctx);
			runtime.ctx.showStatus(t("Plugins reloaded."));
			clearSubmittedText(runtime);
		},
	},
];
