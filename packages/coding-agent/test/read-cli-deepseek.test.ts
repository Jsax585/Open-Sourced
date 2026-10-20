import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";

const READ_CLI_URL = new URL("../src/cli/read-cli.ts", import.meta.url).href;

interface ReadFixtureOptions {
	provider?: "deepseek" | "auto" | "native";
	credential?: "saved" | "configured";
	brokerUrl?: string;
	target?: (articleUrl: string, localPath: string) => string;
}

async function runReadFixture(options: ReadFixtureOptions) {
	const temp = TempDir.createSync("@pi-read-cli-deepseek-");
	const agentDir = temp.join("agent");
	const project = temp.join("project");
	const home = temp.join("home");
	const expectedKey = options.credential === "configured" ? "configured-cli-key" : "saved-cli-key";
	let deepseekRequests = 0;
	let authenticatedRequests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: request => {
			const pathname = new URL(request.url).pathname;
			if (pathname === "/article") {
				return new Response(
					`<html><body><article><h1>Local fallback</h1><p>${"This local article contains enough meaningful prose for the reader. ".repeat(8)}</p></article></body></html>`,
					{ headers: { "Content-Type": "text/html" } },
				);
			}
			if (pathname === "/plain") {
				return new Response("Plain text bypasses HTML readers.", { headers: { "Content-Type": "text/plain" } });
			}
			if (pathname === "/data.json") {
				return Response.json({ message: "JSON bypasses HTML readers." });
			}
			if (pathname === "/deepseek") {
				deepseekRequests++;
				if (request.headers.get("authorization") === `Bearer ${expectedKey}`) {
					authenticatedRequests++;
					return Response.json({
						content: `# Credential extraction\n\n${"DeepSeek extracted the requested article using the configured credential. ".repeat(8)}`,
					});
				}
				return new Response("Unauthorized", { status: 401 });
			}
			return new Response("Not found", { status: 404 });
		},
	});
	try {
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(home, { recursive: true });
		await Bun.write(
			temp.join("project", ".omp", "config.yml"),
			`providers:\n  fetch: ${options.provider ?? "deepseek"}\n`,
		);
		const localPath = temp.join("project", "local.txt");
		await Bun.write(localPath, "Local file before the remote URL.\n");
		if (options.credential === "saved") {
			const authStorage = await AuthStorage.create(temp.join("agent", "agent.db"));
			try {
				await authStorage.credentials.set("deepseek", { type: "api_key", key: expectedKey, source: "login" });
			} finally {
				authStorage.close();
			}
		} else if (options.credential === "configured") {
			await Bun.write(
				temp.join("agent", "models.yml"),
				`providers:\n  deepseek:\n    baseUrl: https://api.deepseek.com/v1\n    apiKey: ${expectedKey}\n`,
			);
		}
		const runner = temp.join("read-cli-runner.ts");
		await Bun.write(
			runner,
			`import { runReadCommand } from ${JSON.stringify(READ_CLI_URL)};
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign((input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === "https://api.deepseek.com/v1/tools/fetch") return originalFetch(${JSON.stringify(new URL("/deepseek", server.url).href)}, init);
  if (new URL(url).origin === ${JSON.stringify(server.url.origin)}) return originalFetch(input, init);
  return Promise.resolve(new Response("Unexpected external request", { status: 404 }));
}, originalFetch);
await runReadCommand({ path: process.argv[2] });
`,
		);
		const articleUrl = new URL("/article", server.url).href;
		const child = Bun.spawn([process.execPath, runner, options.target?.(articleUrl, localPath) ?? articleUrl], {
			cwd: project,
			env: {
				// Do not inherit host credentials, broker configuration, profile overrides,
				// or provider settings into these standalone CLI contracts.
				PATH: process.env.PATH,
				TMPDIR: process.env.TMPDIR,
				TEMP: process.env.TEMP,
				TMP: process.env.TMP,
				SystemRoot: process.env.SystemRoot,
				HOME: home,
				PI_CODING_AGENT_DIR: agentDir,
				PI_TEST_RUNTIME: "1",
				DEEPSEEK_API_KEY: "",
				OMP_AUTH_BROKER_URL: options.brokerUrl ?? "",
				OMP_AUTH_BROKER_TOKEN: "",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { stdout, stderr, exitCode, deepseekRequests, authenticatedRequests };
		} finally {
			child.kill();
		}
	} finally {
		await server.stop(true);
		temp.removeSync();
	}
}

it("standalone URL reads use saved DeepSeek credentials without an environment key", async () => {
	const result = await runReadFixture({ credential: "saved" });
	expect(result.exitCode, result.stderr).toBe(0);
	expect(result.stdout).toContain("Credential extraction");
	expect(result.stdout).toContain("Method: deepseek");
	expect(result.authenticatedRequests).toBe(1);
}, 60_000);

it("standalone URL reads use an official DeepSeek key configured only in models.yml", async () => {
	const result = await runReadFixture({ credential: "configured" });
	expect(result.exitCode, result.stderr).toBe(0);
	expect(result.stdout).toContain("Credential extraction");
	expect(result.stdout).toContain("Method: deepseek");
	expect(result.authenticatedRequests).toBe(1);
}, 60_000);

it("local-file-first semicolon lists lazily use saved DeepSeek credentials for nested URLs", async () => {
	const result = await runReadFixture({
		credential: "saved",
		target: (articleUrl, localPath) => `${localPath};${articleUrl}`,
	});
	expect(result.exitCode, result.stderr).toBe(0);
	expect(result.stdout).toContain("Local file before the remote URL.");
	expect(result.stdout).toContain("Credential extraction");
	expect(result.stdout).toContain("Method: deepseek");
	expect(result.authenticatedRequests).toBe(1);
}, 60_000);

it.each([
	{
		name: "auto HTML",
		provider: "auto",
		brokerUrl: "not-a-valid-broker-url",
		target: (articleUrl: string) => articleUrl,
		method: "native",
		content: "Local fallback",
	},
	{
		name: "native HTML",
		provider: "native",
		brokerUrl: "http://127.0.0.1:1",
		target: (articleUrl: string) => articleUrl,
		method: "native",
		content: "Local fallback",
	},
	{
		name: "raw HTML",
		provider: "deepseek",
		brokerUrl: "http://127.0.0.1:1",
		target: (articleUrl: string) => `${articleUrl}:raw`,
		method: "raw",
		content: "<html><body><article>",
	},
	{
		name: "plain text",
		provider: "deepseek",
		brokerUrl: "not-a-valid-broker-url",
		target: (articleUrl: string) => new URL("/plain", articleUrl).href,
		method: "text",
		content: "Plain text bypasses HTML readers.",
	},
	{
		name: "JSON",
		provider: "deepseek",
		brokerUrl: "http://127.0.0.1:1",
		target: (articleUrl: string) => new URL("/data.json", articleUrl).href,
		method: "json",
		content: "JSON bypasses HTML readers.",
	},
] as const)(
	"$name reads do not discover an invalid or missing-token auth broker",
	async ({ provider, brokerUrl, target, method, content }) => {
		const result = await runReadFixture({ provider, brokerUrl, target });
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain(content);
		expect(result.stdout).toContain(`Method: ${method}`);
		expect(result.deepseekRequests).toBe(0);
	},
	60_000,
);
