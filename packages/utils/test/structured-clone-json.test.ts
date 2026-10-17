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

		const copy = structuredCloneJSON(frozen);
		expect(copy.child.when).toBeInstanceOf(Date);
		expect("keep" in copy.child).toBe(true);
	});

	// A remembered failure must never outlive the value it was recorded on, and
	// `Object.isFrozen(root)` is not a sound cache key for one: it proves only
	// that the root's own bindings cannot change, not what the root yields. A
	// frozen getter can stop yielding an uncloneable member, and the value then
	// stays pinned to the degraded JSON shape (a `Date` member serializes to a
	// string) even though `structuredClone` can copy it natively again.
	it("retries the native clone for a frozen value whose getter stops yielding an uncloneable member", () => {
		let reads = 0;
		const value = Object.freeze({
			get member(): unknown {
				reads++;
				return reads === 1 ? () => {} : new Date(0);
			},
		});

		// The first read yields a function, so `structuredClone` throws and the
		// JSON fallback reads the getter again, serializing the `Date` to a string.
		expect(structuredCloneJSON(value)).toEqual({ member: "1970-01-01T00:00:00.000Z" });

		// A remembered failure would send this call straight to the JSON fallback,
		// which reads the getter a third time and returns that string shape again.
		const copy = structuredCloneJSON(value);
		expect(copy.member).toBeInstanceOf(Date);
	});
});
