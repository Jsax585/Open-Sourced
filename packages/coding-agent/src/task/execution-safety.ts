/** Terminal outcome safety helpers for task subagent finalization. */
export type TerminalInput = {
	/** Exit code before yield/success normalization. */
	initialExitCode: number;
	doneAborted: boolean;
	signalAborted: boolean;
	/** A terminal success yield committed the result before internal termination. */
	hasCommittedSuccess: boolean;
	/** The finalizer has no error text for this termination. */
	stderrEmpty: boolean;
};

export function isTerminalFailure(input: TerminalInput): boolean {
	if (input.initialExitCode !== 0) {
		// A completed yield may be followed by expected internal abort cleanup with an empty stderr;
		// preserve that established success path. A genuine failure without a committed result fails.
		return !(input.hasCommittedSuccess && input.stderrEmpty);
	}
	if (input.hasCommittedSuccess) return false;
	return input.doneAborted === true || input.signalAborted === true;
}
