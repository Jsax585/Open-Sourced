import type { Component } from "../tui";
import { Disclosure } from "../components/disclosure";
import { truncateToWidth } from "../render";
import type { Theme } from "../theme";

/** Custom message type that carries one autopilot decision into the transcript. */
export const AUTOPILOT_ANSWER_MESSAGE_TYPE = "autopilot-answer";

/** Structured details the session stores on the autopilot-answer message. */
export interface AutopilotCardDetails {
	kind?: "question" | "ending" | "reiterate";
	decision?: string;
	strategy?: string;
	model?: string;
	latencyMs?: number;
	inputTokens?: number;
	outputTokens?: number;
	stopped?: string;
}

/** One pre-rendered row; the disclosure supplies the surrounding padding. */
class Line implements Component {
	readonly #line: string;

	constructor(line: string) {
		this.#line = line;
	}

	render(width: number): readonly string[] {
		return [truncateToWidth(this.#line, width)];
	}

	invalidate(): void {}
}

class Lines implements Component {
	readonly #lines: readonly string[];

	constructor(lines: readonly string[]) {
		this.#lines = lines;
	}

	render(width: number): readonly string[] {
		return this.#lines.map(line => truncateToWidth(line, width));
	}

	invalidate(): void {}
}

function detailLines(details: AutopilotCardDetails | undefined, uiTheme: Theme): string[] {
	const lines: string[] = [];
	if (details?.decision) lines.push(`${uiTheme.fg("muted", "Decision:")} ${details.decision}`);
	lines.push(
		`${uiTheme.fg("muted", "Kind:")} ${details?.kind ?? "ending"} ${uiTheme.fg("muted", "· strategy:")} ${details?.strategy ?? "?"}`,
	);
	if (details?.model) lines.push(`${uiTheme.fg("muted", "Model:")} ${details.model}`);
	if (details?.latencyMs !== undefined) {
		const input = details.inputTokens ?? 0;
		const output = details.outputTokens ?? 0;
		lines.push(`${uiTheme.fg("muted", "Responder:")} ${details.latencyMs} ms · ${input} in / ${output} out tokens`);
	}
	if (details?.stopped) lines.push(`${uiTheme.fg("muted", "Stopped:")} ${details.stopped}`);
	return lines;
}

function summaryLine(details: AutopilotCardDetails | undefined, uiTheme: Theme): string {
	const label =
		details?.kind === "question"
			? "answered"
			: details?.kind === "reiterate"
				? "reiterated the objective"
				: "continued";
	const decision = details?.decision ? ` ${details.decision}` : "";
	return `${uiTheme.fg("accent", `${uiTheme.icon.agents} Autopilot`)} ${uiTheme.fg("muted", `· ${label}`)}${decision}`;
}

/**
 * Compact transcript card for one autopilot decision. One row while collapsed;
 * Ctrl+O (the transcript-wide tool-output toggle) expands the kind, strategy,
 * responder model/latency/tokens and the stop reason.
 */
export function createAutopilotMessageCard(
	details: AutopilotCardDetails | undefined,
	getExpanded: () => boolean,
	uiTheme: Theme,
): Component & { setExpanded(expanded: boolean): void } {
	let override: boolean | undefined;
	let lastGlobal = getExpanded();
	const expanded = (): boolean => {
		const global = getExpanded();
		if (global !== lastGlobal) {
			lastGlobal = global;
			override = undefined;
		}
		return override ?? global;
	};
	const disclosure = new Disclosure({
		summary: new Line(summaryLine(details, uiTheme)),
		body: () => new Lines(detailLines(details, uiTheme)),
		expanded: getExpanded(),
		paddingX: 1,
	});
	return {
		render(width: number): readonly string[] {
			disclosure.setExpanded(expanded());
			return disclosure.render(width);
		},
		setExpanded(value: boolean): void {
			lastGlobal = value;
			override = undefined;
		},
		invalidate(): void {
			disclosure.invalidate();
		},
	};
}
