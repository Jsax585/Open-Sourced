import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { postProcessToolResult } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text" && typeof c.text === "string")
		.map(c => c.text as string)
		.join("\n");
}

describe("read tool artifacts without an artifacts directory", () => {
	let testDir: string;
	let manager: SessionManager;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-artifact-memory-"));
		manager = SessionManager.inMemory(testDir);
	});

	afterEach(async () => {
		await manager.close();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	function makeSession(): ToolSession {
		return {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => manager.getArtifactsDir(),
			sessionManager: manager,
			settings: Settings.isolated(),
		};
	}

	it("reads the artifact a spill footer advertises back from the in-memory store", async () => {
		const settings = Settings.isolated();
		const fullOutput = Array.from({ length: 8_000 }, (_, index) => `spill line ${index + 1} ${"x".repeat(80)}`).join(
			"\n",
		);
		const spilled = await postProcessToolResult(
			{ content: [{ type: "text", text: fullOutput }], details: {} },
			"bash",
			{ sessionManager: manager, settings } as unknown as Parameters<typeof postProcessToolResult>[2],
		);
		const advertised = getTextOutput(spilled).match(/artifact:\/\/(\d+)/);
		expect(advertised).not.toBeNull();
		expect(manager.getArtifactsDir()).toBeNull();

		const tool = new ReadTool(makeSession());
		const head = getTextOutput(await tool.execute("call-head", { path: `artifact://${advertised![1]}` }));
		const tail = getTextOutput(
			await tool.execute("call-tail", { path: `artifact://${advertised![1]}:raw:8000-8000` }),
		);

		expect(head).toContain("spill line 1 ");
		expect(tail).toContain("spill line 8000 ");
	});

	it("pages an in-memory artifact with a line selector", async () => {
		const lines = Array.from({ length: 50 }, (_, index) => `line-${index + 1}`);
		const id = await manager.saveArtifact(lines.join("\n"), "bash");
		if (id === undefined) throw new Error("expected an artifact id");

		const result = await new ReadTool(makeSession()).execute("call-range", { path: `artifact://${id}:raw:10-12` });
		const output = getTextOutput(result);

		expect(output).toContain("line-10");
		expect(output).toContain("line-12");
		expect(output).not.toContain("line-9");
		expect(output).not.toContain("line-13");
	});
});
