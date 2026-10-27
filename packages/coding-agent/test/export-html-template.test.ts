import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BunPlugin } from "bun";
import { getTemplate, resolveBundledHtmlAssetPath } from "../src/export/html/index";

interface HeapProbeResult {
	retainedAssetStrings: number;
	retainedAssets: Array<{ name: string; selfSize: number }>;
}

interface TemplateProbeResult {
	stableCache: boolean;
	assetsRemoved: number;
}

const bundleDistUrl = new URL("../scripts/bundle-dist.ts", import.meta.url).href;
const templateProbePath = path.resolve(import.meta.dir, "fixtures", "html-export-template-probe.ts");
const heapProbePath = path.resolve(import.meta.dir, "fixtures", "html-export-static-import-heap-probe.ts");
const packageDir = path.resolve(import.meta.dir, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-html-template-"));
const unrelatedCwd = path.join(tempRoot, "unrelated-cwd");
const bundleDir = path.join(tempRoot, "bundle");
let bundlePath: string;
const bundledDependencyStubs: Record<string, string> = {
	"@oh-my-pi/pi-utils": 'export const APP_NAME = "omp"; export const isEnoent = () => false;',
	"@oh-my-pi/pi-tui/theme":
		"export const getResolvedThemeColors = async () => ({}); export const getThemeExportColors = async () => ({});",
	"../../session/sub-sessions": "export const collectSubSessions = async () => ({});",
	"../../session/session-manager":
		"export class SessionManager { static async open() { return new SessionManager(); } }",
	"./args": "export const parseExportArgs = () => undefined;",
	"./web-palette": 'export const webExportThemeVars = () => "";',
};
const focusedBundlePlugin: BunPlugin = {
	name: "html-template-focused-bundle",
	setup(build) {
		build.onResolve({ filter: /.*/ }, args =>
			bundledDependencyStubs[args.path] === undefined
				? undefined
				: { path: args.path, namespace: "html-template-test-stub" },
		);
		build.onLoad({ filter: /.*/, namespace: "html-template-test-stub" }, args => ({
			contents: bundledDependencyStubs[args.path]!,
			loader: "js",
		}));
	},
};

async function runProbe(command: string[]): Promise<TemplateProbeResult> {
	const proc = Bun.spawn(command, {
		cwd: unrelatedCwd,
		stdin: "ignore",
		stderr: "pipe",
		stdout: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as TemplateProbeResult;
}

beforeAll(async () => {
	fs.mkdirSync(unrelatedCwd);
	const bundle = await Bun.build({
		entrypoints: [templateProbePath],
		outdir: bundleDir,
		target: "bun",
		plugins: [focusedBundlePlugin],
	});
	expect(bundle.success, bundle.logs.map(log => log.message).join("\n")).toBe(true);
	const entrypoint = bundle.outputs.find(output => output.kind === "entry-point");
	expect(entrypoint).toBeDefined();
	bundlePath = entrypoint!.path;
}, 120_000);

afterAll(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("HTML export template", () => {
	test("keeps Windows drive-letter asset paths as filesystem paths", () => {
		const windowsAssetPath = "C:\\repo\\packages\\coding-agent\\src\\export\\html\\template.css";
		expect(resolveBundledHtmlAssetPath(windowsAssetPath, "C:\\repo\\packages\\coding-agent\\src\\export\\html")).toBe(
			windowsAssetPath,
		);
	});
	test("returns the cached standalone template on repeated calls", () => {
		const first = getTemplate();
		const repeated = getTemplate();

		expect(repeated).toBe(first);
	});

	test("production normal bundle packs every HTML export asset", async () => {
		const productionBundleDir = path.join(tempRoot, "production-bundle");
		const staleAssetPath = path.join(productionBundleDir, "template-stale.css");
		const bundleRunnerPath = path.join(tempRoot, "bundle-dist-runner.ts");
		await Bun.write(staleAssetPath, "stale");
		await Bun.write(
			bundleRunnerPath,
			`import { bundleDist } from ${JSON.stringify(bundleDistUrl)};\nawait bundleDist(${JSON.stringify(productionBundleDir)});\n`,
		);
		const build = Bun.spawn([process.execPath, bundleRunnerPath], {
			cwd: packageDir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [buildStdout, buildStderr, buildExitCode] = await Promise.all([
			new Response(build.stdout).text(),
			new Response(build.stderr).text(),
			build.exited,
		]);
		expect(buildExitCode, `${buildStdout}\n${buildStderr}`).toBe(0);
		expect(await Bun.file(staleAssetPath).exists()).toBe(false);

		// `catalog:` versions resolve from the workspace root manifest, so pack inside a workspace that keeps the
		// repo's catalog but declares only this package (Bun rejects declared workspaces that do not exist).
		const packWorkspace = path.join(tempRoot, "production-workspace");
		const repoRoot = path.resolve(packageDir, "../..");
		const packageRel = path.relative(repoRoot, packageDir).split(path.sep).join("/");
		const rootManifest = await Bun.file(path.join(repoRoot, "package.json")).json();
		rootManifest.workspaces = { packages: [packageRel], catalog: rootManifest.workspaces.catalog };
		await Bun.write(path.join(packWorkspace, "package.json"), JSON.stringify(rootManifest));
		await Bun.write(path.join(packWorkspace, "bun.lock"), Bun.file(path.join(repoRoot, "bun.lock")));
		const packDir = path.join(packWorkspace, packageRel);
		await Bun.write(path.join(packDir, "package.json"), Bun.file(path.join(packageDir, "package.json")));
		for (const entry of await fs.promises.readdir(productionBundleDir)) {
			await Bun.write(path.join(packDir, "dist", entry), Bun.file(path.join(productionBundleDir, entry)));
		}
		const proc = Bun.spawn([process.execPath, "pm", "pack", "--dry-run", "--ignore-scripts"], {
			cwd: packDir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		const packedAssets = Array.from(
			stdout.matchAll(
				/^packed \S+ (dist\/(?:template-[^.]+\.(?:css|html|js)|tool-views\.generated-[^.]+\.js|(?:marked|highlight)\.min-[^.]+\.js))$/gm,
			),
			match => match[1],
		);
		expect(packedAssets).toHaveLength(6);
		expect(packedAssets.filter(filePath => /^dist\/template-[^.]+\.css$/.test(filePath))).toHaveLength(1);
		expect(packedAssets.filter(filePath => /^dist\/template-[^.]+\.html$/.test(filePath))).toHaveLength(1);
		expect(packedAssets.filter(filePath => /^dist\/template-[^.]+\.js$/.test(filePath))).toHaveLength(1);
		expect(packedAssets.filter(filePath => /^dist\/tool-views\.generated-[^.]+\.js$/.test(filePath))).toHaveLength(1);
		expect(
			packedAssets.filter(filePath => /^dist\/(?:marked|highlight)\.min-[^.]+\.js$/.test(filePath)),
		).toHaveLength(2);
	}, 30_000);

	test("serves the cached normal-bundle template after its asset files are removed", async () => {
		const result = await runProbe([process.execPath, bundlePath, "--remove-assets-after-first-use"]);
		expect(result.stableCache).toBe(true);
		expect(result.assetsRemoved).toBe(6);
	});

	test("does not retain source asset strings during a static import", async () => {
		const proc = Bun.spawn([process.execPath, heapProbePath], {
			stdin: "ignore",
			stderr: "pipe",
			stdout: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		const result = JSON.parse(stdout) as HeapProbeResult;
		expect(result, JSON.stringify(result)).toEqual({ retainedAssetStrings: 0, retainedAssets: [] });
	}, 30_000);
});
