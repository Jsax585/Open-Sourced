/**
 * The read group draws a read's visual under the row of the file that
 * produced it. These pin the two contracts between the read tool's result
 * shape and that rendering: a delimited read maps each image block to its own
 * target (`displayReadTargetImages`), and only a text read proven to hold the
 * whole SVG document (`totalLines` matched by `displayContent.lineNumbers`) is
 * rasterized — a range, a prefix, or a structural summary is not.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { SvgFigure } from "@oh-my-pi/pi-tui/chat/svg-figure";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { type Component, ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const originalImageProtocol = TERMINAL.imageProtocol;

// 1x1 PNG; the 2x2 sibling is resized from it so the two targets differ in size.
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);
const SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="12" height="7">\n<rect width="12" height="7" fill="red"/>\n</svg>\n';

function makeSession(cwd: string): ToolSession {
	const model = createMockModel({ id: "vision" });
	model.input.push("image");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getArtifactsDir: () => path.join(cwd, "session"),
		getSessionSpawns: () => null,
		getModelString: () => `${model.provider}/${model.id}`,
		getActiveModelString: () => `${model.provider}/${model.id}`,
		getActiveModel: () => model,
		modelRegistry: {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		},
		settings: Settings.isolated({ "images.autoResize": false }),
	} as unknown as ToolSession;
}

function hasSvgFigure(component: Component): boolean {
	if (component instanceof SvgFigure) return true;
	if (!("children" in component) || !Array.isArray(component.children)) return false;
	return component.children.some(child => hasSvgFigure(child));
}

/** A group holding one read of `target` with the tool's actual result for it. */
async function groupFor(tool: ReadTool, target: string): Promise<ReadToolGroupComponent> {
	const group = new ReadToolGroupComponent({ ui: { requestRender: () => {} } });
	group.updateArgs({ path: target }, "read-1");
	group.updateResult(await tool.execute("read-1", { path: target }), false, "read-1");
	return group;
}

describe("ReadToolGroupComponent visuals", () => {
	let testDir: string;
	let tool: ReadTool;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme(false, undefined, undefined, "dark", "light");
	});

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-group-visuals-"));
		const png2x2 = await new Bun.Image(PNG_1X1).resize(2, 2).png().bytes();
		await Bun.write(path.join(testDir, "a.png"), PNG_1X1);
		await Bun.write(path.join(testDir, "b.png"), png2x2);
		await Bun.write(path.join(testDir, "d.svg"), SVG);
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(async () => {
		setTerminalImageProtocol(originalImageProtocol);
		await removeWithRetries(testDir);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("draws each delimited target's own image under its row", async () => {
		// No graphics protocol: each image renders as a marker carrying its own size.
		setTerminalImageProtocol(null);
		const group = await groupFor(tool, "a.png;b.png");

		const lines = Bun.stripANSI(group.render(100).join("\n")).split("\n");
		const aRow = lines.findIndex(line => line.includes("a.png"));
		const bRow = lines.findIndex(line => line.includes("b.png"));
		expect(aRow).toBeGreaterThanOrEqual(0);
		expect(bRow).toBeGreaterThan(aRow);
		expect(lines[aRow + 1]).toContain("[Image: [image/png] 1x1]");
		expect(lines[bRow + 1]).toContain("[Image: [image/png] 2x2]");
		expect(lines.filter(line => line.includes("[Image:")).length).toBe(2);
	});

	it("rasterizes a whole-file SVG read but not a range of it", async () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		expect(hasSvgFigure(await groupFor(tool, "d.svg"))).toBe(true);
		expect(hasSvgFigure(await groupFor(tool, "d.svg:raw"))).toBe(true);
		expect(hasSvgFigure(await groupFor(tool, "d.svg:1-2"))).toBe(false);
	});

	it("does not rasterize a prefix, a user-limited read, or a structural summary of an SVG", () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const head = SVG.split("\n").slice(0, 2).join("\n");
		const displayContent = { text: head, startLine: 1, lineNumbers: [1, 2] };
		const partialResults = [
			// Scan stopped before EOF: the tool emits the prefix with no line count.
			{ content: [{ type: "text", text: head }], details: { displayContent } },
			// Reached EOF but a limit cut the body: fewer lines than the file holds.
			{ content: [{ type: "text", text: head }], details: { displayContent, totalLines: 4 } },
			// Structural summary: whole file span, elided body.
			{
				content: [{ type: "text", text: SVG }],
				details: {
					displayContent: { text: SVG, startLine: 1, lineNumbers: [1, 2, 3, 4] },
					totalLines: 4,
					summary: { lines: 4, elidedSpans: 1, elidedLines: 1 },
				},
			},
		];
		for (const result of partialResults) {
			const group = new ReadToolGroupComponent({ ui: { requestRender: () => {} } });
			group.updateArgs({ path: path.join(testDir, "d.svg") }, "read-partial");
			group.updateResult(result, false, "read-partial");
			expect(hasSvgFigure(group)).toBe(false);
		}
	});
});
