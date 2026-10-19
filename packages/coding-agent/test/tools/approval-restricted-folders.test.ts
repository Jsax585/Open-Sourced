/**
 * `tools.restrictedFolders` — folders where every action needs an explicit
 * approval, whatever the approval mode or a remembered grant.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, ToolTier } from "@oh-my-pi/pi-agent-core";
import {
	type ApprovalGrantStore,
	approvalGrantKey,
	approvalToolKey,
	resolveApproval,
} from "@oh-my-pi/pi-coding-agent/tools/approval";
import { approvalDirectoryKey } from "@oh-my-pi/pi-coding-agent/tools/approval-cache";
import { approvalTargetKey, approvalTreeSearchKey } from "@oh-my-pi/pi-coding-agent/tools/approval-targets";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Check-only store: knows exactly the given keys. */
function grantsOf(keys: string[] = []): ApprovalGrantStore {
	const grants = new Set(keys);
	return { has: key => grants.has(key) };
}

/** Tool whose targets come from `args.path`, like read/write/edit. */
function pathTool(name: string, tier: ToolTier, cwd: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: {} as never,
		approval: tier,
		approvalCacheTargets: (args: unknown) => {
			const record = args as { path?: unknown } | null;
			return typeof record?.path === "string" ? [approvalTargetKey(cwd, record.path)!] : undefined;
		},
		execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
	};
}

/** Exec tool that names no path: it is matched by the directory it runs in. */
function commandTool(): AgentTool {
	return {
		name: "bash",
		label: "Bash",
		description: "command tool",
		parameters: {} as never,
		approval: "exec",
		execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
	};
}

describe("tools.restrictedFolders", () => {
	let temp: TempDir;
	let cwd: string;
	let restricted: string;
	let plain: string;

	beforeEach(() => {
		temp = TempDir.createSync("@omp-restricted-folders-");
		cwd = temp.path();
		restricted = path.join(cwd, "restricted");
		plain = path.join(cwd, "plain");
		fs.mkdirSync(restricted);
		fs.mkdirSync(plain);
		fs.writeFileSync(path.join(restricted, "secret.txt"), "secret\n");
		fs.writeFileSync(path.join(plain, "open.txt"), "open\n");
	});

	afterEach(() => temp.removeSync());

	const options = () => ({ restrictedFolders: [restricted], cwd });

	it("prompts for a restricted target in every mode, grants irrelevant", () => {
		const read = pathTool("read", "read", cwd);
		const args = { path: "restricted/secret.txt" };
		const target = approvalTargetKey(cwd, "restricted/secret.txt")!;

		// Yolo would allow the read, always-ask allows reads too: both must ask here.
		const blocked = resolveApproval(read, args, "yolo", {}, grantsOf(), options());
		expect(blocked).toMatchObject({ policy: "prompt", source: "restriction", override: true });
		expect(blocked.reason).toContain("Restricted folder:");
		expect(blocked.reason).toContain("restricted");
		expect(resolveApproval(read, args, "always-ask", {}, grantsOf(), options()).policy).toBe("prompt");
		expect(resolveApproval(read, args, "write", {}, grantsOf(), options()).policy).toBe("prompt");
		// A remembered exact grant, a folder grant, and a by-name tool grant never silence it.
		expect(
			resolveApproval(read, args, "always-ask-cached", {}, grantsOf([approvalGrantKey("read", target)]), options())
				.policy,
		).toBe("prompt");
		expect(
			resolveApproval(
				read,
				args,
				"always-ask-cached",
				{},
				grantsOf([approvalGrantKey("read", approvalDirectoryKey(restricted))]),
				options(),
			).policy,
		).toBe("prompt");
		expect(
			resolveApproval(
				read,
				args,
				"always-ask-cached",
				{},
				grantsOf([approvalGrantKey("read", approvalToolKey("read"))]),
				options(),
			).policy,
		).toBe("prompt");
	});

	it("leaves folders outside the restriction alone", () => {
		const read = pathTool("read", "read", cwd);
		expect(resolveApproval(read, { path: "plain/open.txt" }, "yolo", {}, grantsOf(), options()).policy).toBe("allow");
		// A sibling whose name only shares the prefix is not inside it.
		const sibling = path.join(cwd, "restricted-other");
		fs.mkdirSync(sibling);
		fs.writeFileSync(path.join(sibling, "file.txt"), "x");
		expect(
			resolveApproval(read, { path: "restricted-other/file.txt" }, "yolo", {}, grantsOf(), options()).policy,
		).toBe("allow");
	});

	it("restricts the folder itself, not only its contents", () => {
		const read = pathTool("read", "read", cwd);
		expect(resolveApproval(read, { path: "restricted" }, "yolo", {}, grantsOf(), options()).policy).toBe("prompt");
	});

	it("keeps a deny policy denied, which is stricter than a prompt", () => {
		const read = pathTool("read", "read", cwd);
		expect(
			resolveApproval(read, { path: "restricted/secret.txt" }, "yolo", { read: "deny" }, grantsOf(), options())
				.policy,
		).toBe("deny");
	});

	it("matches exec tools by the directory they run in", () => {
		const bash = commandTool();
		expect(
			resolveApproval(bash, {}, "yolo", {}, grantsOf(), { restrictedFolders: [restricted], cwd: restricted }),
		).toMatchObject({
			policy: "prompt",
			source: "restriction",
		});
		expect(
			resolveApproval(bash, {}, "yolo", {}, grantsOf(), {
				restrictedFolders: [restricted],
				cwd: path.join(restricted, "nested"),
			}).policy,
		).toBe("prompt");
		expect(resolveApproval(bash, {}, "yolo", {}, grantsOf(), options()).policy).toBe("allow");
	});

	it("catches a recursive search rooted above a restricted folder", () => {
		const cwdTree = approvalTreeSearchKey(approvalDirectoryKey(cwd));
		const insideTree = approvalTreeSearchKey(approvalDirectoryKey(restricted));
		const search: AgentTool = {
			name: "grep",
			label: "Grep",
			description: "search tool",
			parameters: {} as never,
			approval: "read",
			approvalCacheTargets: () => [cwdTree],
			execute: async () => ({ content: [{ type: "text" as const, text: "found" }] }),
		};
		// The root contains the restricted folder, so the search reaches into it.
		expect(resolveApproval(search, {}, "yolo", {}, grantsOf(), options()).policy).toBe("prompt");
		// An exact tree grant does not help either.
		expect(
			resolveApproval(search, {}, "always-ask-cached", {}, grantsOf([approvalGrantKey("read", cwdTree)]), options())
				.policy,
		).toBe("prompt");
		const inside: AgentTool = { ...search, approvalCacheTargets: () => [insideTree] };
		expect(resolveApproval(inside, {}, "yolo", {}, grantsOf(), options()).policy).toBe("prompt");
	});

	it("expands a leading tilde in configured folders", () => {
		const read = pathTool("read", "read", cwd);
		const target = path.join(os.homedir(), ".omp", "restricted-probe.txt");
		const grants = grantsOf();
		const homeRestricted = { restrictedFolders: ["~/.omp"], cwd };
		// Target keys come from the tool, so resolve against a synthetic keyed tool.
		const probe: AgentTool = {
			...read,
			approvalCacheTargets: () => [approvalTargetKey(cwd, target)!],
		};
		expect(resolveApproval(probe, {}, "yolo", {}, grants, homeRestricted)).toMatchObject({
			policy: "prompt",
			source: "restriction",
		});
	});

	it("does nothing when no folder is configured", () => {
		const read = pathTool("read", "read", cwd);
		expect(resolveApproval(read, { path: "restricted/secret.txt" }, "yolo", {}, grantsOf()).policy).toBe("allow");
		expect(
			resolveApproval(read, { path: "restricted/secret.txt" }, "yolo", {}, grantsOf(), { restrictedFolders: [] })
				.policy,
		).toBe("allow");
	});
});
