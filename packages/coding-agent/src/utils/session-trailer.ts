/**
 * `Omp-Session: <id>` attribution for the commits omp writes itself through the
 * native VCS layer (`commitCreate`, `commitTree`). Those commits never run the
 * `git` binary, so neither `git commit --trailer` nor a `prepare-commit-msg` hook
 * reaches them; every such call site passes its message through here instead.
 *
 * The id is `OMP_SESSION_ID` and must be a lowercase session UUID. A missing or
 * malformed id adds nothing: attribution may be absent, never wrong.
 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// git counts `(cherry picked from commit …)` as a trailer line too.
const TRAILER_LINE = /^(?:[A-Za-z0-9][A-Za-z0-9-]*:\s|\(cherry picked from commit )/;
const CONTINUATION_LINE = /^[ \t]+\S/;
const GIT_GENERATED_LINE = /^(Signed-off-by: |\(cherry picked from commit )/;

/**
 * Append the session's `Omp-Session` trailer to `message`. It joins the trailer
 * block the message ends in, by git's own rule (`trailer.c`: a last paragraph of
 * trailers, or one with a git-generated trailer where trailers are at least a
 * quarter of its lines; the subject never counts), and opens a new paragraph
 * otherwise. A message whose trailer block already carries the same line comes
 * back unchanged, so an amend never repeats it.
 */
export function withSessionTrailer(message: string, sessionId = process.env.OMP_SESSION_ID): string {
	if (!sessionId || !SESSION_ID.test(sessionId)) return message;
	const body = message.trimEnd();
	if (!body) return message;
	const trailer = `Omp-Session: ${sessionId}`;
	const paragraphs = body.split(/\n[ \t]*\n/);
	const last = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1].split("\n") : [];
	const trailers = last.filter(line => TRAILER_LINE.test(line)).length;
	const prose = last.filter(line => !TRAILER_LINE.test(line) && !CONTINUATION_LINE.test(line)).length;
	const inBlock =
		trailers > 0 && (prose === 0 || (last.some(line => GIT_GENERATED_LINE.test(line)) && trailers * 3 >= prose));
	if (inBlock && last.includes(trailer)) return message;
	return `${body}${inBlock ? "\n" : "\n\n"}${trailer}\n`;
}
