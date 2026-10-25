import type { ThemeJson } from "../schema";

/**
 * Lazily-loaded built-in theme JSONs.
 *
 * `index.ts` statically imports all 100 default theme JSONs, which puts every
 * theme on the boot module graph even though a launch only ever shows one.
 * This module loads one theme JSON on first use instead, behind the async
 * boundary callers already have, and memoizes the result per theme name.
 */

const cache = new Map<string, Promise<ThemeJson>>();

/** Load one built-in default theme JSON by name, memoized per name. */
export function loadDefaultThemeJson(name: string): Promise<ThemeJson> {
	let cached = cache.get(name);
	if (cached === undefined) {
		// Runtime-selected specifier: the theme name is a user setting, so no
		// static import can name the JSON at author time.
		cached = import(`./${name}.json`, { with: { type: "json" } }).then(
			(module: { default: ThemeJson }) => module.default,
			(error: unknown) => {
				cache.delete(name);
				throw error;
			},
		);
		cache.set(name, cached);
	}
	return cached;
}

/** Built-in default theme names served by {@link loadDefaultThemeJson}. */
export const defaultThemeNames: readonly string[] = [
	"alabaster",
	"amethyst",
	"anthracite",
	"basalt",
	"birch",
	"dark-abyss",
	"dark-arctic",
	"dark-aurora",
	"dark-catppuccin",
	"dark-cavern",
	"dark-celestial",
	"dark-copper",
	"dark-cosmos",
	"dark-cyberpunk",
	"dark-dracula",
	"dark-eclipse",
	"dark-ember",
	"dark-equinox",
	"dark-forest",
	"dark-github",
	"dark-gruvbox",
	"dark-lavender",
	"dark-lunar",
	"dark-midnight",
	"dark-monochrome",
	"dark-monokai",
	"dark-nebula",
	"dark-neon-noir",
	"dark-nord",
	"dark-ocean",
	"dark-one",
	"dark-poimandres",
	"dark-rainforest",
	"dark-reef",
	"dark-retro",
	"dark-rose-pine",
	"dark-sakura",
	"dark-slate",
	"dark-solarized",
	"dark-solstice",
	"dark-starfall",
	"dark-sunset",
	"dark-swamp",
	"dark-synthwave",
	"dark-taiga",
	"dark-terminal",
	"dark-tokyo-night",
	"dark-tundra",
	"dark-twilight",
	"dark-volcanic",
	"graphite",
	"light-arctic",
	"light-aurora-day",
	"light-canyon",
	"light-catppuccin",
	"light-cirrus",
	"light-coral",
	"light-cyberpunk",
	"light-dawn",
	"light-dunes",
	"light-eucalyptus",
	"light-forest",
	"light-frost",
	"light-github",
	"light-glacier",
	"light-gruvbox",
	"light-haze",
	"light-honeycomb",
	"light-lagoon",
	"light-lavender",
	"light-meadow",
	"light-mint",
	"light-monochrome",
	"light-ocean",
	"light-one",
	"light-opal",
	"light-orchard",
	"light-paper",
	"light-poimandres",
	"light-prism",
	"light-retro",
	"light-sand",
	"light-savanna",
	"light-solarized",
	"light-soleil",
	"light-sunset",
	"light-synthwave",
	"light-tokyo-night",
	"light-wetland",
	"light-zenith",
	"limestone",
	"mahogany",
	"marble",
	"obsidian",
	"onyx",
	"pearl",
	"porcelain",
	"quartz",
	"sandstone",
	"titanium",
];
