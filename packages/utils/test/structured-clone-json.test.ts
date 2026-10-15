import { describe, expect, it } from "bun:test";
import { structuredCloneJSON } from "@oh-my-pi/pi-utils";

describe("structuredCloneJSON", () => {
	// Regression: a failed `structuredClone` attempt used to be remembered for
	// every value, frozen or not. A mutable object that later sheds the member
	// that broke the clone (and gains a `structuredClone`-only value such as a
	// bigint) then skipped straight to the JSON fallback, which throws.
	it("re-attempts structuredClone after a mutable value sheds the member that broke it", () => {
		const value: Record<string, unknown> = { keep: 1, bad: () => {} };

		expect(structuredCloneJSON(value)).toEqual({ keep: 1 });

		delete value.bad;
		value.big = 10n;

		expect(structuredCloneJSON(value)).toEqual({ keep: 1, big: 10n });
	});

	it("re-attempts structuredClone after a member becomes cloneable on a mutable array", () => {
		const value: unknown[] = [() => {}];

		expect(() => structuredCloneJSON(value) as unknown).not.toThrow();

		value[0] = 10n;

		expect(structuredCloneJSON(value)).toEqual([10n]);
	});

	// The remembered failure must survive for values that can no longer change:
	// observable through a getter that counts reads, since a trusted failure
	// means the getter is not re-read by a second clone attempt.
	it("still skips the structuredClone retry for frozen values that cannot be cloned", () => {
		let reads = 0;
		const value = Object.freeze({
			get bad(): unknown {
				reads++;
				return () => {};
			},
		});

		expect(structuredCloneJSON(value)).toEqual({});
		expect(reads).toBe(2); // one read by structuredClone, one by the JSON fallback

		const before = reads;
		structuredCloneJSON(value);
		expect(reads).toBe(before + 1); // remembered failure: no second clone attempt

		const after = reads;
		structuredCloneJSON(value);
		expect(reads).toBe(after + 1);
	});
});
