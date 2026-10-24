import { AsyncLocalStorage } from "node:async_hooks";

const singleAttempt = new AsyncLocalStorage<{ active: boolean }>();

/** Keep command retries disabled across adapters without changing concurrent model calls. */
export function withMCPSingleAttempt<T>(callback: () => Promise<T>): Promise<T> {
	const scope = { active: true };
	return singleAttempt.run(scope, async () => {
		try {
			return await callback();
		} finally {
			// Timers and transport listeners created during a call must not inherit this policy forever.
			scope.active = false;
		}
	});
}

export function isMCPSingleAttempt(): boolean {
	return singleAttempt.getStore()?.active === true;
}
