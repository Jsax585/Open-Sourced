/**
 * Normalize a session title exactly as it is stored by `SessionManager.setSessionName`.
 *
 * Control characters (including C1 such as U+0085) become spaces, runs of spaces collapse,
 * and the result is trimmed. Callers that must reject an unusable title before acting can
 * compare the result with an empty string instead of guessing which characters survive.
 */
export function normalizeSessionTitle(raw: string): string {
	return raw
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}
