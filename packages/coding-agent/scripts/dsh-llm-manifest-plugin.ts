import * as fs from "node:fs";
import { isRecord } from "@oh-my-pi/pi-utils";

/**
 * Published `@deepseek-ai/dsh-llm` reads its own version at module top level
 * via `createRequire(import.meta.url)("../package.json")` (lib/index.js and
 * lib/types/attribution.js). Under `bun build --compile` that relative path
 * resolves against the `$bunfs` chunk directory and the require throws,
 * aborting TUI boot. This plugin inlines the version constant at bundle time.
 * The store's subpath imports do not avoid it: `@deepseek-ai/dsh-session` and
 * `dsh-session-format-v1-to-v2` import the dsh-llm main entry themselves.
 */
export async function createDshLlmManifestPlugin(): Promise<Bun.BunPlugin> {
	// Resolve as the importing workspace does, so a nested (non-hoisted) install still works.
	const manifest: unknown = await Bun.file(
		Bun.resolveSync("@deepseek-ai/dsh-llm/package.json", import.meta.dir),
	).json();
	if (!isRecord(manifest) || typeof manifest.version !== "string") {
		throw new Error("@deepseek-ai/dsh-llm package.json has no version");
	}
	const replacement = `{ version: ${JSON.stringify(manifest.version)} }`;
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
