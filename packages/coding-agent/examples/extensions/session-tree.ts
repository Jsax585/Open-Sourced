import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { sessionDisplayName, type SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { loadPinnedSessionIds, toggleSessionPin } from "@oh-my-pi/pi-coding-agent/session/session-pins";
import { copyToClipboard } from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import {
	type Component,
	Input,
	Key,
	matchesKey,
	type Theme,
	TreeView,
	truncateToWidth,
	type TUI,
} from "@oh-my-pi/pi-tui";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";

export type SessionTreeSort = "time" | "size" | "turns";

export interface SessionLineageNode {
	session: SessionInfo;
	children: SessionLineageNode[];
	unresolvedParent: boolean;
}

function normalizedPath(value: string): string {
	return path.posix.normalize(value.replaceAll("\\", "/"));
}

function addUnique(index: Map<string, SessionLineageNode | null>, key: string, node: SessionLineageNode): void {
	index.set(key, index.has(key) ? null : node);
}

/** Project picker metadata without reading or rewriting transcripts, or guessing ambiguous links. */
export function buildSessionForest(
	sessions: readonly SessionInfo[],
	pinned: ReadonlySet<string>,
	query = "",
	sort: SessionTreeSort = "time",
): SessionLineageNode[] {
	const nodes = sessions.map<SessionLineageNode>(session => ({ session, children: [], unresolvedParent: false }));
	const byPath = new Map<string, SessionLineageNode | null>();
	const byName = new Map<string, SessionLineageNode | null>();
	const byId = new Map<string, SessionLineageNode | null>();
	for (const node of nodes) {
		const file = normalizedPath(node.session.path);
		addUnique(byPath, file, node);
		addUnique(byName, path.posix.basename(file), node);
		addUnique(byId, node.session.id, node);
	}
	const parents = new Map<SessionLineageNode, SessionLineageNode>();
	for (const node of nodes) {
		const reference = node.session.parentSessionPath;
		if (!reference) continue;
		const file = normalizedPath(reference);
		const basename = path.posix.basename(file);
		const parent = byPath.has(file)
			? byPath.get(file)
			: byName.has(basename)
				? byName.get(basename)
				: byId.get(reference);
		if (parent && parent !== node) parents.set(node, parent);
		else node.unresolvedParent = true;
	}
	// A damaged header must not hide sessions or create an infinite traversal.
	const processed = new Set<SessionLineageNode>();
	for (const node of nodes) {
		const chain = new Set<SessionLineageNode>();
		let cursor: SessionLineageNode | undefined = node;
		while (cursor && !processed.has(cursor)) {
			if (chain.has(cursor)) {
				parents.delete(cursor);
				cursor.unresolvedParent = true;
				break;
			}
			chain.add(cursor);
			cursor = parents.get(cursor);
		}
		for (const item of chain) processed.add(item);
	}
	for (const [child, parent] of parents) parent.children.push(child);
	const related = nodes.filter(node => node.session.parentSessionPath || node.children.length > 0);
	const needle = query.trim().toLocaleLowerCase();
	const visible = new Set<SessionLineageNode>();
	for (const node of related) {
		const session = node.session;
		if (
			needle &&
			![sessionDisplayName(session), session.firstMessage, session.id, session.cwd].some(value =>
				value.toLocaleLowerCase().includes(needle),
			)
		)
			continue;
		let cursor: SessionLineageNode | undefined = node;
		while (cursor && !visible.has(cursor)) {
			visible.add(cursor);
			cursor = parents.get(cursor);
		}
	}
	const compare = (a: SessionLineageNode, b: SessionLineageNode): number => {
		const pinOrder = Number(pinned.has(b.session.id)) - Number(pinned.has(a.session.id));
		if (pinOrder) return pinOrder;
		const aValue =
			sort === "size"
				? a.session.size
				: sort === "turns"
					? (a.session.assistantTurns ?? a.session.messageCount)
					: a.session.modified.getTime();
		const bValue =
			sort === "size"
				? b.session.size
				: sort === "turns"
					? (b.session.assistantTurns ?? b.session.messageCount)
					: b.session.modified.getTime();
		return bValue - aValue || a.session.path.localeCompare(b.session.path);
	};
	for (const node of related) node.children = node.children.filter(child => visible.has(child)).sort(compare);
	return related.filter(node => visible.has(node) && !parents.has(node)).sort(compare);
}

class SessionTreeView implements Component {
	#tree: TreeView<SessionLineageNode, string>;
	#input = new Input();
	#filtering = false;
	#scope: "folder" | "all" = "folder";
	#allSessions: SessionInfo[] | undefined;
	#sort: SessionTreeSort = "time";
	#loading = false;
	#pinning = false;
	#closed = false;
	#message = "";
	#rows = 0;

	constructor(
		private readonly folderSessions: SessionInfo[],
		private readonly pinned: Set<string>,
		private readonly currentPath: string | undefined,
		query: string,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: (result: string | undefined) => void,
	) {
		this.#input.prompt = "Search: ";
		this.#input.setValue(query);
		this.#tree = this.#buildTree(currentPath);
	}

	#pageSize(): number {
		return Math.max(1, (this.tui.terminal.rows || 24) - 7);
	}

	#buildTree(selected?: string): TreeView<SessionLineageNode, string> {
		this.#rows = this.#pageSize();
		const sessions = this.#scope === "all" ? (this.#allSessions ?? []) : this.folderSessions;
		return new TreeView({
			roots: buildSessionForest(sessions, this.pinned, this.#input.getValue(), this.#sort),
			getKey: node => node.session.path,
			getChildren: node => node.children,
			theme: this.theme,
			selectedKey: selected,
			maxRows: this.#rows,
			scrollbar: true,
			renderLeading: (_node, context) => (context.selected ? this.theme.fg("accent", "> ") : "  "),
			renderRow: node => {
				const session = node.session;
				const current =
					this.currentPath && normalizedPath(session.path) === normalizedPath(this.currentPath)
						? " [current]"
						: "";
				const pin = this.pinned.has(session.id) ? "[pinned] " : "";
				const unresolved = node.unresolvedParent ? " [parent unavailable]" : "";
				return `${pin}${sanitizeText(sessionDisplayName(session))}${current}${unresolved} ${this.theme.fg("dim", sanitizeText(session.id.slice(0, 8)))}`;
			},
		});
	}

	#rebuild(): void {
		const selected = this.#tree.selectedKey;
		this.#tree.dispose();
		this.#tree = this.#buildTree(selected);
	}

	async #toggleScope(): Promise<void> {
		if (this.#loading) return;
		if (this.#scope === "folder" && !this.#allSessions) {
			this.#loading = true;
			this.#message = "Loading session metadata from all projects…";
			this.tui.requestRender();
			try {
				this.#allSessions = await SessionManager.listAllForPicker();
			} catch (error) {
				this.#message = `Loading failed: ${sanitizeText(error instanceof Error ? error.message : String(error))}`;
				return;
			} finally {
				this.#loading = false;
				if (!this.#closed) this.tui.requestRender();
			}
		}
		if (this.#closed) return;
		this.#scope = this.#scope === "folder" ? "all" : "folder";
		this.#message = "";
		this.#rebuild();
		this.tui.requestRender();
	}

	async #togglePin(): Promise<void> {
		const session = this.#tree.selectedItem?.session;
		if (!session || this.#pinning) return;
		this.#pinning = true;
		try {
			const pinned = await toggleSessionPin(session.id);
			if (pinned) this.pinned.add(session.id);
			else this.pinned.delete(session.id);
			this.#message = pinned ? "Pinned (shared with /resume)" : "Unpinned";
			if (!this.#closed) this.#rebuild();
		} catch (error) {
			this.#message = `Pin failed: ${sanitizeText(error instanceof Error ? error.message : String(error))}`;
		} finally {
			this.#pinning = false;
			if (!this.#closed) this.tui.requestRender();
		}
	}

	async #copy(key: string): Promise<void> {
		const session = this.#tree.selectedItem?.session;
		if (!session) return;
		const title = sessionDisplayName(session);
		try {
			await copyToClipboard(
				key === "i"
					? session.id
					: key === "p"
						? session.path
						: key === "y"
							? `${title}\n${session.path}\n${session.id}`
							: title,
			);
			this.#message = "Copy requested";
		} catch (error) {
			this.#message = `Copy failed: ${sanitizeText(error instanceof Error ? error.message : String(error))}`;
		}
		if (!this.#closed) this.tui.requestRender();
	}

	render(width: number): readonly string[] {
		if (this.#rows !== this.#pageSize()) this.#rebuild();
		const body = [...this.#tree.render(width)];
		if (!body.length)
			body.push(
				this.theme.fg(
					"dim",
					this.#input.getValue()
						? "No matching forked sessions"
						: "No forks in this scope; use /resume for other sessions",
				),
			);
		while (body.length < this.#rows) body.push("");
		const selected = this.#tree.selectedItem?.session;
		const scope = this.#scope === "folder" ? "Current project" : "All projects";
		const sort = this.#sort === "time" ? "recent activity" : this.#sort === "size" ? "size" : "turns";
		return [
			this.theme.fg("accent", "/ts · Session lineage"),
			`${scope} · ${this.#tree.rows.length} sessions · Sort: ${sort}${this.#message ? ` · ${this.#message}` : ""}`,
			...(this.#filtering
				? this.#input.render(width)
				: [`Search: ${sanitizeText(this.#input.getValue()) || "none"}`]),
			...body,
			selected
				? `${sanitizeText(selected.id)} · ${selected.modified.toLocaleString()} · ${(selected.size / 1048576).toFixed(2)} MiB`
				: "Forked sessions and their available ancestors only",
			selected
				? sanitizeText(shortenPath(selected.path))
				: "Missing or ambiguous parents stay as roots; no logs are changed",
			"↑↓ move · Enter resume · Esc close · Tab scope · / search · Space pin · s sort · c/i/p/y copy",
		].map(line => truncateToWidth(line, Math.max(1, width)));
	}

	handleInput(data: string): void {
		if (this.#filtering) {
			if (matchesKey(data, Key.escape)) {
				this.#input.setValue("");
				this.#filtering = false;
			} else if (matchesKey(data, Key.enter)) this.#filtering = false;
			else this.#input.handleInput(data);
			this.#input.focused = this.#filtering;
			this.#rebuild();
		} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done(undefined);
			return;
		} else if (matchesKey(data, Key.enter)) {
			const selected = this.#tree.selectedItem;
			if (selected) this.done(selected.session.path);
			return;
		} else if (matchesKey(data, Key.tab)) void this.#toggleScope();
		else if (data === "/") {
			this.#filtering = true;
			this.#input.focused = true;
		} else if (matchesKey(data, Key.up)) this.#tree.moveSelection(-1);
		else if (matchesKey(data, Key.down)) this.#tree.moveSelection(1);
		else if (matchesKey(data, Key.pageUp)) this.#tree.moveSelection(-this.#rows);
		else if (matchesKey(data, Key.pageDown)) this.#tree.moveSelection(this.#rows);
		else if (matchesKey(data, Key.home)) this.#tree.setSelectionIndex(0);
		else if (matchesKey(data, Key.end)) this.#tree.setSelectionIndex(this.#tree.rows.length - 1);
		else if (data === "s") {
			this.#sort = this.#sort === "time" ? "size" : this.#sort === "size" ? "turns" : "time";
			this.#rebuild();
		} else if (data === " ") void this.#togglePin();
		else if (["c", "i", "p", "y"].includes(data)) void this.#copy(data);
		else return;
		this.tui.requestRender();
	}

	invalidate(): void {
		this.#tree.invalidate();
	}

	dispose(): void {
		this.#closed = true;
		this.#tree.dispose();
	}
}

/** Optional cross-session view; the built-in /tree continues to navigate one session's entries. */
export default function sessionTree(pi: ExtensionAPI): void {
	pi.registerCommand("ts", {
		description: "Browse forked sessions as a lineage tree (/tree shows messages within one session)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("/ts requires an interactive terminal", "warning");
				return;
			}
			try {
				const folder = await SessionManager.listForPicker(ctx.cwd, ctx.sessionManager.getSessionDir() || undefined);
				const pinned = await loadPinnedSessionIds();
				const selected = await ctx.ui.custom<string | undefined>(
					(tui, theme, _keys, done) =>
						new SessionTreeView(
							folder,
							pinned,
							ctx.sessionManager.getSessionFile(),
							args.trim(),
							tui,
							theme,
							done,
						),
					{
						overlay: true,
						overlayOptions: { fullscreen: true, width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
					},
				);
				if (selected && selected !== ctx.sessionManager.getSessionFile()) await ctx.switchSession(selected);
			} catch (error) {
				ctx.ui.notify(
					`Session tree failed: ${sanitizeText(error instanceof Error ? error.message : String(error))}`,
					"error",
				);
			}
		},
	});
}
