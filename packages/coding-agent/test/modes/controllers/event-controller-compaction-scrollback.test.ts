/**
 * Contract: a compaction rebuilds the transcript — `rebuildChatFromMessages`
 * clears the container's emission ledger — so the repaint that follows MUST
 * clear native scrollback (forced), whether or not `display.collapseCompacted`
 * is on. Without that clear every block re-emits over the rows still sitting in
 * native scrollback and each compaction appends a duplicate copy of the whole
 * transcript (#12140). Covers both compaction paths: the automatic
 * `auto_compaction_end` handler and the manual `/compact`
 * (`CommandController.executeCompaction`) route.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
function compactionResultEvent(): AgentSessionEvent {
	return {
		type: "auto_compaction_end",
		action: "snapcompact",
		result: { summary: "compacted summary", firstKeptEntryId: "entry-1", tokensBefore: 100_000 },
		aborted: false,
		willRetry: false,
	};
}

async function dispatchCompactionEnd(collapseCompacted: boolean) {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "display.collapseCompacted": collapseCompacted } });
	const context = createInteractiveModeContext();
	const controller = new EventController(context);
	try {
		await controller.handleEvent(compactionResultEvent());
	} finally {
		controller.dispose();
	}
	return context;
}

describe("auto compaction-end scrollback pairing", () => {
	beforeEach(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("pairs the rebuild with a forced scrollback clear when collapseCompacted is off", async () => {
		const context = await dispatchCompactionEnd(false);

		expect(context.rebuildChatFromMessages).toHaveBeenCalledWith({ reuseSettledComponents: true });
		expect(context.ui.requestRender).toHaveBeenCalledWith(true, { clearScrollback: true });
	});

	it("keeps the same forced scrollback clear when collapseCompacted is on", async () => {
		const context = await dispatchCompactionEnd(true);

		expect(context.rebuildChatFromMessages).toHaveBeenCalledWith({ reuseSettledComponents: true });
		expect(context.ui.requestRender).toHaveBeenCalledWith(true, { clearScrollback: true });
	});

	it("clears retired scrollback when auto-handoff replays initial messages", async () => {
		const tempDir = TempDir.createSync("@pi-auto-compaction-scrollback-");
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		const term = new VirtualTerminal(120, 10);
		const mode = new InteractiveMode(
			session,
			"test",
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: term }),
		);
		const controller = new EventController(mode);
		try {
			const usage: Usage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const retiredMarker = "RETIRED_AUTO_HANDOFF_ROW";
			session.sessionManager.appendMessage({ role: "user", content: retiredMarker, timestamp: 1 });
			for (let i = 0; i < 12; i++) {
				const filler: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: `Filler reply ${i} occupying a transcript row.` }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet",
					usage,
					stopReason: "stop",
					timestamp: i + 2,
				};
				session.sessionManager.appendMessage(filler);
			}
			await mode.init({ suppressWelcomeIntro: true });
			await mode.renderInitialMessages();

			const plainRows = (rows: readonly string[]) => rows.map(row => Bun.stripANSI(row).trimEnd());
			const committedRows = () => {
				const { baseY } = term.getBufferPosition();
				return plainRows(term.getScrollBuffer()).slice(0, baseY);
			};
			const drainRetirement = async () => {
				await term.waitForRender();
				let prevBaseY = -1;
				for (
					let i = 0;
					i < 20 &&
					(i === 0 ||
						term.getBufferPosition().baseY !== prevBaseY ||
						!committedRows().some(row => row.includes(retiredMarker)));
					i++
				) {
					prevBaseY = term.getBufferPosition().baseY;
					mode.ui.requestRender(true);
					await term.waitForRender();
				}
				return plainRows(term.getScrollBuffer());
			};
			for (let i = 0; i < 20 && !committedRows().some(row => row.includes(retiredMarker)); i++) {
				mode.ui.requestRender(true);
				await term.waitForRender();
			}
			expect(committedRows().some(row => row.includes(retiredMarker))).toBe(true);

			let rowsDuringReloadTodos: string[] = [];
			const originalReloadTodos = mode.reloadTodos.bind(mode);
			vi.spyOn(mode, "reloadTodos").mockImplementation(async () => {
				rowsDuringReloadTodos = await drainRetirement();
				await originalReloadTodos();
			});

			await controller.handleEvent({
				type: "auto_compaction_end",
				action: "handoff",
				result: undefined,
				aborted: false,
				willRetry: false,
			});
			const rowsAfterHandoff = await drainRetirement();

			expect(rowsDuringReloadTodos.filter(row => row.includes(retiredMarker))).toHaveLength(1);
			expect(rowsAfterHandoff.filter(row => row.includes(retiredMarker))).toHaveLength(1);
		} finally {
			controller.dispose();
			mode.stop();
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
	});
});

describe("manual /compact scrollback pairing", () => {
	beforeEach(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	async function runCompact(collapseCompacted: boolean) {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "display.collapseCompacted": collapseCompacted } });
		const container = { addChild: vi.fn(), disposeChildren: vi.fn() };
		const ctx = {
			loadingAnimation: undefined,
			statusContainer: container,
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			keybindings: { getKeys: vi.fn(() => ["escape"]) },
			session: { compact: vi.fn(async () => {}) },
			rebuildChatFromMessages: vi.fn(),
			statusLine: { invalidate: vi.fn() },
			flushCompactionQueue: vi.fn(async () => {}),
			showError: vi.fn(),
			// The pre-fix path reads display.collapseCompacted off ctx.settings;
			// point at the real singleton so the old code takes its production
			// branches instead of throwing on a bare mock.
			settings,
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		await controller.executeCompaction();
		return ctx;
	}

	it("pairs the /compact rebuild with a forced scrollback clear when collapseCompacted is off", async () => {
		const ctx = await runCompact(false);

		expect(ctx.rebuildChatFromMessages).toHaveBeenCalledWith({ reuseSettledComponents: true });
		expect(ctx.ui.requestRender).toHaveBeenCalledWith(true, { clearScrollback: true });
	});

	it("keeps the same forced scrollback clear for /compact when collapseCompacted is on", async () => {
		const ctx = await runCompact(true);

		expect(ctx.rebuildChatFromMessages).toHaveBeenCalledWith({ reuseSettledComponents: true });
		expect(ctx.ui.requestRender).toHaveBeenCalledWith(true, { clearScrollback: true });
	});
});
