import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getProjectDir, removeSyncWithRetries, setProjectDir } from "@oh-my-pi/pi-utils";
import type { TspProps } from "@oh-my-pi/pi-wire";
import type { NativeChild, NativeNode } from "../src/native/node";
import { setNativeRendering } from "../src/native/state";
import { StatusLineComponent } from "../src/status-line/component";
import type { StatusLineHost, StatusLineSession } from "../src/status-line/host";
import { describeSegment, renderSegment, type SegmentContext } from "../src/status-line/segments";
import { createStartupStatusLine } from "../src/status-line/startup";
import type { StatusLineSettings } from "../src/status-line/types";
import { initTheme } from "../src/theme";

const mounted: StatusLineComponent[] = [];

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	setNativeRendering(false);
	for (const line of mounted.splice(0)) line.dispose();
});

function statusLine(settings: StatusLineSettings, gitEnabled = false): StatusLineComponent {
	return createStartupStatusLine({
		settings,
		gitEnabled,
		autoThinking: false,
		fastMode: false,
		usingSubscription: false,
		autoCompactEnabled: false,
		compactionBoundaries: null,
	});
}

function isNode(child: NativeChild | undefined): child is NativeNode {
	return child !== undefined && "k" in child;
}

/** The `seg` facts of the composer's extras, in order. */
function facts(line: StatusLineComponent): { key: string; props: TspProps<"seg"> }[] {
	const extras = line.describeComposerFacts().extras;
	expect(extras.k).toBe("status");
	return (extras.c ?? [])
		.filter(isNode)
		.flatMap(child =>
			child.k === "seg" && child.key !== undefined ? [{ key: child.key, props: child.p ?? {} }] : [],
		);
}

const NO_MESSAGES: readonly never[] = [];
const NO_USAGE = {
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
};

/**
 * A session-bound status line whose `getContextUsage()` reports `usage`, the way a
 * live session feeds the composer's context meter. The host mirrors the startup
 * session's, so only the context usage differs.
 */
function usageLine(
	usage: { tokens: number; contextWindow: number; percent: number | null },
	settings: StatusLineSettings,
): StatusLineComponent {
	const session: StatusLineSession = {
		state: { model: undefined, thinkingLevel: undefined, messages: NO_MESSAGES },
		model: undefined,
		messages: NO_MESSAGES,
		isStreaming: false,
		isAutoThinking: false,
		sessionManager: {
			getSessionName: () => undefined,
			getSessionId: () => "",
			getUsageStatistics: () => NO_USAGE,
		},
		modelRegistry: { isUsingOAuth: () => false },
		getContextUsage: () => usage,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => null,
		getGoalModeState: () => undefined,
	};
	const host: StatusLineHost = {
		getSettings: () => settings,
		gitEnabled: () => false,
		codexResetFireworksEnabled: () => false,
		getSettingsRevision: () => 0,
		getSessionSettingsIdentity: () => undefined,
		getSessionSettingsRevision: () => 0,
		goalStatusInFooter: () => false,
		activeAccount: () => undefined,
		canFetchUsageReports: () => false,
		fetchUsageReports: async () => null,
		resolveActiveRepo: () => null,
		lookupPullRequest: async () => ({ stdout: "", exitCode: 1 }),
		calculateTokensPerSecond: () => null,
		limitMatchesActiveAccount: () => false,
		computeCompactionBoundaries: () => null,
	};
	const line = new StatusLineComponent(session, host);
	mounted.push(line);
	return line;
}

describe("native composer facts", () => {
	it("keeps the configured segments without another home, outer edges dropping last", () => {
		setNativeRendering(true);
		const segs = facts(
			statusLine({
				preset: "custom",
				leftSegments: ["hostname", "path", "session", "model"],
				rightSegments: ["session_name", "time", "context_pct", "cost"],
			}),
		);

		// Path goes to Tern's pane header, the session name to the tab title, the
		// model to its chip, context and cost to the hairline and usage text.
		expect(segs.map(seg => seg.key)).toEqual(["hostname", "session", "time"]);
		const priority = Object.fromEntries(segs.map(seg => [seg.key, seg.props.priority]));
		expect(priority.hostname!).toBeGreaterThan(priority.session!);
	});

	it("reorders priorities when the configured order changes", () => {
		setNativeRendering(true);
		const segs = facts(statusLine({ preset: "custom", leftSegments: ["session", "hostname"], rightSegments: [] }));
		const priority = Object.fromEntries(segs.map(seg => [seg.key, seg.props.priority]));
		expect(priority.session!).toBeGreaterThan(priority.hostname!);
	});

	it("keeps the git branch by the model chip, outlasting the other facts and opening /git", () => {
		setNativeRendering(true);
		const originalProjectDir = getProjectDir();
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omp-composer-git-"));
		try {
			// The repository's on-disk shape, written without invoking git (no hooks, signing or user config).
			const gitDir = path.join(repo, ".git");
			for (const dir of ["objects", path.join("refs", "heads")])
				fs.mkdirSync(path.join(gitDir, dir), { recursive: true });
			fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feature/parity\n");
			fs.writeFileSync(path.join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
			setProjectDir(repo);

			const segs = facts(
				statusLine(
					{ preset: "custom", leftSegments: ["hostname", "model", "path", "git"], rightSegments: [] },
					true,
				),
			);
			expect(segs.map(seg => seg.key)).toEqual(["hostname", "git"]);
			const [hostname, branch] = segs;
			expect(branch!.props).toMatchObject({
				icon: "branch",
				spans: [{ t: "feature/parity", s: "statusLineGitClean" }],
				actions: { click: "status.git" },
			});
			expect(branch!.props.priority!).toBeGreaterThan(hostname!.props.priority!);
		} finally {
			setProjectDir(originalProjectDir);
			removeSyncWithRetries(repo);
		}
	});

	it("spaces the git counts apart from the branch and each other", () => {
		const text = (branch: string | null, showBranch = true) =>
			describeSegment("git", {
				git: { branch, status: { staged: 2, unstaged: 3, untracked: 1 }, pr: null },
				options: { git: { showBranch } },
			} as unknown as SegmentContext)
				?.spans.map(part => part.t)
				.join("");
		expect(text("main")).toBe("main *3 +2 ?1");
		expect(text("main", false)).toBe("*3 +2 ?1");
	});

	it("describes spans without ANSI escapes or separator glyphs", () => {
		setNativeRendering(true);
		const line = statusLine({ preset: "full", separator: "powerline" });
		const json = JSON.stringify(line.describeComposerFacts());
		expect(json).not.toContain("\\u001b");
		for (const glyph of ["\ue0b0", "\ue0b2", "\ue0b1", "\ue0b3", "─", "│"]) expect(json).not.toContain(glyph);
		expect(facts(line).length).toBeGreaterThan(0);
	});

	it("returns the same facts while nothing changed and new ones after a change", () => {
		setNativeRendering(true);
		const line = statusLine({ preset: "custom", leftSegments: ["path", "mode"], rightSegments: [] });
		const first = line.describeComposerFacts();
		expect(line.describeComposerFacts()).toBe(first);

		line.setPlanModeStatus({ enabled: true, paused: false });
		expect(line.describeComposerFacts()).not.toBe(first);
		expect(facts(line).map(seg => seg.key)).toEqual(["mode"]);
	});
});

describe("composer context meter", () => {
	beforeEach(() => {
		setNativeRendering(true);
	});

	const WINDOW = 272_000;
	/** `context_pct` settings; `showTokens` is set only when given, so the default omits it. */
	const contextSettings = (showTokens?: boolean): StatusLineSettings => ({
		preset: "custom",
		leftSegments: ["model"],
		rightSegments: ["context_pct"],
		separator: "powerline-thin",
		segmentOptions: showTokens === undefined ? {} : { context_pct: { showTokens } },
	});
	/** The composer's `omp.composer.context` meter props. */
	function meter(line: StatusLineComponent): TspProps<"meter"> {
		const node = line.describeComposerFacts().context;
		if (node.k !== "meter" || !node.p) throw new Error(`expected a meter node with props, got ${node.k}`);
		return node.p;
	}

	it("shows a percent by default, tokens while showTokens is on, and a percent again when off", () => {
		const line = usageLine({ tokens: 114_240, contextWindow: WINDOW, percent: 42 }, contextSettings());
		expect(meter(line)).toMatchObject({ label: "42%", total: "272K" });
		expect(meter(line).value).toBeCloseTo(0.42);

		line.updateSettings(contextSettings(true));
		expect(meter(line)).toMatchObject({ label: "114K", total: "272K" });

		line.updateSettings(contextSettings(false));
		expect(meter(line)).toMatchObject({ label: "42%", total: "272K" });
	});

	it("drops the label while usage is unknown, keeping the window total", () => {
		const props = meter(usageLine({ tokens: 114_240, contextWindow: WINDOW, percent: null }, contextSettings(true)));
		expect(props.label).toBeUndefined();
		expect(props.total).toBe("272K");
	});

	it("reads zero usage as 0 in both modes", () => {
		const zero = { tokens: 0, contextWindow: WINDOW, percent: 0 };
		const byPercent = meter(usageLine(zero, contextSettings()));
		expect(byPercent.label).toBe("0%");
		expect(byPercent.value).toBe(0);

		const byTokens = meter(usageLine(zero, contextSettings(true)));
		expect(byTokens.label).toBe("0");
		expect(byTokens.total).toBe("272K");
	});
});

describe("context_pct segment text", () => {
	const usage = (contextPercent: number | null, options: SegmentContext["options"] = {}) =>
		({
			contextPercent,
			contextTokens: 114_240,
			contextWindow: 272_000,
			autoCompactEnabled: false,
			options,
		}) as unknown as SegmentContext;
	const rendered = (ctx: SegmentContext) => stripVTControlCharacters(renderSegment("context_pct", ctx).content);

	it("shows tokens over the window only when showTokens is on, and window alone while usage is unknown", () => {
		const tokens = usage(42, { context_pct: { showTokens: true } });
		expect(rendered(tokens)).toContain("114K/272K");

		const defaults = usage(42);
		expect(rendered(defaults)).toContain("42.0%/272K");

		const unknown = usage(null, { context_pct: { showTokens: true } });
		expect(rendered(unknown)).toContain("272K");
		expect(rendered(unknown)).not.toMatch(/[%/]/);
	});
});
