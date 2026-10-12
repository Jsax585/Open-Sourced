import type { Component } from "../tui";
import { Text } from "../components/text";
import type { Theme } from "../theme/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import {
	formatErrorDetail,
	formatMoreItems,
	PREVIEW_LIMITS,
	replaceTabs,
	shortenEmbeddedPaths,
	TRUNCATE_LENGTHS,
} from "../render/render-utils";
import { renderStatusLine, truncateToWidth } from "../render/index";
import { framedToolCard } from "../render/tool-card";
import { compact, span, text } from "../native/describe";
import { OwnerMemo } from "../native/memo";
import { errorView, resultText, toolHead } from "./native-view";
import type { NativeToolView, RenderResultOptions, ToolRenderer, ToolRenderResult } from "./renderer";

type SessionOp = "rename" | "move" | "worktree_list" | "worktree_create" | "worktree_remove";

/** Details the `session` tool attaches to its results. */
export interface SessionRenderDetails {
	op?: SessionOp;
	path?: string;
	branch?: string;
	moveQueued?: boolean;
}

/** Arguments the `session` tool is called with, as far as the renderer reads them. */
export interface SessionRenderArgs {
	op?: SessionOp;
	title?: string;
	path?: string;
	branch?: string;
}

/** Strips terminal control sequences, shortens home-directory paths wherever they appear, and replaces tabs. */
function displayText(value: string): string {
	return replaceTabs(shortenEmbeddedPaths(sanitizeText(value)));
}

function describeOp(op: SessionOp | undefined): string {
	// `op` arrives from streamed, possibly malformed arguments, so it is type-checked, sanitized and bounded.
	if (typeof op !== "string") return "?";
	return truncateToWidth(displayText(op).replaceAll("_", " "), TRUNCATE_LENGTHS.TITLE);
}

function callDetail(args: SessionRenderArgs): string | undefined {
	if (args.op === "rename" && args.title) return truncateToWidth(displayText(args.title), TRUNCATE_LENGTHS.TITLE);
	if (args.op === "worktree_create" && args.branch)
		return truncateToWidth(displayText(args.branch), TRUNCATE_LENGTHS.TITLE);
	if ((args.op === "move" || args.op === "worktree_remove") && args.path) {
		return truncateToWidth(displayText(args.path), TRUNCATE_LENGTHS.TITLE);
	}
	return undefined;
}

function resultLines(result: ToolRenderResult<SessionRenderDetails>): string[] {
	return resultText(result)
		.split("\n")
		.filter(line => line.trim() !== "")
		.map(line => truncateToWidth(displayText(line), TRUNCATE_LENGTHS.LONG));
}

/** The error text bounded in rows and width: it can embed a long model-supplied path or a multiline VCS message. */
function errorText(result: ToolRenderResult<SessionRenderDetails>): string {
	const lines = displayText(resultText(result))
		.split("\n")
		.slice(0, PREVIEW_LIMITS.EXPANDED_LINES)
		.map(line => truncateToWidth(line, TRUNCATE_LENGTHS.LONG));
	return lines.join("\n") || "Session tool failed";
}

/** Result rows capped at `limit`, with the standard omitted-items marker for the rest. */
function boundedResultLines(result: ToolRenderResult<SessionRenderDetails>, limit: number): string[] {
	const lines = resultLines(result);
	if (lines.length <= limit) return lines;
	return [...lines.slice(0, limit), formatMoreItems(lines.length - limit, "worktree")];
}

const sessionResultMemo = new OwnerMemo<NativeToolView | undefined>();

function describeSessionResult(
	result: ToolRenderResult<SessionRenderDetails>,
	args?: SessionRenderArgs,
): NativeToolView {
	const op = result.details?.op ?? args?.op;
	if (result.isError) return errorView("Session", errorText(result), describeOp(op));
	return {
		head: toolHead("Session", describeOp(op)),
		body: compact(
			boundedResultLines(result, PREVIEW_LIMITS.EXPANDED_LINES).map(line =>
				text([span(line, "muted")], { wrap: "word" }),
			),
		),
	};
}

/** Renders `session` calls and results with home-relative paths. */
export const sessionToolRenderer = {
	renderCall(args: SessionRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		return new Text(
			renderStatusLine(
				{ icon: "pending", title: "Session", description: describeOp(args.op), meta: compact([callDetail(args)]) },
				uiTheme,
			),
			0,
			0,
		);
	},

	renderResult(
		result: ToolRenderResult<SessionRenderDetails>,
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: SessionRenderArgs,
	): Component {
		const description = describeOp(result.details?.op ?? args?.op);
		if (result.isError) {
			const header = renderStatusLine({ icon: "error", title: "Session", description }, uiTheme);
			return framedToolCard(uiTheme, () => ({
				header,
				sections: [
					{
						content: formatErrorDetail(errorText(result), uiTheme).split("\n"),
					},
				],
				phase: "error",
				borderColor: "error",
			}));
		}
		const header = renderStatusLine({ icon: "success", title: "Session", description }, uiTheme);
		return framedToolCard(uiTheme, () => ({
			header,
			sections: [
				{
					content: boundedResultLines(
						result,
						options.expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_ITEMS,
					).map(line => uiTheme.fg("muted", line)),
				},
			],
			phase: "success",
			borderColor: "borderMuted",
		}));
	},

	describeCall(args: SessionRenderArgs): NativeToolView {
		return { head: toolHead("Session", describeOp(args.op), callDetail(args)) };
	},

	describeResult(
		result: ToolRenderResult<SessionRenderDetails>,
		_options: RenderResultOptions,
		args?: SessionRenderArgs,
	): NativeToolView | undefined {
		return sessionResultMemo.get(result, [args?.op], () => describeSessionResult(result, args));
	},

	mergeCallAndResult: true,
} satisfies ToolRenderer<SessionRenderArgs, SessionRenderDetails>;
