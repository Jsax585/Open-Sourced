import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";

const encoder = new TextEncoder();

/**
 * OpenAI-compatible provider that walks a script of `read` paths. A step of
 * "STOP" ends the turn; requests without tools (compaction summaries) get a
 * fixed summary. Records the text of every request it receives.
 */
function startProvider(script: string[]) {
	let step = 0;
	const requests: string[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const payload: unknown = await request.json();
			const body = isRecord(payload) ? payload : {};
			requests.push(JSON.stringify(body.messages));
			const withTools = Array.isArray(body.tools) && body.tools.length > 0;
			const next = withTools ? script[step++] : undefined;
			const delta =
				next && next !== "STOP"
					? {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: `call_${step}`,
									type: "function",
									function: { name: "read", arguments: JSON.stringify({ path: next }) },
								},
							],
						}
					: { role: "assistant", content: withTools ? "done" : "## Summary\nthe user read files" };
			const chunk = {
				id: `chunk-${step}`,
				object: "chat.completion.chunk",
				created: 0,
				model: "nested-model",
				choices: [{ index: 0, delta, finish_reason: next && next !== "STOP" ? "tool_calls" : "stop" }],
			};
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		},
	});
	return { server, requests };
}

describe("AgentSession nested context files", () => {
	let tmp: TempDir | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let server: Server<undefined> | undefined;
	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		await server?.stop(true);
		tmp?.removeSync();
		session = authStorage = server = tmp = undefined;
	});

	async function start(script: string[], settings: Record<string, unknown> = {}) {
		tmp = TempDir.createSync("@omp-nested-session-");
		const root = fs.realpathSync(tmp.path());
		for (const [rel, content] of Object.entries({
			"AGENTS.md": "ROOT_RULES",
			"a/AGENTS.md": "A_RULES",
			"a/b/AGENTS.md": "B_RULES",
			"a/b/file.ts": "export const x = 1;\n",
			"a/b/other.ts": "export const y = 2;\n",
		})) {
			fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
			fs.writeFileSync(path.join(root, rel), content);
		}
		const provider = startProvider(script);
		server = provider.server;
		authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		authStorage.keys.setRuntime("nested", "key");
		const modelsPath = path.join(root, "models.yml");
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  nested:",
				`    baseUrl: http://127.0.0.1:${server.port}/v1`,
				"    api: openai-completions",
				"    apiKey: key",
				"    models:",
				"      - id: nested-model",
				"        name: Nested",
				"        contextWindow: 32768",
				"        maxTokens: 512",
				"        supportsTools: true",
			].join("\n"),
		);
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		const created = await createAgentSession({
			cwd: root,
			agentDir: root,
			sessionManager: SessionManager.inMemory(root),
			authStorage,
			modelRegistry,
			model: modelRegistry.find("nested", "nested-model")!,
			settings: Settings.isolated({ "compaction.enabled": false, "compaction.keepRecentTokens": 1, ...settings }),
			disableExtensionDiscovery: true,
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = created.session;
		return { session: created.session, root, requests: provider.requests };
	}

	function nestedPaths(s: AgentSession, root: string): string[] {
		return s.agent.state.messages.flatMap(message =>
			message.role === "custom" && message.customType === "nested-context" && isRecord(message.details)
				? [path.relative(root, String(message.details.path))]
				: [],
		);
	}

	it("loads each nested AGENTS.md once per read area, and again only after compaction removed it", async () => {
		const {
			session: s,
			root,
			requests,
		} = await start(["a/b/file.ts", "a/b/other.ts", "STOP", "a/b/other.ts", "STOP"]);
		await s.prompt(`read the files ${"filler ".repeat(2000)}`);
		expect(nestedPaths(s, root)).toEqual([path.join("a", "b", "AGENTS.md"), path.join("a", "AGENTS.md")]);
		// The model sees the nested rules in the request that follows the first read, nearest first.
		const afterFirstRead = requests[1]!;
		expect(afterFirstRead.indexOf("B_RULES")).toBeGreaterThan(-1);
		expect(afterFirstRead.indexOf("B_RULES")).toBeLessThan(afterFirstRead.indexOf("A_RULES"));
		expect(requests[1]!.split("B_RULES").length - 1).toBe(1);
		// The second read in the same area adds nothing.
		expect(requests[2]!.split("B_RULES").length - 1).toBe(1);

		await s.compact();
		expect(nestedPaths(s, root)).toEqual([]);

		await s.prompt("read it again");
		expect(nestedPaths(s, root)).toEqual([path.join("a", "b", "AGENTS.md"), path.join("a", "AGENTS.md")]);
	});

	it("loads nothing when contextFiles.nestedDiscovery is off", async () => {
		const {
			session: s,
			root,
			requests,
		} = await start(["a/b/file.ts", "STOP"], {
			"contextFiles.nestedDiscovery": false,
		});
		await s.prompt("read the file");
		expect(nestedPaths(s, root)).toEqual([]);
		expect(requests.join("")).not.toContain("B_RULES");
	});

	it("announces an edited root AGENTS.md before the next request, once", async () => {
		const { session: s, root, requests } = await start(["a/b/file.ts", "STOP", "a/b/other.ts", "STOP"]);
		await s.prompt("first");
		fs.writeFileSync(path.join(root, "AGENTS.md"), "ROOT_RULES_EDITED");
		const future = new Date(Date.now() + 10_000);
		fs.utimesSync(path.join(root, "AGENTS.md"), future, future);
		await s.prompt("second");
		const second = requests.at(-2)!; // the request that carries the second prompt
		expect(second).toContain("ROOT_RULES_EDITED");
		await s.prompt("third");
		expect(requests.at(-1)!.split("ROOT_RULES_EDITED").length - 1).toBe(1);
	});
});
