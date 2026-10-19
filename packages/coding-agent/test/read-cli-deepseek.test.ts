import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";

const READ_CLI_URL = new URL("../src/cli/read-cli.ts", import.meta.url).href;

it("standalone URL reads use saved DeepSeek credentials without an environment key", async () => {
	const temp = TempDir.createSync("@pi-read-cli-deepseek-");
	const agentDir = temp.join("agent");
	const project = temp.join("project");
	const home = temp.join("home");
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
			if (pathname === "/deepseek" && request.headers.get("authorization") === "Bearer saved-cli-key") {
				authenticatedRequests++;
				return Response.json({
					content: `# Saved credential extraction\n\n${"DeepSeek extracted the requested article using the saved login credential. ".repeat(8)}`,
				});
			}
			return new Response("Not found", { status: 404 });
		},
	});
	try {
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(home, { recursive: true });
		await Bun.write(temp.join("project", ".omp", "config.yml"), "providers:\n  fetch: deepseek\n");
		const authStorage = await AuthStorage.create(temp.join("agent", "agent.db"));
		try {
			await authStorage.credentials.set("deepseek", { type: "api_key", key: "saved-cli-key", source: "login" });
		} finally {
			authStorage.close();
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
		const child = Bun.spawn(["bun", runner, new URL("/article", server.url).href], {
			cwd: project,
			env: {
				...process.env,
				HOME: home,
				PI_CODING_AGENT_DIR: agentDir,
				PI_TEST_RUNTIME: "1",
				DEEPSEEK_API_KEY: "",
				OMP_AUTH_BROKER_URL: "",
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
			expect(exitCode, stderr).toBe(0);
			expect(stdout).toContain("Saved credential extraction");
			expect(authenticatedRequests).toBe(1);
		} finally {
			child.kill();
		}
	} finally {
		await server.stop(true);
		temp.removeSync();
	}
}, 60_000);
