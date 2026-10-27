import { t } from "@oh-my-pi/pi-utils/i18n";
import { SEANCE_SLASH_COMMAND } from "./seance";
import { clearSubmittedText, refuseImages, runWithDetachedDraft } from "./helpers/draft";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CompactionCancelledError } from "@oh-my-pi/pi-agent-core/compaction";
import { logger, setProjectDir } from "@oh-my-pi/pi-utils";
import { clearClaudePluginRootsCache } from "../discovery/helpers";
import { rebindMemoryBackendForCwd } from "../hindsight/backend";
import { memoryStatsUnavailableMessage, resolveMemoryBackend } from "../memory-backend";
import type { FreshSessionResult, HandoffResult } from "../session/agent-session";
import { COMPACT_MODES, parseCompactArgs } from "../session/compact-modes";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import { resolveResumableSession } from "../session/session-listing";
import { toggleSessionPin } from "../session/session-pins";
import {
	cleanSourceCheckoutIfConfigured,
	createSessionWorktree,
	defaultSessionWorktreeBranch,
	formatSessionWorktreeSummary,
	type SessionWorktree,
} from "../session/session-worktree";
import { formatShakeSummary, type ShakeMode } from "../session/shake-types";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "../system-prompt";
import { resolveToCwd } from "../tools/path-utils";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import { handleSshAcp } from "./helpers/ssh";
import type {
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

function formatFreshSessionResult(result: FreshSessionResult): string {
	const stateLabel = t("provider state");
	return t("Fresh provider session started ({1} {0} pruned).\u0004packages/coding-agent/src/slash-commands/builtin-lifecycle.ts:formatFreshSessionResult", `${stateLabel}`, `${result.closedProviderSessions}`);
}

export const shutdownHandlerTui = (
	_command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
): SlashCommandResult => {
	clearSubmittedText(runtime);
	void runtime.ctx.shutdown();
	return commandConsumed();
};

/** Parse the `/shake` subcommand into a {@link ShakeMode}; empty defaults to elide. */
function parseShakeMode(args: string): ShakeMode | { error: string } {
	const verb = args.trim().toLowerCase();
	if (verb === "" || verb === "elide") return "elide";
	if (verb === "images") return "images";
	if (verb === "thinking") return "thinking";
	return { error: t("Unknown /shake mode \"{0}\". Use elide, images, or thinking.", `${verb}`) };
}

/** Format the session's workspace directories (cwd + additional) for display. */
function formatWorkspaceDirectories(runtime: SlashCommandRuntime, note?: string): string {
	const cwd = runtime.sessionManager.getCwd();
	const additional = runtime.sessionManager.getAdditionalDirectories();
	const lines = [t("Workspace directories:"), t("  {0} (working directory)", `${cwd}`), ...additional.map(d => `  ${d}`)];
	return note ? `${note}\n${lines.join("\n")}` : lines.join("\n");
}
async function fatalMoveFailure(text: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	await runtime.output(text);
	await runtime.session.dispose();
	return commandConsumed();
}

/** A move rollback failed: re-align the workspace to wherever the session ended up and report it. */
async function reportFailedRollback(runtime: SlashCommandRuntime, rollbackError: unknown): Promise<SlashCommandResult> {
	const actual = runtime.sessionManager.getCwd();
	try {
		await rescopeHeadlessToCwd(runtime, actual);
	} catch {
		return fatalMoveFailure(
			t("Move failed and rollback failed: {0} (failed to re-align workspace to {1}; process remains at source while session is at {2})", `${errorMessage(rollbackError)}`, `${actual}`, `${actual}`),
			runtime,
		);
	}
	return usage(
		t("Move failed and rollback failed: {0} (workspace remains at {1})", `${errorMessage(rollbackError)}`, `${actual}`),
		runtime,
	);
}

/**
 * Relocate the headless session to `resolvedPath` (an existing directory):
 * flush settings, move the session file, re-scope the process, rolling back
 * on failure. Returns a result when the move did not complete; `undefined`
 * on success so the caller can report its own confirmation.
 */
async function relocateHeadlessSession(
	runtime: SlashCommandRuntime,
	resolvedPath: string,
): Promise<SlashCommandResult | undefined> {
	try {
		await runtime.settings.flush();
	} catch (err) {
		return usage(t("Failed to save pending settings: {0}\u0004packages/coding-agent/src/modes/controllers/selector-controller.ts:SelectorController.showSessionSelector", `${errorMessage(err)}`), runtime);
	}
	const previousState = runtime.sessionManager.captureState();
	try {
		await runtime.session.moveSession(resolvedPath);
	} catch (err) {
		return usage(t("Move failed: {0}", `${errorMessage(err)}`), runtime);
	}
	try {
		setProjectDir(resolvedPath);
	} catch (err) {
		try {
			await runtime.sessionManager.rollbackMove(previousState);
		} catch (rollbackError) {
			return reportFailedRollback(runtime, rollbackError);
		}
		return usage(t("Move failed: {0}", `${errorMessage(err)}`), runtime);
	}
	try {
		await rescopeHeadlessToCwd(runtime, resolvedPath);
	} catch (err) {
		try {
			await runtime.sessionManager.rollbackMove(previousState);
			await rescopeHeadlessToCwd(runtime, previousState.cwd);
		} catch (rollbackError) {
			return reportFailedRollback(runtime, rollbackError);
		}
		return usage(t("Move failed: {0}", `${errorMessage(err)}`), runtime);
	}
	await runtime.notifyConfigChanged?.();
	await runtime.notifyTitleChanged?.();
	return undefined;
}

export const BUILTIN_LIFECYCLE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "ssh",
		icon: "host",
		description: t("Manage SSH hosts (add, list, remove)"),
		acpDescription: t("Manage SSH connections"),
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: t("Add an SSH host"),
				usage: "<name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--scope project|user]",
			},
			{ name: "list", description: t("List all configured SSH hosts") },
			{ name: "remove", description: t("Remove an SSH host"), usage: "<name> [--scope project|user]" },
			{ name: "help", description: t("Show help message") },
		],
		allowArgs: true,
		handle: handleSshAcp,
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleSSHCommand(command.text);
		},
	},
	{
		name: "new",
		icon: "plus",
		description: t("Start a new session"),
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleNewCommand();
		},
	},
	{
		name: "fresh",
		icon: "restart",
		description: t("Reset provider stream state without changing the local transcript"),
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.session.isStreaming ? t("Fresh: unavailable while streaming") : t("Fresh: ready"),
		handle: async (_command, runtime) => {
			const result = runtime.session.freshSession();
			if (!result) {
				await runtime.output(
					t("Wait for the current response to finish or abort it before refreshing provider state."),
				);
				return commandConsumed();
			}
			await runtime.output(formatFreshSessionResult(result));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleFreshCommand();
		},
	},
	{
		name: "clear",
		icon: "eraser",
		description: t("Clear the conversation context in place, keeping the session"),
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.session.isStreaming ? t("Clear: unavailable while streaming") : t("Clear: drop context, keep session"),
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleResetContextCommand();
		},
	},
	{
		name: "delete",
		icon: "trash",
		description: t("Delete the current session and start a new one"),
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleDeleteCommand();
		},
	},
	{
		name: "compact",
		icon: "compress",
		description: t("Manually compact the session context"),
		acpDescription: t("Compact the conversation"),
		subcommands: COMPACT_MODES.map(mode => ({
			name: mode.name,
			description: mode.description,
			usage: mode.rejectsFocus ? undefined : "[focus]",
		})),
		acpInputHint: `[${COMPACT_MODES.map(mode => mode.name).join("|")}] [focus]`,
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const usage = runtime.ctx.session.getContextUsage();
			return usage ? t("Compact: context {0}% used", `${Math.round(usage.percent)}`) : t("Compact: context unavailable");
		},
		handle: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);
			// Print mode turns a failed compaction into a nonzero exit; the
			// flag is closure state because the background-dispatch branch
			// (RPC) returns before `runCompact` settles.
			let compactFailed = false;
			const runCompact = async (): Promise<void> => {
				const before = runtime.session.getContextUsage?.();
				const beforeTokens = before?.tokens;
				try {
					await runtime.session.compact(parsed.instructions, parsed.mode ? { mode: parsed.mode } : undefined);
				} catch (err) {
					// RPC `abort` and ACP `session/cancel` propagate their explicit
					// USER_INTERRUPT_LABEL through the compaction abort signal. The client
					// already saw the interrupt it sent; emitting anything here would
					// append an out-of-turn chunk. Other cancellations (including an
					// extension veto) remain visible.
					if (err instanceof CompactionCancelledError && err.cause === USER_INTERRUPT_LABEL) return;
					// Compaction precondition failures (no model, already compacted, too
					// small) and provider errors propagate as plain Errors; surface them
					// via runtime.output so they don't fail the ACP prompt turn.
					compactFailed = true;
					await runtime.output(t("Compaction failed: {0}", `${errorMessage(err)}`));
					return;
				}
				const after = runtime.session.getContextUsage?.();
				const afterTokens = after?.tokens;
				if (beforeTokens != null && afterTokens != null) {
					const saved = beforeTokens - afterTokens;
					await runtime.output(t("Compaction complete. Tokens: {0} -> {1} (saved {2}).", `${beforeTokens}`, `${afterTokens}`, `${saved}`));
				} else {
					await runtime.output(t("Compaction complete."));
				}
			};
			// Provider-backed: background-dispatch under RPC so the serialized command
			// queue stays free for `abort` (SlashCommandRuntime.runCommandInBackground).
			// ACP/TUI have no such hook and keep the inline await.
			if (runtime.runCommandInBackground) {
				runtime.runCommandInBackground(runCompact);
				return commandConsumed();
			}
			await runCompact();
			return commandConsumed({ failed: compactFailed });
		},
		handleTui: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			clearSubmittedText(runtime);
			if ("error" in parsed) {
				runtime.ctx.showWarning(parsed.error);
				return;
			}
			await runtime.ctx.handleCompactCommand(parsed.instructions, parsed.mode);
		},
	},
	{
		name: "shake",
		icon: "vibrate",
		description: t("Drop heavy content from context (tool results, large blocks)"),
		acpDescription: t("Shake heavy content out of the conversation context"),
		subcommands: [
			{ name: "elide", description: t("Strip tool results + large blocks (default)") },
			{ name: "images", description: t("Strip image blocks") },
			{ name: "thinking", description: t("Drop all thinking blocks") },
		],
		acpInputHint: "[elide|images|thinking]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") return usage(mode.error, runtime);
			const result = await runtime.session.shake(mode);
			await runtime.output(formatShakeSummary(result));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") {
				runtime.ctx.showWarning(mode.error);
				return;
			}
			await runtime.ctx.handleShakeCommand(mode);
		},
	},
	{
		name: "handoff",
		icon: "handoff",
		description: t("Summarize the session into a handoff document and compact in place"),
		acpDescription: t("Summarize the session into a handoff document and compact in place"),
		inlineHint: t("[focus instructions]"),
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) {
				return usage(t("Wait for the current response to finish or abort it before handing off."), runtime);
			}
			if (runtime.session.isGeneratingHandoff) {
				return usage(t("Handoff generation is already in progress."), runtime);
			}
			// Print mode turns a failed handoff into a nonzero exit; closure
			// state because the background-dispatch branch (RPC) returns
			// before `runHandoff` settles.
			let handoffFailed = false;
			const runHandoff = async (): Promise<void> => {
				let result: HandoffResult | undefined;
				try {
					result = await runtime.session.handoff(command.args || undefined);
				} catch (err) {
					const message = errorMessage(err);
					// A user interrupt (ACP `session/cancel`, TUI Esc) already settled the
					// owning turn: `AgentSession.abort()` forwards its reason into the
					// handoff abort controller, and `throwIfHandoffAborted` rethrows a
					// reasoned abort verbatim — so the throw arrives as
					// `USER_INTERRUPT_LABEL`, not "Handoff cancelled". Emitting anything
					// here would append an out-of-turn chunk after the client already saw
					// `stopReason: "cancelled"`, so consume silently.
					if (message === USER_INTERRUPT_LABEL) {
						return;
					}
					// `session.handoff()` normalizes an unreasoned cancellation to this
					// exact message; every other throw is a real failure (no model
					// selected, nothing to hand off, already compacted, provider error)
					// and is surfaced verbatim behind the same "<verb> failed:" prefix
					// `/compact` uses.
					if (message === "Handoff cancelled") {
						await runtime.output(t("Handoff cancelled."));
						return;
					}
					// Persist the real failure so it stays debuggable after the client
					// message scrolls away (same rationale as the TUI path, #7993).
					logger.error("Handoff failed", { error: message });
					handoffFailed = true;
					await runtime.output(t("Handoff failed: {0}", `${message}`));
					return;
				}
				if (!result) {
					await runtime.output(t("Handoff cancelled."));
					return;
				}
				// `savedPath` is deliberately not reported: `SessionHandoff` only writes
				// the document to disk when `options.autoTriggered` is set, which the
				// user-invoked path never passes.
				await runtime.output(t("Context handed off and compacted in place."));
			};
			if (runtime.runCommandInBackground) {
				runtime.runCommandInBackground(runHandoff);
				return commandConsumed();
			}
			await runHandoff();
			return commandConsumed({ failed: handoffFailed });
		},
		handleTui: async (command, runtime) => {
			if (refuseImages(command, runtime)) return;
			const customInstructions = command.args || undefined;
			clearSubmittedText(runtime);
			await runtime.ctx.handleHandoffCommand(customInstructions);
		},
	},
	SEANCE_SLASH_COMMAND,
	{
		name: "resume",
		icon: "history",
		description: t("Resume a different session"),
		inlineHint: t("[session id|@claude|@codex]"),
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const sessionArg = command.args.trim();
			clearSubmittedText(runtime);
			const foreignSource = sessionArg === "@claude" ? "claude" : sessionArg === "@codex" ? "codex" : undefined;
			if (foreignSource) {
				runtime.ctx.showSessionSelector(foreignSource);
				return;
			}
			if (!sessionArg) {
				runtime.ctx.showSessionSelector();
				return;
			}
			const match = await resolveResumableSession(
				sessionArg,
				runtime.ctx.sessionManager.getCwd(),
				runtime.ctx.sessionManager.getSessionDir(),
				{ allowGlobalFallback: true },
			);
			if (!match) {
				runtime.ctx.showError(t("Session \"{0}\" not found", `${sessionArg}`));
				return;
			}
			try {
				await runtime.ctx.handleResumeSession(match.session.path);
			} catch (error) {
				// The picker reports a failed switch itself; `/resume <id>` has no picker.
				runtime.ctx.showError(error instanceof Error ? error.message : String(error));
			}
		},
	},
	{
		name: "pin",
		icon: "pin",
		description: t("Pin or unpin a session at the top of the resume list"),
		inlineHint: t("[session id]"),
		allowArgs: true,
		handle: async (command, runtime) => {
			const sessionArg = command.args.trim();
			let sessionId: string | undefined;
			if (sessionArg) {
				const match = await resolveResumableSession(
					sessionArg,
					runtime.cwd,
					runtime.sessionManager.getSessionDir(),
					{ allowGlobalFallback: true },
				);
				if (!match) {
					return usage(t("Session \"{0}\" not found.\u0004packages/coding-agent/src/main.ts:createSessionManager", `${sessionArg}`), runtime);
				}
				sessionId = match.session.id;
			} else {
				sessionId = runtime.sessionManager.getSessionId();
				if (!sessionId) {
					return usage(t("No active session to pin."), runtime);
				}
			}
			const pinned = await toggleSessionPin(sessionId);
			await runtime.output(pinned ? t("Session pinned to the top of the resume list.") : t("Session unpinned."));
			return commandConsumed();
		},
	},
	{
		name: "btw",
		icon: "question",
		description: t("Ask a side question, or browse this session's BTW history"),
		inlineHint: "[question]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const question = command.text.slice(`/${command.name}`.length).trim();
			await runWithDetachedDraft(
				command,
				runtime,
				() => runtime.ctx.handleBtwCommand(question, runtime.input?.images),
				{ restoreText: true },
			);
		},
	},
	{
		name: "tan",
		icon: "rocket",
		description: t("Run a full background agent on tangential work"),
		inlineHint: "<work>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const work = command.text.slice(`/${command.name}`.length).trim();
			await runWithDetachedDraft(command, runtime, () => runtime.ctx.handleTanCommand(work, runtime.input?.images), {
				restoreText: true,
			});
		},
	},
	{
		name: "omfg",
		icon: "rule",
		description: t("Forge a TTSR rule from a complaint to stop a recurring behavior"),
		inlineHint: "<complaint>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			if (refuseImages(command, runtime)) return;
			const complaint = command.text.slice(`/${command.name}`.length).trim();
			clearSubmittedText(runtime);
			await runtime.ctx.handleOmfgCommand(complaint);
		},
	},
	{
		name: "cleanse",
		icon: "stethoscope",
		description: t("Detect and fix project diagnostics with weighted parallel subagents\u0004packages/coding-agent/src/slash-commands/builtin-lifecycle.ts:BUILTIN_LIFECYCLE_SLASH_COMMANDS.description"),
		inlineHint: "[request] [--all]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			if (refuseImages(command, runtime)) return;
			const args = command.text.slice(`/${command.name}`.length).trim();
			clearSubmittedText(runtime);
			await runtime.ctx.handleCleanseCommand(args);
		},
	},
	{
		name: "retry",
		icon: "redo",
		description: t("Retry the last failed agent turn"),
		handle: async (_command, runtime) => {
			if (runtime.session.isStreaming) {
				return usage(t("Wait for the current response to finish or abort it before retrying."), runtime);
			}
			const didRetry = await runtime.session.retry();
			if (!didRetry) {
				return usage(t("Nothing to retry."), runtime);
			}
			await runtime.output(t("Retrying the last failed turn."));
			// `AgentSession.retry()` only schedules the continuation as a
			// post-prompt task; it returns before the retried turn streams. Hosts
			// whose prompt turn owns the event subscription (ACP) must stay open
			// across that turn — `AcpAgent.prompt` installs the subscription
			// before running the command and `#finishPrompt` unsubscribes, so
			// returning early would silently swallow the entire retried turn
			// (model output and tool calls). RPC and TUI omit this hook: they
			// stream the continuation through their own session subscription, and
			// blocking their command queue here would strand a follow-up `abort`.
			await runtime.keepTurnOpenUntilIdle?.();
			// `retry()` returned true, so a real agent turn is now scheduled — RPC
			// hosts must not be told this was local-only work.
			return commandConsumed({ agentInvoked: true });
		},
		handleTui: async (_command, runtime) => {
			const didRetry = await runtime.ctx.session.retry();
			if (!didRetry) {
				runtime.ctx.showStatus(t("Nothing to retry\u0004packages/coding-agent/src/slash-commands/builtin-lifecycle.ts:BUILTIN_LIFECYCLE_SLASH_COMMANDS.handleTui"));
			}
			clearSubmittedText(runtime);
		},
	},
	{
		name: "debug",
		icon: "bug",
		description: t("Open debug tools selector"),
		handleTui: async (_command, runtime) => {
			await runtime.ctx.showDebugSelector();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "memory",
		icon: "memory",
		description: t("Inspect and operate memory maintenance"),
		acpDescription: t("Manage memory"),
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "view", description: t("Show current memory injection payload") },
			{ name: "stats", description: t("Show memory backend statistics") },
			{ name: "diagnose", description: t("Run memory backend diagnostics") },
			{ name: "queue", description: t("Show pending memory deltas awaiting consolidation") },
			{ name: "sync", description: t("Run memory consolidation now") },
			{ name: "clear", description: t("Clear persisted memory data and artifacts") },
			{ name: "reset", description: t("Alias for clear") },
			{ name: "enqueue", description: t("Enqueue memory consolidation maintenance") },
			{ name: "rebuild", description: t("Alias for enqueue") },
			{ name: "mm list", description: t("List mental models on the active bank") },
			{ name: "mm show", description: t("Show one mental model (id required)") },
			{
				name: "mm refresh",
				description: t("Refresh auto-refresh models bank-wide, or one model by id"),
			},
			{ name: "mm history", description: t("Diff the change history of a mental model") },
			{ name: "mm seed", description: t("Create any built-in mental models that are missing") },
			{ name: "mm delete", description: t("Delete a mental model from the bank (id required)") },
			{ name: "mm reload", description: t("Re-pull the cached <mental_models> block") },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const verb = (command.args.trim().split(/\s+/)[0] ?? "").toLowerCase() || "view";
			const backend = await resolveMemoryBackend(runtime.settings);
			switch (verb) {
				case "view": {
					const payload = await backend.buildDeveloperInstructions(
						runtime.settings.getAgentDir(),
						runtime.cwd,
						runtime.settings,
						runtime.session,
					);
					await runtime.output(payload || t("Memory payload is empty."));
					return commandConsumed();
				}
				case "clear":
				case "reset": {
					await backend.clear(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.session.refreshBaseSystemPrompt();
					await runtime.output(t("Memory cleared."));
					return commandConsumed();
				}
				case "enqueue":
				case "rebuild": {
					await backend.enqueue(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output(t("Memory consolidation enqueued.\u0004packages/coding-agent/src/slash-commands/builtin-lifecycle.ts:BUILTIN_LIFECYCLE_SLASH_COMMANDS.handle"));
					return commandConsumed();
				}
				case "queue": {
					const payload = await backend.queuePreview?.({
						agentDir: runtime.settings.getAgentDir(),
						cwd: runtime.cwd,
						session: runtime.session,
					});
					await runtime.output(payload ?? t("Memory queue is not available for the {0} backend.", `${backend.id}`));
					return commandConsumed();
				}
				case "sync": {
					await backend.enqueue(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output(t("Memory consolidation ran."));
					return commandConsumed();
				}
				case "stats":
				case "diagnose": {
					const hook = verb === "stats" ? backend.stats : backend.diagnose;
					const payload = await hook?.(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output(payload ?? memoryStatsUnavailableMessage(backend.id, verb));
					return commandConsumed();
				}
				case "mm":
					return usage(
						t("Mental-model maintenance via /memory mm is unsupported in ACP mode; use the hindsight HTTP API directly."),
						runtime,
					);
				default:
					return usage("Usage: /memory <view|stats|diagnose|clear|reset|enqueue|rebuild|queue|sync>", runtime);
			}
		},
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleMemoryCommand(command.text);
		},
	},
	{
		name: "rename",
		icon: "pencil",
		description: t("Rename the current session (omit title to generate)"),
		inlineHint: "[title]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const session = runtime.session;
			const sessionManager = runtime.sessionManager;
			const runRename = async (): Promise<void> => {
				const sessionId = sessionManager.getSessionId();
				const titleSignal = session.titleGenerationSignal;
				let titleRevision = sessionManager.titleRevision;
				const isCurrent = () =>
					runtime.session === session &&
					runtime.sessionManager === sessionManager &&
					!runtime.signal?.aborted &&
					// An interrupt cancels a generated title; a typed one applies regardless.
					!(titleSignal.aborted && !command.args) &&
					sessionManager.getSessionId() === sessionId &&
					sessionManager.titleRevision === titleRevision;
				try {
					const generation = session.renameTitle(command.args, runtime.signal);
					titleRevision = sessionManager.titleRevision;
					const title = await generation;
					if (!isCurrent() || title === undefined) return;
					if (!title) {
						await runtime.output(t("Could not generate a session title. Use /rename <title> to set one."));
						return;
					}
					const persistence = sessionManager.setSessionName(title, "user");
					titleRevision = sessionManager.titleRevision;
					const ok = await persistence;
					if (!isCurrent()) return;
					if (!ok) {
						await runtime.output(t("Session name not changed (a user-set name takes precedence)."));
						return;
					}
					await runtime.notifyTitleChanged?.();
					if (!isCurrent()) return;
					await runtime.output(t("Session renamed to {0}.", `${title}`));
				} catch (err) {
					if (!isCurrent()) return;
					if (command.args || !runtime.runCommandInBackground) throw err;
					await runtime.output(t("Rename failed: {0}", `${errorMessage(err)}`));
				}
			};
			if (!command.args && runtime.runCommandInBackground) {
				runtime.runCommandInBackground(runRename);
				return commandConsumed();
			}
			await runRename();
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const session = runtime.ctx.session;
			const sessionManager = runtime.ctx.sessionManager;
			const sessionId = sessionManager.getSessionId();
			// `renameTitle` resolves undefined for a generated title an interrupt cancelled.
			const generation = session.renameTitle(command.args.trim());
			const titleRevision = sessionManager.titleRevision;
			const title = await generation;
			if (
				runtime.ctx.session !== session ||
				runtime.ctx.sessionManager !== sessionManager ||
				sessionManager.getSessionId() !== sessionId ||
				sessionManager.titleRevision !== titleRevision ||
				title === undefined
			)
				return;
			if (!title) {
				runtime.ctx.showStatus(t("Could not generate a session title. Use /rename <title> to set one."));
				return;
			}
			await runtime.ctx.handleRenameCommand(title);
		},
	},
	{
		name: "move",
		icon: "folderMove",
		description: t("Move the current session to a different directory"),
		acpDescription: t("Move the current session to a different directory"),
		inlineHint: "[<path>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage(t("Cannot move while streaming."), runtime);
			if (!command.args) return usage(t("Usage: /move <path>"), runtime);
			const resolvedPath = resolveToCwd(command.args, runtime.cwd);
			try {
				const stat = await fs.stat(resolvedPath);
				if (!stat.isDirectory()) {
					return usage(t("Not a directory: {0}", `${resolvedPath}`), runtime);
				}
			} catch {
				return usage(t("Directory does not exist: {0}", `${resolvedPath}`), runtime);
			}
			const failure = await relocateHeadlessSession(runtime, resolvedPath);
			if (failure) return failure;
			await runtime.output(t("Moved to {0}.", `${runtime.sessionManager.getCwd()}`));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			clearSubmittedText(runtime);
			await runtime.ctx.handleMoveCommand(command.args || undefined);
		},
	},
	{
		name: "wt",
		aliases: ["worktree"],
		icon: "folderMove",
		description: t("Move this session into a new worktree, changes included"),
		acpDescription: t("Move this session into a new worktree, changes included"),
		inlineHint: "[<branch>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage(t("Cannot create a worktree while streaming."), runtime);
			const branch = command.args.trim() || defaultSessionWorktreeBranch();
			const sourceCwd = runtime.sessionManager.getCwd();
			let worktree: SessionWorktree;
			try {
				worktree = await createSessionWorktree(sourceCwd, runtime.settings, branch);
			} catch (err) {
				return usage(t("Worktree creation failed: {0}", `${errorMessage(err)}`), runtime);
			}
			const failure = await relocateHeadlessSession(runtime, worktree.path);
			if (failure) return failure;
			const cleanup = await cleanSourceCheckoutIfConfigured(sourceCwd, runtime.settings);
			if (cleanup.errorMessage !== undefined) {
				await runtime.output(
					t("Warning: Worktree created, but cleaning source checkout failed: {0}", `${cleanup.errorMessage}`),
				);
			}
			await runtime.output(formatSessionWorktreeSummary(worktree, cleanup.cleaned));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			clearSubmittedText(runtime);
			await runtime.ctx.handleWorktreeCommand(command.args || undefined);
		},
	},
	{
		name: "add-dir",
		icon: "folderPlus",
		description: t("Add a workspace directory to this session (multi-root)"),
		acpDescription: t("Add a workspace directory to this session"),
		inlineHint: "<path>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage(t("Cannot add a directory while streaming."), runtime);
			if (!command.args) return usage(formatWorkspaceDirectories(runtime, t("Usage: /add-dir <path>")), runtime);
			const resolved = resolveToCwd(command.args, runtime.cwd);
			try {
				const stat = await fs.stat(resolved);
				if (!stat.isDirectory()) return usage(t("Not a directory: {0}", `${resolved}`), runtime);
			} catch {
				return usage(t("Directory does not exist: {0}", `${resolved}`), runtime);
			}
			let added: string | null;
			try {
				added = await runtime.sessionManager.addWorkspaceDirectory(resolved);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			if (added === null) {
				await runtime.output(t("Already in the workspace: {0}", `${resolved}`));
				return commandConsumed();
			}
			await runtime.session.refreshBaseSystemPrompt();
			await runtime.output(formatWorkspaceDirectories(runtime, `Added ${added}.`));
			return commandConsumed();
		},
	},
	{
		name: "remove-dir",
		icon: "folderMinus",
		description: t("Remove a workspace directory from this session"),
		acpDescription: t("Remove a workspace directory from this session"),
		inlineHint: "<path>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage(t("Cannot remove a directory while streaming."), runtime);
			if (!command.args) return usage(t("Usage: /remove-dir <path>"), runtime);
			const resolved = resolveToCwd(command.args, runtime.cwd);
			if (resolved === path.resolve(runtime.cwd)) {
				return usage(t("Cannot remove the working directory; use /move to change it."), runtime);
			}
			let removed: string | null;
			try {
				removed = await runtime.sessionManager.removeWorkspaceDirectory(resolved);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			if (removed === null) {
				await runtime.output(t("Not a workspace directory: {0}", `${resolved}`));
				return commandConsumed();
			}
			await runtime.session.refreshBaseSystemPrompt();
			await runtime.output(formatWorkspaceDirectories(runtime, `Removed ${removed}.`));
			return commandConsumed();
		},
	},
	{
		name: "dirs",
		description: t("List this session's workspace directories"),
		acpDescription: t("List this session's workspace directories"),
		handle: async (_command, runtime) => {
			await runtime.output(formatWorkspaceDirectories(runtime));
			return commandConsumed();
		},
	},
	{
		name: "exit",
		description: t("Exit the application"),
		handleTui: shutdownHandlerTui,
	},
	{
		name: "restart",
		icon: "restart",
		description: t("Restart omp with the same launch flags, resuming this session"),
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.restart();
		},
	},
];
async function rescopeHeadlessToCwd(runtime: SlashCommandRuntime, cwd: string): Promise<void> {
	setProjectDir(cwd);
	await runtime.settings.reloadForCwd(cwd);
	await rebindMemoryBackendForCwd(runtime.session);
	clearClaudePluginRootsCache();
	const src = discoverTitleSystemPromptFile(cwd);
	const p = await resolvePromptInput(src, "title system prompt");
	runtime.session.setTitleSystemPrompt(p);
	await runtime.session.refreshSkillsAndCommands();
	await runtime.refreshCommands?.();
	await runtime.reloadPlugins();
}
