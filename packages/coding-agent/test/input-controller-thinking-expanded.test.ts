/**
 * InputController thinking-expansion pair (`setThinkingExpanded`), the
 * extension-facing counterpart to `setToolsExpanded`.
 *
 * Contract (review on #17222): the override and the creation preference are
 * separate state. `setThinkingExpanded` force-applies to the blocks already
 * on screen — sections the user toggled by hand included — and records the
 * override `getThinkingExpanded` reads back, but it must NOT rewrite the
 * creation preference (`ctx.expandThinkingBlocks`, mirrored from the
 * persisted setting): a block created afterwards still renders from the
 * user's configured preference, and the persisted setting is never touched.
 * Assertions read the native description — the rendered state — not the
 * internal fields alone.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { cfgExpandThinkingBlocks } from "@oh-my-pi/pi-coding-agent/session/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { createAssistantMessageComponent } from "@oh-my-pi/pi-tui/prompt/interactive-context-helpers";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

function thinkingMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking: "Weighing it carefully" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
}

type DescribedNode = {
	k?: string;
	p?: Record<string, unknown>;
	c?: readonly unknown[];
};

/** The `collapsed` prop of the thinking section in the component's native description. */
function thinkingSectionCollapsed(component: AssistantMessageComponent): boolean | undefined {
	const visit = (node: unknown): boolean | undefined => {
		if (typeof node !== "object" || node === null) return undefined;
		const described = node as DescribedNode;
		if (described.k === "section" && described.p?.role === "omp.thinking") {
			return described.p.collapsed as boolean | undefined;
		}
		for (const child of described.c ?? []) {
			const hit = visit(child);
			if (hit !== undefined) return hit;
		}
		return undefined;
	};
	return visit(component.describe());
}

describe("InputController setThinkingExpanded", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("force-applies to live blocks without rewriting the creation preference", async () => {
		await Settings.init({ inMemory: true });
		// The user's configured preference keeps finished thoughts open.
		const ctx = createInteractiveModeContext({ expandThinkingBlocks: true });
		const controller = new InputController(ctx);
		const live = createAssistantMessageComponent(ctx, thinkingMessage());
		ctx.chatContainer.addChild(live);
		expect(thinkingSectionCollapsed(live)).toBe(false);

		controller.setThinkingExpanded(false);
		expect(thinkingSectionCollapsed(live)).toBe(true);
		// The override is the state extensions read back…
		expect(ctx.thinkingExpandedOverride).toBe(false);
		// …but the creation preference and the persisted setting are untouched.
		expect(ctx.expandThinkingBlocks).toBe(true);
		expect(cfgExpandThinkingBlocks.get(ctx.settings)).toBe(false);

		// A block created now — the next turn's — still renders from the
		// configured preference, not from the extension's override.
		const nextTurn = createAssistantMessageComponent(ctx, thinkingMessage());
		expect(thinkingSectionCollapsed(nextTurn)).toBe(false);

		controller.setThinkingExpanded(true);
		expect(thinkingSectionCollapsed(live)).toBe(false);
		expect(ctx.thinkingExpandedOverride).toBe(true);
		expect(ctx.expandThinkingBlocks).toBe(true);
	});

	it("overrides per-section choices the user recorded by hand", async () => {
		await Settings.init({ inMemory: true });
		// Preference folds settled thoughts; the user opened this one by hand.
		const ctx = createInteractiveModeContext({ expandThinkingBlocks: false });
		const controller = new InputController(ctx);
		const opened = createAssistantMessageComponent(ctx, thinkingMessage());
		ctx.chatContainer.addChild(opened);
		opened.handleNativeEvent({ type: "toggle", key: "k0", collapsed: false });
		expect(thinkingSectionCollapsed(opened)).toBe(false);
		controller.setThinkingExpanded(false);
		expect(thinkingSectionCollapsed(opened)).toBe(true);

		// Reverse: a hand-folded thought under a keep-expanded preference
		// opens when the override asks for expanded.
		const ctx2 = createInteractiveModeContext({ expandThinkingBlocks: true });
		const controller2 = new InputController(ctx2);
		const folded = createAssistantMessageComponent(ctx2, thinkingMessage());
		ctx2.chatContainer.addChild(folded);
		folded.handleNativeEvent({ type: "toggle", key: "k0", collapsed: true });
		expect(thinkingSectionCollapsed(folded)).toBe(true);
		controller2.setThinkingExpanded(true);
		expect(thinkingSectionCollapsed(folded)).toBe(false);
	});
});
