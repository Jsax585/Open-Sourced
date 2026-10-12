import type { Component } from "../tui";
import { Text } from "../components/text";
import type { Theme } from "../theme/theme";
import { formatErrorDetail, replaceTabs, shortenPath, TRUNCATE_LENGTHS } from "../render/render-utils";
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

/** Shortens the home directory in every absolute path a result line mentions. */
function displayLine(line: string): string {
	const whole = shortenPath(line);
	if (whole !== line) return replaceTabs(whole);
	return replaceTabs(
		line
			.split(" ")
			.map(token => shortenPath(token))
			.join(" "),
	);
}

function describeOp(op: SessionOp | undefined): string {
	return op?.replaceAll("_", " ") ?? "?";
}

function callDetail(args: SessionRenderArgs): string | undefined {
	if (args.op === "rename" && args.title) return truncateToWidth(replaceTabs(args.title), TRUNCATE_LENGTHS.TITLE);
	if (args.op === "worktree_create" && args.branch) return args.branch;
	if ((args.op === "move" || args.op === "worktree_remove") && args.path) return displayLine(args.path);
	return undefined;
}

function resultLines(result: ToolRenderResult<SessionRenderDetails>): string[] {
	return resultText(result)
		.split("\n")
		.filter(line => line.trim() !== "")
		.map(line => truncateToWidth(displayLine(line), TRUNCATE_LENGTHS.LONG));
}

const sessionResultMemo = new OwnerMemo<NativeToolView | undefined>();

function describeSessionResult(
	result: ToolRenderResult<SessionRenderDetails>,
	args?: SessionRenderArgs,
): NativeToolView {
	const op = result.details?.op ?? args?.op;
	if (result.isError) return errorView("Session", resultText(result) || "Session tool failed", describeOp(op));
	return {
		head: toolHead("Session", describeOp(op)),
		body: compact(resultLines(result).map(line => text([span(line, "muted")], { wrap: "word" }))),
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
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: SessionRenderArgs,
	): Component {
		const description = describeOp(result.details?.op ?? args?.op);
		if (result.isError) {
			const header = renderStatusLine({ icon: "error", title: "Session", description }, uiTheme);
			return framedToolCard(uiTheme, () => ({
				header,
				sections: [
					{ content: formatErrorDetail(resultText(result) || "Session tool failed", uiTheme).split("\n") },
				],
				phase: "error",
				borderColor: "error",
			}));
		}
		const header = renderStatusLine({ icon: "success", title: "Session", description }, uiTheme);
		return framedToolCard(uiTheme, () => ({
			header,
			sections: [{ content: resultLines(result).map(line => uiTheme.fg("muted", line)) }],
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
