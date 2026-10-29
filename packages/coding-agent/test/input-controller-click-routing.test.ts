import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Text } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { setTranscriptActionHandler, setTranscriptMouseEnabled } from "@oh-my-pi/pi-tui/chat/transcript-actions";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer, PINNED_HUD_TOGGLE_ID } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { cfgTuiMouse } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const TABLE = "| 项目 | 状态 |\n| --- | --- |\n| 需求确认 | 已完成 |";
const scenes: Composer[] = [];

class AgentCard extends Text {
	getClickFocusAgentIds(): string[] {
		return [PINNED_HUD_TOGGLE_ID];
	}
}

function message(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function makeHarness() {
	const terminal = new VirtualTerminal(80, 30);
	const composer = new Composer({ terminal, preferences: { quiet: true } });
	scenes.push(composer);
	const copied: string[] = [];
	const focused: string[] = [];
	let toggled = 0;
	setTranscriptActionHandler(action => {
		if (action.act === "copy") copied.push(action.text);
	});
	setTranscriptMouseEnabled(true);
	composer.ui.setInlineMouseTrackingProvider(() => cfgTuiMouse.get(settings) || composer.hasInlineClickTargets());
	const transcript = new TranscriptContainer();
	transcript.addChild(new AgentCard("agent card", 0, 0));
	const assistant = new AssistantMessageComponent();
	assistant.updateContent(message(TABLE));
	transcript.addChild(assistant);
	composer.setRuntimeChildren([transcript, composer.editor]);
	const ctx = {
		ui: composer.ui,
		editor: composer.editor,
		settings,
		keybindings: KeybindingsManager.inMemory(),
		handlesBtwBranchKey: () => false,
		dictationSpaceHold: () => undefined,
		session: {
			extensionRunner: undefined,
		},
		resolveViewportClickCandidates: (row: number) => composer.viewportClickCandidates(row),
		activateViewportLink: () => false,
		handleTranscriptMouse: composer.handleTranscriptMouse.bind(composer),
		focusedAgentId: undefined,
		focusAgentSession: async (id: string) => {
			focused.push(id);
		},
		togglePinnedHudExpanded: () => {
			toggled++;
		},
		showStatus: () => {},
		setClickHoverId: (id: string | undefined) => composer.setHoveredClickId(id),
	} as unknown as InteractiveModeContext;
	new InputController(ctx).setupKeyHandlers();
	composer.start();
	composer.ui.renderNow();
	const point = (text: string) => {
		const rows = terminal.getViewport();
		const row = rows.findIndex(line => line.includes(text));
		if (row < 0) throw new Error(`Missing rendered target: ${text}`);
		const line = rows[row]!;
		return { column: Bun.stringWidth(line.slice(0, line.indexOf(text))), row };
	};
	const send = (position: { column: number; row: number }, button = 0, release = false) => {
		composer.ui.injectDebugInput(`\x1b[<${button};${position.column + 1};${position.row + 1}${release ? "m" : "M"}`);
	};
	const click = (text: string) => {
		const p = point(text);
		send(p);
		send(p, 0, true);
	};
	return { composer, terminal, assistant, copied, focused, toggled: () => toggled, point, send, click };
}

beforeAll(async () => {
	await initTheme(false);
});
beforeEach(async () => {
	AgentRegistry.resetGlobalForTests();
	await Settings.init({ inMemory: true });
});
afterEach(() => {
	for (const scene of scenes.splice(0)) scene.stop();
	setTranscriptActionHandler(undefined);
	setTranscriptMouseEnabled(false);
	AgentRegistry.resetGlobalForTests();
	resetSettingsForTest();
});

describe("InputController transcript mouse gestures", () => {
	it("copies the requested table on release with focus-on-click disabled", () => {
		cfgTuiMouse.set(settings, false);
		const h = makeHarness();
		const p = h.point("Copy Markdown");
		h.send(p);
		expect(h.copied).toEqual([]);
		h.send(p, 0, true);
		expect(h.copied).toEqual([TABLE]);
		expect(h.focused).toEqual([]);
		expect(h.toggled()).toBe(0);
	});

	it("copies an ordinary CJK drag rather than activating the table", () => {
		const h = makeHarness();
		const start = h.point("需求确认");
		const end = { ...start, column: start.column + Bun.stringWidth("需求确认") };
		h.send(start);
		h.send(end, 32);
		h.composer.ui.renderNow();
		h.send(end, 0, true);
		expect(h.copied).toEqual(["需求确认"]);
		expect(h.focused).toEqual([]);
	});

	it("treats small movement inside a button as the same click through real input routing", () => {
		const h = makeHarness();
		const start = h.point("Copy Markdown");
		const end = { ...start, column: start.column + 1 };
		h.send(start);
		h.composer.ui.renderNow();
		h.send(end, 32);
		h.composer.ui.renderNow();
		h.send(end, 0, true);
		expect(h.copied).toEqual([TABLE]);
		expect(h.focused).toEqual([]);
	});

	it("copies a fast CJK selection without requiring an intermediate motion report", () => {
		const h = makeHarness();
		const start = h.point("需求确认");
		h.send(start);
		h.send({ ...start, column: start.column + Bun.stringWidth("需求确认") }, 0, true);
		expect(h.copied).toEqual(["需求确认"]);
	});

	it("does not copy or focus when a button is released over a different format", () => {
		const h = makeHarness();
		h.send(h.point("Copy Markdown"));
		h.send(h.point("Copy CSV"), 0, true);
		expect(h.copied).toEqual([]);
		expect(h.focused).toEqual([]);
	});

	it("restores agent hover after passing over a table button", () => {
		cfgTuiMouse.set(settings, true);
		const h = makeHarness();
		const banded = () =>
			h.composer
				.renderFrame({ columns: 80, rows: 30 })
				.viewport.find(line => line.includes("agent card"))!
				.includes("\x1b[48");
		h.send(h.point("agent card"), 35);
		expect(banded()).toBe(true);
		h.send(h.point("Copy Markdown"), 35);
		expect(banded()).toBe(false);
		h.send(h.point("agent card"), 35);
		expect(banded()).toBe(true);
	});

	it("preserves live-agent precedence over the pinned-toggle sentinel on a completed click", () => {
		cfgTuiMouse.set(settings, true);
		AgentRegistry.global().register({
			id: PINNED_HUD_TOGGLE_ID,
			displayName: "agent",
			kind: "sub",
			session: {} as unknown as AgentSession,
			sessionFile: null,
		});
		const h = makeHarness();
		h.click("agent card");
		expect(h.focused).toEqual([PINNED_HUD_TOGGLE_ID]);
		expect(h.toggled()).toBe(0);
	});

	it("toggles the pinned HUD only when the clean click has no live-agent target", () => {
		cfgTuiMouse.set(settings, true);
		const h = makeHarness();
		h.click("agent card");
		expect(h.toggled()).toBe(1);
		expect(h.focused).toEqual([]);
	});

	it("does not carry a pending copy click through a fullscreen overlay", () => {
		const h = makeHarness();
		const p = h.point("Copy Markdown");
		h.send(p);
		const overlay = h.composer.ui.showOverlay(new Text("dialog"), { fullscreen: true });
		h.composer.ui.renderNow();
		h.send(p, 0, true);
		overlay.hide();
		h.composer.ui.renderNow();
		h.send(p, 0, true);
		expect(h.copied).toEqual([]);
		h.click("Copy Markdown");
		expect(h.copied).toEqual([TABLE]);
	});
});
