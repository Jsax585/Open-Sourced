import { afterEach, describe, expect, it } from "bun:test";
import { setKeyHintPlatform } from "@oh-my-pi/pi-tui/app-keybindings";
import { buildHotkeysMarkdown } from "@oh-my-pi/pi-tui/hotkeys-markdown";

/** Exit-row wiring for stubs that only care about display strings: no key claims the
 *  forward-delete role, so the exit row renders its plain "Exit" wording. */
const noForwardDelete = { getKeys: () => [], matchesCanonical: () => false };

describe("buildHotkeysMarkdown", () => {
	afterEach(() => setKeyHintPlatform(undefined));

	it("emits flush-left markdown and uses the configured temporary selector hint", () => {
		const displayStrings: Record<string, string> = {
			"app.clipboard.copyLine": "Alt+Shift+L",
			"app.clipboard.copyPrompt": "Ctrl+Shift+P",
			"app.plan.toggle": "Alt+Shift+P",
			"app.tools.expand": "Ctrl+O",
			"app.tools.toggleVisibility": "Ctrl+Shift+O",
			"app.display.reset": "Alt+L",
			"app.interrupt": "Esc",
			"app.clear": "Ctrl+C",
			"app.exit": "Ctrl+D",
			"app.suspend": "Ctrl+Z",
			"app.thinking.cycle": "Shift+Tab",
			"app.model.cycleForward": "Ctrl+P",
			"app.model.cycleBackward": "Shift+Ctrl+P",
			"app.model.selectTemporary": "Ctrl+Shift+L",
			"app.model.select": "Alt+M",
			"app.history.search": "Ctrl+R",
			"app.thinking.toggle": "Ctrl+T",
			"app.editor.external": "Ctrl+G",
			"app.retry": "Alt+R",
			"app.clipboard.pasteImage": "Ctrl+V",
			"app.stt.toggle": "Alt+H",
			"app.live.toggle": "Ctrl+L",
		};
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				...noForwardDelete,
				getDisplayString(action) {
					return displayStrings[action] ?? "Disabled";
				},
			},
		});

		const lines = markdown.split("\n");
		for (const hint of [
			"Ctrl+Shift+P",
			"Ctrl+Shift+L",
			"Alt+M",
			"Alt+L",
			"Ctrl+L",
			"Alt+R",
			"Alt+Shift+P",
			"Ctrl+Shift+O",
		]) {
			expect(markdown).toContain(`| \`${hint}\` |`);
		}
		for (const line of lines) {
			if (line.length === 0) continue;
			expect(line.startsWith(" ")).toBe(false);
			expect(line.startsWith("\t")).toBe(false);
		}
	});

	it("drops Option/Cmd static navigation labels off darwin", () => {
		setKeyHintPlatform("linux");
		const markdown = buildHotkeysMarkdown({
			keybindings: { ...noForwardDelete, getDisplayString: () => "Disabled" },
		});

		expect(markdown).not.toContain("Option+");
		expect(markdown).not.toContain("Cmd+");
	});

	it("renders the effective push-to-talk remap without borrowing the separate toggle binding", () => {
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				getKeys(action) {
					if (action === "app.stt.pushToTalk") return ["x", "ctrl+x"];
					if (action === "app.stt.toggle") return ["alt+h"];
					return [];
				},
				getDisplayString(action) {
					if (action === "app.stt.pushToTalk") return "X / Ctrl+X";
					if (action === "app.stt.toggle") return "Alt+H";
					return "Disabled";
				},
				matchesCanonical: () => false,
			},
		});

		expect(markdown).toContain("X / Ctrl+X");
		expect(markdown).not.toContain("Alt+H");
	});
});
