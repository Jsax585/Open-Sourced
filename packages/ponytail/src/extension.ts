// SPDX-License-Identifier: MIT
// Vendored from https://github.com/DietrichGebert/ponytail
// Original author: Dietrich Gebert (MIT License). Ruleset text copied from the
// project's `skills/ponytail/SKILL.md`; only the ruleset is reproduced here.
// The ponytail npm package's own extension is NOT executed by omp (its
// `before_agent_start` returns a string where omp requires `string[]`); this
// adapter reproduces the ruleset with the correct contract and self-gates on
// the `ponytail.enabled` setting.
/**
 * /ponytail - Lazy-senior-dev ruleset, config-toggled.
 *
 * When `ponytail.enabled` is set, injects the ponytail ruleset into the system
 * prompt every turn at the active level (off/lite/full/ultra), and registers
 * `/ponytail [lite|full|ultra|off]` to switch and report the mode. Mode is
 * persisted per session via a custom entry and restored on session start.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent";
import { settings } from "@oh-my-pi/pi-coding-agent/config/settings";

export type PonytailMode = "off" | "lite" | "full" | "ultra";

const MODES: readonly string[] = ["off", "lite", "full", "ultra"];
const ENTRY_TYPE = "ponytail-mode";

function isMode(value: string): value is PonytailMode {
	return MODES.includes(value);
}

const DEACTIVATION_PHRASES: readonly string[] = ["stop ponytail", "normal mode"];

/**
 * Matches a standalone "stop ponytail" / "normal mode" message, ignoring case
 * and trailing punctuation. Text that merely *mentions* the phrase is not a
 * deactivation request.
 */
export function isDeactivationCommand(text: string): boolean {
	const normalized = text
		.trim()
		.toLowerCase()
		.replace(/[.!?\s]+$/, "");
	return DEACTIVATION_PHRASES.includes(normalized);
}

// =============================================================================
// Ruleset (vendored from ponytail skills/ponytail/SKILL.md, frontmatter stripped)
// =============================================================================

const PONYTAIL_SKILL_BODY = `
# Ponytail

You are a lazy senior developer. Lazy means efficient, not careless. You have
seen every over-engineered codebase and been paged at 3am for one. The best
code is the code never written.

## The ladder

Stop at the first rung that holds:

1. **Does this need to exist at all?** Speculative need = skip it, say so in one line. (YAGNI)
2. **Already in this codebase?** A helper, util, type, or pattern that already lives here -> reuse it. Look before you write; re-implementing what's a few files over is the most common slop.
3. **Stdlib does it?** Use it.
4. **Native platform feature covers it?** \`<input type="date">\` over a picker lib, CSS over JS, DB constraint over app code.
5. **Already-installed dependency solves it?** Use it. Never add a new one for what a few lines can do.
6. **Can it be one line?** One line.
7. **Only then:** the minimum code that works.

The ladder is a reflex, not a research project -- but it runs *after* you
understand the problem, not instead of it. Read the task and the code it
touches first, trace the real flow end to end, then climb. Two rungs work ->
take the higher one and move on.

**Bug fix = root cause, not symptom.** Before you edit, check every caller of
the function you're about to touch. The lazy fix IS the root-cause fix: one
guard in the shared function is a smaller diff than a guard in every caller.

## Rules

- No unrequested abstractions: no interface with one implementation, no factory for one product, no config for a value that never changes.
- No boilerplate, no scaffolding "for later", later can scaffold for itself.
- Deletion over addition. Boring over clever, clever is what someone decodes at 3am.
- Fewest files possible. Shortest working diff wins -- but only once you understand the problem. The smallest change in the wrong place isn't lazy, it's a second bug.
- Complex request? Ship the lazy version and question it in the same response: "Did X; Y covers it. Need full X? Say so." Never stall on an answer you can default.
- Two stdlib options, same size? Take the one that's correct on edge cases. Lazy means writing less code, not picking the flimsier algorithm.
- Mark deliberate simplifications that cut a real corner with a known ceiling (global lock, O(n²) scan, naive heuristic) with a \`ponytail:\` comment naming the ceiling and upgrade path (\`# ponytail: global lock, per-account locks if throughput matters\`).

## Output

Code first. Then at most three short lines: what was skipped, when to add it.
No essays, no feature tours, no design notes. If the explanation is longer
than the code, delete the explanation. Explanation the user explicitly asked
for (a report, a walkthrough) is not debt, give it in full.

Pattern: \`[code] -> skipped: [X], add when [Y].\`

## When NOT to be lazy

Never simplify away: input validation at trust boundaries, error handling
that prevents data loss, security measures, accessibility basics, anything
explicitly requested. User insists on the full version -> build it, no
re-arguing.

Never lazy about understanding the problem. The ladder shortens the solution,
never the reading. Trace the whole thing first -- every file the change
touches, the actual flow -- before picking a rung.

Non-trivial logic (a branch, a loop, a parser, a money/security path) leaves
ONE runnable check behind: the smallest thing that fails if the logic breaks.
Trivial one-liners need no test.

The shortest path to done is the right path.

`;

// Per-level guidance appended after the shared body.
const LEVEL_GUIDANCE: Record<Exclude<PonytailMode, "off">, string> = {
	lite: "Level lite: build what's asked, but name the lazier alternative in one line. The user picks.",
	full: "Level full: the ladder enforced. Stdlib and native first. Shortest diff, shortest explanation.",
	ultra: "Level ultra: YAGNI extremist. Deletion before addition. Ship the one-liner and challenge the rest of the requirement in the same breath.",
};

export function getPonytailInstructions(mode: PonytailMode): string {
	if (mode === "off") return "";
	const header = `PONYTAIL MODE ACTIVE -- level: ${mode}`;
	return `${header}\n\n${PONYTAIL_SKILL_BODY}\n${LEVEL_GUIDANCE[mode]}`;
}

// =============================================================================
// Mode state (persisted per session via session entries)
// =============================================================================

const createPonytailExtension: ExtensionFactory = (api: ExtensionAPI) => {
	const config = settings.getGroup("ponytail");
	if (!config.enabled) {
		// Fully off: register nothing, inject nothing. Fork is unchanged.
		return;
	}

	const defaultMode = config.defaultMode;

	const getMode = (ctx: ExtensionContext): PonytailMode => {
		const entry = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === ENTRY_TYPE);
		const mode = entry?.type === "custom" ? (entry.data as { mode?: unknown }).mode : undefined;
		return typeof mode === "string" && isMode(mode) ? mode : defaultMode;
	};

	const setMode = (mode: PonytailMode): void => {
		api.appendEntry(ENTRY_TYPE, { mode });
	};

	// "stop ponytail" / "normal mode" turn the ruleset off for the rest of the
	// session (upstream parity). The message itself is not consumed; it still
	// reaches the model.
	api.on("input", (event, ctx) => {
		if (event.source === "extension") return;
		if (getMode(ctx) === "off") return;
		if (!isDeactivationCommand(event.text)) return;
		setMode("off");
	});

	api.on("before_agent_start", (event, ctx) => {
		const mode = getMode(ctx);
		if (mode === "off") return;
		return { systemPrompt: [...event.systemPrompt, getPonytailInstructions(mode)] };
	});

	api.registerCommand("ponytail", {
		description: "Set or report ponytail lazy-mode level (lite|full|ultra|off)",
		getArgumentCompletions: () => MODES.map(m => ({ value: m, label: m })),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = args.trim().toLowerCase();
			if (arg === "") {
				const current = getMode(ctx);
				ctx.ui.notify(`ponytail: ${current} (default: ${defaultMode})`, "info");
				return;
			}
			if (!isMode(arg)) {
				ctx.ui.notify(`ponytail: unknown level "${arg}". Use lite|full|ultra|off.`, "error");
				return;
			}
			setMode(arg);
			ctx.ui.notify(arg === "off" ? "ponytail: off" : `ponytail: ${arg}`, "info");
		},
	});
};

export default createPonytailExtension;
