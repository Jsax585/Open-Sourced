#!/usr/bin/env bun
// Usage: bun packages/coding-agent/scripts/smoke-deepseek-import.ts /absolute/path/to/built/omp
// Linux network namespaces fail closed: fixture provider is the only reachable network service.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { MODELS_DEV_CATALOG_PROVIDER_IDS, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models";
import { Terminal as VirtualTerminal, TerminalQueryResponder } from "@oh-my-pi/pi-utils/vterm";
import { deepseekEvent, writeDeepSeekDatabase, writeDeepSeekLog } from "../test/helpers/deepseek-fixtures";

const binaryArgument = process.argv[2];
assert(binaryArgument, "Usage: bun packages/coding-agent/scripts/smoke-deepseek-import.ts <built-standalone-omp>");
const binary = path.resolve(binaryArgument);
assert(
	process.platform === "linux",
	"Prerequisite: Linux user/network namespaces (unshare) for fail-closed networking",
);
if (process.argv[3] !== "--network-isolated") {
	const unshare = Bun.which("unshare");
	const python = Bun.which("python3");
	assert(unshare && python, "Prerequisite: unshare and Python 3 stdlib to isolate networking and enable loopback");
	const setup = [
		"import fcntl, os, socket, struct, sys",
		"s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)",
		"flags = struct.unpack('16sh', fcntl.ioctl(s, 0x8913, struct.pack('16sh', b'lo', 0)))[1]",
		"fcntl.ioctl(s, 0x8914, struct.pack('16sh', b'lo', flags | 1))",
		"s.close()",
		"os.execv(sys.argv[1], sys.argv[1:])",
	].join("\n");
	const child = Bun.spawn(
		[
			unshare,
			"--user",
			"--map-root-user",
			"--net",
			python,
			"-c",
			setup,
			process.execPath,
			import.meta.path,
			binary,
			"--network-isolated",
		],
		{ stdin: "inherit", stdout: "inherit", stderr: "inherit" },
	);
	const code = await child.exited;
	if (code !== 0)
		console.error(
			"Smoke failed; unshare permission and loopback ioctl capability are required. No nonisolated fallback.",
		);
	process.exit(code);
}
const networkInterfaces = (await Bun.file("/proc/net/dev").text())
	.split("\n")
	.filter(line => line.includes(":"))
	.map(line => line.slice(0, line.indexOf(":")).trim());
assert.deepEqual(networkInterfaces, ["lo"], "Refusing smoke outside loopback-only network namespace");

const work = await fs.mkdtemp(path.join(os.tmpdir(), "omp-deepseek-smoke-"));
const executable = path.join(work, "standalone", "omp");
const cwd = path.join(work, "project");
const home = path.join(work, "home");
const agentDir = path.join(work, "agent");
const emptyPath = path.join(work, "empty-bin");
const configPath = path.join(agentDir, "config.yml");
const requests: Record<string, unknown>[] = [];
const failures: string[] = [];
const answer = "OMP_DEEPSEEK_CONTROLLED_ANSWER";
const historicalTool = "historical_probe";
const callId = "dsh_smoke_call";
const currentPrompt = "You are omp's trusted coding assistant.";
let expectedPrompt = "";
let responseNumber = 0;

function record(value: unknown): Record<string, unknown> {
	assert(value !== null && typeof value === "object" && !Array.isArray(value), "Expected JSON object");
	return value as Record<string, unknown>;
}

function array(value: unknown): Record<string, unknown>[] {
	assert(Array.isArray(value), "Expected JSON array");
	return value.map(record);
}

function textMessage(id: string, text: string) {
	return { id, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] };
}

function fixtureEvents(label: string): Record<string, unknown>[] {
	const events = [
		deepseekEvent(
			"system/message",
			{
				turn: 1,
				step: 1,
				message: {
					id: "source-system",
					role: "system",
					source: { kind: "system-prompt" },
					content: [{ type: "text", text: `DSH_SOURCE_SYSTEM_${label}` }],
				},
			},
			0,
			"append",
		),
		deepseekEvent("user/message", textMessage("old-user", `DSH_REMOVED_${label}`), 1, "append"),
		deepseekEvent(
			"assistant/message",
			{
				turn: 0,
				step: 0,
				message: {
					id: "tool-assistant",
					role: "assistant",
					source: { kind: "model", provider: "old-dsh-provider", model: "old-dsh-model" },
					content: [
						{ type: "tool-call", id: callId, name: historicalTool, arguments: '{"path":"synthetic.txt"}' },
					],
				},
				stream: [],
			},
			2,
			"append",
		),
		deepseekEvent(
			"tool/result",
			{
				turn: 0,
				step: 0,
				message: {
					id: "tool-result",
					role: "tool",
					source: { kind: "tool", callId },
					toolCallId: callId,
					content: [{ type: "text", text: `DSH_TOOL_RESULT_${label}` }],
				},
			},
			3,
			"append",
		),
		deepseekEvent(
			"assistant/message",
			{
				turn: 0,
				step: 1,
				message: {
					id: "final-assistant",
					role: "assistant",
					source: { kind: "model", provider: "old-dsh-provider", model: "old-dsh-model" },
					content: [{ type: "text", text: `DSH_TRANSCRIPT_${label}` }],
				},
				stream: [],
			},
			4,
			"append",
		),
		deepseekEvent("user/message", textMessage("replacement-user", `DSH_CURRENT_${label}`), 5, {
			op: "replace",
			startSeq: 1,
			endSeq: 1,
		}),
		deepseekEvent(
			"request/header",
			{
				reason: "initial",
				header: {
					config: { provider: "old-dsh-provider", model: "old-dsh-model" },
					tools: [
						{
							name: historicalTool,
							description: "Inert historical tool schema",
							parameters: { type: "object", properties: { path: { type: "string" } } },
						},
					],
				},
			},
			6,
		),
		deepseekEvent(
			"developer/message",
			{
				turn: 1,
				step: 2,
				message: {
					id: "source-developer",
					role: "developer",
					source: { kind: "user" },
					content: [{ type: "tool-removal", toolName: "read" }],
				},
			},
			7,
			"append",
		),
	];
	events[5].sourceEventSeqs = [1];
	return events;
}

function verifyRequest(body: Record<string, unknown>, label: string, reopened: boolean): void {
	assert.equal(body.model, "smoke", "Only controlled loopback model may receive requests");
	const messages = array(body.messages);
	const serialized = JSON.stringify(messages);
	assert.equal(serialized.split(`DSH_CURRENT_${label}`).length - 1, 1, "Replacement context must occur exactly once");
	assert(!serialized.includes(`DSH_REMOVED_${label}`), "Removed historical user text leaked into active context");
	assert(!serialized.includes(`DSH_SOURCE_SYSTEM_${label}`), "Source system prompt became active authority");
	const systems = messages.filter(message => message.role === "system" || message.role === "developer");
	assert(JSON.stringify(systems).includes(currentPrompt), "Current OMP system prompt missing");
	const tools = array(body.tools).map(tool => record(tool.function));
	const names = tools.map(tool => tool.name);
	assert(names.includes("read") && names.includes("write"), "Current OMP read/write tool schemas missing");
	assert(!names.includes(historicalTool), "Historical tool schema became active capability");
	if (label !== "V0") {
		const callMessage = messages.find(
			message =>
				Array.isArray(message.tool_calls) &&
				array(message.tool_calls).some(call => record(call.function).name === historicalTool),
		);
		assert(callMessage, "Imported assistant tool call missing");
		const calls = array(callMessage.tool_calls);
		const call = calls.find(item => record(item.function).name === historicalTool);
		assert(call && typeof call.id === "string", "Imported tool call ID missing");
		assert.deepEqual(JSON.parse(String(record(call.function).arguments)), { path: "synthetic.txt" });
		const result = messages.find(message => message.role === "tool" && message.tool_call_id === call.id);
		assert(
			result && JSON.stringify(result.content).includes(`DSH_TOOL_RESULT_${label}`),
			"Historical tool result lost call pairing",
		);
	}
	assert(serialized.includes(expectedPrompt), "New OMP user turn missing");
	assert.equal(serialized.split(`${label}_FIRST_TURN`).length - 1, 1, "New OMP turn duplicated or missing");
	if (reopened) {
		assert(serialized.includes(`${answer}_1`), "Reopened continuation lost prior OMP assistant response");
		assert.equal(serialized.split(`${label}_REOPEN_TURN`).length - 1, 1, "Reopened user turn duplicated");
	}
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		try {
			assert.equal(request.method, "POST");
			assert.equal(new URL(request.url).pathname, "/v1/chat/completions", "Unexpected network surface");
			const body = record(await request.json());
			assert(expectedPrompt, "Import/picker caused unexpected model request");
			assert(JSON.stringify(body).includes(expectedPrompt), "Background request instead of requested OMP turn");
			requests.push(body);
			const chunk = { id: "smoke", object: "chat.completion.chunk", model: "smoke", created: 1 };
			const content = `${answer}_${++responseNumber}`;
			return new Response(
				`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n` +
					`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
					"data: [DONE]\n\n",
				{ headers: { "content-type": "text/event-stream" } },
			);
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
			return new Response("Smoke rejected unexpected provider request", { status: 400 });
		}
	},
});

async function snapshot(root: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	for await (const relative of new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: false, dot: true })) {
		const filename = path.join(root, relative);
		const info = await fs.lstat(filename);
		result[relative] = info.isDirectory()
			? "directory"
			: `${info.mode}:${info.size}:${info.mtimeMs}:${new Bun.CryptoHasher("sha256").update(new Uint8Array(await Bun.file(filename).arrayBuffer())).digest("hex")}`;
	}
	return result;
}

async function nativeFiles(): Promise<string[]> {
	const files: string[] = [];
	for await (const file of new Bun.Glob("sessions/**/*.jsonl").scan({ cwd: agentDir, absolute: true }))
		files.push(file);
	return files;
}

async function until(
	test: () => boolean | Promise<boolean>,
	description: string,
	details: () => string = () => "",
): Promise<void> {
	const deadline = Date.now() + 45_000;
	while (Date.now() < deadline) {
		assert.equal(failures.length, 0, failures.join("; "));
		if (await test()) return;
		await Bun.sleep(50);
	}
	throw new Error(`Timed out: ${description}\n${details()}`);
}

async function launch(sourceRoot: string, selectors: string[]) {
	const screen = new VirtualTerminal({ cols: 160, rows: 60, scrollback: 2000 });
	const responder = new TerminalQueryResponder();
	const decoder = new TextDecoder();
	const painted = new Set<string>();
	let tail = "";
	function rendered(): string {
		const buffer = screen.buffer.active;
		return Array.from(
			{ length: buffer.length },
			(_, index) => buffer.getLine(index)?.translateToString(true) ?? "",
		).join("\n");
	}
	const terminal = new Bun.Terminal({
		cols: 160,
		rows: 60,
		data(pty, data) {
			const chunk = decoder.decode(data, { stream: true });
			tail = (tail + chunk).slice(-32_000);
			screen.write(data, () => {
				for (const line of rendered().split("\n")) painted.add(line);
			});
			const replies = responder.feed(chunk);
			if (replies) pty.write(replies);
		},
	});
	const child = Bun.spawn(
		[
			executable,
			"--config",
			configPath,
			"--model",
			"fixture/smoke",
			"--no-title",
			"--no-lsp",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--tools",
			"read,write",
			"--auto-approve",
			...selectors,
		],
		{
			cwd,
			terminal,
			env: {
				HOME: home,
				USER: "smoke",
				LOGNAME: "smoke",
				PATH: emptyPath,
				XDG_CONFIG_HOME: path.join(home, ".config"),
				XDG_DATA_HOME: path.join(home, ".local/share"),
				XDG_CACHE_HOME: path.join(home, ".cache"),
				XDG_STATE_HOME: path.join(home, ".local/state"),
				TMPDIR: work,
				PI_CODING_AGENT_DIR: agentDir,
				DSH_HOME: sourceRoot,
				OMP_SKIP_SETUP: "1",
				OMP_TUI_NATIVE: "0",
				PI_TUI_NATIVE: "0",
				TERM: "xterm-256color",
				LANG: "C.UTF-8",
				HTTP_PROXY: "http://127.0.0.1:9",
				HTTPS_PROXY: "http://127.0.0.1:9",
				ALL_PROXY: "http://127.0.0.1:9",
				NO_PROXY: "127.0.0.1,localhost",
				npm_config_update_notifier: "false",
			},
		},
	);
	return {
		send: (text: string) => terminal.write(text),
		seen: (text: string) => [...painted].some(line => line.includes(text)),
		evidence: (markers: string[]) =>
			[...painted].filter(line => markers.some(marker => line.includes(marker))).map(line => line.trim()),
		wait: (text: string) =>
			until(
				() => {
					assert.equal(child.exitCode, null, `Standalone exited ${child.exitCode} before ${text}: ${tail}`);
					return rendered().includes(text);
				},
				`rendered ${text}`,
				() => rendered(),
			),
		async close() {
			if (child.exitCode === null) child.kill();
			await child.exited;
			terminal.close();
			screen.dispose();
		},
	};
}

try {
	await Promise.all(
		[path.dirname(executable), cwd, home, agentDir, emptyPath].map(dir => fs.mkdir(dir, { recursive: true })),
	);
	assert.deepEqual(
		new Uint8Array(await Bun.file(binary).slice(0, 4).arrayBuffer()),
		new Uint8Array([0x7f, 0x45, 0x4c, 0x46]),
		"Supply built standalone ELF executable, not source launcher or shell wrapper",
	);
	await fs.copyFile(binary, executable);
	await fs.chmod(executable, 0o755);
	await Bun.write(
		configPath,
		JSON.stringify({
			setupVersion: 2,
			startup: { setupWizard: false, checkUpdate: false, quiet: true, showSplash: false, changelogMode: "hidden" },
			marketplace: { autoUpdate: "off" },
			tui: { titleState: false },
			mcp: { enableProjectConfig: false },
			telemetry: { otlpExportEnabled: false },
			tools: { xdev: false, format: "native" },
			async: { enabled: false },
			launch: { enabled: false },
			disabledProviders: [
				...new Set([
					...getBundledProviders(),
					...PROVIDER_DESCRIPTORS.map(provider => provider.providerId),
					...MODELS_DEV_CATALOG_PROVIDER_IDS,
					"google-antigravity",
					"google-gemini-cli",
					"openai-codex",
					"ollama",
					"llama.cpp",
					"lm-studio",
					"apple",
					"local",
					"web",
				]),
			],
		}),
	);
	await Bun.write(
		path.join(agentDir, "models.yml"),
		JSON.stringify({
			providers: {
				fixture: {
					baseUrl: `${server.url.origin}/v1`,
					apiKey: "offline-fixture-key",
					api: "openai-completions",
					models: [
						{
							id: "smoke",
							name: "Smoke",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 1024,
						},
					],
				},
			},
		}),
	);
	for (const kind of ["v0", "jsonl", "zstd", "sqlite"] as const) {
		const label = kind.toUpperCase();
		const sourceRoot = path.join(work, `source-${kind}`);
		const id = `synthetic-deepseek-${kind}`;
		const events =
			kind === "v0"
				? [
						deepseekEvent("turn/start", { turn: 1 }, 0),
						deepseekEvent("step/start", { turn: 1, step: 1 }, 1),
						deepseekEvent("user/message", textMessage("v0-user", "DSH_CURRENT_V0"), 2, "append"),
						deepseekEvent("step/end", { turn: 1, step: 1 }, 3),
						deepseekEvent("turn/end", { turn: 1, reason: { kind: "completed" } }, 4),
					]
				: fixtureEvents(label);
		if (kind === "sqlite") await writeDeepSeekDatabase(sourceRoot, [{ id, cwd, events, title: `Smoke ${label}` }]);
		else
			await writeDeepSeekLog(sourceRoot, {
				id,
				cwd,
				events,
				version: kind === "v0" ? 0 : 4,
				compressed: kind === "zstd",
			});
		const before = await snapshot(sourceRoot);
		const existing = new Set(await nativeFiles());
		const requestOffset = requests.length;
		responseNumber = 0;
		expectedPrompt = "";
		const pickerRoute = kind === "zstd" ? "/resume @deepseek" : "--from-deepseek";
		const session = await launch(sourceRoot, pickerRoute === "--from-deepseek" ? ["--from-deepseek"] : []);
		let nativeFile = "";
		let importEvidence: string[] = [];
		let reopenEvidence: string[] = [];
		try {
			if (pickerRoute.startsWith("/")) {
				await session.wait("╰─");
				session.send(`${pickerRoute}\r`);
			}
			await session.wait("Import DeepSeek Harness Session");
			await session.wait(kind === "sqlite" ? `Smoke ${label}` : "(no messages)");
			await session.wait("select");
			assert.equal(requests.length, requestOffset, "Picker/import must not request model");
			session.send("\r");
			await session.wait(kind === "v0" ? "DSH_CURRENT_V0" : `DSH_TRANSCRIPT_${label}`);
			if (kind !== "v0")
				assert(session.seen(`DSH_REMOVED_${label}`), "Rendered transcript lost replaced historical user message");
			assert.equal(requests.length, requestOffset, "Import must not request model or execute historical tools");
			expectedPrompt = `${label}_FIRST_TURN`;
			session.send(`${expectedPrompt}\r`);
			await session.wait(`${answer}_1`);
			await until(async () => {
				const created = (await nativeFiles()).filter(file => !existing.has(file));
				for (const file of created) {
					if ((await Bun.file(file).text()).includes(`DSH_CURRENT_${label}`)) {
						nativeFile = file;
						return true;
					}
				}
				return false;
			}, "native imported session publication");
			assert.equal(requests.length, requestOffset + 1, "Expected exactly one controlled turn");
			verifyRequest(requests[requestOffset], label, false);
			await until(
				async () => (await Bun.file(nativeFile).text()).includes(`${answer}_1`),
				"first OMP response native persistence",
			);
			importEvidence = session.evidence([
				`DSH_REMOVED_${label}`,
				`DSH_TRANSCRIPT_${label}`,
				`DSH_CURRENT_${label}`,
				`${answer}_1`,
			]);
		} finally {
			await session.close();
		}
		const persisted = (await Bun.file(nativeFile).text())
			.trim()
			.split("\n")
			.map(line => record(JSON.parse(line)));
		const header = persisted.find(entry => entry.type === "session");
		assert(header && header.id !== id && header.cwd === cwd, "Native import needs fresh identity and source cwd");
		const provenance = persisted.find(
			entry => entry.type === "custom" && entry.customType === "foreign_session_import",
		);
		assert(
			provenance && record(provenance.data).source === "deepseek" && record(provenance.data).sourceId === id,
			"Native import provenance missing or wrong source identity",
		);
		if (kind !== "v0")
			assert(
				persisted.some(
					entry =>
						entry.type === "compaction" &&
						entry.preserveData !== undefined &&
						record(entry.preserveData).deepseekImportContext,
				),
				"Exact replacement carrier not persisted",
			);
		assert.deepEqual(await snapshot(sourceRoot), before, "Import modified source files, entries, WAL, or SHM");
		await fs.rename(sourceRoot, `${sourceRoot}-removed`);
		expectedPrompt = "";
		const resumed = await launch(sourceRoot, ["--session", nativeFile]);
		try {
			await resumed.wait(`${answer}_1`);
			expectedPrompt = `${label}_REOPEN_TURN`;
			resumed.send(`${expectedPrompt}\r`);
			await resumed.wait(`${answer}_2`);
			assert.equal(requests.length, requestOffset + 2, "Reopen must produce exactly one additional turn");
			verifyRequest(requests[requestOffset + 1], label, true);
			await until(
				async () => (await Bun.file(nativeFile).text()).includes(`${answer}_2`),
				"reopened OMP response native persistence",
			);
			reopenEvidence = resumed.evidence([`${answer}_1`, `${answer}_2`]);
		} finally {
			await resumed.close();
		}
		assert((await Bun.file(nativeFile).text()).includes(`${answer}_2`), "Reopened response not natively persisted");
		assert.deepEqual(await snapshot(`${sourceRoot}-removed`), before, "Native reopen touched removed source");
		console.log(
			JSON.stringify({
				source: kind,
				picker: pickerRoute,
				standaloneOutsideCheckout: true,
				isolatedNetwork: "loopback-only",
				rendered: [
					...(kind === "v0" ? ["DSH_CURRENT_V0"] : [`DSH_REMOVED_${label}`, `DSH_TRANSCRIPT_${label}`]),
					`${answer}_1`,
					`${answer}_2`,
				],
				requests: 2,
				currentContextOccurrences: 1,
				removedContextOccurrences: 0,
				toolPair: kind === "v0" ? null : historicalTool,
				currentTools: ["read", "write"],
				nativeReopenWithoutSource: true,
				sourceUnchanged: true,
				nativeIdentity: header.id,
				terminalEvidence: { imported: importEvidence, reopened: reopenEvidence },
			}),
		);
	}
	assert.equal(failures.length, 0, failures.join("; "));
	console.log(
		"PASS: standalone DeepSeek v0 migration/JSONL/zstd/SQLite picker, controlled continuation, persistence, source-free native reopen",
	);
} finally {
	await server.stop(true);
	await fs.rm(work, { recursive: true, force: true });
}
