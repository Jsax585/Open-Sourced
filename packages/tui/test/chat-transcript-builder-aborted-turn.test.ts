import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import type { TranscriptEntryLike } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function entry(id: string, message: unknown): TranscriptEntryLike {
	return { type: "message", id, parentId: null, timestamp: new Date(0).toISOString(), message } as TranscriptEntryLike;
}

describe("ChatTranscriptBuilder — aborted turn tool calls", () => {
	beforeAll(async () => {
		await initTheme();
	});

	const { readToolResultPreview } = chatTranscriptDisplayPreferences;
	afterEach(() => {
		setChatTranscriptDisplayPreferences({ readToolResultPreview });
	});

	it("shows the real results of an aborted Cursor turn instead of its abort row", () => {
		setChatTranscriptDisplayPreferences({ readToolResultPreview: true });
		const builder = new ChatTranscriptBuilder({
			ui: { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
			cwd: "/tmp",
			requestRender: () => {},
		});
		builder.rebuild([
			entry("a", {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "read", name: "read", arguments: { path: "/tmp/file.txt" } },
					{ type: "toolCall", id: "ran", name: "grep", arguments: { pattern: "foo" } },
					{ type: "toolCall", id: "cut-off", name: "bash", arguments: { command: "pwd" } },
				],
				api: "cursor-agent",
				provider: "cursor",
				model: "claude-haiku",
				usage,
				stopReason: "aborted",
				errorMessage: "cursor turn aborted after its tools ran",
				timestamp: 1,
			}),
			entry("r1", {
				role: "toolResult",
				toolCallId: "read",
				toolName: "read",
				content: [{ type: "text", text: "contents of the file read before the abort" }],
				isError: false,
				timestamp: 2,
			}),
			entry("r2", {
				role: "toolResult",
				toolCallId: "ran",
				toolName: "grep",
				content: [{ type: "text", text: "output of the tool that ran inside the Cursor stream" }],
				isError: false,
				timestamp: 3,
			}),
			entry("r3", {
				role: "toolResult",
				toolCallId: "cut-off",
				toolName: "bash",
				content: [{ type: "text", text: "placeholder for the call that never ran" }],
				details: { __synthetic: true, source: "assistant_stop_aborted" },
				isError: true,
				timestamp: 4,
			}),
		]);
		builder.setExpanded(true);

		const rendered = Bun.stripANSI(builder.container.render(120).join("\n"));
		expect(rendered).toContain("contents of the file read before the abort");
		expect(rendered).toContain("output of the tool that ran inside the Cursor stream");
		expect(rendered.match(/cursor turn aborted after its tools ran/g)).toHaveLength(1);
		expect(rendered).not.toContain("placeholder for the call that never ran");
	});
});
