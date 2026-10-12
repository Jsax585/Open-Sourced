import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { pathIsWithin, prompt } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import sessionDescription from "../prompts/tools/session.md" with { type: "text" };
import { createSessionWorktree, type SessionWorktree } from "../session/session-worktree";
import type { ToolSession } from ".";
import { resolveToCwd } from "./path-utils";
import { throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

/** Session mutations the tool needs from the owning session; absent for subagents and advisors. */
export interface SessionControl {
	/** Retitle the session. Resolves false when the title is empty or the session is released. */
	rename(title: string): Promise<boolean>;
	/** Whether this host can relocate the session workspace. Only hosts that own the process cwd can. */
	canMove(): boolean;
	/** Queue a workspace move for the next step boundary. Throws when the host cannot relocate. */
	requestMove(directory: string): void;
	/** Directory of a queued, not yet applied move. */
	pendingMove(): string | undefined;
}

const sessionSchema = type({
	op: type("'rename' | 'move' | 'worktree_list' | 'worktree_create' | 'worktree_remove'").describe(
		"session operation",
	),
	"title?": type("string").describe("new session title (rename)"),
	"path?": type("string").describe("directory (move) or worktree path (worktree_remove)"),
	"branch?": type("string").describe("new branch name for the worktree (worktree_create)"),
	"carryChanges?": type("boolean").describe("copy uncommitted changes into the new worktree (worktree_create)"),
	"move?": type("boolean").describe("also move the session into the new worktree (worktree_create)"),
	"force?": type("boolean").describe("remove a worktree with uncommitted changes (worktree_remove)"),
});

type SessionParams = typeof sessionSchema.infer;

export interface SessionToolDetails {
	op: SessionParams["op"];
	path?: string;
	branch?: string;
	/** True when a move was queued and has not been applied yet. */
	moveQueued?: boolean;
	meta?: OutputMeta;
}

const MOVE_UNSUPPORTED = "This host cannot move the session workspace. Ask the user to run /move.";

function requireText(value: string | undefined, field: string, op: string): string {
	const text = value?.trim();
	if (!text) throw new ToolError(`session ${op} requires \`${field}\`.`);
	return text;
}

/** Whether `git worktree lock` protects the checkout: its admin directory holds a `locked` file. */
async function isWorktreeLocked(worktreePath: string): Promise<boolean> {
	try {
		const pointer = (await fs.readFile(path.join(worktreePath, ".git"), "utf8")).trim();
		const gitdir = pointer.startsWith("gitdir:") ? pointer.slice("gitdir:".length).trim() : undefined;
		if (!gitdir) return false;
		await fs.stat(path.join(path.resolve(worktreePath, gitdir), "locked"));
		return true;
	} catch {
		return false;
	}
}

async function realpathOrSelf(target: string): Promise<string> {
	try {
		return await fs.realpath(target);
	} catch {
		return path.resolve(target);
	}
}

export class SessionTool implements AgentTool<typeof sessionSchema, SessionToolDetails> {
	readonly name = "session";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const op = (args as Partial<SessionParams> | null)?.op;
		if (op === "worktree_list") return "read";
		return op === "rename" ? "write" : "exec";
	};
	readonly label = "Session";
	readonly summary = "Rename or move the session, and manage git worktrees";
	readonly loadMode = "discoverable";
	readonly description = prompt.render(sessionDescription);
	readonly parameters = sessionSchema;
	readonly strict = true;
	// Mutating ops race on the pending move and on the worktree registry (a removal reads the pending
	// move before a concurrent `move` queues it), so only the read-only listing may overlap.
	readonly concurrency = (args: Partial<SessionParams>): "shared" | "exclusive" =>
		args.op === "worktree_list" ? "shared" : "exclusive";
	readonly intent = (args: Partial<SessionParams>): string => (args.op ? `session ${args.op}` : "session");

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): SessionTool | null {
		return session.sessionControl ? new SessionTool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: SessionParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SessionToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SessionToolDetails>> {
		const control = this.session.sessionControl;
		if (!control) throw new ToolError("The session tool is unavailable in this session.");
		throwIfAborted(signal);
		switch (params.op) {
			case "rename": {
				const title = requireText(params.title, "title", "rename");
				if (!(await control.rename(title))) throw new ToolError("The session title was not changed.");
				return toolResult<SessionToolDetails>({ op: "rename" }).text(`Session renamed to "${title}".`).done();
			}
			case "move": {
				if (!control.canMove()) throw new ToolError(MOVE_UNSUPPORTED);
				const target = await this.#resolveMoveTarget(requireText(params.path, "path", "move"));
				control.requestMove(target);
				return toolResult<SessionToolDetails>({ op: "move", path: target, moveQueued: true })
					.text(this.#queuedMoveText(target))
					.done();
			}
			case "worktree_list":
				return await this.#list();
			case "worktree_create":
				return await this.#create(control, params, signal);
			case "worktree_remove":
				return await this.#remove(control, params);
		}
	}

	async #resolveMoveTarget(input: string): Promise<string> {
		const resolved = resolveToCwd(input, this.session.cwd);
		let stat: Stats;
		try {
			stat = await fs.stat(resolved);
		} catch {
			throw new ToolError(`Directory does not exist: ${resolved}`);
		}
		if (!stat.isDirectory()) throw new ToolError(`Not a directory: ${resolved}`);
		const target = await fs.realpath(resolved);
		if (target === (await realpathOrSelf(this.session.cwd))) {
			throw new ToolError(`The session already runs in ${target}.`);
		}
		return target;
	}

	#queuedMoveText(target: string): string {
		return `Move to ${target} queued. It takes effect after this step finishes: tool calls issued in the same step still run in ${this.session.cwd}, and tool calls from your next step run in ${target}.`;
	}

	#repository(): VcsGitRepo {
		const repository = vcs.git(this.session.cwd);
		if (!repository) throw new ToolError(`Not inside a git repository: ${this.session.cwd}`);
		return repository;
	}

	async #list(): Promise<AgentToolResult<SessionToolDetails>> {
		const entries = await this.#repository().worktrees();
		const cwd = await realpathOrSelf(this.session.cwd);
		const lines: string[] = [];
		for (const entry of entries) {
			const root = await realpathOrSelf(entry.path);
			const label = entry.detached
				? `detached ${entry.head?.slice(0, 8) ?? ""}`.trim()
				: (entry.branch?.replace(/^refs\/heads\//, "") ?? "(no branch)");
			let state = "";
			try {
				state = (await vcs.git(root)?.isDirty()) ? ", uncommitted changes" : "";
			} catch {
				state = ", status unavailable";
			}
			const marker = pathIsWithin(root, cwd) ? " (this session)" : "";
			lines.push(`${root}  [${label}${state}]${marker}`);
		}
		return toolResult<SessionToolDetails>({ op: "worktree_list" })
			.text(lines.length > 0 ? lines.join("\n") : "No worktrees.")
			.done();
	}

	async #create(
		control: SessionControl,
		params: SessionParams,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<SessionToolDetails>> {
		const branch = requireText(params.branch, "branch", "worktree_create");
		// Fail before creating anything: a worktree the session cannot move into would be left behind.
		if (params.move === true && !control.canMove()) throw new ToolError(MOVE_UNSUPPORTED);
		let worktree: SessionWorktree;
		try {
			worktree = await createSessionWorktree(this.session.cwd, this.session.settings, branch, {
				keepChanges: params.carryChanges === true,
				signal,
			});
		} catch (error) {
			throw new ToolError(`Worktree creation failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const changes = params.carryChanges === true ? "uncommitted changes copied" : "clean checkout of HEAD";
		let text = `Created worktree ${worktree.path} on new branch ${worktree.branch} (${changes}).`;
		if (params.move === true) {
			try {
				control.requestMove(worktree.path);
			} catch (error) {
				throw new ToolError(
					`${text} Moving the session failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			text += ` ${this.#queuedMoveText(worktree.path)}`;
		}
		return toolResult<SessionToolDetails>({
			op: "worktree_create",
			path: worktree.path,
			branch: worktree.branch,
			moveQueued: params.move === true,
		})
			.text(text)
			.done();
	}

	async #remove(control: SessionControl, params: SessionParams): Promise<AgentToolResult<SessionToolDetails>> {
		const input = requireText(params.path, "path", "worktree_remove");
		const repository = this.#repository();
		const target = await realpathOrSelf(resolveToCwd(input, this.session.cwd));
		const entries = await repository.worktrees();
		const registered = await Promise.all(
			entries.map(async entry => ({ entry, real: await realpathOrSelf(entry.path) })),
		);
		const match = registered.find(item => item.real === target);
		if (!match) {
			throw new ToolError(`${target} is not a registered worktree of this repository. Use worktree_list.`);
		}
		if (target === (await realpathOrSelf(repository.primaryRoot()))) {
			throw new ToolError(`${target} is the primary checkout, not a removable worktree.`);
		}
		const inUse = [this.session.cwd, ...(this.session.additionalDirectories ?? []), control.pendingMove()];
		for (const directory of inUse) {
			if (directory !== undefined && pathIsWithin(target, await realpathOrSelf(directory))) {
				throw new ToolError(
					`Refusing to remove ${target}: this session works in ${directory}. Move the session elsewhere first.`,
				);
			}
		}
		if (params.force !== true && (await isWorktreeLocked(match.entry.path))) {
			throw new ToolError(
				`Refusing to remove ${target}: it is locked (git worktree lock). Unlock it first, or pass force: true.`,
			);
		}
		if (params.force !== true && (await vcs.git(target)?.isDirty())) {
			throw new ToolError(
				`Refusing to remove ${target}: it has uncommitted changes. Commit or discard them, or pass force: true to delete them.`,
			);
		}
		let removed: boolean;
		try {
			removed = await repository.worktreeRemove(match.entry.path, params.force === true);
		} catch (error) {
			throw new ToolError(`Worktree removal failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!removed) throw new ToolError(`Git did not remove worktree ${target}.`);
		// The native removal deletes the checkout, then its admin entry only when both paths share one spelling
		// (/tmp vs /private/tmp, or a symlinked repo path). Prune clears the entry it left behind.
		if ((await repository.worktrees()).some(entry => entry.path === match.entry.path)) {
			await repository.worktreePrune();
		}
		return toolResult<SessionToolDetails>({ op: "worktree_remove", path: target })
			.text(`Removed worktree ${target}. Its branch was kept.`)
			.done();
	}
}
