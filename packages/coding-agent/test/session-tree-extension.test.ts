import { describe, expect, test } from "bun:test";
import { buildSessionForest, type SessionLineageNode } from "../examples/extensions/session-tree";
import type { SessionInfo } from "../src/session/session-listing";

function session(id: string, parent?: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		id,
		path: `/new/sessions/project/${id}.jsonl`,
		cwd: "/project",
		title: id,
		parentSessionPath: parent,
		created: new Date("2026-01-01T10:00:00Z"),
		modified: new Date("2026-01-01T10:00:00Z"),
		size: 1024,
		messageCount: 2,
		assistantTurns: 1,
		firstMessage: "request",
		allMessagesText: "",
		...overrides,
	};
}

function flatten(roots: SessionLineageNode[]): SessionLineageNode[] {
	const pending = [...roots].reverse();
	const result: SessionLineageNode[] = [];
	while (pending.length) {
		const node = pending.pop()!;
		result.push(node);
		for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]!);
	}
	return result;
}

function ids(roots: SessionLineageNode[]): string[] {
	return flatten(roots).map(node => node.session.id);
}

describe("session lineage extension", () => {
	test("connects relocated Windows and exact parent paths, excluding unrelated sessions", () => {
		const source = [
			session("root"),
			session("child", "C:\\old\\sessions\\root.jsonl"),
			session("grandchild", "/new/sessions/project/child.jsonl"),
			session("unrelated"),
		];
		const roots = buildSessionForest(source, new Set());
		expect(roots.map(node => node.session.id)).toEqual(["root"]);
		expect(roots[0]!.children.map(node => node.session.id)).toEqual(["child"]);
		expect(roots[0]!.children[0]!.children.map(node => node.session.id)).toEqual(["grandchild"]);
		expect(source[1]!.parentSessionPath).toBe("C:\\old\\sessions\\root.jsonl");
	});

	test("retains the ancestor chain of a search result, not unrelated siblings", () => {
		const source = [
			session("root"),
			session("middle", "root"),
			session("leaf", "middle", { title: "核查旧会话" }),
			session("sibling", "root"),
		];
		expect(ids(buildSessionForest(source, new Set(), "旧会话"))).toEqual(["root", "middle", "leaf"]);
		expect(buildSessionForest(source, new Set(), "absent")).toEqual([]);
	});

	test("searches project paths and ids without losing cross-project ancestors", () => {
		const source = [
			session("root"),
			session("child-identifier", "root", { title: "named branch", cwd: "/Other-Project" }),
			session("sibling", "root"),
		];
		expect(ids(buildSessionForest(source, new Set(), "other-project"))).toEqual(["root", "child-identifier"]);
		expect(ids(buildSessionForest(source, new Set(), "CHILD-IDENTIFIER"))).toEqual(["root", "child-identifier"]);
	});

	test("prefers an exact parent path over ambiguous basenames", () => {
		const roots = buildSessionForest(
			[
				session("one", undefined, { path: "/one/shared.jsonl" }),
				session("two", undefined, { path: "/two/shared.jsonl" }),
				session("orphan", "/moved/shared.jsonl"),
				session("exact", "/one/shared.jsonl"),
			],
			new Set(),
		);
		expect(roots.find(node => node.session.id === "one")?.children.map(node => node.session.id)).toEqual(["exact"]);
		expect(roots.find(node => node.session.id === "orphan")?.unresolvedParent).toBe(true);
		expect(ids(roots).sort()).toEqual(["exact", "one", "orphan"]);
	});

	test("does not reinterpret an ambiguous filename as a unique session id", () => {
		const roots = buildSessionForest(
			[
				session("root", undefined, { path: "/one/root.jsonl" }),
				session("other", undefined, { path: "/two/root.jsonl" }),
				session("ambiguous", "root.jsonl"),
				session("explicit-id", "root"),
			],
			new Set(),
		);
		expect(roots.find(node => node.session.id === "root")?.children.map(node => node.session.id)).toEqual([
			"explicit-id",
		]);
		expect(roots.find(node => node.session.id === "ambiguous")?.unresolvedParent).toBe(true);
	});

	test("keeps duplicate-id parents unresolved rather than attaching to an arbitrary file", () => {
		const roots = buildSessionForest(
			[
				session("duplicate", undefined, { path: "/one/first.jsonl" }),
				session("duplicate", undefined, { path: "/two/second.jsonl" }),
				session("child", "duplicate"),
			],
			new Set(),
		);
		expect(ids(roots)).toEqual(["child"]);
		expect(roots[0]!.unresolvedParent).toBe(true);
	});

	test("retains missing-parent, self-parent and cyclic histories exactly once", () => {
		const roots = buildSessionForest(
			[
				session("missing", "/gone/parent.jsonl"),
				session("self", "self"),
				session("a", "b"),
				session("b", "a"),
				session("descendant", "b"),
			],
			new Set(),
		);
		expect(ids(roots).sort()).toEqual(["a", "b", "descendant", "missing", "self"]);
		expect(roots.every(node => node.unresolvedParent)).toBe(true);
	});

	test("pins reorder siblings without detaching children, and size/turn sorting uses that metric", () => {
		const source = [
			session("root"),
			session("old", "root", { modified: new Date("2026-01-01"), size: 2000, assistantTurns: 4 }),
			session("new", "root", { modified: new Date("2026-01-02"), size: 1000, assistantTurns: 8 }),
		];
		expect(ids(buildSessionForest(source, new Set()))).toEqual(["root", "new", "old"]);
		expect(ids(buildSessionForest(source, new Set(["old"])))).toEqual(["root", "old", "new"]);
		expect(ids(buildSessionForest(source, new Set(), "", "size"))).toEqual(["root", "old", "new"]);
		expect(ids(buildSessionForest(source, new Set(), "", "turns"))).toEqual(["root", "new", "old"]);
	});

	test("projects a ten-thousand-generation chain without recursive stack growth or missing ancestors", () => {
		const source = Array.from({ length: 10000 }, (_, index) =>
			session(`s${index}`, index ? `s${index - 1}` : undefined),
		);
		expect(ids(buildSessionForest(source, new Set(), "s9999"))).toEqual(source.map(item => item.id));
	});
});
