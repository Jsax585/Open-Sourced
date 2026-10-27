import { describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { BashInterceptorRule } from "@oh-my-pi/pi-coding-agent/exec/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool, type BashToolInput } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { checkBashInterception } from "@oh-my-pi/pi-coding-agent/tools/bash-interceptor";
import {
	cfgBashAutoBackgroundEnabled,
	cfgBashAutoBackgroundThresholdMs,
} from "@oh-my-pi/pi-coding-agent/exec/settings";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { DEFAULT_BASH_INTERCEPTOR_RULES } from "@oh-my-pi/pi-coding-agent/exec/settings";

function createBashTool(rules: BashInterceptorRule[]): BashTool {
	const session = {
		settings: Settings.isolated({
			"bashInterceptor.enabled": true,
			"bashInterceptor.patterns": rules,
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bash.autoBackground.thresholdMs": 60_000,
		}),
		getSessionFile: () => null,
	} as unknown as ToolSession;

	return new BashTool(session);
}

describe("BashTool interception", () => {
	it("checks the original command before leading cd normalization", async () => {
		const tool = createBashTool([
			{
				pattern: "^\\s*cd\\s+",
				tool: "bash",
				message: "Do not hide directory changes in the command string.",
			},
		]);

		await expect(
			tool.execute("tool-call", { command: "cd packages/coding-agent && echo ok" }, undefined, undefined, {
				toolNames: ["bash"],
			} as AgentToolContext),
		).rejects.toThrow("Do not hide directory changes");
	});

	it("checks the cwd-normalized command after leading cd normalization", async () => {
		const tool = createBashTool([
			{
				pattern: "^\\s*cat\\s+",
				tool: "read",
				message: "Use read instead.",
			},
		]);

		const command = "cd packages/coding-agent && cat package.json";
		await expect(
			tool.execute("tool-call", { command }, undefined, undefined, {
				toolNames: ["read"],
			} as AgentToolContext),
		).rejects.toThrow(`Use read instead.\n\nOriginal command: ${command}`);
	});
});

describe("compound command interception", () => {
	const rules: BashInterceptorRule[] = [
		{
			pattern: "^\\s*git\\s+commit\\b",
			tool: "commit",
			message: "Use the commit tool instead.",
		},
	];

	it.each([
		"git commit -m message",
		"git add file && git commit -m message",
		"git add file; git commit -m message",
		"git add file || git commit -m message",
		"git add file & git commit -m message",
		"git add file\ngit commit -m message",
	])("blocks a later command after %s", command => {
		expect(checkBashInterception(command, ["commit"], rules).block).toBe(true);
	});

	it("does not intercept a downstream pipe stage that consumes piped stdin", () => {
		// `git commit` after a single `|` reads the previous stage's stdout, so
		// the dedicated tool cannot replace it. `||` still starts a fresh command.
		expect(checkBashInterception("git add file | git commit -m message", ["commit"], rules).block).toBe(false);
		expect(checkBashInterception("git add file || git commit -m message", ["commit"], rules).block).toBe(true);
	});

	it("removes one or more leading environment assignments before matching", () => {
		expect(
			checkBashInterception('GIT_AUTHOR_EMAIL="a@example.com" git commit -m message', ["commit"], rules).block,
		).toBe(true);
		expect(
			checkBashInterception(
				'GIT_AUTHOR_EMAIL="a@example.com" GIT_AUTHOR_NAME=Dev git commit -m message',
				["commit"],
				rules,
			).block,
		).toBe(true);
	});

	it("does not treat quoted, escaped, or commented text as a later command", () => {
		for (const command of [
			"printf '%s\\n' \"git add file && git commit -m message\"",
			'echo "git commit"',
			"echo git\\ commit",
			"echo ok # git commit -m message",
		]) {
			expect(checkBashInterception(command, ["commit"], rules).block).toBe(false);
		}
	});

	it("does not treat redirection targets as later commands", () => {
		for (const command of [
			"echo hi >|git commit -m message",
			"echo hi >| git commit -m message",
			"echo hi >&git commit -m message",
			"echo hi >& git commit -m message",
			"echo hi <&3 git commit -m message",
		]) {
			expect(checkBashInterception(command, ["commit"], rules).block).toBe(false);
		}
		// <& is a redirect operator, so the & does not split the command;
		// but when a && follows the redirect, the later command is still extracted.
		expect(checkBashInterception("echo hi <&3 && git commit -m message", ["commit"], rules).block).toBe(true);
	});

	it("does not add matches for unsupported shell syntax", () => {
		for (const command of [
			'echo "$(git commit -m message)"',
			"echo `git commit -m message`",
			// oxlint-disable-next-line no-template-curly-in-string -- literal shell parameter expansion under test
			"echo ${x:-foo;git commit -m message}",
			"( git commit -m message )",
			"echo start; { true; git commit -m message; }",
			"cat <<'EOF'\ngit commit -m message\nEOF",
		]) {
			expect(checkBashInterception(command, ["commit"], rules).block).toBe(false);
		}
	});

	it("keeps matching a rule written for the complete original input", () => {
		const command = "git add file && git commit -m message";
		const completeInputRule: BashInterceptorRule[] = [
			{
				pattern: "^git add file && git commit",
				tool: "commit",
				message: "Use the commit tool instead.",
			},
		];
		expect(checkBashInterception(command, ["commit"], completeInputRule).block).toBe(true);
	});

	it("does not block when the suggested tool is unavailable", () => {
		expect(checkBashInterception("git add file && git commit -m message", [], rules).block).toBe(false);
	});
});

describe("default echo/printf redirect rule", () => {
	const tools = ["write"];

	it("blocks unquoted redirects to files", () => {
		expect(checkBashInterception("echo hi > out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo hi >> out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception('printf "%s" foo > /tmp/x', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("blocks clobber and variable-target redirects", () => {
		expect(checkBashInterception("echo hi >| out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo hi > $OUT", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("does not block /dev device sink redirects", () => {
		expect(checkBashInterception("echo result > /dev/null", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("echo done > /dev/null 2>&1", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(checkBashInterception('echo "" > /dev/tty', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("echo x > /dev/stdout", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "marker" > /dev/stderr', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(checkBashInterception('echo x > "/dev/null"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});

	it("still blocks real paths that resemble /dev sinks", () => {
		expect(checkBashInterception("echo data > ./dev/null", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo data > /devices/x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("keeps scanning after allowed /dev sink redirects", () => {
		expect(
			checkBashInterception("echo data > /dev/null > out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(true);
		expect(
			checkBashInterception("printf x > /dev/stdout >> real.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(true);
	});

	it("does not block `>` inside quoted text or fd duplication", () => {
		expect(checkBashInterception('echo "a -> b"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "<p>hi</p>"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("printf 'use 2>&1'", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "err" >&2', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});

	it("does not attribute a later command's stderr redirect to echo", () => {
		const tools = ["write", "read"];
		for (const command of [
			'echo "hi"; gcloud auth print-access-token 2>/tmp/tok.err',
			'echo "hi" && ls 2>/tmp/e.err',
			"echo start\nmake 2>build.err",
			"echo x > /dev/null; ls > listing.txt",
			"echo x 2>err.log",
			"echo x 2>>err.log",
			"echo x 2>&1 && ls > listing.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		}
		expect(checkBashInterception("ls; echo hi > out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo hi 1> out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo hi &> out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		for (const command of ["echo hi 2>err.txt > out.txt", "echo hi 2>|err.txt > out.txt", "echo hi 2>&1 > out.txt"]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		}
	});

	it("keeps scanning past escaped separators and input fd duplication", () => {
		const tools = ["write", "read"];
		for (const command of [
			"echo foo\\; > out.txt",
			"echo a \\| b > out.txt",
			"echo a \\& b > out.txt",
			"echo hi <&0 > out.txt",
			"echo hi 0<&- > out.txt",
			"echo one\\\ntwo > out.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("write");
		}
		expect(checkBashInterception("echo hi <&0", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});

	it("keeps separators inside a substitution out of the boundary scan", () => {
		const tools = ["write", "read"];
		for (const command of [
			"echo $(printf foo; printf bar) > out.txt",
			"echo `date; ls` > out.txt",
			"echo ${x:-a;b} > out.txt",
			"echo $(ls > /dev/null) > out.txt",
			"echo ${a:-${b}} > out.txt",
			"echo $(( (1 + 2) * 3 )) > out.txt",
			"printf %s ${HOME:-${USER}} >> out.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("write");
		}
		expect(checkBashInterception("echo $(ls) ; ls > f", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("echo ${a:-${b}}; ls 2>e.log", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(checkBashInterception("echo $(printf a; printf b)", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
	});

	it("matches commands with many stderr sinks without exponential backtracking", () => {
		const start = performance.now();
		const echo = checkBashInterception(
			"echo hi" + " 2>/dev/null 2>>/dev/null 2>&1 \\; <&0 $(a; b) `c; d` ${e:-f;g}".repeat(20),
			["write"],
			DEFAULT_BASH_INTERCEPTOR_RULES,
		);
		const cat = checkBashInterception(
			`cat${" 2>>/dev/null 2>|e.log".repeat(20)} file.txt`,
			["write", "read"],
			DEFAULT_BASH_INTERCEPTOR_RULES,
		);
		expect(performance.now() - start).toBeLessThan(1000);
		expect(echo.block).toBe(false);
		expect(cat.suggestedTool).toBe("read");
	});

	it("routes cat heredoc and redirect writes to write, not read", () => {
		const tools = ["write", "read"];
		for (const command of ["cat > /tmp/f <<'EOF'\nx\nEOF", "cat <<'EOF' > /tmp/f\nx\nEOF", "cat >> log.txt"]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("write");
		}
		expect(checkBashInterception("cat <<'EOF'\nx\nEOF", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("cat file.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("read");
	});

	it("keeps cat on read unless its stdout goes to a file", () => {
		const tools = ["write", "read"];
		for (const command of [
			"cat 2>/dev/null file.txt",
			"cat 2>err.log file.txt",
			"cat 2>&1 file.txt",
			"cat >&2 file.txt",
			"cat 1>&2 file.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("read");
		}
		for (const command of [
			"cat 2>err.log > out.txt",
			"cat 2> err.log >> out.txt",
			"cat 2>/dev/null 1>out.txt",
			"cat &>out.txt",
			"cat 2>&1 1>out.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("write");
		}
		expect(
			checkBashInterception("cat 2>/dev/null <<'EOF'\nx\nEOF", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(false);
	});
});

describe("default grep rule and pipeline stdin", () => {
	const tools = ["grep"];

	it("blocks standalone file searches", () => {
		expect(checkBashInterception("grep pattern path", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("rg pattern src", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("blocks a first-stage grep that produces pipeline input", () => {
		expect(checkBashInterception("grep x file | wc -l", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("does not block grep consuming pipeline stdin", () => {
		expect(checkBashInterception("printf 'x\\n' | grep x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(
			checkBashInterception("tr -d '\\r' < input.log | grep -v '^ *foo'", tools, DEFAULT_BASH_INTERCEPTOR_RULES)
				.block,
		).toBe(false);
		expect(checkBashInterception("printf 'x\\n' |\n grep x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(
			checkBashInterception("printf 'x\\n' |\n # filter\n grep x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(false);
		expect(checkBashInterception("printf 'x\\n' |& grep x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});

	it("still blocks a standalone grep sequenced after a pipeline", () => {
		expect(
			checkBashInterception("cat log | tr a b && grep err file", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(true);
	});
});

describe("default bash service rules", () => {
	const tools = ["bash"];

	it.each(["bun run dev", "vite --host 0.0.0.0", "lldb ./app", "bun test --watch", "nohup server", "server &"])(
		"routes %s to named bash service mode",
		command => {
			const result = checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES);
			expect(result.block).toBe(true);
			expect(result.suggestedTool).toBe("bash");
		},
	);

	it.each(["git diff -w", "docker compose up -d", "bun test", "printf 'server &'"])(
		"does not misclassify finite command %s",
		command => {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		},
	);
});

describe("BashTool argument validation", () => {
	it("preserves async requests so disabled async mode returns the explicit error", async () => {
		const tool = createBashTool([]);
		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "tool-call",
			name: tool.name,
			arguments: { command: "echo should-not-run", async: true },
		});

		await expect(tool.execute("tool-call", args as unknown as BashToolInput)).rejects.toThrow(
			"Async bash execution is disabled",
		);
	});
});

describe("BashTool live settings", () => {
	function createLiveTool(): { tool: BashTool; settings: Settings; manager: AsyncJobManager } {
		// Every setting is read through its registry handle on each access,
		// so a later override is visible without a restart.
		const settings = Settings.isolated();
		cfgAsyncEnabled.set(settings, false);
		cfgBashAutoBackgroundEnabled.set(settings, true);
		cfgBashAutoBackgroundThresholdMs.set(settings, 60_000);
		const manager = new AsyncJobManager({ retentionMs: 0 });
		const session = {
			cwd: "/tmp",
			hasUI: false,
			skills: [],
			getSessionFile: () => null,
			getSessionId: () => "bash-live-settings",
			getAgentId: () => null,
			getClientBridge: () => undefined,
			asyncJobManager: manager,
			settings,
		} as unknown as ToolSession;
		return { tool: new BashTool(session), settings, manager };
	}

	// `properties` is `unknown` on omptype's JSON-schema projection; the cast
	// keeps every assertion reading the same shape.
	const propertyNames = (tool: BashTool): string[] =>
		Object.keys(tool.parameters.toJsonSchema().properties as Record<string, unknown>);

	const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
		result.content
			.filter(block => block.type === "text" && typeof block.text === "string")
			.map(block => block.text as string)
			.join("\n");

	it("keeps the base schema while async stays disabled", () => {
		const { tool } = createLiveTool();
		expect(propertyNames(tool)).not.toContain("async");
	});

	it("advertises the async option while async stays enabled", () => {
		const { tool, settings } = createLiveTool();
		cfgAsyncEnabled.override(settings, true);
		expect(propertyNames(tool)).toContain("async");
	});

	it("swaps the live schema when async.enabled flips without a restart", () => {
		const { tool, settings } = createLiveTool();
		expect(propertyNames(tool)).not.toContain("async");

		cfgAsyncEnabled.override(settings, true);
		expect(propertyNames(tool)).toContain("async");

		cfgAsyncEnabled.override(settings, false);
		expect(propertyNames(tool)).not.toContain("async");
	});

	it("backgrounds the next run after a live threshold override", async () => {
		const { tool, settings, manager } = createLiveTool();
		try {
			const foreground = await tool.execute("autobg-foreground", { command: "printf hi" });
			expect(foreground.details?.async).toBeUndefined();
			expect(textOf(foreground)).toContain("hi");

			// thresholdMs 0 backgrounds immediately, and the value is resolved at
			// execute time instead of being snapshotted at construction.
			cfgBashAutoBackgroundThresholdMs.override(settings, 0);
			const backgrounded = await tool.execute("autobg-background", { command: "printf hi" });
			expect(backgrounded.details?.async).toMatchObject({ state: "running", type: "bash" });
		} finally {
			await manager.dispose();
		}
	});
});
