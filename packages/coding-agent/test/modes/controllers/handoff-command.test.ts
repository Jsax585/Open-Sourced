import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";
const keybindings = { getKeys: () => ["escape"] };

function createContainer() {
	return {
		children: [] as unknown[],
		addChild(child: unknown) {
			this.children.push(child);
		},
		clear() {
			this.children = [];
		},
		disposeChildren() {
			this.children = [];
		},
	};
}

describe("/handoff command", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shows a cancellable loader while handoff generation is running", async () => {
		const handoffStarted = Promise.withResolvers<void>();
		const handoffDone = Promise.withResolvers<{ document: string }>();
		let isGeneratingHandoff = false;
		const statusContainer = createContainer();
		const chatContainer = createContainer();
		const abortHandoff = vi.fn();
		// InputController installs the real Esc handler; CommandController should
		// leave it in place while showing the handoff loader.
		const originalOnEscape = vi.fn(() => {
			if (isGeneratingHandoff) abortHandoff();
		});
		const requestRender = vi.fn();
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: {
				handoff: vi.fn(async () => {
					isGeneratingHandoff = true;
					handoffStarted.resolve();
					try {
						return await handoffDone.promise;
					} finally {
						isGeneratingHandoff = false;
					}
				}),
				abortHandoff,
			},
			loadingAnimation: undefined,
			statusContainer,
			keybindings,
			chatContainer,
			ui: { requestRender, requestComponentRender: vi.fn() },
			editor: { onEscape: originalOnEscape },
			rebuildChatFromMessages: vi.fn(),
			statusLine: { invalidate: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			reloadTodos: vi.fn(async () => undefined),
			flushCompactionQueue: vi.fn(async () => undefined),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		const commandPromise = controller.handleHandoffCommand("focus on tests");
		await handoffStarted.promise;

		expect(statusContainer.children).toHaveLength(1);
		expect(ctx.editor.onEscape).toBe(originalOnEscape);
		ctx.editor.onEscape?.();
		expect(abortHandoff).toHaveBeenCalledTimes(1);

		handoffDone.resolve({ document: "## Goal\nContinue" });
		await commandPromise;

		expect(statusContainer.children).toHaveLength(0);
		expect(ctx.editor.onEscape).toBe(originalOnEscape);
		expect(ctx.session.handoff).toHaveBeenCalledWith("focus on tests");
	});

	it("clears a working loader mounted while the completed handoff rebuilds the transcript", async () => {
		const statusContainer = createContainer();
		const lateWorkingLoader = { stop: vi.fn() };
		let loadingAnimation: { stop: () => void } | undefined;
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: {
				isStreaming: false,
				handoff: vi.fn(async () => ({ document: "## Goal\nContinue" })),
			},
			get loadingAnimation() {
				return loadingAnimation;
			},
			set loadingAnimation(value: { stop: () => void } | undefined) {
				loadingAnimation = value;
			},
			statusContainer,
			keybindings,
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			clearTransientSessionUi: vi.fn(() => {
				loadingAnimation?.stop();
				loadingAnimation = undefined;
				statusContainer.disposeChildren();
			}),
			renderInitialMessages: vi.fn(async () => {
				// Simulate a delayed agent_start event landing while transcript replay yields.
				loadingAnimation = lateWorkingLoader;
				statusContainer.addChild(lateWorkingLoader);
			}),
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			reloadTodos: vi.fn(async () => undefined),
			flushCompactionQueue: vi.fn(async () => undefined),
			present: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleHandoffCommand();

		expect(lateWorkingLoader.stop).toHaveBeenCalledTimes(1);
		expect(loadingAnimation).toBeUndefined();
		expect(statusContainer.children).toHaveLength(0);
	});

	it("recreates a fresh working loader when a new turn is streaming after handoff", async () => {
		const statusContainer = createContainer();
		const staleWorkingLoader = { stop: vi.fn() };
		const freshWorkingLoader = { stop: vi.fn() };
		let loadingAnimation: { stop: () => void } | undefined;
		let isStreaming = false;
		let loaderAtEnsureCall: { stop: () => void } | undefined | "unset" = "unset";
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: {
				get isStreaming() {
					return isStreaming;
				},
				handoff: vi.fn(async () => ({ document: "## Goal\nContinue" })),
			},
			get loadingAnimation() {
				return loadingAnimation;
			},
			set loadingAnimation(value: { stop: () => void } | undefined) {
				loadingAnimation = value;
			},
			statusContainer,
			keybindings,
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			clearTransientSessionUi: vi.fn(() => {
				loadingAnimation?.stop();
				loadingAnimation = undefined;
				statusContainer.disposeChildren();
			}),
			renderInitialMessages: vi.fn(async () => {
				// A new turn begins and a delayed agent_start mounts its loader while
				// handoff cleanup is still running.
				isStreaming = true;
				loadingAnimation = staleWorkingLoader;
				statusContainer.addChild(staleWorkingLoader);
			}),
			ensureLoadingAnimation: vi.fn(() => {
				loaderAtEnsureCall = loadingAnimation;
				loadingAnimation = freshWorkingLoader;
				statusContainer.addChild(freshWorkingLoader);
			}),
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			reloadTodos: vi.fn(async () => undefined),
			flushCompactionQueue: vi.fn(async () => undefined),
			present: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleHandoffCommand();

		// The frozen loader (its timer stopped by disposeChildren) must be dropped
		// before ensureLoadingAnimation runs, so it builds a fresh running loader
		// instead of reattaching the stale one.
		expect(staleWorkingLoader.stop).toHaveBeenCalledTimes(1);
		expect(loaderAtEnsureCall).toBeUndefined();
		expect(ctx.ensureLoadingAnimation).toHaveBeenCalledTimes(1);
		expect(loadingAnimation).toBe(freshWorkingLoader);
	});

	it("preserves a retry loader that replaces the handoff overlay during replay", async () => {
		const statusContainer = createContainer();
		const retryLoader = { stop: vi.fn() };
		let isStreaming = false;
		let activeRetryLoader: { stop: () => void } | undefined;
		const ensureLoadingAnimation = vi.fn();
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: {
				get isStreaming() {
					return isStreaming;
				},
				handoff: vi.fn(async () => ({ document: "## Goal\nContinue" })),
			},
			loadingAnimation: undefined,
			autoCompactionLoader: undefined,
			get retryLoader() {
				return activeRetryLoader;
			},
			set retryLoader(value: { stop: () => void } | undefined) {
				activeRetryLoader = value;
			},
			statusContainer,
			keybindings,
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			clearTransientSessionUi: vi.fn(() => {
				statusContainer.disposeChildren();
			}),
			renderInitialMessages: vi.fn(async () => {
				isStreaming = true;
				activeRetryLoader = retryLoader;
				statusContainer.addChild(retryLoader);
			}),
			ensureLoadingAnimation,
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			reloadTodos: vi.fn(async () => undefined),
			flushCompactionQueue: vi.fn(async () => undefined),
			present: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleHandoffCommand();

		expect(statusContainer.children).toEqual([retryLoader]);
		expect(activeRetryLoader).toBe(retryLoader);
		expect(ensureLoadingAnimation).not.toHaveBeenCalled();
	});

	it("surfaces a provider failure named AbortError as a real error, not a cancellation", async () => {
		// Regression: the catch used to map any name==="AbortError" error to
		// "Handoff cancelled". session.handoff() now normalizes genuine cancellations
		// to the exact "Handoff cancelled" message and re-throws real provider failures
		// verbatim, so the controller must report those as a failure.
		const providerError = new Error("Deepseek stream stalled");
		providerError.name = "AbortError";
		const showError = vi.fn();
		const statusContainer = createContainer();
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: {
				handoff: vi.fn(async () => {
					throw providerError;
				}),
				abortHandoff: vi.fn(),
			},
			loadingAnimation: undefined,
			statusContainer,
			keybindings,
			chatContainer: createContainer(),
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			editor: { onEscape: vi.fn() },
			showError,
			flushCompactionQueue: vi.fn(async () => undefined),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleHandoffCommand();

		expect(showError).toHaveBeenCalledTimes(1);
		expect(showError).toHaveBeenCalledWith("Handoff failed: Deepseek stream stalled");
	});

	it("refuses to hand off while a response is streaming", async () => {
		// Bug: /handoff dispatches before the streaming-queue branch, so without a
		// guard it resets the agent mid-turn and the live stream keeps emitting into
		// the torn-down session. Streaming must short-circuit with a warning.
		const handoff = vi.fn();
		const showWarning = vi.fn();
		const statusContainer = createContainer();
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: { isStreaming: true, handoff },
			loadingAnimation: undefined,
			statusContainer,
			keybindings,
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			showWarning,
			showError: vi.fn(),
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleHandoffCommand();

		expect(handoff).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledTimes(1);
		expect(statusContainer.children).toHaveLength(0);
	});

	it("preserves idle auto-compaction UI instead of starting handoff", async () => {
		const statusContainer = createContainer();
		const autoCompactionLoader = { stop: vi.fn() };
		statusContainer.addChild(autoCompactionLoader);
		const handoff = vi.fn(async () => {
			throw new Error("Compaction already in progress");
		});
		const showWarning = vi.fn();
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: { isStreaming: false, isCompacting: true, handoff },
			loadingAnimation: undefined,
			autoCompactionLoader,
			retryLoader: undefined,
			statusContainer,
			keybindings,
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			showWarning,
			showError: vi.fn(),
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleHandoffCommand();

		expect(handoff).not.toHaveBeenCalled();
		expect(statusContainer.children).toEqual([autoCompactionLoader]);
		expect(autoCompactionLoader.stop).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith(
			"Wait for context compaction to finish or cancel it before handing off.",
		);
	});

	it("clears retired scrollback when /handoff replays initial messages", async () => {
		resetSettingsForTest();
		const tempDir = TempDir.createSync("@pi-handoff-scrollback-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
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
		vi.spyOn(session, "handoff").mockResolvedValue({ document: "## Goal\nContinue" });
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
		try {
			const usage: Usage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const retiredMarker = "RETIRED_MANUAL_HANDOFF_ROW";
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
			for (let i = 0; i < 20 && !committedRows().some(row => row.includes(retiredMarker)); i++) {
				mode.ui.requestRender(true);
				await term.waitForRender();
			}
			expect(committedRows().some(row => row.includes(retiredMarker))).toBe(true);
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
			let rowsDuringReloadTodos: string[] = [];
			const originalReloadTodos = mode.reloadTodos.bind(mode);
			vi.spyOn(mode, "reloadTodos").mockImplementation(async () => {
				rowsDuringReloadTodos = await drainRetirement();
				await originalReloadTodos();
			});

			const controller = new CommandController(mode);
			await controller.handleHandoffCommand();
			const rowsAfterHandoff = await drainRetirement();

			expect(rowsDuringReloadTodos.filter(row => row.includes(retiredMarker))).toHaveLength(1);
			expect(rowsAfterHandoff.filter(row => row.includes(retiredMarker))).toHaveLength(1);
		} finally {
			mode.stop();
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
			resetSettingsForTest();
		}
	});
});
