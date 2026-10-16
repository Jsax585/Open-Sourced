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

		// A function member makes `structuredClone` throw, so this copy comes
		// from the JSON fallback: array functions serialize to `null`, and an
		// aliasing or absent fallback here would surface as a throw or a
		// wrong shape rather than this exact value.
		expect(structuredCloneJSON(value)).toEqual([null]);

		value[0] = 10n;

		expect(structuredCloneJSON(value)).toEqual([10n]);
	});

	// Regression (#15807): `Object.isFrozen` was read on the ROOT only, but
	// `structuredClone` reports a failure raised by any member anywhere in the
	// graph. A frozen root wrapping a mutable child therefore cached a failure
	// the child had caused, and every later clone of that root took the JSON
	// fallback — even after the child shed the member that broke the clone.
	// Consumer-visible effect: a native copy of `when: new Date(0)` is a `Date`,
	// the JSON round-trip yields a string, and the JSON round-trip also drops an
	// own `undefined`-valued member outright.
	it("retries the native clone for a frozen root whose mutable child became cloneable", () => {
		const child: Record<string, unknown> = { when: new Date(0), keep: undefined, bad: () => {} };
		const frozen = Object.freeze({ child });

		// Native clone throws on the function member, so this copy comes from the
		// JSON fallback and the frozen root is poisoned by it.
		expect(structuredCloneJSON(frozen)).toEqual({ child: { when: "1970-01-01T00:00:00.000Z" } });

		delete child.bad; // the child is natively cloneable again

		const copy = structuredCloneJSON(frozen) as { child: { when: unknown; keep: unknown } };
		expect(copy.child.when).toBeInstanceOf(Date);
		expect("keep" in copy.child).toBe(true);
	});

	// A remembered failure must never outlive the value it was recorded on.
	// Object.isFrozen(root) proves only that the root's own bindings cannot
	// change — it says nothing about what the root yields or wraps, so neither
	// shape below is a sound cache key. Observable through getter read counts:
	// a cache hit means the getter is never re-read by a clone attempt, so a
	// value that becomes cloneable stays pinned to the degraded JSON shape.
	it("re-attempts structuredClone for frozen values on every call", () => {
		let frozenReads = 0;
		const frozen = Object.freeze({
			get bad(): unknown {
				frozenReads++;
				return () => {};
			},
		});
		let mutableReads = 0;
		const mutable = {
			get bad(): unknown {
				mutableReads++;
				return () => {};
			},
		};

		expect(structuredCloneJSON(frozen)).toEqual({});
		expect(structuredCloneJSON(mutable)).toEqual({});
		expect(frozenReads).toBe(2); // structuredClone + JSON fallback
		expect(mutableReads).toBe(2);

		structuredCloneJSON(frozen);
		expect(frozenReads).toBe(4); // no remembered failure: both paths run again

		structuredCloneJSON(mutable);
		expect(mutableReads).toBe(4);
	});
});
