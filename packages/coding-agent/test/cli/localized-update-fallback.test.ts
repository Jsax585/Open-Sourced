import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { removeWithRetries, VERSION } from "@oh-my-pi/pi-utils";
import { compileFakeExecutable } from "../helpers/fake-executable";

const warning = "현재 한글 버전이 원본 버전과 맞지 않아 공식판으로 실행합니다.";
const original = "Korean executable retained until a verified official replacement is available\n";
const updateModule = pathToFileURL(path.resolve(import.meta.dir, "../../src/cli/update-cli.ts")).href;
const buildModule = pathToFileURL(path.resolve(import.meta.dir, "../../src/cli/build-service.ts")).href;
const bunPath = process.execPath;

interface Scenario {
	portable?: boolean;
	check?: boolean;
	channel?: "canary";
	sourceExit?: number;
	version?: string;
	reportedVersion?: string;
	corruptDownload?: boolean;
}

interface ScenarioResult {
	requests: string[];
	error?: string;
	dir: string;
	target: string;
	metadataPath: string;
	metadata: string;
	started: string;
	sourceCalled: string;
	output: string;
	exitCode: number;
}

// Every updater invocation runs in a child: execPath, fetch, exitCode and environment
// changes cannot leak into other test files or touch the running Bun installation.
describe("localized update official fallback", () => {
	let fixtureDir: string;
	let officialPath: string;
	const dirs: string[] = [];

	beforeAll(async () => {
		fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-official-fixture-"));
		officialPath = await compileFakeExecutable(
			fixtureDir,
			"official",
			`if (process.argv.includes("--version")) {
	console.log("omp/" + (process.env.FIXTURE_REPORTED_VERSION || "999.0.0"));
} else {
	await Bun.write(process.env.FIXTURE_STARTED, JSON.stringify(process.argv.slice(2)));
	process.exitCode = 7;
}`,
		);
	}, 60_000);

	afterEach(async () => {
		await Promise.all(dirs.splice(0).map(dir => removeWithRetries(dir)));
	});

	afterAll(async () => {
		if (fixtureDir) await removeWithRetries(fixtureDir);
	});

	async function run(scenario: Scenario = {}): Promise<ScenarioResult> {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-localized-fallback-")));
		dirs.push(dir);
		const target = path.join(dir, process.platform === "win32" ? "omp.exe" : "omp");
		const metadataPath = path.join(dir, "omp-localized.json");
		const started = path.join(dir, "started.json");
		const sourceCalled = path.join(dir, "source-called.json");
		const resultPath = path.join(dir, "result.json");
		await Bun.write(target, original);
		await fs.chmod(target, 0o755);
		await fs.mkdir(path.join(dir, "scripts"));
		await Bun.write(
			path.join(dir, "scripts", "update-localized.ts"),
			`await Bun.write(${JSON.stringify(sourceCalled)}, JSON.stringify(process.argv.slice(2))); process.exit(${scenario.sourceExit ?? 42});`,
		);
		const metadata = JSON.stringify({ schemaVersion: 1, bunPath, repoRoot: dir, executablePath: target });
		if (!scenario.portable) await Bun.write(metadataPath, metadata);
		const harness = path.join(dir, "harness.ts");
		await Bun.write(
			harness,
			`import { runUpdateCommand } from ${JSON.stringify(updateModule)};
import { currentBuildHost } from ${JSON.stringify(buildModule)};
const { fileName } = await currentBuildHost();
const payload = await Bun.file(${JSON.stringify(officialPath)}).arrayBuffer();
const requests = [];
const fetchStub = async input => {
	const url = String(input);
	requests.push(url);
	if (url.startsWith("https://build.test/api/products/omp/latest/")) {
		return Response.json({
			build: { version: ${JSON.stringify(scenario.version ?? "999.0.0")} },
			file: { name: fileName, size: payload.byteLength, sha256: Bun.SHA256.hash(payload, "hex") },
			download: "https://download.test/official"
		});
	}
	if (url === "https://download.test/official") return new Response(${scenario.corruptDownload ? '"corrupt download"' : "payload"});
	throw new Error("Unexpected network request: " + url);
};
globalThis.fetch = Object.assign(fetchStub, { preconnect: globalThis.fetch.preconnect });
Object.defineProperty(process, "execPath", { value: ${JSON.stringify(target)}, configurable: true });
let error;
try {
	await runUpdateCommand(${JSON.stringify({ force: false, check: scenario.check ?? false, ...(scenario.channel ? { channel: scenario.channel } : {}) })});
} catch (caught) {
	error = String(caught);
	process.exitCode = 1;
} finally {
	await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({ requests, error }));
}
`,
		);
		const child = Bun.spawn([bunPath, harness], {
			cwd: dir,
			env: {
				...process.env,
				OMP_LANGUAGE_PACK_BUILD: "true",
				OMP_LANG: "ko",
				OMP_LOCALE_DIR: path.join(dir, "locales"),
				PI_BUILD_URL: "https://build.test",
				FIXTURE_REPORTED_VERSION: scenario.reportedVersion ?? scenario.version ?? "999.0.0",
				FIXTURE_STARTED: started,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(await Bun.file(resultPath).exists(), `${stdout}\n${stderr}`).toBe(true);
		const result = (await Bun.file(resultPath).json()) as { requests: string[]; error?: string };
		return { ...result, dir, target, metadataPath, metadata, started, sourceCalled, output: stdout + stderr, exitCode };
	}

	async function expectRetained(result: ScenarioResult, metadata = true) {
		expect(await Bun.file(result.target).text()).toBe(original);
		expect(await Bun.file(result.started).exists()).toBe(false);
		if (metadata) expect(await Bun.file(result.metadataPath).text()).toBe(result.metadata);
	}

	it("replaces the exact executable after a confirmed conflict, archives metadata and starts the official app", async () => {
		const result = await run();
		expect(await Bun.file(result.sourceCalled).exists()).toBe(true);
		expect(result.requests).toHaveLength(2);
		expect(result.requests[0]).toContain("channel=stable");
		expect(result.requests[1]).toBe("https://download.test/official");
		expect(await Bun.file(result.target).arrayBuffer()).toEqual(await Bun.file(officialPath).arrayBuffer());
		expect(await Bun.file(result.metadataPath).exists()).toBe(false);
		const archived = (await fs.readdir(result.dir)).filter(name => name.startsWith("omp-localized.json") && name !== "omp-localized.json");
		expect(archived).toHaveLength(1);
		expect(await Bun.file(path.join(result.dir, archived[0]!)).text()).toBe(result.metadata);
		expect(await Bun.file(result.started).json()).toEqual([]);
		expect(result.output).toContain(warning);
		expect(result.exitCode).toBe(7);
	}, 30_000);

	it("retains the installation on an ordinary source updater failure without fetching official builds", async () => {
		const result = await run({ sourceExit: 1 });
		expect(result.exitCode).toBe(1);
		expect(result.requests).toEqual([]);
		expect(result.output).not.toContain(warning);
		await expectRetained(result);
	});

	it("never installs or launches during a source --check, even if the source updater signals a conflict", async () => {
		const result = await run({ check: true });
		expect(await Bun.file(result.sourceCalled).json()).toContain("--check");
		expect(result.exitCode).toBe(42);
		expect(result.requests).toEqual([]);
		await expectRetained(result);
	});

	it("rolls back a downloaded official executable that reports the wrong version and preserves metadata", async () => {
		const result = await run({ reportedVersion: "1.0.0" });
		expect(result.requests).toHaveLength(2);
		expect(result.exitCode).toBe(1);
		expect(result.error).toBeDefined();
		expect(result.output).not.toContain(warning);
		await expectRetained(result);
	}, 30_000);

	it("keeps the original binary and metadata when the official download fails integrity verification", async () => {
		const result = await run({ corruptDownload: true });
		expect(result.exitCode).toBe(1);
		expect(result.error).toBeDefined();
		await expectRetained(result);
	});

	it("checks newer official builds for portable Korean installs without developer metadata, but never installs on --check", async () => {
		const result = await run({ portable: true, check: true });
		expect(result.exitCode).toBe(0);
		expect(result.requests).toHaveLength(1);
		expect(result.requests[0]).toContain("channel=stable");
		expect(await Bun.file(result.sourceCalled).exists()).toBe(false);
		await expectRetained(result, false);
	});

	it("switches a portable Korean install to a newer verified official build and immediately launches it", async () => {
		const result = await run({ portable: true });
		expect(result.exitCode).toBe(7);
		expect(result.requests).toHaveLength(2);
		expect(await Bun.file(result.target).arrayBuffer()).toEqual(await Bun.file(officialPath).arrayBuffer());
		expect(await Bun.file(result.started).json()).toEqual([]);
		expect(await Bun.file(result.sourceCalled).exists()).toBe(false);
		expect(result.output).toContain(warning);
	}, 30_000);

	for (const version of [VERSION, "0.0.1"]) {
		it(`does not replace a portable Korean install with official version ${version}`, async () => {
			const result = await run({ portable: true, version });
			expect(result.exitCode).toBe(0);
			expect(result.requests).toHaveLength(1);
			expect(result.output).not.toContain(warning);
			await expectRetained(result, false);
		});
	}

	it("does not downgrade after a source conflict", async () => {
		const result = await run({ version: "0.0.1" });
		expect(result.requests).toHaveLength(1);
		await expectRetained(result);
	});

	for (const portable of [false, true]) {
		it(`rejects explicit canary for ${portable ? "portable" : "source-managed"} Korean installs before any update`, async () => {
			const result = await run({ portable, channel: "canary" });
			expect(result.exitCode).toBe(1);
			expect(result.requests).toEqual([]);
			expect(await Bun.file(result.sourceCalled).exists()).toBe(false);
			await expectRetained(result, !portable);
		});
	}
});
