import { t } from "@oh-my-pi/pi-utils/i18n";
import { combine, effect, register, type Setting } from "../config/registry";
import type { Settings } from "../config/settings";
import { formatKeyHint, formatKeyHints } from "@oh-my-pi/pi-tui/app-keybindings";
import { cfgReadToolResultPreview } from "../tools/settings";
import { MAGIC_KEYWORDS, type MagicKeywordId } from "./magic-keywords";
import { TREE_FILTER_MODES } from "@oh-my-pi/pi-tui/overlays/tree-selector";
import {
	CONTEXT_LINE_MODE_VALUES,
	CUSTOM_STATUS_LINE_DEFAULTS,
	STATUS_LINE_PRESET_VALUES,
	STATUS_LINE_SEGMENT_IDS,
	STATUS_LINE_SEPARATOR_VALUES,
} from "@oh-my-pi/pi-tui/status-line/schema";
import { setChatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { setEditorGapComposerShape } from "@oh-my-pi/pi-tui/prompt/editor-top-gap";
import { setEmojiAutocompleteEnabled } from "@oh-my-pi/pi-tui/prompt/prompt-action-autocomplete";
import { WORD_COMPLETION_METHODS } from "@oh-my-pi/pi-tui/prompt/word-completion";
import { applyHyperlinkSetting } from "@oh-my-pi/pi-tui/render/hyperlink";
import { setInlineImageMaxColumns, setInlineImageMaxRows } from "@oh-my-pi/pi-tui/render/render-utils";
import { setShimmerMode } from "@oh-my-pi/pi-tui/theme/shimmer";
import { setAutoThemeMapping, setColorBlindMode, setSymbolPreset } from "@oh-my-pi/pi-tui/theme/theme";

const EMPTY_UNKNOWN_RECORD: Record<string, unknown> = {};

// ────────────────────────────────────────────────────────────────────────
// General settings (no UI)
// ────────────────────────────────────────────────────────────────────────
export const cfgSetupVersion = register({ id: "setupVersion", type: "number", default: 0 });

export const cfgAutoResume = register({
	id: "autoResume",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Startup & Updates",
		label: t("Auto Resume"),
		description: t("Automatically resume the most recent session in the current directory"),
	},
});

export const cfgGitEnabled = register({
	id: "git.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Git",
		label: t("Enable Git Integration"),
		description: t("Show git branch, status, and PR information in the TUI and watch repository metadata."),
	},
});

// ────────────────────────────────────────────────────────────────────────
// Appearance
// ────────────────────────────────────────────────────────────────────────

// Theme
export const cfgThemeDark = register({
	id: "theme.dark",
	type: "string",
	default: "titanium",
	ui: {
		tab: "appearance",
		group: "Theme",
		label: t("Dark Theme"),
		description: t("Theme used when the terminal has a dark background"),
		options: "runtime",
	},
});
effect(cfgThemeDark, name => setAutoThemeMapping("dark", name));

export const cfgThemeLight = register({
	id: "theme.light",
	type: "string",
	default: "light",
	ui: {
		tab: "appearance",
		group: "Theme",
		label: t("Light Theme"),
		description: t("Theme used when the terminal has a light background"),
		options: "runtime",
	},
});
effect(cfgThemeLight, name => setAutoThemeMapping("light", name));

export const cfgSymbolPreset = register({
	id: "symbolPreset",
	type: "enum",
	values: ["unicode", "nerd", "ascii"] as const,
	default: "unicode",
	ui: {
		tab: "appearance",
		group: "Theme",
		label: t("Symbol Preset"),
		description: t("Glyph set for icons and symbols (Unicode, Nerd Font, or ASCII)"),
		options: [
			{ value: "unicode", label: "Unicode", description: t("Standard symbols (default)") },
			{
				value: "nerd",
				label: "Nerd Font",
				description: t("Requires a Nerd Font, or a Glyph Protocol terminal (icons ship in-band)"),
			},
			{ value: "ascii", label: "ASCII", description: t("Maximum compatibility") },
		],
	},
});
effect(cfgSymbolPreset, setSymbolPreset);

export const cfgColorBlindMode = register({
	id: "colorBlindMode",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Theme",
		label: t("Color-Blind Mode"),
		description: t("Use blue instead of green for diff additions"),
	},
});
effect(cfgColorBlindMode, setColorBlindMode);

// Composer
export const cfgComposerShape = register({
	id: "composer.shape",
	type: "string",
	default: "band",
	ui: {
		tab: "appearance",
		group: "Composer",
		label: t("Composer Shape"),
		description: t("Visual layout of the input editor and status line"),
		options: "runtime",
	},
});
effect(cfgComposerShape, setEditorGapComposerShape);

export const cfgComposerTokenRate = register({
	id: "composer.tokenRate",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Composer",
		label: t("Generation Rate"),
		description:
			t("Show a live generation tok/s readout: on the working row next to the session title, or in the native composer bar right after the thinking level, where the last reading stays between turns. Estimated from streamed deltas and corrected by the provider's billed output count as each message completes."),
	},
});

// Status line
export const cfgStatusLinePreset = register({
	id: "statusLine.preset",
	type: "enum",
	values: STATUS_LINE_PRESET_VALUES,
	default: "default",
	ui: {
		tab: "appearance",
		group: "Status Line",
		label: t("Status Line Preset"),
		description: t("Pre-built status line configurations"),
		options: [
			{ value: "default", label: t("Default"), description: t("Model, path, git, context, tokens, cost") },
			{ value: "minimal", label: t("Minimal"), description: t("Path and git only") },
			{ value: "compact", label: t("Compact"), description: t("Model, git, cost, context") },
			{ value: "full", label: t("Full"), description: t("All segments including time") },
			{ value: "nerd", label: "Nerd", description: t("Maximum info with Nerd Font icons") },
			{ value: "ascii", label: "ASCII", description: t("No special characters") },
			{ value: "custom", label: t("Custom"), description: t("User-defined segments") },
		],
	},
});

export const cfgStatusLineSeparator = register({
	id: "statusLine.separator",
	type: "enum",
	values: STATUS_LINE_SEPARATOR_VALUES,
	default: "powerline-thin",
	ui: {
		tab: "appearance",
		group: "Status Line",
		label: t("Status Line Separator"),
		description: t("Style of separators between segments"),
		options: [
			{ value: "powerline", label: "Powerline", description: t("Solid arrows (Nerd Font)") },
			{ value: "powerline-thin", label: t("Thin chevron"), description: t("Thin arrows (Nerd Font)") },
			{ value: "slash", label: t("Slash"), description: t("Forward slashes") },
			{ value: "pipe", label: t("Pipe"), description: t("Vertical pipes") },
			{ value: "block", label: t("Block"), description: t("Solid blocks") },
			{ value: "none", label: t("None"), description: t("Space only") },
			{ value: "ascii", label: "ASCII", description: t("Greater-than signs") },
		],
	},
});

export const cfgStatusLineContextLine = register({
	id: "statusLine.contextLine",
	type: "enum",
	values: CONTEXT_LINE_MODE_VALUES,
	default: "embedded",
	ui: {
		tab: "appearance",
		group: "Status Line",
		label: t("Context-Reactive Line"),
		description: t("How the line between the left and right segments reflects context usage (box composer only)"),
		options: [
			{ value: "off", label: t("Off"), description: t("Solid accent line, no context feedback") },
			{
				value: "percentage",
				label: t("Percentage"),
				description: t("Used portion in accent color, remainder dimmed"),
			},
			{
				value: "annotated",
				label: t("Annotated"),
				description: t("Percentage plus ticks at the speculative and auto-compaction boundaries"),
			},
			{
				value: "embedded",
				label: t("Embedded"),
				description: t("Annotated line with the context percentage and window embedded in the gauge"),
			},
		],
	},
});

export const cfgStatusLineSessionAccent = register({
	id: "statusLine.sessionAccent",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Status Line",
		label: t("Session Accent"),
		description: t("Use the session name color for the editor border and status line gap"),
	},
});

export const cfgStatusLineTransparent = register({
	id: "statusLine.transparent",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Status Line",
		label: t("Transparent Status Line"),
		description:
			t("Use the terminal's default background for the status line instead of the theme's `statusLineBg`. Powerline end caps are dropped because they need a contrasting fill to bridge into the surrounding terminal."),
	},
});

export const cfgStatusLineCompactThinkingLevel = register({
	id: "statusLine.compactThinkingLevel",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Status Line",
		label: t("Compact Thinking Level"),
		description:
			t("Show the thinking level as a single icon on the model name instead of a separate ` · <level>` suffix; in Tern's composer, as the model chip's icon instead of a separate chip (click the icon to cycle it)."),
	},
});

export const cfgStatusLineShowHookStatus = register({
	id: "statusLine.showHookStatus",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Status Line",
		label: t("Show Hook Status"),
		description: t("Display hook status messages below the status line"),
	},
});

export const cfgStatusLineLeftSegments = register({
	id: "statusLine.leftSegments",
	type: "array",
	default: CUSTOM_STATUS_LINE_DEFAULTS.left,
	items: { values: STATUS_LINE_SEGMENT_IDS, label: t("status line segment") },
});

export const cfgStatusLineRightSegments = register({
	id: "statusLine.rightSegments",
	type: "array",
	default: CUSTOM_STATUS_LINE_DEFAULTS.right,
	items: { values: STATUS_LINE_SEGMENT_IDS, label: t("status line segment") },
});

export const cfgStatusLineSegmentOptions = register({
	id: "statusLine.segmentOptions",
	type: "record",
	default: EMPTY_UNKNOWN_RECORD,
});

// Images and terminal
export const cfgTerminalShowImages = register({
	id: "terminal.showImages",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Images",
		label: t("Show Inline Images"),
		description: t("Render images inline in the terminal"),
		condition: "hasImageProtocol",
	},
});

export const cfgImagesAutoResize = register({
	id: "images.autoResize",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Images",
		label: t("Auto-Resize Images"),
		description: t("Resize large images to 2000x2000 max for better model compatibility"),
	},
});

export const cfgImagesBlockImages = register({
	id: "images.blockImages",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Images",
		label: t("Block Images"),
		description: t("Prevent images from being sent to LLM providers"),
	},
});

export const cfgTuiMaxInlineImageColumns = register({
	id: "tui.maxInlineImageColumns",
	type: "number",
	default: 100,
	description:
		t("Maximum width in terminal columns for inline images (default 100). Set to 0 for unlimited (bounded only by terminal width)."),
});
effect(cfgTuiMaxInlineImageColumns, setInlineImageMaxColumns);

export const cfgTuiMaxInlineImageRows = register({
	id: "tui.maxInlineImageRows",
	type: "number",
	default: 20,
	description:
		t("Maximum height in terminal rows for inline images (default 20). Set to 0 to use only the viewport-based limit (60% of terminal height)."),
});
effect(cfgTuiMaxInlineImageRows, setInlineImageMaxRows);

export const cfgTuiMaxInlineImages = register({
	id: "tui.maxInlineImages",
	type: "number",
	default: 8,
	description:
		t("Maximum number of inline images kept as live terminal graphics (default 8). Older images fall back to a text placeholder via a full redraw once the limit is exceeded. Set to 0 to keep every image (no limit)."),
});

export const cfgTuiResizeScrollback = register({
	id: "tui.resizeScrollback",
	type: "enum",
	values: ["append", "rebuild", "preserve"] as const,
	default: "rebuild",
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Resize Scrollback"),
		description: t("How a settled terminal resize refreshes transcript rows retained in terminal scrollback"),
		options: [
			{
				value: "append",
				label: t("Append"),
				description: t("Replay the transcript at the new width below retained history"),
			},
			{
				value: "rebuild",
				label: t("Rebuild"),
				description: t("Erase all terminal scrollback, then replay one current-width transcript"),
			},
			{
				value: "preserve",
				label: t("Preserve"),
				description: t("Repaint only the viewport and keep history wrapped at its old width"),
			},
		],
	},
});

export const cfgTuiCompleteScrollback = register({
	id: "tui.completeScrollback",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Complete Scrollback"),
		description:
			t("Send transcript rows pushed off screen by a growing HUD or dialog straight to scrollback; when it shrinks, blank rows sit between the transcript and the input until new output fills them"),
	},
});

export const cfgTerminalShowProgress = register({
	id: "terminal.showProgress",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Native Terminal Progress"),
		description:
			t("Emit OSC 9;4 indeterminate progress while the agent or context maintenance is running (always on in Tern)"),
	},
});

export const cfgTerminalProgramStatus = register({
	id: "terminal.programStatus",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Program Status (OSC 7501)"),
		description:
			t("Report whether the agent is working, waiting on you, done, or failed over OSC 7501, for terminal tab indicators and agent inboxes"),
	},
});

export const cfgTuiTextSizing = register({
	id: "tui.textSizing",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Large Headings (Kitty)"),
		description:
			t("Render Markdown H1 headings at 2x scale using Kitty's OSC 66 text-sizing protocol. Only takes effect on Kitty terminals; ignored everywhere else. Off by default."),
	},
});

export const cfgTuiRenderMermaid = register({
	id: "tui.renderMermaid",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Render Mermaid Diagrams"),
		description: t("Render Mermaid fenced code blocks as ASCII diagrams"),
	},
});

export const cfgTuiRenderSvg = register({
	id: "tui.renderSvg",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Render SVG Figures"),
		description:
			t("Invite the agent to draw diagrams and charts as SVG, rendered inline as images on terminals that show graphics"),
	},
});

export const cfgTuiAutoGraph = register({
	id: "tui.autoGraph",
	type: "enum",
	values: ["smart", "always", "off"] as const,
	default: "always",
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Auto-Graph Tables"),
		description:
			t("Draw a chart under numeric tables in the agent's answers, in your theme's colors, on terminals that show graphics"),
		options: [
			{
				value: "smart",
				label: t("Smart"),
				description:
					t("The judge model refines each chart: kind, columns, row names and grouping, scales, which way is better, and its title"),
			},
			{
				value: "always",
				label: t("Always"),
				description: t("Chart every table that reads as numeric, using the built-in best guess"),
			},
			{ value: "off", label: t("Off"), description: t("Leave tables as tables") },
		],
	},
});

export const cfgTuiReactions = register({
	id: "tui.reactions",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Agent Reactions"),
		description: t("Invite the agent to react to your message with an emoji badge on its bubble"),
	},
});

export const cfgTuiCodexResetFireworks = register({
	id: "tui.codexResetFireworks",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Codex Reset Fireworks"),
		get description() {
			return t("Celebrate unscheduled Codex weekly usage resets and newly banked saved resets with a top-third fireworks overlay that remains until {0}", `${formatKeyHint("escape")}`);
		},
	},
});

export const cfgTuiTitleState = register({
	id: "tui.titleState",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Terminal Title Run State"),
		description:
			t("Show the agent run state in the terminal title's separator — an animated spinner while working (a static ':' under WSL), '>' when it's your turn, '!' when the agent is waiting on you"),
	},
});

export const cfgTuiTitleSpinner = register({
	id: "tui.titleSpinner",
	type: "enum",
	values: ["braille", "pulse", "dots", "line"] as const,
	default: "braille",
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Terminal Title Spinner"),
		description:
			t("Glyph set for the working-state spinner in the terminal title — braille sweep, filling moon, single-dot cycle, or ASCII-safe line"),
		options: [
			{ value: "braille", label: t("Braille"), description: t("Classic ⠋⠙⠹ sweep (default)") },
			{ value: "pulse", label: t("Pulse"), description: t("Moon filling ○◑● then emptying") },
			{ value: "dots", label: t("Dots"), description: t("Single braille dots cycling") },
			{ value: "line", label: t("Line"), description: t("ASCII - \\ | / for fonts without braille coverage") },
		],
	},
});

export const cfgTuiHyperlinks = register({
	id: "tui.hyperlinks",
	type: "enum",
	values: ["off", "auto", "always"] as const,
	default: "auto",
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Terminal Hyperlinks"),
		description:
			t("Wrap paths and URLs in OSC 8 hyperlinks for terminal-native click-to-open (auto: detect support; off: never; always: unconditional)"),
	},
});
// Also re-applied when a project-scoped reload (`/move`, cross-project resume, rollback) changes the
// effective value, so pi-tui renderers gating on the shared flag track it the same instant path links do.
effect(cfgTuiHyperlinks, applyHyperlinkSetting);

export const cfgTuiMouse = register({
	id: "tui.mouse",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Mouse Click-to-Focus"),
		get description() {
			const shift = formatKeyHint("shift");
			return t("Capture mouse clicks in the main session so live subagent cards and HUD rows focus on click, with a hover highlight on the target. Native text selection becomes {0}+drag and wheel scroll becomes {1}+wheel while on", `${shift}`, `${shift}`);
		},
	},
});

export const cfgTuiTight = register({
	id: "tui.tight",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Tight Layout"),
		description: t("Remove the 1-character horizontal padding from the left and right of the terminal output"),
	},
});

export const cfgDisplayShimmer = register({
	id: "display.shimmer",
	type: "enum",
	values: ["classic", "kitt", "disabled"] as const,
	default: "classic",
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Shimmer"),
		description: t("Animation style for working/loading messages"),
		options: [
			{ value: "classic", label: t("Classic"), description: t("Soft cosine wave sweeping across the text") },
			{ value: "kitt", label: t("KITT Scanner"), description: t("Knight Rider 1982 red light bouncing left-right") },
			{ value: "disabled", label: t("Disabled\u0004packages/coding-agent/src/modes/settings.ts:cfgDisplayShimmer.ui.options.label"), description: t("No animation; static muted text") },
		],
	},
});
effect(cfgDisplayShimmer, setShimmerMode);

export const cfgDisplayPinnedAgents = register({
	id: "display.pinnedAgents",
	type: "enum",
	values: ["off", "collapsed", "full"] as const,
	default: "collapsed",
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Pinned Agents"),
		description:
			t("Pinned live-agent jump list above the editor (off hides it; collapsed shows a few rows with an expander; full lists all)"),
		options: [
			{ value: "off", label: t("Off"), description: t("Hide the pinned jump list") },
			{ value: "collapsed", label: t("Collapsed"), description: t("Show a few rows with an expander") },
			{ value: "full", label: t("Full"), description: t("Always list every live agent") },
		],
	},
});

export const cfgDisplaySubagentLivePreview = register({
	id: "display.subagentLivePreview",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Subagent Live Preview"),
		description: t("Show each pinned subagent's current (or most recent) tool call beneath its row"),
	},
});

export const cfgDisplaySmoothStreaming = register({
	id: "display.smoothStreaming",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Smooth Streaming"),
		description: t("Reveal assistant text and streamed tool input smoothly while chunks arrive"),
	},
});

export const cfgDisplayHideToolActivity = register({
	id: "display.hideToolActivity",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Hide Tool Activity"),
		description: t("Hide model-initiated tool calls and results from the transcript"),
	},
});

export const cfgDisplayShowTokenUsage = register({
	id: "display.showTokenUsage",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Show Token Usage"),
		description: t("Show per-turn token usage on assistant messages"),
	},
});

export const cfgDisplayShowTurnTime = register({
	id: "display.showTurnTime",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Show Turn Time"),
		description: t("Show the total prompt-to-yield time (including tool calls) on assistant message usage rows"),
	},
});

export const cfgDisplayCacheMissMarker = register({
	id: "display.cacheMissMarker",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Cache Miss Marker"),
		description: t("Show a divider after an assistant turn whose request lost (missed) the prompt cache"),
	},
});
effect(
	combine({
		hideToolActivity: cfgDisplayHideToolActivity,
		readToolResultPreview: cfgReadToolResultPreview,
		showImages: cfgTerminalShowImages,
		cacheMissMarker: cfgDisplayCacheMissMarker,
		showTokenUsage: cfgDisplayShowTokenUsage,
		showTurnTime: cfgDisplayShowTurnTime,
	}),
	setChatTranscriptDisplayPreferences,
);

export const cfgDisplayCollapseCompacted = register({
	id: "display.collapseCompacted",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Collapse Compacted History"),
		description:
			t("Collapse pre-compaction history behind the summary divider on the live transcript; disable to keep the full transcript inline with dividers at each compaction point"),
	},
});

export const cfgShowHardwareCursor = register({
	id: "showHardwareCursor",
	type: "boolean",
	default: true, // will be computed based on platform if undefined
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Show Hardware Cursor"),
		description: t("Show terminal cursor for IME support"),
	},
});

export const cfgTuiImeSafeCursor = register({
	id: "tui.imeSafeCursor",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("IME-Safe Prompt Layout"),
		description: t("Move the prompt's bottom border to a separate row so macOS IME preedit cannot displace it"),
	},
});

// ────────────────────────────────────────────────────────────────────────
// Interaction
// ────────────────────────────────────────────────────────────────────────

// Conversation flow
export const cfgSteeringMode = register({
	id: "steeringMode",
	type: "enum",
	values: ["all", "one-at-a-time"] as const,
	default: "one-at-a-time",
	ui: {
		tab: "interaction",
		group: "Input",
		label: t("Steering Mode"),
		description: t("How to process queued messages while agent is working"),
	},
});

export const cfgFollowUpMode = register({
	id: "followUpMode",
	type: "enum",
	values: ["all", "one-at-a-time"] as const,
	default: "one-at-a-time",
	ui: {
		tab: "interaction",
		group: "Input",
		label: t("Follow-Up Mode"),
		description: t("How to drain follow-up messages after a turn completes"),
	},
});

export const cfgInterruptMode = register({
	id: "interruptMode",
	type: "enum",
	values: ["immediate", "wait"] as const,
	default: "immediate",
	ui: {
		tab: "interaction",
		group: "Input",
		label: t("Interrupt Mode"),
		description: t("When steering messages interrupt tool execution"),
	},
});

export const cfgTuiVimMode = register({
	id: "tui.vimMode",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Input",
		label: t("Vim Editing Mode"),
		get description() {
			return t("Modal prompt editing. {0} leaves Insert mode; Normal mode has hjkl, 0, $, ^, w, b, e, gg, G, counts, x/D/C, dd/yy, p and u; operators take motions or text objects (diw, ca(, dap); v/V start a Visual selection that y copies and d deletes", `${formatKeyHint("escape")}`);
		},
	},
});

export const cfgTuiVimModeDisplay = register({
	id: "tui.vimModeDisplay",
	type: "enum",
	values: ["text", "icon", "none"] as const,
	default: "text",
	ui: {
		tab: "interaction",
		group: "Input",
		label: t("Vim Mode Indicator"),
		description: t("How the current Vim mode appears in the status line"),
		condition: "vimModeEnabled",
		options: [
			{ value: "text", label: t("Text"), description: t("Full mode name — NORMAL, INSERT, VISUAL, V-LINE, REPLACE") },
			{ value: "icon", label: t("Icon"), description: t("Single compact glyph per mode") },
			{ value: "none", label: t("Hidden"), description: t("Do not show the mode in the status line") },
		],
	},
});

export const cfgLoopMode = register({
	id: "loop.mode",
	type: "enum",
	values: ["prompt", "compact", "reset"] as const,
	default: "prompt",
	ui: {
		tab: "interaction",
		group: "Input",
		label: t("Loop Mode"),
		description: t("What happens between /loop iterations before re-submitting the prompt"),
		options: [
			{
				value: "prompt",
				label: t("Prompt"),
				description: t("Re-submit the prompt as a follow-up message (current behavior)"),
			},
			{
				value: "compact",
				label: t("Compact\u0004packages/coding-agent/src/modes/settings.ts:cfgLoopMode.ui.options.label"),
				description: t("Compact the session context, then re-submit the prompt"),
			},
			{ value: "reset", label: t("Reset"), description: t("Start a new session, then re-submit the prompt") },
		],
	},
});

export const cfgLoopConditionTimeoutMs = register({
	id: "loop.conditionTimeoutMs",
	type: "number",
	default: 30_000,
	ui: {
		tab: "interaction",
		group: "Input",
		label: t("Loop Condition Timeout (ms)"),
		description:
			t("Max wait for a `/loop --while` / `--until` condition command before treating it as broken and stopping the loop. Set to 0 to wait indefinitely"),
		options: [
			{ value: "0", label: t("Unlimited") },
			{ value: "10000", label: t("10 seconds") },
			{ value: "30000", label: t("30 seconds") },
			{ value: "120000", label: t("2 minutes") },
		],
	},
});

// Input and startup
export const cfgComposerRecallClearedDrafts = register({
	id: "composer.recallClearedDrafts",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Input",
		label: t("Recall Cleared Drafts"),
		get description() {
			return t("Keep drafts cleared with {0} in local {1} history until exit; disabling affects future clears", `${formatKeyHint("ctrl+c")}`, `${formatKeyHints(["up", "down"])}`);
		},
	},
});

export const cfgDoubleEscapeAction = register({
	id: "doubleEscapeAction",
	type: "enum",
	values: ["rewind", "tree", "none"] as const,
	default: "rewind",
	ui: {
		tab: "interaction",
		group: "Input",
		label: t("Double-Escape Action"),
		get description() {
			return t("What pressing {0} twice with an empty editor does: open the transcript rewind selector, open the session tree, or nothing", `${formatKeyHint("escape")}`);
		},
	},
});

export const cfgBareExitOnEmptySession = register({
	id: "input.bareExitOnEmptySession",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Input",
		label: t("Bare Exit on Empty Session"),
		description:
			t("Submitting exactly `exit`, `quit`, or `q` (any case) before the first message quits instead of prompting the model"),
	},
});

export const cfgBareSlashCommands = register({
	id: "input.bareSlashCommands",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Input",
		label: t("Bare Slash Commands"),
		description:
			t("Submitting exactly a command name without the leading `/` (e.g. `model`, `compact`) runs that slash command; once the session has messages, press Enter twice to confirm"),
	},
});

export const cfgTreeFilterMode = register({
	id: "treeFilterMode",
	type: "enum",
	values: TREE_FILTER_MODES,
	default: "default",
	ui: {
		tab: "interaction",
		group: "Input",
		label: t("Session Tree Filter"),
		description: t("Default filter mode when opening the session tree"),
	},
});

export const cfgAutocompleteMaxVisible = register({
	id: "autocompleteMaxVisible",
	type: "number",
	default: 10,
	ui: {
		tab: "interaction",
		group: "Input",
		label: t("Autocomplete Items"),
		description: t("Max visible items in autocomplete dropdown (3-20)"),
		options: [
			{ value: "3", label: t("3 items") },
			{ value: "5", label: t("5 items") },
			{ value: "7", label: t("7 items") },
			{ value: "10", label: t("10 items") },
			{ value: "15", label: t("15 items") },
			{ value: "20", label: t("20 items") },
		],
	},
});

export const cfgSpellingTypoDetection = register({
	id: "spelling.typoDetection",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Input",
		label: t("Typo Detection (macOS)"),
		description: t("Mark misspelled prompt words with the active macOS dictionaries"),
		condition: "macOS",
	},
});

export const cfgSpellingAutocomplete = register({
	id: "spelling.autocomplete",
	type: "enum",
	values: WORD_COMPLETION_METHODS,
	default: "auto",
	ui: {
		tab: "interaction",
		group: "Input",
		label: t("Word Autocomplete"),
		get description() {
			return t("Show predicted word completions as inline hints: {0} accepts with a space, {1} without", `${formatKeyHint("tab")}`, `${formatKeyHint("right")}`);
		},
		options: [
			{ value: "off", label: t("Off"), description: t("No word completion") },
			{
				value: "auto",
				label: t("Auto"),
				description: t("N-gram (nothing to download)"),
			},
			{ value: "ngram", label: "N-gram", description: t("Learns your vocabulary from prompt history") },
			{
				value: "smollm",
				label: "SmolLM",
				description: t("Small on-device language model blended with N-gram (downloads weights on first use)"),
			},
			...(process.platform === "darwin"
				? [{ value: "apple" as const, label: "Apple", description: t("macOS dictionary completions") }]
				: []),
		],
	},
});

export const cfgComposerPredictions = register({
	id: "composer.predictions",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Input",
		label: t("Composer Predictions"),
		get description() {
			return t("After a completed turn, ask the active model to predict your next message and show it as ghost text in the empty composer; {0} or {1} inserts it without sending. Extra usage: every completed turn sends one more billed request over the whole conversation (counted in /stats)", `${formatKeyHint("tab")}`, `${formatKeyHint("right")}`);
		},
	},
});

export const cfgSpellingAutocorrect = register({
	id: "spelling.autocorrect",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Input",
		label: t("Autocorrect (macOS)"),
		description: t("Apply confident macOS spelling corrections after completed words"),
		condition: "macOS",
	},
});

export const cfgEmojiAutocomplete = register({
	id: "emojiAutocomplete",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Input",
		label: t("Emoji Autocomplete"),
		description: t("Suggest emojis from `:name:` shortcodes and expand text emoticons like `:D` or `:-)`"),
	},
});
effect(cfgEmojiAutocomplete, setEmojiAutocompleteEnabled);

export const cfgPasteLargeMenuThreshold = register({
	id: "paste.largeMenuThreshold",
	type: "number",
	default: 100,
	ui: {
		tab: "interaction",
		group: "Input",
		label: t("Large Paste Menu"),
		description:
			t("When a paste reaches this many lines, offer a menu to wrap it in a code block, wrap it in XML tags, or save it to a file. 0 disables the menu (large pastes still collapse to a [Paste] marker)."),
		options: [
			{ value: "0", label: t("Off") },
			{ value: "100", label: t("100 lines") },
			{ value: "250", label: t("250 lines") },
			{ value: "500", label: t("500 lines") },
			{ value: "1000", label: t("1000 lines") },
		],
	},
});

export const cfgStartupQuiet = register({
	id: "startup.quiet",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Startup & Updates",
		label: t("Quiet Startup"),
		description: t("Skip welcome screen and startup status messages"),
	},
});

export const cfgStartupShowSplash = register({
	id: "startup.showSplash",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Startup & Updates",
		label: t("Show Startup Splash"),
		description:
			t("Show the full animated setup splash on normal interactive startup without rerunning setup. Quiet Startup still suppresses it."),
	},
});

export const cfgStartupSetupWizard = register({
	id: "startup.setupWizard",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Startup & Updates",
		label: t("Setup Wizard"),
		description: t("Show newly added onboarding steps once per setup version"),
	},
});

export const cfgStartupCheckUpdate = register({
	id: "startup.checkUpdate",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Startup & Updates",
		label: t("Check for Updates"),
		description: t("Check for omp updates on startup"),
	},
});

export const cfgUpdateChannel = register({
	id: "update.channel",
	type: "enum",
	values: ["stable", "canary"] as const,
	default: "stable",
	ui: {
		tab: "interaction",
		group: "Startup & Updates",
		label: t("Update Channel"),
		description: t("Update channel used by omp update and the startup update check"),
		options: [
			{ value: "stable", label: t("Stable") },
			{ value: "canary", label: t("Canary") },
		],
	},
});

export const cfgMarketplaceAutoUpdate = register({
	id: "marketplace.autoUpdate",
	type: "enum",
	values: ["off", "notify", "auto"] as const,
	default: "notify",
	ui: {
		tab: "interaction",
		group: "Startup & Updates",
		label: t("Marketplace Auto-Update"),
		description: t("Check for plugin updates on startup"),
		options: [
			{ value: "off", label: t("Off"), description: t("Don't check for plugin updates") },
			{ value: "notify", label: t("Notify"), description: t("Check on startup and notify when updates are available") },
			{ value: "auto", label: t("Auto"), description: t("Check on startup and auto-install updates") },
		],
	},
});

export const cfgStartupChangelogMode = register({
	id: "startup.changelogMode",
	type: "enum",
	values: ["summary", "expanded", "hidden"] as const,
	default: "summary",
	ui: {
		tab: "interaction",
		group: "Startup & Updates",
		label: t("Startup Changelog"),
		description: t("Choose whether update notes start as a summary, full details, or stay hidden"),
		options: [
			{
				value: "summary",
				label: t("Summary"),
				description: t("Show release and change counts with a /changelog hint"),
			},
			{
				value: "expanded",
				label: t("Expanded"),
				description: t("Show the recent release notes in full"),
			},
			{
				value: "hidden",
				label: t("Hidden"),
				description: t("Do not show release notes on startup"),
			},
		],
	},
});

export const cfgMagicKeywordsEnabled = register({
	id: "magicKeywords.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Magic Keywords",
		label: t("Magic Keywords"),
		description: t("Enable hidden notices for standalone {0} keywords", `${MAGIC_KEYWORDS.map(keyword => keyword.word).join(", ")}`),
	},
});

/** One `magicKeywords.<id>` toggle per registered keyword, keyed by keyword id. */
export const cfgMagicKeyword = Object.fromEntries(
	MAGIC_KEYWORDS.map(keyword => [
		keyword.id,
		register({
			id: `magicKeywords.${keyword.id}`,
			type: "boolean",
			default: true,
			ui: { tab: "interaction", group: "Magic Keywords", label: keyword.label, description: keyword.description },
		}),
	]),
) as Record<MagicKeywordId, Setting<boolean>>;

// Notifications
export const cfgCompletionNotify = register({
	id: "completion.notify",
	type: "enum",
	values: ["on", "off"] as const,
	default: "on",
	ui: {
		tab: "interaction",
		group: "Notifications",
		label: t("Completion Notification"),
		description: t("Notify when the agent finishes a turn"),
	},
});

export const cfgErrorNotify = register({
	id: "error.notify",
	type: "enum",
	values: ["on", "off"] as const,
	default: "off",
	ui: {
		tab: "interaction",
		group: "Notifications",
		label: t("Error Notification"),
		description: t("Notify when the agent stops with an error"),
	},
});

export const cfgAskTimeout = register({
	id: "ask.timeout",
	type: "number",
	default: 0,
	ui: {
		tab: "interaction",
		group: "Notifications",
		label: t("Ask Timeout"),
		description:
			t("Auto-select the recommended ask option after this many seconds (0 disables). Also bounds cfg:// approval prompts; an unanswered approval denies the write instead of auto-selecting"),
		options: [
			{ value: "0", label: t("Disabled\u0004packages/coding-agent/src/modes/settings.ts:cfgDisplayShimmer.ui.options.label") },
			{ value: "15", label: t("15 seconds") },
			{ value: "30", label: t("30 seconds") },
			{ value: "60", label: t("60 seconds") },
			{ value: "120", label: t("120 seconds") },
		],
	},
});

/**
 * `ask.timeout` in the milliseconds dialogs consume, or `undefined` for no
 * deadline. Shared by the ask tool and the `cfg://` approval prompt so the
 * setting means the same thing everywhere it is honored.
 */
export function askTimeoutMs(settings: Settings): number | undefined {
	const timeoutSeconds = cfgAskTimeout.get(settings);
	return timeoutSeconds === 0 ? undefined : timeoutSeconds * 1000;
}

export const cfgAskNotify = register({
	id: "ask.notify",
	type: "enum",
	values: ["on", "off"] as const,
	default: "on",
	ui: {
		tab: "interaction",
		group: "Notifications",
		label: t("Ask Notification"),
		description: t("Notify when the ask tool is waiting for input"),
	},
});

export const cfgRecapEnabled = register({
	id: "recap.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Notifications",
		label: t("Idle Recap"),
		description: t("Generate a brief LLM recap of where things stand after the terminal has been idle"),
	},
});

export const cfgRecapIdleSeconds = register({
	id: "recap.idleSeconds",
	type: "number",
	default: 240,
	ui: {
		tab: "interaction",
		group: "Notifications",
		label: t("Idle Recap Delay"),
		description: t("Seconds to wait while idle before showing the recap"),
		options: [
			{ value: "60", label: t("1 minute") },
			{ value: "120", label: t("2 minutes") },
			{ value: "240", label: t("4 minutes") },
			{ value: "300", label: t("5 minutes") },
			{ value: "600", label: t("10 minutes") },
		],
	},
});

/** Idle recap policy (`recap.*`). */
export const cfgRecap = combine({ enabled: cfgRecapEnabled, idleSeconds: cfgRecapIdleSeconds });
