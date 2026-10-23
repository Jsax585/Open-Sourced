import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Regression probe: `options.spawns: ""` is a DELIBERATE deny-all (persisted
 * revive) and must survive the pre-construction `getSessionSpawns` fallback in
 * sdk.ts. A truthy fallback (`options.spawns ? options.spawns : "*"`) flipped
 * it to `"*"` in the window before `session` is assigned, so the initial
 * system-prompt build advertised agent() spawning that execution rejects.
 */

describe("createAgentSession empty-string spawns deny-all", () => {
	it("keeps the empty-string spawn deny-all through the pre-construction fallback", async () => {
		const tempDir = `pi-spawns-denyall-${Snowflake.next()}`;
		fs.mkdirSync(tempDir, { recursive: true });
		const auth = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry: new ModelRegistry(auth),
			sessionManager: SessionManager.inMemory(),
			// Full-dialect rendering puts tool descriptors IN the system prompt, so
			// the pre-construction fallback's window value is observable there.
			settings: Settings.isolated({ "tools.format": "glm", inlineToolDescriptors: "on" }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			spawns: "",
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		try {
			// The host getter must surface "" as the deny-all ([] after AgentSession
			// normalization), never "*".
			expect(session.getSessionSpawns()).toEqual([]);
			// The INITIAL system prompt was built in the pre-construction window:
			// with a truthy fallback the window value flipped "" to "*" and the
			// prompt advertised agent() spawning that execution rejects.
			const prompt = session.agent.state.systemPrompt.join("\n");
			expect(prompt).not.toContain("agent(prompt");
			expect(prompt).toContain("Agent spawning is currently disabled");
		} finally {
			await session.dispose();
			auth.close();
			removeSyncWithRetries(tempDir);
		}
	});
});

describe("AgentSession persona spawn intersect", () => {
	it("a persona spawns:* never widens past a host deny-all", async () => {
		const tempDir = `pi-spawns-intersect-${Snowflake.next()}`;
		fs.mkdirSync(tempDir, { recursive: true });
		const auth = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry: new ModelRegistry(auth),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			spawns: "",
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		try {
			expect(session.getSessionSpawns()).toEqual([]);
			// A persona declaring `spawns: "*"` narrows the host ceiling —
			// the deny-all survives.
			session.setSessionSpawns("*");
			expect(session.getSessionSpawns()).toEqual([]);
			session.setSessionSpawns(["scout"]);
			expect(session.getSessionSpawns()).toEqual([]);
			// Clearing the override returns to the host value.
			session.setSessionSpawns(null);
			expect(session.getSessionSpawns()).toEqual([]);
		} finally {
			await session.dispose();
			auth.close();
			removeSyncWithRetries(tempDir);
		}
	});

	it("a persona spawn list narrows (not replaces) a host allowlist", async () => {
		const tempDir = `pi-spawns-narrow-${Snowflake.next()}`;
		fs.mkdirSync(tempDir, { recursive: true });
		const auth = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry: new ModelRegistry(auth),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			spawns: "scout,worker",
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		try {
			expect(session.getSessionSpawns()).toEqual(["scout", "worker"]);
			session.setSessionSpawns(["scout", "other"]);
			expect(session.getSessionSpawns()).toEqual(["scout"]);
			session.setSessionSpawns("*");
			expect(session.getSessionSpawns()).toEqual(["scout", "worker"]);
		} finally {
			await session.dispose();
			auth.close();
			removeSyncWithRetries(tempDir);
		}
	});
});
