import { afterEach, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as utils from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { convertToLlm } from "../src/session/messages";
import * as powerBackend from "../src/session/power-assertion-backend";
import { SessionManager } from "../src/session/session-manager";
import { cfgPowerInhibitIdle, cfgPowerInhibitSuspend, cfgPowerKeepDisplayAwake } from "../src/session/settings";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

afterEach(() => vi.restoreAllMocks());

it("applies each power toggle during an active prompt, releases it when disabled, and never holds between prompts", async () => {
	const tempDir = utils.TempDir.createSync("@pi-power-");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({ "compaction.enabled": false });
	cfgPowerInhibitIdle.set(settings, false);
	const held = new Set<symbol>();
	vi.spyOn(powerBackend, "startPowerAssertion").mockImplementation(() => {
		const token = Symbol();
		held.add(token);
		return {
			stop: () => {
				held.delete(token);
			},
		};
	});
	vi.spyOn(utils, "isBunTestRuntime").mockReturnValue(false);

	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const holdSchema = type({});
	const hold: AgentTool<typeof holdSchema, undefined> = {
		name: "hold",
		label: "Hold",
		description: "Hold the prompt open",
		parameters: holdSchema,
		async execute() {
			entered.resolve();
			await release.promise;
			return { content: [{ type: "text", text: "released" }], details: undefined };
		},
	};
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled test model");
	const mock = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", name: "hold", arguments: {} }], stopReason: "toolUse" },
			{ content: ["done"] },
		],
	});
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [hold as AgentTool], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry,
		toolRegistry: new Map([[hold.name, hold as AgentTool]]),
	});
	let running: Promise<boolean> | undefined;
	try {
		running = session.prompt("go");
		await entered.promise;
		expect(held.size).toBe(0);
		for (const toggle of [cfgPowerInhibitIdle, cfgPowerInhibitSuspend, cfgPowerKeepDisplayAwake]) {
			toggle.set(settings, true);
			await Promise.resolve();
			expect(held.size).toBe(1);
			toggle.set(settings, false);
			await Promise.resolve();
			expect(held.size).toBe(0);
		}
		cfgPowerInhibitSuspend.set(settings, true);
		await Promise.resolve();
		expect(held.size).toBe(1);
		release.resolve();
		await running;
		expect(held.size).toBe(0);
		cfgPowerKeepDisplayAwake.set(settings, true);
		await Promise.resolve();
		expect(held.size).toBe(0);
	} finally {
		release.resolve();
		// Drain a prompt left running by a failed assertion without replacing that assertion's error.
		await running?.catch(() => undefined);
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	}
});
