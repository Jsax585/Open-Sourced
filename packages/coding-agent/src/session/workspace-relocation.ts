/**
 * Headless workspace relocation for the `session` tool's `move` op: the same
 * flow `/move` runs in RPC/ACP (`relocateHeadlessSession`), driven by the
 * session itself instead of a slash-command runtime. The interactive mode
 * installs its own relocator over this one so the UI follows the move.
 */
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../discovery/helpers";
import type { AgentSession } from "./agent-session";

export function createHeadlessWorkspaceRelocator(session: AgentSession): (directory: string) => Promise<void> {
	return async directory => {
		// Loaded on first use: the slash-command module is heavy and no startup path needs it.
		const { relocateHeadlessSession } = await import("../slash-commands/builtin-lifecycle");
		const messages: string[] = [];
		const failure = await relocateHeadlessSession(
			{
				session,
				sessionManager: session.sessionManager,
				settings: session.settings,
				cwd: session.sessionManager.getCwd(),
				output: text => {
					messages.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {
					const projectPath = await resolveActiveProjectRegistryPath(session.sessionManager.getCwd());
					clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
					await session.refreshSkillsAndCommands();
				},
			},
			directory,
		);
		if (failure) throw new Error(messages.join(" ") || `Could not move the session to ${directory}.`);
		session.emitNotice("info", `Moved session to ${session.sessionManager.getCwd()}`, "session-move");
	};
}
