import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "../src/status-line/segments";
import { renderSegment } from "../src/status-line/segments";
import { initTheme, theme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

function createContext(overrides: Partial<SegmentContext>): SegmentContext {
	return {
		session: {} as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		autopilotMode: null,
		vim: null,
		collab: null,
		stream: null,
		recording: false,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		compactionSpeculation: "idle",
		speculationBlinkOn: true,
		subagentCount: 0,
		activeMs: 0,
		turnElapsedMs: null,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
		...overrides,
	};
}

describe("status line autopilot indicator", () => {
	it("shows Autopilot when it is the only active mode", () => {
		const rendered = renderSegment("mode", createContext({ autopilotMode: { enabled: true } }));
		expect(Bun.stripANSI(rendered.content)).toContain("Autopilot");
		expect(rendered.visible).toBe(true);
	});

	it("appends Autopilot alongside another active mode", () => {
		const rendered = renderSegment(
			"mode",
			createContext({ vibeMode: { enabled: true }, autopilotMode: { enabled: true } }),
		);
		const plain = Bun.stripANSI(rendered.content);
		expect(plain).toContain("Vibe");
		expect(plain).toContain("Autopilot");
	});

	it("hides the indicator when autopilot is off", () => {
		const rendered = renderSegment("mode", createContext({ autopilotMode: { enabled: false } }));
		expect(rendered.visible).toBe(false);
		expect(Bun.stripANSI(rendered.content)).not.toContain("Autopilot");
	});

	it("describes the mode for the status-line editor", () => {
		const described = renderSegment("mode", createContext({ autopilotMode: { enabled: true } }));
		expect(Bun.stripANSI(described.content)).toContain("Autopilot");
		expect(theme.icon.agents).toBeString();
	});
});
