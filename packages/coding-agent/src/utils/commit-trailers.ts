/**
 * Trailers for the commits omp writes itself through the native VCS layer
 * (`commitCreate`, `commitTree`). Those commits never run the `git` binary, so
 * neither `git commit --trailer` nor a `prepare-commit-msg` hook reaches them;
 * every such call site passes its message through here instead.
 *
 * The trailers come from `PI_COMMIT_TRAILERS`, one `Key: value` per line (an
 * embedding harness sets it, e.g. to attribute commits to its session). Lines of
 * any other shape are ignored, and with the variable unset messages are unchanged.
 */
const CONFIGURED_TRAILER = /^[A-Za-z0-9][A-Za-z0-9-]*: \S.*$/;
// git counts `(cherry picked from commit …)` as a trailer line too.
const TRAILER_LINE = /^(?:[A-Za-z0-9][A-Za-z0-9-]*:\s|\(cherry picked from commit )/;
const CONTINUATION_LINE = /^[ \t]+\S/;
const GIT_GENERATED_LINE = /^(Signed-off-by: |\(cherry picked from commit )/;

/**
 * Append the configured trailers to `message`. They join the trailer block the
 * message ends in, by git's own rule (`trailer.c`: a last paragraph of trailers,
 * or one with a git-generated trailer where trailers are at least a quarter of
 * its lines; the subject never counts), and open a new paragraph otherwise. A
 * trailer the block already carries is not repeated, so an amend adds nothing.
 */
export function withCommitTrailers(message: string, configured = process.env.PI_COMMIT_TRAILERS): string {
	const wanted = (configured ?? "")
		.split("\n")
		.map(line => line.trim())
		.filter(line => CONFIGURED_TRAILER.test(line));
	const body = message.trimEnd();
	if (wanted.length === 0 || !body) return message;
	const paragraphs = body.split(/\n[ \t]*\n/);
	const last = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1].split("\n") : [];
	const trailers = last.filter(line => TRAILER_LINE.test(line)).length;
	const prose = last.filter(line => !TRAILER_LINE.test(line) && !CONTINUATION_LINE.test(line)).length;
	const inBlock =
		trailers > 0 && (prose === 0 || (last.some(line => GIT_GENERATED_LINE.test(line)) && trailers * 3 >= prose));
	const missing = [...new Set(wanted)].filter(line => !(inBlock && last.includes(line)));
	if (missing.length === 0) return message;
	return `${body}${inBlock ? "\n" : "\n\n"}${missing.join("\n")}\n`;
}
