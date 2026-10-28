import "../src/slash-commands/builtin-registry";
import { describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { BUILTIN_SKILLS_SLASH_COMMANDS } from "../src/slash-commands/builtin-skills";
import { BUILTIN_SESSION_SLASH_COMMANDS } from "../src/slash-commands/builtin-session";
import type { SlashCommandRuntime } from "../src/slash-commands/types";

describe("portable session and skills commands", () => {
	test("invalid install arguments fail before registry access", async () => {
		const output: string[] = [];
		const runtime = {
			output: (text: string) => {
				output.push(text);
			},
		} as SlashCommandRuntime;
		const command = BUILTIN_SKILLS_SLASH_COMMANDS.find(command => command.name === "skills")!;
		const result = await command.handle!(
			{ name: "skills", args: "install --unknown", text: "/skills install --unknown" },
			runtime,
		);
		expect(result).toMatchObject({ consumed: true, failed: true });
		expect(output.join("\n")).toContain("Unknown option");
	});
	test("session deletion requires confirmation and respects refusal", async () => {
		const output: string[] = [];
		let deleted = false;
		const runtime = {
			session: { isStreaming: false },
			sessionManager: {
				getSessionFile: () => "/fixture/session.jsonl",
				dropSession: async () => {
					deleted = true;
				},
			},
			output: (text: string) => {
				output.push(text);
			},
		} as unknown as SlashCommandRuntime;
		const command = BUILTIN_SESSION_SLASH_COMMANDS.find(command => command.name === "session")!;
		const parsed = { name: "session", args: "delete", text: "/session delete" };
		expect(await command.handle!(parsed, runtime)).toMatchObject({ failed: true });
		expect(deleted).toBe(false);
		runtime.ui = {
			confirm: async () => false,
			select: async () => undefined,
			input: async () => undefined,
			editor: async () => undefined,
		};
		await command.handle!(parsed, runtime);
		expect(deleted).toBe(false);
		expect(output.join("\n")).toContain("cancelled");
	});
});

test("git renders a real revision, reports invalid revisions, and leaves the working copy unchanged", async () => {
	using directory = TempDir.createSync("omp-acp-git-");
	const cwd = directory.path();
	async function git(...args: string[]) {
		const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0) throw new Error(stderr);
		return stdout;
	}
	await git("init");
	await Bun.write(directory.join("file.txt"), "original\n");
	await git("add", "file.txt");
	await git(
		"-c",
		"user.name=Microck",
		"-c",
		"user.email=contact@micr.dev",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"fixture commit",
	);
	await Bun.write(directory.join("file.txt"), "edited\n");
	const before = await git("status", "--porcelain");
	const output: string[] = [];
	const runtime = {
		cwd,
		output: (text: string) => {
			output.push(text);
		},
	} as SlashCommandRuntime;
	const command = BUILTIN_SESSION_SLASH_COMMANDS.find(command => command.name === "git")!;
	expect(await command.handle!({ name: "git", args: "HEAD", text: "/git HEAD" }, runtime)).toEqual({ consumed: true });
	expect(output.join("\n")).toContain("fixture commit");
	expect(output.join("\n")).toContain("+original");
	expect(
		await command.handle!({ name: "git", args: "missing-revision", text: "/git missing-revision" }, runtime),
	).toMatchObject({ consumed: true, failed: true });
	expect(await git("status", "--porcelain")).toBe(before);
	expect(await Bun.file(directory.join("file.txt")).text()).toBe("edited\n");
});

test("local editing saves confirmed text, preserves cancellations, and rejects concurrent writes", async () => {
	using directory = TempDir.createSync("omp-acp-local-");
	const file = directory.join("local", "notes.md");
	await Bun.write(file, "original");
	const output: string[] = [];
	const runtime = {
		sessionManager: { getArtifactsDir: () => directory.path(), getSessionId: () => "local-test" },
		ui: { editor: async () => "edited" },
		output: (text: string) => {
			output.push(text);
		},
	} as unknown as SlashCommandRuntime;
	const command = BUILTIN_SESSION_SLASH_COMMANDS.find(command => command.name === "local")!;
	const parsed = { name: "local", args: "notes.md", text: "/local notes.md" };
	await command.handle!(parsed, runtime);
	expect(await Bun.file(file).text()).toBe("edited");
	runtime.ui!.editor = async () => undefined;
	await command.handle!(parsed, runtime);
	expect(await Bun.file(file).text()).toBe("edited");
	runtime.ui!.editor = async () => {
		await Bun.write(file, "external change");
		return "stale edit";
	};
	expect(await command.handle!(parsed, runtime)).toMatchObject({ failed: true });
	expect(await Bun.file(file).text()).toBe("external change");
	expect(output.join(" ")).toContain("File changed during editing");
});
