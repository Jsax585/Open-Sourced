import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionTool } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const probeSchema = type({ label: type("string") });

interface Harness {
	session: AgentSession;
	mock: MockModel;
	/** Working directory each `probe` call observed, in execution order. */
	probed: string[];
	source: string;
	destination: string;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function createHarness(
	responses: MockResponseSource,
	relocator?: (session: AgentSession, directory: string) => Promise<void>,
): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-workspace-move-");
	const root = await fs.realpath(tempDir.path());
	const source = path.join(root, "source");
	const destination = path.join(root, "destination");
	await fs.mkdir(source);
	await fs.mkdir(destination);
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("mock", "test-key");
	const mock = createMockModel({ responses });
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.eager": "default",
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);

	const sessionManager = SessionManager.inMemory(source);
	const probed: string[] = [];
	const probe: AgentTool<typeof probeSchema, unknown> = {
		name: "probe",
		label: "Probe",
		description: "Report the working directory",
		parameters: probeSchema,
		async execute() {
			probed.push(sessionManager.getCwd());
			return { content: [{ type: "text" as const, text: sessionManager.getCwd() }], details: undefined };
		},
	};
	const live: { session?: AgentSession } = {};
	const sessionTool = new SessionTool({
		get cwd() {
			return sessionManager.getCwd();
		},
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		sessionControl: {
			rename: title => sessionManager.setSessionName(title, "user", "session-tool"),
			requestMove: directory => live.session!.requestWorkspaceMove(directory),
			pendingMove: () => live.session!.pendingWorkspaceMove,
		},
	});
	const tools = [sessionTool, probe] as AgentTool[];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	live.session = session;
	if (relocator) session.setWorkspaceRelocator(directory => relocator(session, directory));
	cleanups.push(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});
	return { session, mock, probed, source, destination };
}

function textOf(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

const moveAndProbe = (destination: string) => ({
	content: [
		{ type: "toolCall" as const, id: "call_move", name: "session", arguments: { op: "move", path: destination } },
		{ type: "toolCall" as const, id: "call_same_step", name: "probe", arguments: { label: "same step" } },
	],
	stopReason: "toolUse" as const,
});
const probeStep = {
	content: [{ type: "toolCall" as const, id: "call_next", name: "probe", arguments: { label: "next step" } }],
	stopReason: "toolUse" as const,
};
const done = { content: ["DONE"], stopReason: "stop" as const };

describe("AgentSession workspace move (session tool)", () => {
	it("applies a queued move after the current tool batch, so only the next step runs in the destination", async () => {
		const relocated: string[] = [];
		const harness = await createHarness(
			[(() => moveAndProbe(harness.destination)) as never, probeStep, done],
			async (session, directory) => {
				relocated.push(directory);
				session.sessionManager.setCwdWithoutRelocation(directory);
			},
		);
		await harness.session.prompt("move and probe");

		expect(relocated).toEqual([harness.destination]);
		expect(harness.probed).toEqual([harness.source, harness.destination]);
		expect(harness.session.pendingWorkspaceMove).toBeUndefined();
		// The model is told about the move before the step that runs in the new directory.
		const nextRequest = harness.mock.calls[1]!.context.messages.map(textOf).join("\n");
		expect(nextRequest).toContain(`The session workspace moved to ${harness.destination}`);
	});

	it("tells the model when the move failed and keeps running in the source directory", async () => {
		const harness = await createHarness(
			[(() => moveAndProbe(harness.destination)) as never, probeStep, done],
			async () => {
				throw new Error("destination is busy");
			},
		);
		await harness.session.prompt("move and probe");

		expect(harness.probed).toEqual([harness.source, harness.source]);
		const nextRequest = harness.mock.calls[1]!.context.messages.map(textOf).join("\n");
		expect(nextRequest).toContain("move");
		expect(nextRequest).toContain("failed (destination is busy)");
		expect(nextRequest).toContain(`Tools still run in ${harness.source}`);
	});

	it("rejects the move up front when the host registered no relocator", async () => {
		const harness = await createHarness([(() => moveAndProbe(harness.destination)) as never, done]);
		await harness.session.prompt("move and probe");

		expect(harness.probed).toEqual([harness.source]);
		const nextRequest = harness.mock.calls[1]!.context.messages.map(textOf).join("\n");
		expect(nextRequest).toContain("This host cannot move the session workspace.");
		expect(harness.session.pendingWorkspaceMove).toBeUndefined();
	});

	it("keeps only the last move requested within one step", async () => {
		const harness = await createHarness([], async () => {});
		harness.session.requestWorkspaceMove("/first");
		harness.session.requestWorkspaceMove("/second");
		expect(harness.session.pendingWorkspaceMove).toBe("/second");
	});
});
