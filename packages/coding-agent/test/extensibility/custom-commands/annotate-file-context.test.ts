import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { writeTar } from "@oh-my-pi/pi-coding-agent/skillshare/tar";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { TUI } from "@oh-my-pi/pi-tui";
import type {
	ExtensionCustomOptions,
	ExtensionUIContext,
	ExtensionUiComponent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { CopySelectorComponent } from "@oh-my-pi/pi-tui/overlays/copy-selector";
import { initTheme, theme, type Theme } from "@oh-my-pi/pi-tui/theme";
import type { CustomCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { TextReviewSource } from "@oh-my-pi/pi-tui/overlays/annotation-types";
import { selectSessionTextReviewSource } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/text-source";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

const ENTER = "\r";
const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";
const USAGE = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

beforeAll(async () => {
	await initTheme();
});

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "annotate-file-context-"));
	try {
		return await run(directory);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

function toolCallEntry(
	id: string,
	callId: string,
	toolName: string,
	args: Record<string, unknown>,
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-10T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: toolName, arguments: args }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			stopReason: "toolUse",
			usage: USAGE,
			timestamp: 1,
		} as unknown as AgentMessage,
	};
}

function toolResultEntry(
	id: string,
	callId: string,
	toolName: string,
	output: string,
	details?: unknown,
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: "assistant-call",
		timestamp: "2026-10-10T00:00:01.000Z",
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName,
			content: [{ type: "text", text: output }],
			details,
			isError: false,
			timestamp: 2,
		} as unknown as AgentMessage,
	};
}

function toolBranch(
	toolName: string,
	args: Record<string, unknown>,
	output = "selected result",
	details?: unknown,
): SessionMessageEntry[] {
	const callId = `call-${toolName}`;
	return [
		toolCallEntry("assistant-call", callId, toolName, args),
		toolResultEntry("tool-result", callId, toolName, output, details),
	];
}

function readResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

function createContext(
	branch: SessionMessageEntry[],
	options: { cwd: string; cwdAfterPick?: string; keys?: readonly string[] },
): { ctx: CustomCommandContext } {
	let liveCwd = options.cwd;
	const custom: ExtensionUIContext["custom"] = async <T>(
		factory: (
			tui: TUI,
			uiTheme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => ExtensionUiComponent | Promise<ExtensionUiComponent>,
		_options?: ExtensionCustomOptions,
	): Promise<T> => {
		const tui = new TUI(new VirtualTerminal(120, 30));
		const completion = Promise.withResolvers<T>();
		const done = (result: T): void => {
			if (options.cwdAfterPick && typeof result === "object" && result !== null && "entry" in result) {
				liveCwd = options.cwdAfterPick;
			}
			completion.resolve(result);
		};
		const component = await factory(tui, theme, KeybindingsManager.inMemory(), done);
		if (!(component instanceof CopySelectorComponent)) throw new Error("expected the native copy selector");
		component.render(120);
		for (const key of options.keys ?? [RIGHT, ENTER]) component.handleInput(key);
		component.dispose?.();
		return completion.promise;
	};
	return {
		ctx: {
			hasUI: true,
			cwd: options.cwd,
			sessionManager: {
				getBranch: () => branch,
				getCwd: () => liveCwd,
				getSessionId: () => "session-file-context",
			},
			ui: { custom, notify: () => undefined },
		} as unknown as CustomCommandContext,
	};
}

async function selectSource(
	branch: SessionMessageEntry[],
	options: { cwd: string; cwdAfterPick?: string; keys?: readonly string[] },
): Promise<TextReviewSource | undefined> {
	return selectSessionTextReviewSource(createContext(branch, options).ctx);
}

describe("/annotate transcript file context", () => {
	it("uses execution-time read provenance when the session cwd changes", async () => {
		await withTempDir(async root => {
			const historicalCwd = path.join(root, "workspace");
			const currentCwd = path.join(historicalCwd, "nested");
			const historicalPath = path.join(historicalCwd, "src", "module.ts");
			const currentPath = path.join(currentCwd, "src", "module.ts");
			await fs.mkdir(path.dirname(historicalPath), { recursive: true });
			await fs.mkdir(path.dirname(currentPath), { recursive: true });
			await Bun.write(historicalPath, "historical first\nhistorical second\nhistorical third\n");
			await Bun.write(currentPath, "current first\ncurrent second\ncurrent third\n");
			const excerpt = "2: historical second\n3: historical third";
			const source = await selectSource(
				toolBranch("read", { path: "src/module.ts:2-3" }, excerpt, { editableFilePath: historicalPath }),
				{ cwd: historicalCwd, cwdAfterPick: currentCwd },
			);
			const legacySource = await selectSource(toolBranch("read", { path: "src/module.ts:2-3" }, excerpt), {
				cwd: historicalCwd,
				cwdAfterPick: currentCwd,
			});

			expect(source?.editorFilePath).toBe(historicalPath);
			expect(source?.text).toBe(excerpt);
			expect(source?.provenance).toEqual({ kind: "session", entryId: "tool-result" });
			expect(legacySource?.editorFilePath).toBeUndefined();
		});
	});

	it("uses explicit editable-file metadata instead of read backing paths", async () => {
		await withTempDir(async cwd => {
			const resolvedPath = path.join(cwd, "actual.ts");
			const metadataPath = path.join(cwd, "source-metadata.ts");
			await Bun.write(resolvedPath, "actual file\n");
			await Bun.write(metadataPath, "metadata source file\n");
			const source = await selectSource(
				toolBranch("read", { path: "old-name.ts:1-2" }, "excerpt from the resolved file\n", {
					editableFilePath: resolvedPath,
					resolvedPath: metadataPath,
					meta: { source: { type: "path", value: metadataPath } },
				}),
				{ cwd, keys: [ENTER] },
			);

			expect(source?.editorFilePath).toBe(resolvedPath);
			expect(source?.text).toBe("excerpt from the resolved file");
		});
	});

	it("uses the full recorded path for selector-shaped filenames", async () => {
		await withTempDir(async cwd => {
			const basePath = path.join(cwd, "module.ts");
			const literalPath = path.join(cwd, "module.ts:2-3");
			await Bun.write(basePath, "base file\n");
			await Bun.write(literalPath, "literal file\n");
			const source = await selectSource(
				toolBranch("read", { path: "module.ts:2-3" }, "selected excerpt", {
					editableFilePath: literalPath,
				}),
				{ cwd },
			);
			const legacySource = await selectSource(
				toolBranch("read", { path: "module.ts:2-3" }, "historical read", {
					resolvedPath: literalPath,
					meta: { source: { type: "path", value: literalPath } },
				}),
				{ cwd },
			);
			const relativeMarkerSource = await selectSource(
				toolBranch("read", { path: "module.ts:2-3" }, "relative marker", {
					editableFilePath: "module.ts:2-3",
				}),
				{ cwd },
			);

			expect(source?.editorFilePath).toBe(literalPath);
			expect(legacySource?.editorFilePath).toBeUndefined();
			expect(relativeMarkerSource?.editorFilePath).toBeUndefined();
		});
	});

	it("uses the recorded full path for selector-bearing semicolon filenames", async () => {
		await withTempDir(async cwd => {
			const literalPath = path.join(cwd, "module;draft.ts");
			await Bun.write(literalPath, "first\nsecond\nthird\n");
			const selectedPath = "module;draft.ts:2-3";
			const metadataSource = await selectSource(
				toolBranch("read", { path: selectedPath }, "selected metadata excerpt", {
					editableFilePath: literalPath,
					resolvedPath: path.join(cwd, "source.zip"),
					meta: { source: { type: "path", value: path.join(cwd, "source.zip") } },
				}),
				{ cwd },
			);
			const legacyResult = await selectSource(
				toolBranch("read", { path: selectedPath }, "selected historical excerpt", {
					resolvedPath: literalPath,
					meta: { source: { type: "path", value: literalPath } },
				}),
				{ cwd },
			);

			expect(metadataSource?.editorFilePath).toBe(literalPath);
			expect(legacyResult?.editorFilePath).toBeUndefined();
		});
	});

	it("pairs a selected tool result with its call by toolCallId", async () => {
		await withTempDir(async cwd => {
			const localPath = path.join(cwd, "src", "local.ts");
			await fs.mkdir(path.join(cwd, "src"), { recursive: true });
			await Bun.write(localPath, "local file\n");

			const assistant = toolCallEntry("assistant-call", "remote-call", "read", {
				path: "https://example.invalid/remote.ts",
			});
			if (assistant.message.role !== "assistant") throw new Error("expected an assistant tool-call entry");
			assistant.message.content.push({
				type: "toolCall",
				id: "local-call",
				name: "read",
				arguments: { path: "src/local.ts" },
			});
			const branch = [
				assistant,
				toolResultEntry("remote-result", "remote-call", "read", "remote excerpt"),
				toolResultEntry("local-result", "local-call", "read", "local excerpt", { editableFilePath: localPath }),
			];
			const source = await selectSource(branch, { cwd, keys: [RIGHT, DOWN, ENTER] });

			expect(source?.editorFilePath).toBe(localPath);
			expect(source?.text).toBe("local excerpt");
		});
	});

	it("uses absolute paths and authoritative single-file metadata for edit and write", async () => {
		await withTempDir(async cwd => {
			const editPath = path.join(cwd, "src", "edited.ts");
			const metadataEditPath = path.join(cwd, "src", "hashline-edited.ts");
			const writePath = path.join(cwd, "src", "created.ts");
			const metadataWritePath = path.join(cwd, "src", "metadata-created.ts");
			await fs.mkdir(path.join(cwd, "src"), { recursive: true });
			await Bun.write(metadataEditPath, "edited through hashline mode\n");
			const edited = await selectSource(
				toolBranch("edit", { path: editPath, old_string: "old", new_string: "new" }, "edit result"),
				{ cwd },
			);
			const metadataEdit = await selectSource(
				toolBranch("edit", { input: "[src/hashline-edited.ts#ABCD]\n1: old\n1: new" }, "hashline edit result", {
					path: metadataEditPath,
					diff: "--- a/src/hashline-edited.ts\n+++ b/src/hashline-edited.ts",
				}),
				{ cwd },
			);
			const renameSourcePath = path.join(cwd, "src", "before-rename.ts");
			const renameTargetPath = path.join(cwd, "src", "after-rename.ts");
			await Bun.write(renameTargetPath, "renamed file\n");
			const renamed = await selectSource(
				toolBranch(
					"edit",
					{ input: "[src/before-rename.ts#ABCD]\nMV src/after-rename.ts" },
					"renamed edit result",
					{
						path: renameTargetPath,
						sourcePath: renameSourcePath,
						move: renameTargetPath,
						diff: "--- a/src/before-rename.ts\n+++ b/src/after-rename.ts",
					},
				),
				{ cwd },
			);
			const applyPatchPath = path.join(cwd, "src", "apply-patched.ts");
			await Bun.write(applyPatchPath, "old\n");
			const applyPatch = await selectSource(
				[
					toolCallEntry("assistant-call", "call-apply-patch", "apply_patch", {
						input: [
							"*** Begin Patch",
							"*** Update File: src/apply-patched.ts",
							"@@",
							"-old",
							"+new",
							"*** End Patch",
						].join("\n"),
					}),
					toolResultEntry("tool-result", "call-apply-patch", "edit", "applied patch", {
						path: applyPatchPath,
						diff: "--- a/src/apply-patched.ts\n+++ b/src/apply-patched.ts",
					}),
				],
				{ cwd },
			);
			const written = await selectSource(
				toolBranch("write", { path: writePath, content: "new file" }, "write result"),
				{ cwd },
			);
			const metadataWritten = await selectSource(
				toolBranch("write", { path: "src/metadata-created.ts", content: "new file" }, "write result", {
					resolvedPath: metadataWritePath,
				}),
				{ cwd },
			);

			expect(edited?.editorFilePath).toBe(editPath);
			expect(metadataEdit?.editorFilePath).toBe(metadataEditPath);
			expect(renamed?.editorFilePath).toBe(renameTargetPath);
			expect(applyPatch?.editorFilePath).toBe(applyPatchPath);
			expect(written?.editorFilePath).toBe(writePath);
			expect(metadataWritten?.editorFilePath).toBe(metadataWritePath);
		});
	});

	it("rejects deleted edit targets even when those paths exist again", async () => {
		await withTempDir(async cwd => {
			const topLevelDeletePath = path.join(cwd, "top-level-delete.ts");
			const perFileDeletePath = path.join(cwd, "per-file-delete.ts");
			const nativeDeletePath = path.join(cwd, "native-delete.ts");
			await Promise.all([
				Bun.write(topLevelDeletePath, "recreated after deletion\n"),
				Bun.write(perFileDeletePath, "recreated after deletion\n"),
				Bun.write(nativeDeletePath, "recreated after deletion\n"),
			]);

			const topLevelDelete = await selectSource(
				toolBranch(
					"edit",
					{ path: topLevelDeletePath, old_string: "before", new_string: "after" },
					"delete result",
					{ path: topLevelDeletePath, op: "delete" },
				),
				{ cwd },
			);
			const perFileDelete = await selectSource(
				toolBranch(
					"edit",
					{ path: perFileDeletePath, old_string: "before", new_string: "after" },
					"delete result",
					{ perFileResults: [{ path: perFileDeletePath, op: "delete" }] },
				),
				{ cwd },
			);
			const nativeDelete = await selectSource(
				toolBranch("edit", { input: `[${nativeDeletePath}#ABCD]\nREM` }, "delete result", {
					path: nativeDeletePath,
				}),
				{ cwd },
			);

			expect(topLevelDelete?.editorFilePath).toBeUndefined();
			expect(perFileDelete?.editorFilePath).toBeUndefined();
			expect(nativeDelete?.editorFilePath).toBeUndefined();
		});
	});

	it("does not resolve historical relative edit or write paths from the current cwd", async () => {
		await withTempDir(async root => {
			const historicalCwd = path.join(root, "workspace");
			const currentCwd = path.join(historicalCwd, "nested");
			await fs.mkdir(path.join(currentCwd, "src"), { recursive: true });
			await Bun.write(path.join(currentCwd, "src", "module.ts"), "current file\n");

			const relativeEdit = await selectSource(
				toolBranch("edit", { path: "src/module.ts", old_string: "old", new_string: "new" }, "edit result", {
					path: "src/module.ts",
				}),
				{ cwd: historicalCwd, cwdAfterPick: currentCwd },
			);
			const relativeWrite = await selectSource(
				toolBranch("write", { path: "src/module.ts", content: "new file" }, "write result", {
					resolvedPath: "src/module.ts",
				}),
				{ cwd: historicalCwd, cwdAfterPick: currentCwd },
			);

			expect(relativeEdit?.editorFilePath).toBeUndefined();
			expect(relativeWrite?.editorFilePath).toBeUndefined();
		});
	});

	it("rejects URLs, internal resources, and directories", async () => {
		await withTempDir(async cwd => {
			const directory = path.join(cwd, "listing");
			await fs.mkdir(directory);
			const external = await selectSource(
				toolBranch("read", { path: "https://example.invalid/file.ts" }, "remote excerpt", {
					kind: "url",
					url: "https://example.invalid/file.ts",
					resolvedPath: path.join(cwd, "cache.ts"),
				}),
				{ cwd },
			);
			const internal = await selectSource(
				toolBranch("read", { path: "skill://example/SKILL.md" }, "internal resource", {
					resolvedPath: path.join(cwd, "skill-cache.md"),
					meta: { source: { type: "internal", value: "skill://example/SKILL.md" } },
				}),
				{ cwd },
			);
			const internalBackingPath = path.join(cwd, "internal-resource-backing.md");
			const internalSourceEdit = await selectSource(
				toolBranch(
					"apply_patch",
					{
						input: [
							"*** Begin Patch",
							"*** Update File: local://scratch.md",
							"@@",
							"-old",
							"+new",
							"*** End Patch",
						].join("\n"),
					},
					"internal edit result",
					{ path: internalBackingPath, diff: "" },
				),
				{ cwd },
			);
			const internalMoveEdit = await selectSource(
				toolBranch(
					"apply_patch",
					{
						input: [
							"*** Begin Patch",
							"*** Update File: src/source.md",
							"*** Move to: local://moved.md",
							"@@",
							"-old",
							"+new",
							"*** End Patch",
						].join("\n"),
					},
					"internal move result",
					{ path: internalBackingPath, diff: "" },
				),
				{ cwd },
			);
			const directoryRead = await selectSource(
				toolBranch("read", { path: "listing" }, "directory listing", {
					isDirectory: true,
					resolvedPath: directory,
				}),
				{ cwd },
			);

			expect(external?.editorFilePath).toBeUndefined();
			expect(internal?.editorFilePath).toBeUndefined();
			expect(internalSourceEdit?.editorFilePath).toBeUndefined();
			expect(internalMoveEdit?.editorFilePath).toBeUndefined();
			expect(directoryRead?.editorFilePath).toBeUndefined();
		});
	});

	it("uses real read results to distinguish a local text file from archive and SQLite backing files", async () => {
		await withTempDir(async cwd => {
			const sourcePath = path.join(cwd, "src", "module.ts");
			const archivePath = path.join(cwd, "source.tar");
			const databasePath = path.join(cwd, "source.sqlite");
			await fs.mkdir(path.dirname(sourcePath), { recursive: true });
			await Bun.write(sourcePath, "first\nsecond\nthird\n");
			await Bun.write(
				archivePath,
				writeTar([{ path: "src/module.ts", content: Buffer.from("first\nsecond\nthird\n"), executable: false }]),
			);
			const database = new Database(databasePath);
			try {
				database.exec(
					"CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO users (name) VALUES ('Alice'), ('Bob');",
				);
			} finally {
				database.close();
			}

			const readTool = new ReadTool({
				cwd,
				hasUI: false,
				enableLsp: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated(),
			} as ConstructorParameters<typeof ReadTool>[0]);
			const directArgs = { path: "src/module.ts:2-3" };
			const archiveArgs = { path: `${archivePath}:src/module.ts:2-3` };
			const sqliteTableArgs = { path: `${databasePath}:users` };
			const sqliteQueryArgs = { path: `${databasePath}?q=SELECT+name+FROM+users` };
			const directResult = await readTool.execute("direct-text", directArgs);
			const archiveResult = await readTool.execute("archive-member", archiveArgs);
			const sqliteTableResult = await readTool.execute("sqlite-table", sqliteTableArgs);
			const sqliteQueryResult = await readTool.execute("sqlite-query", sqliteQueryArgs);
			const directSource = await selectSource(
				toolBranch("read", directArgs, readResultText(directResult), directResult.details),
				{ cwd },
			);
			const archiveSource = await selectSource(
				toolBranch("read", archiveArgs, readResultText(archiveResult), archiveResult.details),
				{ cwd },
			);
			const sqliteTableSource = await selectSource(
				toolBranch("read", sqliteTableArgs, readResultText(sqliteTableResult), sqliteTableResult.details),
				{ cwd },
			);
			const sqliteQuerySource = await selectSource(
				toolBranch("read", sqliteQueryArgs, readResultText(sqliteQueryResult), sqliteQueryResult.details),
				{ cwd },
			);

			expect(directSource?.editorFilePath).toBe(sourcePath);
			expect(archiveSource?.editorFilePath).toBeUndefined();
			expect(sqliteTableSource?.editorFilePath).toBeUndefined();
			expect(sqliteQuerySource?.editorFilePath).toBeUndefined();
		});
	});

	it("rejects ambiguous multi-file results and non-file tools", async () => {
		await withTempDir(async cwd => {
			const multipleReads = await selectSource(
				toolBranch("read", { path: "src/one.ts;src/two.ts" }, "two excerpts", {
					displayReadTargets: ["src/one.ts", "src/two.ts"],
					displayReadTargetLinks: [path.join(cwd, "src/one.ts"), path.join(cwd, "src/two.ts")],
				}),
				{ cwd },
			);
			const multipleEdits = await selectSource(
				toolBranch("edit", { path: "src/one.ts", input: "multi-file patch" }, "two edits", {
					perFileResults: [{ path: path.join(cwd, "src/one.ts") }, { path: path.join(cwd, "src/two.ts") }],
				}),
				{ cwd },
			);
			const nonFileTool = await selectSource(toolBranch("grep", { path: "src/one.ts", pattern: "value" }), { cwd });

			expect(multipleReads?.editorFilePath).toBeUndefined();
			expect(multipleEdits?.editorFilePath).toBeUndefined();
			expect(nonFileTool?.editorFilePath).toBeUndefined();
		});
	});

	it("does not infer a file from plain transcript prose", async () => {
		await withTempDir(async cwd => {
			const userEntry: SessionMessageEntry = {
				type: "message",
				id: "user-message",
				parentId: null,
				timestamp: "2026-10-10T00:00:00.000Z",
				message: { role: "user", content: "Please inspect /tmp/private.ts", timestamp: 1 } as AgentMessage,
			};
			const source = await selectSource([userEntry], { cwd, keys: [ENTER] });

			expect(source?.editorFilePath).toBeUndefined();
			expect(source?.text).toBe("Please inspect /tmp/private.ts");
		});
	});
});
