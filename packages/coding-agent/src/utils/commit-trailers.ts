import { $env } from "@oh-my-pi/pi-utils";

/**
 * Trailers for the commits OMP writes itself through the native VCS layer
 * (`commitCreate`, `commitTree`). Those commits never run the `git` binary, so
 * neither `git commit --trailer` nor a `prepare-commit-msg` hook reaches them;
 * every such call site passes its message through here instead.
 *
 * The trailers come from `PI_COMMIT_TRAILERS`, one `Key: value` per line (an
 * embedding harness sets it, e.g. to attribute commits to its session). Lines of
 * any other shape are ignored, and with the variable unset messages are unchanged.
 *
 * A message whose own last paragraph git refuses to read as trailers gets a
 * fresh paragraph, never a line appended inside that one, because git would
 * then read neither. The autoresearch harness message is that shape: the key of
 * its `Benchmark entrypoint: …` line holds a space, which makes the line prose
 * to git, and a paragraph that is mostly prose parses as no trailers at all.
 */
const BLANK_LINE = /^[ \t\r]*$/;
// A configured line counts only with git's own key grammar, letters, digits and
// hyphens, so a stray line of prose in the variable never lands in a message.
const CONFIGURED_TRAILER = /^[A-Za-z0-9][A-Za-z0-9-]*:(\s|$)/;
// git's separator rule: the first `:`, with no whitespace before it, and not at
// the start of the line. No space after it is needed and the value may be empty.
const TRAILER_LINE = /^[^\s:][^\s:]*:/;
// git treats these two as trailers whatever else the block holds (`trailer.c`).
const GIT_GENERATED_LINE = /^(Signed-off-by: |\(cherry picked from commit )/;

/**
 * Where git would say the message's trailer block starts, as `trailer.c`'s
 * `find_trailer_start` decides it: scan the last paragraph upwards; a line is a
 * trailer when a whitespace-free key is followed by `:` (no space after it
 * needed, empty value allowed), a continuation when it starts with whitespace,
 * and prose otherwise. Continuations below the topmost trailer belong to it; the
 * rest count as prose. The paragraph is a trailer block when it holds a trailer
 * and either a git-generated one or under a quarter prose lines. Returns
 * `lines.length` when there is no block. Pinned against `git interpret-trailers`
 * by this module's test.
 */
function trailerBlockStart(lines: readonly string[]): number {
	let trailers = 0;
	let prose = 0;
	let continuations = 0;
	let gitGenerated = false;
	let onlyBlank = true;
	let start = lines.length;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (BLANK_LINE.test(line)) {
			if (onlyBlank) continue;
			break;
		}
		onlyBlank = false;
		start = i;
		if (TRAILER_LINE.test(line) || GIT_GENERATED_LINE.test(line)) {
			trailers++;
			continuations = 0;
			gitGenerated ||= GIT_GENERATED_LINE.test(line);
		} else if (line[0] === " " || line[0] === "\t") {
			continuations++;
		} else {
			prose += 1 + continuations;
			continuations = 0;
		}
	}
	if (onlyBlank || trailers === 0) return lines.length;
	if (gitGenerated || (prose + continuations) * 3 < trailers) return start;
	return lines.length;
}

/**
 * Append the configured trailers to `message`, into the trailer block it ends in
 * or as a new paragraph, exactly where `git interpret-trailers` would put them. A
 * trailer the block already carries is not repeated, so an amend adds nothing.
 *
 * One deliberate difference from git: after a message with no trailer block at
 * all (a bare subject line), git appends with no blank line between, and its own
 * parser then reads back no trailer. This opens the paragraph instead, so the
 * trailer is readable.
 */
export function withCommitTrailers(message: string, configured = $env.PI_COMMIT_TRAILERS): string {
	const wanted = (configured ?? "")
		.split("\n")
		.map(line => line.trim())
		.filter(line => CONFIGURED_TRAILER.test(line));
	const body = message.trimEnd();
	if (wanted.length === 0 || !body) return message;
	const lines = body.split("\n");
	const start = trailerBlockStart(lines);
	const block = lines.slice(start);
	const missing = [...new Set(wanted)].filter(line => !block.includes(line));
	if (missing.length === 0) return message;
	return `${body}${start < lines.length ? "\n" : "\n\n"}${missing.join("\n")}\n`;
}
