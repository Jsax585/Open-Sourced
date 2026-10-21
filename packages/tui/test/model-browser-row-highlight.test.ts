import { beforeAll, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	ModelBrowser,
	type ModelBrowserItem,
	type ModelBrowserSource,
	buildBrowserItems,
} from "../src/overlays/model-browser";
import { initTheme, theme } from "../src/theme";

beforeAll(async () => {
	await initTheme(false);
});

/** Rendered rows before the list window: search row + blank. */
const LIST_ROW_START = 2;

function model(provider: string, id: string, extra: Partial<Model> = {}): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://127.0.0.1/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		...extra,
	} as Parameters<typeof buildModel>[0]);
}

function source(): ModelBrowserSource {
	return {
		revision: 0,
		defaultThinkingLevel: "off",
		modelProviderOrder: [],
		knownRoleIds: ["default", "smol"],
		mruOrder: [],
		modelPerf: new Map(),
		getRoleInfo: role => ({ tag: role, name: `${role} role`, section: "chat", accepts: () => true }),
		defaultRoleChain: () => [],
		resolveRoleValue: (value, models) => ({
			model: models.find(candidate => `${candidate.provider}/${candidate.id}` === value),
			explicitThinkingLevel: false,
		}),
		getModelRole: () => undefined,
	};
}

/** Foreground SGR prefix `theme.fg` emits for `color`. */
function colorPrefix(color: Parameters<typeof theme.fg>[0]): string {
	return theme.fg(color, "\u0000").split("\u0000")[0]!;
}

/** Styled run payloads (text between the foreground SGR and its reset) in `line`. */
function runTexts(line: string, color: Parameters<typeof theme.fg>[0]): string[] {
	const prefix = colorPrefix(color);
	return line
		.split(prefix)
		.slice(1)
		.map(part => part.slice(0, part.indexOf("\x1b[39m")));
}

function countRuns(line: string, color: Parameters<typeof theme.fg>[0]): number {
	return line.split(colorPrefix(color)).length - 1;
}

/** List row containing `id`, skipping the trailing detail lines that repeat the selected name. */
function rowFor(lines: readonly string[], id: string): string {
	const row = lines.slice(LIST_ROW_START).find(line => Bun.stripANSI(line).includes(id));
	if (!row) throw new Error(`no rendered row for ${id}`);
	return row;
}

function renderBrowser(
	items: ModelBrowserItem[],
	options: ConstructorParameters<typeof ModelBrowser>[1] = {},
): string[] {
	const browser = new ModelBrowser(source(), options);
	browser.setItems(items);
	return browser.render(120);
}

test("selected row paints its metric columns in the name's accent", () => {
	const lines = renderBrowser(
		buildBrowserItems([model("anthropic", "alpha", { int: 60 }), model("anthropic", "beta", { int: 60 })]),
	);

	const selected = rowFor(lines, "alpha");
	const other = rowFor(lines, "beta");

	// All rows share the same int/ctx/cost values, so column padding is empty and
	// the metric cell text is identical across rows.
	const metricCells = runTexts(other, "dim").slice(1); // drop the provider prefix
	expect(metricCells.length).toBeGreaterThanOrEqual(3);

	const selectedRuns = runTexts(selected, "accent");
	for (const cell of metricCells) expect(selectedRuns).toContain(cell);
	expect(countRuns(other, "accent")).toBe(0);
});

test("over-context selected row keeps every metric dim, leaving only the cursor accent", () => {
	const lines = renderBrowser(buildBrowserItems([model("anthropic", "tiny-ctx", { contextWindow: 8_000 })]), {
		currentContextTokens: 200_000,
		markOverContext: true,
	});

	const selected = rowFor(lines, "tiny-ctx");
	expect(Bun.stripANSI(selected)).toContain("context>");

	// The over-context branch strips the row's styling and re-dims it after the
	// cursor prefix, so accent survives only on the cursor glyph.
	expect(countRuns(selected, "accent")).toBe(1);
	expect(countRuns(selected, "dim")).toBeGreaterThan(0);
});

test("selected labelColor row paints its metrics in that color", () => {
	const items = buildBrowserItems([model("anthropic", "alpha", { int: 60 }), model("anthropic", "beta", { int: 60 })]);
	const roleRow = items[0]!;
	roleRow.labelColor = "warning";
	const lines = renderBrowser(items);

	const selected = rowFor(lines, "alpha");
	const other = rowFor(lines, "beta");

	const metricCells = runTexts(other, "dim").slice(1);
	const warningRuns = runTexts(selected, "warning");
	for (const cell of metricCells) expect(warningRuns).toContain(cell);
	// The cursor glyph stays accent; the name and metrics follow labelColor.
	expect(countRuns(selected, "accent")).toBe(1);
	expect(warningRuns).toContain("alpha");
});
