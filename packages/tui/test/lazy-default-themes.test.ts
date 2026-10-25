import { describe, expect, it } from "bun:test";
import {
	createTheme,
	getAllBuiltinThemes,
	getAvailableThemes,
	getBuiltinThemes,
	loadTheme,
	loadThemeJson,
} from "../src/theme/loader";

/**
 * Regression test for lazy default-theme loading: the boot module graph must
 * not pay for all 100 theme JSONs, but resolving any built-in theme by name
 * must still return the same definition as the eager table once did.
 *
 * Failure mode a user sees: `loadTheme("titanium")` (or any non-first-paint
 * default) throws `Theme not found`, or returns a different definition than
 * the bundled JSON — theme switching silently breaks.
 */
describe("lazy default themes", () => {
	it("resolves a lazily-loaded theme identically on repeat loads", async () => {
		const first = await loadThemeJson("titanium");
		expect(first.name).toBe("titanium");
		const second = await loadThemeJson("titanium");
		expect(second).toBe(first);
	});

	it("builds the same theme object as the bundled JSON", async () => {
		const theme = await loadTheme("porcelain", { mode: "truecolor" });
		const json = await loadThemeJson("porcelain");
		const direct = createTheme(json, { mode: "truecolor" });
		expect(theme.getColorHex("accent")).toBe(direct.getColorHex("accent"));
		expect(theme.getBgHex("userMessageBg")).toBe(direct.getBgHex("userMessageBg"));
	});

	it("keeps dark and light on the synchronous first-paint path", async () => {
		const { loadThemeJsonSync } = await import("../src/theme/loader");
		expect(loadThemeJsonSync("dark").name).toBe("dark");
		expect(loadThemeJsonSync("light").name).toBe("light");
		expect(getBuiltinThemes().dark.name).toBe("dark");
	});

	it("lists every default theme before any of them loads", async () => {
		const names = await getAvailableThemes();
		expect(names).toContain("titanium");
		expect(names).toContain("porcelain");
		expect(names.length).toBeGreaterThanOrEqual(100);
	});

	it("completes the full built-in table on demand", async () => {
		const all = await getAllBuiltinThemes();
		expect(Object.keys(all).length).toBeGreaterThanOrEqual(100);
		expect(all["titanium"]?.name).toBe("titanium");
	});
});
