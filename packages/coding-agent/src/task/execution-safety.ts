/** Terminal outcome safety helpers for task subagent finalization. */
export type TerminalInput = {
	/** Exit code before yield/success normalization. */
	initialExitCode: number;
	doneAborted: boolean;
	signalAborted: boolean;
	/** A current terminal success yield committed the result. */
	hasCommittedSuccess: boolean;
	/** Run-monitor evidence that termination was an expected internal stop. */
	expectedInternalTermination: boolean;
	/** Run-monitor evidence of an external cancellation/timeout/shutdown. */
	externalTermination: boolean;
};

export function isTerminalFailure(input: TerminalInput): boolean {
	if (input.initialExitCode !== 0) {
		return !(input.hasCommittedSuccess && input.expectedInternalTermination);
	}
	if (input.hasCommittedSuccess) return input.externalTermination;
	return input.doneAborted === true || input.signalAborted === true;
}
