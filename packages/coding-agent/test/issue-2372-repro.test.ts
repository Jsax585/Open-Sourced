import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { DroppedPrompt } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Regression for issue #2372 — pressing Ctrl+T (or any other rebuild path)
 * during the pre-streaming window after a user submission must not erase the
 * optimistically-rendered user message. `startPendingSubmission` paints the
 * user's message before `session.prompt(...)` has appended it to session
 * entries; a `rebuildChatFromMessages()` in that window used to wipe it
 * because `buildTranscriptSessionContext()` has no record of it yet.
 */
describe("issue #2372 pre-streaming chat rebuild preserves optimistic submission", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let droppedPromptHandler: ((prompt: DroppedPrompt) => void) | undefined;
	let term: VirtualTerminal;

	beforeAll(async () => {
		initTheme();
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-2372-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		vi.spyOn(session, "setPromptDropped").mockImplementation(handler => {
			droppedPromptHandler = handler;
		});
		term = new VirtualTerminal(120, 10);
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: term }),
		);
		await mode.init({ suppressWelcomeIntro: true });
	});

	beforeEach(() => {
		mode.clearOptimisticUserMessage();
		mode.chatContainer.clear();
		mode.locallySubmittedUserSignatures.clear();
		mode.optimisticUserMessageSignature = undefined;
		mode.isInitialized = false;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		mode.stop();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("keeps the optimistic user message in chat after rebuildChatFromMessages before streaming starts", () => {
		const addMessageSpy = vi.spyOn(mode, "addMessageToChat");

		mode.startPendingSubmission({ text: "hello world" });
		expect(mode.optimisticUserMessageSignature).toBe("hello world\u00000");
		expect(addMessageSpy).toHaveBeenCalledTimes(1);
		expect(mode.chatContainer.children.length).toBeGreaterThan(0);

		// Pre-streaming rebuild: no streamingComponent yet, message is NOT in
		// session entries yet, signature is still set.
		expect(mode.streamingComponent).toBeUndefined();
		mode.rebuildChatFromMessages();
		// Signature stays set until EventController processes user message_start.
		expect(mode.optimisticUserMessageSignature).toBe("hello world\u00000");
		// The replay must have re-rendered the user message: total addMessageToChat
		// calls == initial optimistic add + 1 replay during rebuild.
		expect(addMessageSpy).toHaveBeenCalledTimes(2);
		const replayCall = addMessageSpy.mock.calls[1]?.[0];
		expect(replayCall).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "hello world" }],
			attribution: "user",
		});
		// Chat container is non-empty (the optimistic user message is back).
		expect(mode.chatContainer.children.length).toBeGreaterThan(0);
	});

	it("does not duplicate the user message once message_start has cleared the optimistic signature", () => {
		const addMessageSpy = vi.spyOn(mode, "addMessageToChat");

		mode.startPendingSubmission({ text: "hello again" });
		expect(addMessageSpy).toHaveBeenCalledTimes(1);

		// Simulate EventController#handleMessageStart having confirmed the user
		// message: signature is cleared, real session entry exists in the
		// transcript path. `#pendingSubmittedInput` may still be alive (we are
		// streaming) but the replay must NOT trigger.
		mode.optimisticUserMessageSignature = undefined;

		mode.rebuildChatFromMessages();

		// Only the initial optimistic add — no replay duplication.
		expect(addMessageSpy).toHaveBeenCalledTimes(1);
	});

	it("replaces raw slash optimistic text when message_start carries expanded content", async () => {
		mode.isInitialized = true;
		const controller = new EventController(mode);
		const addMessageSpy = vi.spyOn(mode, "addMessageToChat");

		mode.startPendingSubmission({ text: "/jira-task" });
		mode.rebuildChatFromMessages();
		await controller.handleEvent({
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "text", text: "Expanded Jira task prompt" }],
				attribution: "user",
				timestamp: Date.now(),
			},
		});

		const renderedTexts = addMessageSpy.mock.calls.map(([message]) => {
			if (message.role !== "user") throw new Error(`Expected user message, got ${message.role}`);
			return typeof message.content === "string"
				? message.content
				: message.content
						.filter(content => content.type === "text")
						.map(content => content.text)
						.join("\n");
		});
		expect(renderedTexts).toEqual(["/jira-task", "/jira-task", "Expanded Jira task prompt"]);
		expect(mode.chatContainer.children).toHaveLength(1);
		expect(mode.optimisticUserMessageSignature).toBeUndefined();
		expect(mode.locallySubmittedUserSignatures.has("/jira-task\u00000")).toBe(false);
	});

	it("does not replace a pending optimistic prompt with another local user event", async () => {
		mode.isInitialized = true;
		const controller = new EventController(mode);
		const addMessageSpy = vi.spyOn(mode, "addMessageToChat");

		mode.startPendingSubmission({ text: "/jira-task" });
		mode.locallySubmittedUserSignatures.add("queued before prompt\u00000");

		await controller.handleEvent({
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "text", text: "queued before prompt" }],
				attribution: "user",
				timestamp: Date.now(),
			},
		});

		expect(mode.optimisticUserMessageSignature).toBe("/jira-task\u00000");
		expect(mode.chatContainer.children).toHaveLength(2);
		expect(mode.locallySubmittedUserSignatures.has("queued before prompt\u00000")).toBe(false);

		await controller.handleEvent({
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "text", text: "Expanded Jira task prompt" }],
				attribution: "user",
				timestamp: Date.now(),
			},
		});

		const renderedTexts = addMessageSpy.mock.calls.map(([message]) => {
			if (message.role !== "user") throw new Error(`Expected user message, got ${message.role}`);
			return typeof message.content === "string"
				? message.content
				: message.content
						.filter(content => content.type === "text")
						.map(content => content.text)
						.join("\n");
		});
		expect(renderedTexts).toEqual(["/jira-task", "queued before prompt", "Expanded Jira task prompt"]);
		expect(mode.chatContainer.children).toHaveLength(2);
		expect(mode.optimisticUserMessageSignature).toBeUndefined();
	});

	it("does not replay after the submission is cancelled", () => {
		const addMessageSpy = vi.spyOn(mode, "addMessageToChat");

		mode.startPendingSubmission({ text: "cancel me" });
		expect(mode.optimisticUserMessageSignature).toBe("cancel me\u00000");
		mode.cancelPendingSubmission();

		// `cancelPendingSubmission` already rebuilds; after that, an explicit
		// rebuild must not resurrect the cancelled message.
		const callsAfterCancel = addMessageSpy.mock.calls.length;
		mode.rebuildChatFromMessages();
		expect(addMessageSpy).toHaveBeenCalledTimes(callsAfterCancel);
		expect(mode.optimisticUserMessageSignature).toBeUndefined();
	});

	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	function plainRows(rows: readonly string[]): string[] {
		return rows.map(row => Bun.stripANSI(row).trimEnd());
	}

	function committedRows(): string[] {
		const { baseY } = term.getBufferPosition();
		return plainRows(term.getScrollBuffer()).slice(0, baseY);
	}

	async function retireTranscriptMarker(marker: string): Promise<void> {
		const assistantText = (text: string): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "stop",
			timestamp: 1,
		});
		session.sessionManager.appendMessage({ role: "user", content: marker, timestamp: 1 });
		for (let i = 0; i < 12; i++) {
			session.sessionManager.appendMessage(assistantText(`Filler reply ${i} occupying a transcript row.`));
		}
		mode.rebuildChatFromMessages();
		for (let i = 0; i < 20 && !committedRows().some(row => row.includes(marker)); i++) {
			mode.ui.requestRender(true);
			await term.waitForRender();
		}
		expect(committedRows().some(row => row.includes(marker))).toBe(true);
	}

	async function drainRetirement(marker: string): Promise<string[]> {
		await term.waitForRender();
		let prevBaseY = -1;
		for (
			let i = 0;
			i < 20 &&
			(i === 0 ||
				term.getBufferPosition().baseY !== prevBaseY ||
				!committedRows().some(row => row.includes(marker)));
			i++
		) {
			prevBaseY = term.getBufferPosition().baseY;
			mode.ui.requestRender(true);
			await term.waitForRender();
		}
		return plainRows(term.getScrollBuffer());
	}

	it("clears scrollback when a dropped prompt rebuilds the transcript", async () => {
		const marker = "RETIRED_DROPPED_PROMPT_ROW";
		await retireTranscriptMarker(marker);
		mode.editor.setText("");
		mode.startPendingSubmission({ text: "dropped prompt" });

		if (!droppedPromptHandler) throw new Error("Expected setPromptDropped handler");
		droppedPromptHandler({ text: "dropped prompt" });
		const rows = await drainRetirement(marker);

		expect(rows.filter(row => row.includes(marker))).toHaveLength(1);
		expect(mode.editor.getText()).toBe("dropped prompt");
	});

	it("recovers a cancelled submission without losing text and images added after Enter", async () => {
		const marker = "RETIRED_CANCELLED_SUBMISSION_ROW";
		await retireTranscriptMarker(marker);
		const submittedImage = { type: "image" as const, data: "YQ==", mimeType: "image/png" };
		const laterImage = { type: "image" as const, data: "Yg==", mimeType: "image/png" };
		mode.editor.setText("");
		mode.startPendingSubmission(
			{ text: "first [Image #1]", images: [submittedImage], imageLinks: ["file:///first.png"] },
			{ clearEditor: false },
		);
		mode.editor.pendingImages = [laterImage];
		mode.editor.pendingImageLinks = ["file:///later.png"];
		mode.editor.setCollapsedText("later [Image #1]");

		expect(mode.cancelPendingSubmission()).toBe(true);
		const rows = await drainRetirement(marker);

		expect(rows.filter(row => row.includes(marker))).toHaveLength(1);
		expect(mode.editor.getExpandedText()).toBe("first [Image #1]\nlater [Image #2]");
		expect(mode.editor.pendingImages).toEqual([submittedImage, laterImage]);
		expect(mode.editor.pendingImageLinks).toEqual(["file:///first.png", "file:///later.png"]);
	});
});
