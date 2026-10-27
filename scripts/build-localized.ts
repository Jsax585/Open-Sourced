#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { compileCodingAgent } from "../packages/coding-agent/scripts/compile-binary";

const repoRoot = path.resolve(import.meta.dir, "..");
const outfile = path.join(repoRoot, "packages/coding-agent/binaries/omp-windows-x64.exe");
if (process.platform !== "win32" || process.arch !== "x64") {
	throw new Error("The localized executable builder supports Windows x64 only");
}
const transformers: unknown = createRequire(import.meta.url)("@huggingface/transformers/package.json");
if (typeof transformers !== "object" || transformers === null || !("version" in transformers) || typeof transformers.version !== "string") {
	throw new Error("Transformers package has no version");
}

async function generate(args: string[]): Promise<void> {
	const child = Bun.spawn([process.execPath, ...args], { cwd: repoRoot, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
	if ((await child.exited) !== 0) throw new Error(`Generation failed: ${args.join(" ")}`);
}

await fs.mkdir(path.dirname(outfile), { recursive: true });
try {
	await generate(["run", "gen:stats"]);
	await generate(["--cwd=packages/collab-web", "run", "gen:tool-views"]);
	await compileCodingAgent({
		repoRoot,
		entrypoint: path.join(repoRoot, "packages/coding-agent/src/cli.ts"),
		outfile,
		transformersVersion: transformers.version,
		native: { platform: process.platform, arch: process.arch },
		// The known local runtime avoids downloading a separate compiler target.
		executablePath: process.execPath,
		minifyIdentifiers: true,
	});
} finally {
	await generate(["run", "gen:stats:reset"]);
}
console.log(`Localized executable built: ${outfile}`);
