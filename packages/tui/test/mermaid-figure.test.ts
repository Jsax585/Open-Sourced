import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import * as natives from "@oh-my-pi/pi-natives";
import { MermaidFigure, resolveMermaidDiagram } from "@oh-my-pi/pi-tui/chat/mermaid-figure";
import { SvgFigure } from "@oh-my-pi/pi-tui/chat/svg-figure";
import { prepareSvg } from "@oh-my-pi/pi-tui/chat/svg-source";
import { Image, ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import { setImageBlobWriter } from "@oh-my-pi/pi-tui/prompt/image-references";
import { applyHyperlinkSetting } from "@oh-my-pi/pi-tui/render/hyperlink";
import {
	type CellDimensions,
	getCellDimensions,
	getImageDimensions,
	ImageProtocol,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { getMarkdownTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { descendants, parseXml, type XmlElement, type XmlNode } from "@oh-my-pi/pi-utils/docx/xml";
import * as pele from "pele";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

const CELL: CellDimensions = { widthPx: 10, heightPx: 20 };

/** Keep invalid/source fallback assertions independent of the optional ASCII adapter. */
function sourceMarkdown(text: string): Markdown {
	return new Markdown(text, 0, 0, { ...getMarkdownTheme(), resolveMermaidAscii: undefined });
}

/** Kitty placement is the actual image box reserved in the terminal, not a layout estimate. */
function placementRows(rows: readonly string[]): number {
	const match = /c=(\d+),r=(\d+)/.exec(rows.join("\n"));
	if (!match) throw new Error("No Kitty image placement");
	return Number(match[2]);
}

function svgNode(svg: XmlElement, id: string): XmlElement {
	const node = descendants(svg, "g").find(element => element.attributes.get("data-id") === id);
	if (!node) throw new Error(`SVG has no node ${id}`);
	return node;
}

/** Decode XML once, treating positioned line breaks as whitespace, not inline span boundaries. */
function svgLabel(node: XmlElement): string {
	let previousY: number | undefined;
	const text = (child: XmlNode): string => {
		if (child.kind === "text") return child.value;
		const y = child.attributes.get("y");
		const nextY = y === undefined ? previousY : Number(y);
		const newLine =
			(nextY !== undefined && previousY !== undefined && nextY !== previousY) ||
			Number(child.attributes.get("dy") ?? 0) !== 0;
		previousY = nextY;
		return (newLine ? " " : "") + child.children.map(text).join("");
	};
	return descendants(node, "text").map(text).join(" ").replace(/\s+/g, " ").trim();
}

/** Inline CSS overrides presentation attributes independently of declaration/attribute ordering. */
function svgProperty(element: XmlElement, property: string): string | undefined {
	let value = element.attributes.get(property);
	for (const declaration of (element.attributes.get("style") ?? "").split(";")) {
		const colon = declaration.indexOf(":");
		if (declaration.slice(0, colon).trim() === property) value = declaration.slice(colon + 1).trim();
	}
	return value;
}

function repeatLines(count: number, line: (index: number) => string): string {
	return Array.from({ length: count }, (_, index) => line(index)).join("\n");
}

describe("source-preserving Mermaid figures", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	const originalGraphics = { ...getKittyGraphics() };
	let originalCell: CellDimensions;

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(() => {
		originalCell = { ...getCellDimensions() };
		setTerminalImageProtocol(ImageProtocol.Kitty);
		setCellDimensions(CELL);
		setKittyGraphics({ unicodePlaceholders: false });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setTerminalImageProtocol(originalProtocol);
		setCellDimensions(originalCell);
		setKittyGraphics(originalGraphics);
	});

	it("keeps full-size SVG/PNG links and row geometry when its preview is demoted", async () => {
		const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-mermaid-export-"));
		const disposeWriter = setImageBlobWriter((data, options) => {
			const file = path.join(directory, `${Bun.hash(data)}.${options?.extension}`);
			fs.writeFileSync(file, data);
			return { displayPath: file };
		});
		applyHyperlinkSetting("always");
		let changed = Promise.withResolvers<void>();
		const budget = new ImageBudget(1);
		const figure = new MermaidFigure({
			maxRows: () => 6,
			markdown: sourceMarkdown,
			budget,
			onChange: () => {
				changed.resolve();
				changed = Promise.withResolvers<void>();
			},
		});
		const source = `flowchart TD\n${repeatLines(10, index => `N${index}[Step ${index}] --> N${index + 1}[Step ${index + 1}]`)}`;
		try {
			figure.update(source, true);
			let rows: readonly string[];
			for (;;) {
				const next = changed.promise;
				rows = figure.render(100);
				if (!figure.pending) break;
				await next;
			}
			const targets = Array.from(rows.join("\n").matchAll(/\x1b\]8;[^;]*;(file:[^\x07\x1b]+)/g), match =>
				url.fileURLToPath(match[1]!),
			);
			expect(targets.map(target => path.extname(target)).sort()).toEqual([".png", ".svg"]);
			const svgPath = targets.find(target => target.endsWith(".svg"))!;
			const svg = await Bun.file(svgPath).text();
			const diagram = resolveMermaidDiagram(source)!;
			const drawing = parseXml(svg);
			expect(drawing.attributes.get("viewBox")).toBe(`0 0 ${diagram.width} ${diagram.height}`);
			expect(svgLabel(svgNode(drawing, "N10"))).toBe("Step 10");
			expect(svg).not.toContain("var(");
			const png = await fs.promises.readFile(targets.find(target => target.endsWith(".png"))!);
			expect(getImageDimensions(png.toBase64(), "image/png")).toEqual({
				widthPx: Math.ceil(diagram.width * 2),
				heightPx: Math.ceil(diagram.height * 2),
			});
			expect(placementRows(rows)).toBeLessThanOrEqual(6);
			const newer = new Image(png.toBase64(), "image/png", { fallbackColor: text => text }, { budget });
			budget.beginPass();
			figure.render(100);
			newer.render(100);
			budget.endPass();
			budget.beginPass();
			const demoted = figure.render(100);
			newer.render(100);
			budget.endPass();
			expect(demoted.some(row => TERMINAL.isImageLine(row))).toBe(false);
			expect(demoted).toHaveLength(rows.length);
			for (const target of targets) expect(demoted.join("\n")).toContain(url.pathToFileURL(target).href);
		} finally {
			figure.dispose();
			disposeWriter();
			applyHyperlinkSetting("auto");
			await fs.promises.rm(directory, { recursive: true, force: true });
		}
	});

	it("exports an oversized diagram whole as SVG without fitting it into a small PNG", async () => {
		const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-mermaid-large-export-"));
		const disposeWriter = setImageBlobWriter((data, options) => {
			const file = path.join(directory, `large.${options?.extension}`);
			fs.writeFileSync(file, data);
			return { displayPath: file };
		});
		applyHyperlinkSetting("always");
		let changed = Promise.withResolvers<void>();
		const figure = new MermaidFigure({
			maxRows: () => 6,
			markdown: sourceMarkdown,
			onChange: () => {
				changed.resolve();
				changed = Promise.withResolvers<void>();
			},
		});
		const source = `flowchart TD\n${repeatLines(120, index => `G${index}[Stage ${index}] --> G${index + 1}[Stage ${index + 1}]`)}`;
		try {
			figure.update(source, true);
			let rows: readonly string[];
			for (;;) {
				const next = changed.promise;
				rows = figure.render(100);
				if (!figure.pending) break;
				await next;
			}
			const targets = Array.from(rows.join("\n").matchAll(/\x1b\]8;[^;]*;(file:[^\x07\x1b]+)/g), match =>
				url.fileURLToPath(match[1]!),
			);
			expect(targets.map(target => path.extname(target))).toEqual([".svg"]);
			const svg = parseXml(await Bun.file(targets[0]!).text());
			expect(Number(svg.attributes.get("height"))).toBeGreaterThan(4_096);
			expect(svgLabel(svgNode(svg, "G120"))).toBe("Stage 120");
			expect(placementRows(rows)).toBeLessThanOrEqual(6);
		} finally {
			figure.dispose();
			disposeWriter();
			applyHyperlinkSetting("auto");
			await fs.promises.rm(directory, { recursive: true, force: true });
		}
	});

	it("materializes links in the current host's store instead of reusing a previous host's paths", async () => {
		const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-mermaid-host-"));
		applyHyperlinkSetting("always");
		async function renderForHost(name: string): Promise<string[]> {
			const root = path.join(directory, name);
			await fs.promises.mkdir(root);
			const disposeWriter = setImageBlobWriter((data, options) => {
				const file = path.join(root, `diagram.${options?.extension}`);
				fs.writeFileSync(file, data);
				return { displayPath: file };
			});
			let changed = Promise.withResolvers<void>();
			const figure = new MermaidFigure({
				markdown: sourceMarkdown,
				onChange: () => {
					changed.resolve();
					changed = Promise.withResolvers<void>();
				},
			});
			try {
				figure.update("flowchart LR\n Host[Current host]", true);
				let rows: readonly string[];
				for (;;) {
					const next = changed.promise;
					rows = figure.render(100);
					if (!figure.pending) break;
					await next;
				}
				return Array.from(rows.join("\n").matchAll(/\x1b\]8;[^;]*;(file:[^\x07\x1b]+)/g), match =>
					url.fileURLToPath(match[1]!),
				);
			} finally {
				figure.dispose();
				disposeWriter();
			}
		}
		try {
			const previous = await renderForHost("previous");
			const current = await renderForHost("current");
			expect(previous.map(file => path.dirname(file))).toEqual([
				path.join(directory, "previous"),
				path.join(directory, "previous"),
			]);
			expect(current.map(file => path.dirname(file))).toEqual([
				path.join(directory, "current"),
				path.join(directory, "current"),
			]);
			const svg = parseXml(await Bun.file(current.find(file => file.endsWith(".svg"))!).text());
			expect(svgLabel(svgNode(svg, "Host"))).toBe("Current host");
		} finally {
			applyHyperlinkSetting("auto");
			await fs.promises.rm(directory, { recursive: true, force: true });
		}
	});

	it("preserves CSS-variable expressions as literal diagram labels while resolving paint", () => {
		const diagram = resolveMermaidDiagram('flowchart LR\n Literal["var(--fg) + var(--missing, red)"]')!;
		const prepared = parseXml(prepareSvg(diagram.svg, { fg: "#eeeeee", accent: "#ff8800" }));
		expect(svgLabel(svgNode(prepared, "Literal"))).toBe("var(--fg) + var(--missing, red)");
		expect(prepared.attributes.get("fill")).toBe("#eeeeee");
	});

	it("enforces the source limit in UTF-8 bytes at the multibyte boundary", () => {
		const syntax = "%% \nflowchart LR\n ByteA[Within budget] --> ByteB[Done]";
		const remaining = 64 * 1024 - Buffer.byteLength(syntax);
		const comment = "界".repeat(Math.floor(remaining / 3)) + "a".repeat(remaining % 3);
		const source = syntax.replace("%% ", `%% ${comment}`);
		expect(Buffer.byteLength(source)).toBe(64 * 1024);
		const accepted = resolveMermaidDiagram(source)!;
		expect(svgLabel(svgNode(parseXml(accepted.svg), "ByteA"))).toBe("Within budget");
		const oversized = `${source}\n%% 界`;
		expect(oversized.length).toBeLessThan(64 * 1024);
		expect(resolveMermaidDiagram(oversized)).toBeNull();
	});

	it("preserves decoded label words across wrapping, original source, authored styles and late-bound themes", () => {
		const source =
			'%% authored-style regression\r\nflowchart LR\r\n A["Original & label"] --> B[Done]\r\n classDef authored fill:#ff0066,stroke:#00aaff,color:#123456,font-weight:bold,font-size:28px\r\n class A authored\r\n';
		const parsing = vi.spyOn(pele, "parse");
		const layout = vi.spyOn(pele, "render");
		const diagram = resolveMermaidDiagram(source);
		if (!diagram) throw new Error("Styled graph did not resolve");
		expect(diagram.source).toBe(source);
		const svg = parseXml(diagram.svg);
		const authored = svgNode(svg, "A");
		const shape = descendants(authored, "rect")[0];
		const label = descendants(authored, "text")[0];
		if (!shape || !label) throw new Error("Styled node has no shape or label");
		// Pele may wrap at the authored 28px font size. The words and decoded
		// ampersand must survive; their XML escaping and text-span boundaries need not.
		expect(svgLabel(authored)).toBe("Original & label");
		expect(svgLabel(svgNode(svg, "B"))).toBe("Done");
		expect(svgProperty(shape, "fill")).toBe("#ff0066");
		expect(svgProperty(shape, "stroke")).toBe("#00aaff");
		expect(svgProperty(label, "fill")).toBe("#123456");
		expect(svgProperty(label, "font-weight")).toBe("bold");
		expect(svgProperty(label, "font-size")).toBe("28px");
		expect(Number.parseFloat(svgProperty(svg, "font-size") ?? "")).toBe(14);
		const dark = prepareSvg(diagram.svg, { fg: "#eeeeee", surface: "#111111", muted: "#aaaaaa", border: "#888888" });
		const light = prepareSvg(diagram.svg, { fg: "#111111", surface: "#eeeeee", muted: "#555555", border: "#777777" });
		const darkSvg = parseXml(dark);
		const lightSvg = parseXml(light);
		expect(svgProperty(darkSvg, "fill")).toBe("#eeeeee");
		expect(svgProperty(lightSvg, "fill")).toBe("#111111");
		for (const prepared of [darkSvg, lightSvg]) {
			const node = svgNode(prepared, "A");
			const preparedShape = descendants(node, "rect")[0];
			const preparedLabel = descendants(node, "text")[0];
			if (!preparedShape || !preparedLabel) throw new Error("Prepared node has no shape or label");
			expect(svgLabel(node)).toBe("Original & label");
			expect(svgProperty(preparedShape, "fill")).toBe("#ff0066");
			expect(svgProperty(preparedShape, "stroke")).toBe("#00aaff");
			expect(svgProperty(preparedLabel, "fill")).toBe("#123456");
			expect(svgProperty(preparedLabel, "font-weight")).toBe("bold");
			expect(svgProperty(preparedLabel, "font-size")).toBe("28px");
		}
		expect(dark).not.toContain("var(");
		expect(light).not.toContain("var(");
		resolveMermaidDiagram(source);
		expect(layout).toHaveBeenCalledTimes(1);
		expect(parsing).toHaveBeenCalledTimes(1);
	});

	it("does not turn authored links and remote images into active SVG resources", () => {
		const source = `flowchart LR
 A@{ img: "https://untrusted.example/image.png", label: "Remote node", w: 60, h: 60 } --> B[Safe]
 click A "https://untrusted.example/open"
`;
		const diagram = resolveMermaidDiagram(source);
		if (!diagram) throw new Error("Graph with disabled resources did not resolve");
		expect(diagram.svg).not.toMatch(/<(?:a|image)\b|\b(?:xlink:)?href=/);
		expect(diagram.source).toContain("https://untrusted.example/image.png");
	});

	it("caches invalid conversion and rejects over-limit source and edge expansion without retrying on repaint", async () => {
		const parsing = vi.spyOn(pele, "parse");
		const layout = vi.spyOn(pele, "render");
		const invalid = "flowchart LR\n Invalid[unterminated cache-failure";
		expect(resolveMermaidDiagram(invalid)).toBeNull();
		expect(resolveMermaidDiagram(invalid)).toBeNull();
		expect(parsing).toHaveBeenCalledTimes(1);
		expect(layout).not.toHaveBeenCalled();
		const oversized = `flowchart LR\n%% ${"x".repeat(64 * 1024)}`;
		expect(resolveMermaidDiagram(oversized)).toBeNull();
		expect(parsing).toHaveBeenCalledTimes(1);
		const left = Array.from({ length: 26 }, (_, index) => `Left${index}`).join(" & ");
		const right = Array.from({ length: 26 }, (_, index) => `Right${index}`).join(" & ");
		expect(resolveMermaidDiagram(`flowchart LR\n ${left} --> ${right}`)).toBeNull();

		const captured: string[] = [];
		const figure = new MermaidFigure({
			onChange: () => {},
			markdown: text => {
				captured.push(text);
				return sourceMarkdown(text);
			},
		});
		try {
			figure.update(invalid, true);
			await Promise.resolve();
			const rendered = figure.render(100);
			figure.render(100);
			expect(figure.pending).toBe(false);
			expect(rendered.some(row => TERMINAL.isImageLine(row))).toBe(false);
			expect(captured).toHaveLength(1);
			expect(captured[0]).toStartWith("```mermaid\n");
			expect(captured[0]).toContain(invalid);
			expect(parsing).toHaveBeenCalledTimes(2);
			expect(layout).not.toHaveBeenCalled();
		} finally {
			figure.dispose();
		}
	});

	it.each([
		["class", `classDiagram\n${repeatLines(513, index => `A --> B : link${index}`)}`],
		["er", `erDiagram\n${repeatLines(513, index => `A ||--o{ B : link${index}`)}`],
		[
			"c4",
			`C4Context\nPerson(a, "A")\n${repeatLines(
				513,
				index => `Person(b${index}, "B ${index}")\nRel(a, b${index}, "link${index}")`,
			)}`,
		],
		["sankey", `sankey-beta\n${repeatLines(513, () => "A,B,1")}`],
		["state", `stateDiagram-v2\nstate Outer {\n${repeatLines(513, index => `A --> B : nested${index}`)}\n}`],
		["sequence", `sequenceDiagram\n${repeatLines(513, index => `A->>B: signal${index}`)}`],
		["gitGraph", `gitGraph\n${repeatLines(514, index => `commit id: "revision${index}"`)}`],
		["journey", `journey\nsection Steps\n${repeatLines(514, index => `Step${index}: 3: Actor`)}`],
		["timeline", `timeline\nPeriod\n${repeatLines(513, index => `: event${index}`)}`],
		["mindmap", `mindmap\n Root\n${repeatLines(513, index => `  Child${index}`)}`],
		["treeView", `treeView-beta\nroot/\n${repeatLines(513, index => `    child${index}`)}`],
		["ishikawa", `ishikawa\nEffect\n${repeatLines(513, index => ` Cause${index}`)}`],
		[
			"railroad",
			`railroad-beta\nRule = sequence(${Array.from({ length: 128 }, () => 'optional(terminal("x"))').join(",")});`,
		],
	])("rejects 513 parsed %s relationships before layout and caches the source fallback", (kind, source) => {
		const parsing = vi.spyOn(pele, "parse");
		const layout = vi.spyOn(pele, "render");
		expect(source.length).toBeLessThan(64 * 1024);
		expect(resolveMermaidDiagram(source)).toBeNull();
		// An invalid/unsupported fixture would also return null, but would not
		// return this family model from the real parser.
		expect(parsing.mock.results[0]).toMatchObject({ type: "return", value: { type: kind } });
		expect(resolveMermaidDiagram(source)).toBeNull();
		expect(parsing).toHaveBeenCalledTimes(1);
		expect(layout).not.toHaveBeenCalled();
	});

	it("renders 512 class relationships without counting arrow-looking comments or labels", () => {
		const source = `%% ${"A --> B ".repeat(600)}\r\nclassDiagram\r\n${repeatLines(
			512,
			index => `A --> B : link${index} --> literal`,
		).replaceAll("\n", "\r\n")}\r\n`;
		const parsing = vi.spyOn(pele, "parse");
		const layout = vi.spyOn(pele, "render");
		const diagram = resolveMermaidDiagram(source);
		if (!diagram) throw new Error("At-limit class relationships did not resolve");
		expect(diagram.source).toBe(source);
		expect(diagram.svg).toContain("link511");
		resolveMermaidDiagram(source);
		expect(parsing).toHaveBeenCalledTimes(1);
		expect(layout).toHaveBeenCalledTimes(1);
	});

	it("renders exactly 512 expanded flowchart relationships but rejects another fan-out", () => {
		const left = Array.from({ length: 16 }, (_, index) => `BoundaryLeft${index}`).join(" & ");
		const right = Array.from({ length: 32 }, (_, index) => `BoundaryRight${index}`).join(" & ");
		const layout = vi.spyOn(pele, "render");
		const diagram = resolveMermaidDiagram(`flowchart LR\n${left} --> ${right}`);
		if (!diagram) throw new Error("At-limit expanded flowchart did not resolve");
		expect(diagram.svg).toContain("BoundaryRight31");
		expect(resolveMermaidDiagram(`flowchart LR\n${left} --> ${right} & BoundaryRight32`)).toBeNull();
		expect(layout).toHaveBeenCalledTimes(1);
	});

	it("does not charge sequence notes, activation or control frames against 512 signal relationships", () => {
		const source = `sequenceDiagram
autonumber
participant A
participant B
activate A
loop Control frame, not a signal
${repeatLines(512, index => `A->>B: boundaryMessage${index}`)}
end
deactivate A
note over A,B: literal --> note, not a signal
`;
		const diagram = resolveMermaidDiagram(source);
		if (!diagram) throw new Error("At-limit sequence signals did not resolve");
		expect(diagram.svg).toContain("boundaryMessage511");
		expect(diagram.source).toBe(source);
	});

	it("allows 512 railroad connections after expanding optional bypass tracks", () => {
		const elements = Array.from({ length: 127 }, () => 'optional(terminal("x"))');
		elements.push('terminal("a")', 'terminal("b")', 'terminal("c")');
		const source = `railroad-beta\nBoundaryRule = sequence(${elements.join(",")});`;
		const diagram = resolveMermaidDiagram(source);
		if (!diagram) throw new Error("At-limit expanded railroad tracks did not resolve");
		expect(diagram.svg).toContain("BoundaryRule");
		expect(diagram.source).toBe(source);
	});

	it("evicts successful and failed natural layouts at the entry limit", () => {
		const layout = vi.spyOn(pele, "render");
		const source = "flowchart LR\n A[Entry-limit original] --> B[Retained source]";
		const original = resolveMermaidDiagram(source);
		if (!original) throw new Error("Eviction fixture did not resolve");
		for (let index = 0; index < 65; index++) {
			resolveMermaidDiagram(`unsupported diagram entry-eviction-${index}`);
		}
		const rebuilt = resolveMermaidDiagram(source);
		expect(rebuilt?.svg).toContain("Entry-limit original");
		expect(rebuilt?.source).toBe(source);
		expect(layout).toHaveBeenCalledTimes(2);
	});

	it("counts preserved source bytes so a few large comments cannot bypass the cache byte limit", () => {
		const source = "flowchart LR\n A[Byte-limit original] --> B[Full detail]";
		const layout = vi.spyOn(pele, "render");
		const original = resolveMermaidDiagram(source);
		if (!original) throw new Error("Byte eviction fixture did not resolve");
		const comment = "x".repeat(60 * 1024);
		for (let index = 0; index < 36; index++) {
			const source = `%% byte-eviction-${index} ${comment}\nflowchart LR\n A[Comment graph ${index}] --> B[Done]`;
			const diagram = resolveMermaidDiagram(source);
			if (!diagram) throw new Error("A source within the source bound was rejected");
		}
		const rebuilt = resolveMermaidDiagram(source);
		expect(rebuilt?.source).toBe(source);
		expect(rebuilt?.svg).toContain("Full detail");
		expect(layout).toHaveBeenCalledTimes(38);
	});

	it("retains the entire tall graph for inspection while its real terminal preview stays within the caller's rows", async () => {
		const source = `flowchart TD\n${Array.from(
			{ length: 140 },
			(_, index) => `N${index}[Step ${index}] --> N${index + 1}[Step ${index + 1}]`,
		).join("\n")}`;
		const parsing = vi.spyOn(pele, "parse");
		const layout = vi.spyOn(pele, "render");
		let changed = Promise.withResolvers<void>();
		const figure = new MermaidFigure({
			markdown: sourceMarkdown,
			maxRows: () => 6,
			onChange: () => changed.resolve(),
		});
		try {
			figure.update(source, true);
			await changed.promise;
			const diagram = resolveMermaidDiagram(source);
			if (!diagram) throw new Error("Tall graph did not resolve");
			expect(diagram?.height).toBeGreaterThan(8000);
			expect(diagram?.svg).toContain("Step 140");
			expect(diagram?.source).toBe(source);
			changed = Promise.withResolvers<void>();
			figure.render(100);
			await changed.promise;
			const rows = figure.render(100);
			expect(placementRows(rows)).toBeLessThanOrEqual(6);
			expect(figure.pending).toBe(false);
			figure.invalidate();
			for (let paint = 0; paint < 5; paint++) figure.render(100);
			expect(layout).toHaveBeenCalledTimes(1);
			expect(resolveMermaidDiagram(source)).toBe(diagram);
			expect(parsing).toHaveBeenCalledTimes(1);
		} finally {
			figure.dispose();
		}
	});

	it("coalesces completed revisions and never lays out streaming or disposed figures", async () => {
		const parsing = vi.spyOn(pele, "parse");
		const layout = vi.spyOn(pele, "render");
		const changed = vi.fn();
		const figure = new MermaidFigure({ markdown: sourceMarkdown, onChange: changed });
		figure.update("flowchart LR\n A[Streaming engine fixture] -->", false);
		figure.render(100);
		await Promise.resolve();
		expect(layout).not.toHaveBeenCalled();
		expect(figure.pending).toBe(false);
		figure.update("flowchart LR\n A[Superseded complete] --> B", true);
		figure.update("flowchart LR\n A[Latest complete] --> C", true);
		await Promise.resolve();
		expect(layout).toHaveBeenCalledTimes(1);
		expect(parsing).toHaveBeenCalledTimes(1);
		expect(parsing.mock.calls[0]?.[0]).toContain("Latest complete");
		expect(resolveMermaidDiagram("flowchart LR\n A[Latest complete] --> C")?.source).toContain("Latest complete");
		figure.dispose();
		figure.update("flowchart LR\n A[Disposed source must not resolve] --> D", true);
		await Promise.resolve();
		expect(layout).toHaveBeenCalledTimes(1);
		expect(figure.render(100)).toEqual([]);
		expect(figure.pending).toBe(false);

		const abandoned = new MermaidFigure({ onChange: changed });
		abandoned.update("flowchart LR\n A[Abandoned queued layout] --> B", true);
		abandoned.dispose();
		await Promise.resolve();
		expect(layout).toHaveBeenCalledTimes(1);
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it("discards a native raster that lands after its Mermaid view was disposed", async () => {
		const png = await natives.rasterizeSvg(
			new TextEncoder().encode('<svg width="10" height="20"><rect width="10" height="20" fill="red"/></svg>'),
			10,
			20,
			1,
		);
		const delayed = Promise.withResolvers<Uint8Array>();
		const raster = vi.spyOn(natives, "rasterizeSvg").mockReturnValue(delayed.promise);
		const changed = vi.fn();
		const figure = new MermaidFigure({ onChange: changed });
		figure.update("flowchart LR\n A[Late-raster disposal fixture] --> B", true);
		await Promise.resolve();
		figure.render(100);
		expect(raster).toHaveBeenCalledTimes(1);
		figure.dispose();
		delayed.resolve(png);
		await delayed.promise;
		await Promise.resolve();
		expect(changed).toHaveBeenCalledTimes(1);
		expect(figure.render(100)).toEqual([]);
	});

	it("uses original-language Markdown if an SVG crop fails, leaving the authored-SVG default unchanged", async () => {
		const source = 'flowchart LR\n A["literal ``` inside a label"] --> B\n';
		const captured: string[] = [];
		const changed = Promise.withResolvers<void>();
		const figure = new SvgFigure({
			label: "Mermaid",
			sourceFallback: () => ({ language: "mermaid", source }),
			markdown: text => {
				captured.push(text);
				return sourceMarkdown(text);
			},
			onChange: () => changed.resolve(),
		});
		try {
			figure.update("not an SVG crop", true);
			figure.render(100);
			await changed.promise;
			const rows = figure.render(100);
			expect(captured[0]).toStartWith("````mermaid\n");
			expect(captured[0]).toContain('A["literal ``` inside a label"] --> B');
			expect(captured[0]).not.toContain("not an SVG crop");
			expect(rows.some(row => TERMINAL.isImageLine(row))).toBe(false);
		} finally {
			figure.dispose();
		}
		const defaults: string[] = [];
		const svg = new SvgFigure({
			markdown: text => {
				defaults.push(text);
				return sourceMarkdown(text);
			},
			onChange: () => {},
		});
		try {
			svg.update("authored invalid SVG source", true);
			svg.render(100);
			expect(defaults[0]).toStartWith("```svg\n");
			expect(defaults[0]).toContain("authored invalid SVG source");
		} finally {
			svg.dispose();
		}
	});

	it("redraws to changed reader row limits while retaining the native pixel-edge cap", async () => {
		let availableRows = 3;
		let changed = Promise.withResolvers<void>();
		const figure = new SvgFigure({ maxRows: () => availableRows, onChange: () => changed.resolve() });
		try {
			figure.update('<svg width="200" height="1000000"><rect width="200" height="1000000" fill="red"/></svg>', true);
			figure.render(100);
			await changed.promise;
			expect(placementRows(figure.render(100))).toBe(3);
			availableRows = 7;
			changed = Promise.withResolvers<void>();
			figure.render(100);
			await changed.promise;
			expect(placementRows(figure.render(100))).toBe(7);
			availableRows = 10000;
			changed = Promise.withResolvers<void>();
			figure.render(100);
			await changed.promise;
			expect(placementRows(figure.render(100)) * CELL.heightPx).toBeLessThanOrEqual(4096);
		} finally {
			figure.dispose();
		}
	});
});
