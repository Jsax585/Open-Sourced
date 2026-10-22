import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { formatManagedSkillsForScribe } from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
import { buildAutolearnScribePrompt, resolveAutolearnScribeModel } from "@oh-my-pi/pi-coding-agent/autolearn/scribe";
import { readManagedSkills } from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { convertMessagesForWireModel, fitPassSnapshotToContext } from "@oh-my-pi/pi-coding-agent/sdk";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function model(id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

const PRIMARY = model("claude-sonnet-4-5");
const SMALL = model("claude-haiku-4-5");

function registry(...models: Model[]): ModelRegistry {
	return { getAll: () => models, getAvailable: () => models } as unknown as ModelRegistry;
}

describe("resolveAutolearnScribeModel", () => {
	it("resolves the smol role through its chain when nothing names a model", () => {
		// No `autolearn.model` and no `modelRoles.smol`: the role alias must still
		// expand to the inherited `default` role instead of reporting "no model".
		const settings = Settings.isolated({ "modelRoles.default": "anthropic/claude-sonnet-4-5" });
		expect(resolveAutolearnScribeModel(settings, registry(PRIMARY))?.model.id).toBe("claude-sonnet-4-5");
	});

	it("prefers autolearn.model over the smol role", () => {
		const settings = Settings.isolated({
			"autolearn.model": "anthropic/claude-haiku-4-5",
			"modelRoles.smol": "anthropic/claude-sonnet-4-5",
		});
		expect(resolveAutolearnScribeModel(settings, registry(PRIMARY, SMALL))?.model.id).toBe("claude-haiku-4-5");
	});

	it("carries the smol role's thinking suffix into the pass instead of the primary level", () => {
		const settings = Settings.isolated({ "modelRoles.smol": "anthropic/claude-haiku-4-5:low" });
		const selection = resolveAutolearnScribeModel(settings, registry(PRIMARY, SMALL));
		expect(selection?.model.id).toBe("claude-haiku-4-5");
		expect(selection?.thinkingLevel).toBe(ThinkingLevel.Low);
	});

	it("reports no model when nothing resolves, so the stop can fall back", () => {
		const settings = Settings.isolated({});
		expect(resolveAutolearnScribeModel(settings, registry())).toBeUndefined();
	});
});

describe("buildAutolearnScribePrompt", () => {
	let tempHome: string;
	let originalAgentDir: string;

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-scribe-prompt-"));
		spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".omp", "agent"));
	});

	afterEach(async () => {
		spyOn(os, "homedir").mockRestore();
		setAgentDir(originalAgentDir);
		await removeWithRetries(tempHome);
	});

	async function writeSkill(name: string, description: string, body: string): Promise<void> {
		const dir = path.join(getAgentDir(), "managed-skills", name);
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
	}

	it("quotes existing skill bodies so an update cannot erase their procedure", async () => {
		await writeSkill("release-notes", "Cuts a release.", "1. Run `bun run release`.\n2. Tag the commit.");
		const prompt = await buildAutolearnScribePrompt(getAgentDir());
		expect(prompt).toContain("## Auto-Learn scribe");
		expect(prompt).toContain("### release-notes");
		expect(prompt).toContain("1. Run `bun run release`.");
		// Frontmatter is stripped so a body can be written back verbatim.
		expect(prompt).not.toContain("description: Cuts a release.");
	});

	it("skips skills the scribe could not safely update", async () => {
		await writeSkill("real", "Writable.", "body");
		// A symlinked skill and a hard-linked SKILL.md are refused by
		// `writeManagedSkill`, so quoting them would only invite a failed update.
		await fs.mkdir(path.join(getAgentDir(), "managed-skills", "linked"), { recursive: true });
		await fs.symlink(
			path.join(getAgentDir(), "managed-skills", "real", "SKILL.md"),
			path.join(getAgentDir(), "managed-skills", "linked", "SKILL.md"),
		);
		const outside = path.join(tempHome, "outside-skill.md");
		await Bun.write(outside, "---\nname: hard\ndescription: Linked.\n---\n\nbody\n");
		await fs.mkdir(path.join(getAgentDir(), "managed-skills", "hard"), { recursive: true });
		await fs.link(outside, path.join(getAgentDir(), "managed-skills", "hard", "SKILL.md"));
		// No description: `writeManagedSkill` would reject the update outright.
		await fs.mkdir(path.join(getAgentDir(), "managed-skills", "nodesc"), { recursive: true });
		await Bun.write(
			path.join(getAgentDir(), "managed-skills", "nodesc", "SKILL.md"),
			"---\nname: nodesc\n---\n\nbody\n",
		);

		const skills = await readManagedSkills(getAgentDir());
		expect(skills.map(skill => skill.name)).toEqual(["real"]);
	});

	it("lists skills past the byte budget by name and description only", () => {
		const inventory = formatManagedSkillsForScribe(
			[
				{ name: "small", description: "Fits.", body: "tiny body" },
				{ name: "huge", description: "Does not fit.", body: "x".repeat(256) },
			],
			128,
		);
		expect(inventory).toContain("### small");
		expect(inventory).not.toContain("### huge");
		expect(inventory).toContain("huge: Does not fit.");
	});
});

describe("fitPassSnapshotToContext", () => {
	const user = (text: string, timestamp: number): AgentMessage => ({ role: "user", content: text, timestamp });

	function assistant(text: string, timestamp: number): AgentMessage {
		return {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku-4-5",
			content: [{ type: "text", text }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp,
		};
	}

	it("keeps the newest turns that fit a smaller scribe window and notes the cut", () => {
		const small = { ...model("claude-haiku-4-5"), contextWindow: 12_000, maxTokens: 8_192 };
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 40; i++) {
			messages.push(user(`turn ${i}: ${"context ".repeat(200)}`, i * 2));
			messages.push(assistant(`reply ${i}`, i * 2 + 1));
		}
		const snapshot = fitPassSnapshotToContext(messages, small);
		expect(snapshot.messages.length).toBeLessThan(messages.length);
		// The cut lands on a user turn, so the kept history never opens with a
		// tool result whose call was dropped.
		expect(snapshot.messages[0]?.role).toBe("user");
		expect(snapshot.omittedNote).toContain("dropped from the snapshot");
		// The newest turn survives.
		expect(JSON.stringify(snapshot.messages.at(-1))).toContain("reply 39");
	});

	it("passes a transcript that already fits through untouched", () => {
		const messages = [user("hello", 1), assistant("hi", 2)];
		const snapshot = fitPassSnapshotToContext(messages, model("claude-haiku-4-5"));
		expect(snapshot.messages).toEqual(messages);
		expect(snapshot.omittedNote).toBeUndefined();
	});
});

describe("convertMessagesForWireModel", () => {
	const PNG = "iVBORw0KGgoAAAANSUhEUg==";

	function imageMessage(): AgentMessage {
		return {
			role: "user",
			content: [
				{ type: "text", text: "what is this?" },
				{ type: "image", data: PNG, mimeType: "image/png" },
			],
			timestamp: 1,
		};
	}

	it("drops images for a text-only wire model", () => {
		const converted = convertMessagesForWireModel([imageMessage()], model("claude-haiku-4-5"), false);
		expect(JSON.stringify(converted)).not.toContain(PNG);
		expect(JSON.stringify(converted)).toContain("does not support image input");
	});

	it("keeps images for a wire model that sends them", () => {
		const vision = buildModel({
			id: "claude-sonnet-4-5-vision",
			name: "vision",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		});
		expect(JSON.stringify(convertMessagesForWireModel([imageMessage()], vision, false))).toContain(PNG);
	});

	it("drops images when the user blocked them, whatever the model", () => {
		const converted = convertMessagesForWireModel([imageMessage()], model("claude-haiku-4-5"), true);
		expect(JSON.stringify(converted)).toContain("Image reading is disabled.");
	});
});
