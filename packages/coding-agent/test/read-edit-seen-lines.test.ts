import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// A call whose arguments span several lines, so a structural read elides the
// inner rows (3-4) and displays the rest.
const SOURCE = [
	"def draw(sheet, anchor, alpha, beta):",
	"    add_native_hole_callout(sheet=sheet,",
	"        nested=nested(alpha,",
	"            beta),",
	"        point=model_point_in_view(",
	"            anchor),",
	"        callout_xy=(0.230, 0.258))",
	"",
].join("\n");

function textOutput(result: AgentToolResult<unknown>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

// Regression: the hashline prompt promises that hunks anchored on lines a read
// never displayed are rejected, but the seen-line guard shipped opt-in. With
// the guard off, a hunk whose range fell inside an elided region was instead
// "auto-repaired" — the syntax probe kept the row the range had selected and
// spliced the body into the neighbouring call, silently and with valid syntax.
describe("read → edit seen-line guard under default settings", () => {
	let cwd: string;
	let file: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seen-lines-"));
		file = path.join(cwd, "draw.py");
		await Bun.write(file, SOURCE);
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("rejects a hunk anchored on a line the read elided", async () => {
		const session = createSession(cwd);
		const read = textOutput(await new ReadTool(session).execute("read", { path: "draw.py:7-7" }));
		expect(read.split("\n")[0]).toMatch(/^\[draw\.py#[0-9A-F]{4}\]$/);
		expect(read).toContain("…");
		expect(read).not.toContain("beta),");

		const result = await new EditTool(session, "hashline").execute("edit", {
			input: `${read.split("\n")[0]}\nPUT 4.=4:\n+            beta, gamma),\n`,
		});

		expect(textOutput(result)).toContain("never displayed");
		expect(await Bun.file(file).text()).toBe(SOURCE);
	});

	it("applies a hunk anchored on a line the read displayed", async () => {
		const session = createSession(cwd);
		const read = textOutput(await new ReadTool(session).execute("read", { path: "draw.py:7-7" }));
		expect(read).toContain("callout_xy=(0.230, 0.258))");

		await new EditTool(session, "hashline").execute("edit", {
			input: `${read.split("\n")[0]}\nPUT 7.=7:\n+        callout_xy=(0.240, 0.258))\n`,
		});

		expect(await Bun.file(file).text()).toBe(SOURCE.replace("0.230", "0.240"));
	});
});

// Regression: grep printed a cross-line match as one row numbered only by its
// first line, so the continuation line carried no `N:` prefix, the seen-line
// guard rejected edits anchored on it, and a `...` gap marker separated the
// match from the context line directly below it.
describe("grep → edit seen-line guard under default settings", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seen-lines-grep-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("numbers every line of a cross-line match so an edit can anchor on it", async () => {
		const session = createSession(cwd);
		const file = path.join(cwd, "conf.py");
		await Bun.write(file, "import os\n\ndef connect(host,\n            port):\n    return (host, port)\n");

		const grep = textOutput(
			await new GrepTool(session).execute("grep", { pattern: "def connect\\(host,\\n\\s+port\\)", path: "conf.py" }),
		);
		expect(grep).toContain("*3:def connect(host,\n 4:            port):\n 5:    return (host, port)");

		await new EditTool(session, "hashline").execute("edit", {
			input: `${grep.split("\n")[0]}\nPUT 4.=4:\n+            port=5432):\n`,
		});

		expect(await Bun.file(file).text()).toBe(
			"import os\n\ndef connect(host,\n            port=5432):\n    return (host, port)\n",
		);
	});
});
