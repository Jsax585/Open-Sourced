import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadedCustomCommand } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("AgentSession structured custom-command submission", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let directory: string | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		if (directory) await rm(directory, { recursive: true, force: true });
		directory = undefined;
	});

	async function createSession(withKey: boolean, onSubmitted: () => Promise<void>) {
		directory = await mkdtemp(join(tmpdir(), "custom-command-submission-"));
		const draftPath = join(directory, "draft.json");
		await writeFile(draftPath, "recoverable draft", "utf8");
		authStorage = await AuthStorage.create(":memory:");
		if (withKey) authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.inMemory();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const agent = new Agent({
			getApiKey: () => (withKey ? "test-key" : undefined),
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: createMockModel({ responses: [] }).stream,
		});
		const command: LoadedCustomCommand = {
			path: "test",
			resolvedPath: "test",
			source: "user",
			command: {
				name: "annotate",
				description: "test annotation handoff",
				execute: () => ({ text: "review feedback", onSubmitted }),
			},
		};
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			customCommands: [command],
		});
		return { draftPath, session };
	}

	it("removes the draft only after direct prompt dispatch succeeds", async () => {
		let acknowledged = 0;
		let draftPath = "";
		const created = await createSession(true, async () => {
			acknowledged++;
			await rm(draftPath, { force: true });
		});
		draftPath = created.draftPath;

		await created.session.prompt("/annotate");

		expect(acknowledged).toBe(1);
		await expect(readFile(draftPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("removes the draft after a real streaming queue accepts the structured command prompt", async () => {
		let acknowledged = 0;
		let draftPath = "";
		const created = await createSession(true, async () => {
			acknowledged++;
			await rm(draftPath, { force: true });
		});
		draftPath = created.draftPath;
		created.session.agent.state.isStreaming = true;

		await created.session.prompt("/annotate", { streamingBehavior: "followUp" });

		expect(acknowledged).toBe(1);
		await expect(readFile(draftPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("retains the draft when real credential validation rejects dispatch", async () => {
		let acknowledged = 0;
		let draftPath = "";
		const created = await createSession(false, async () => {
			acknowledged++;
			await rm(draftPath, { force: true });
		});
		draftPath = created.draftPath;

		await expect(created.session.prompt("/annotate")).rejects.toThrow(/No API key/);

		expect(acknowledged).toBe(0);
		expect(await readFile(draftPath, "utf8")).toBe("recoverable draft");
	});
});
