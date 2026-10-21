/** Terminal outcome safety helpers for task subagent finalization. */
export type TerminalInput = {
	doneAborted: boolean;
	signalAborted: boolean;
	exitCode: number;
	/** A success yield committed the result before internal termination. */
	hasCommittedSuccess?: boolean;
};

export function isErrorEnvelope(data: unknown): boolean {
	if (data === null || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	if (d.aborted === true || d.cancelled === true || d.canceled === true) return true;
	if (d.success === false) return true;
	return "error" in d && d.error !== null && d.error !== "" && d.error !== false;
}

export function isTerminalFailure(input: TerminalInput): boolean {
	if (input.exitCode !== 0) return true;
	if (input.hasCommittedSuccess === true) return false;
	return input.doneAborted === true || input.signalAborted === true;
}
