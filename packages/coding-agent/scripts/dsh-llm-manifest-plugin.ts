import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Published `@deepseek-ai/dsh-llm` reads its own version at module top level
 * via `createRequire(import.meta.url)("../package.json")` (lib/index.js and
 * lib/types/attribution.js). Under `bun build --compile` that relative path
 * resolves against the `$bunfs` chunk directory and the require throws,
 * aborting TUI boot. This plugin inlines the version constant at bundle time.
 */
export function createDshLlmManifestPlugin(): Bun.BunPlugin {
	const packagePath = path.resolve(import.meta.dir, "../../../node_modules/@deepseek-ai/dsh-llm/package.json");
	const { version } = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version: string };
	const replacement = `{ version: ${JSON.stringify(version)} }`;
	return {
		name: "omp:dsh-llm-manifest",
		setup(build) {
			build.onLoad({ filter: /@deepseek-ai[\\/]dsh-llm[\\/].*\.js$/ }, async ({ path: modulePath }) => {
				const source = await fs.promises.readFile(modulePath, "utf8");
				if (!source.includes("createRequire(import.meta.url)")) {
					return undefined;
				}
				const patched = source.replace(
					/createRequire\(import\.meta\.url\)\(["']\.\.\/package\.json["']\)/g,
					() => replacement,
				);
				return { contents: patched, loader: "js" };
			});
		},
	};
}
