import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "../src/types";
import { fetchFactoryDroidManagedSettings } from "../src/wire/factory-droid";

function respond(response: () => Response): FetchImpl {
	return async () => response();
}

describe("fetchFactoryDroidManagedSettings", () => {
	it("returns the settings record", async () => {
		const settings = await fetchFactoryDroidManagedSettings("token", {
			fetch: respond(() => Response.json({ success: true, settings: { webSearchDisabled: true } })),
		});
		expect(settings).toEqual({ webSearchDisabled: true });
	});

	it("treats an oversized body as unknown policy without buffering it whole", async () => {
		let pulled = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled += 1;
				if (pulled > 64) controller.close();
				else controller.enqueue(new Uint8Array(64 * 1024).fill(32));
			},
		});
		const settings = await fetchFactoryDroidManagedSettings("token", {
			fetch: respond(() => new Response(stream, { status: 200 })),
		});
		expect(settings).toBeNull();
		expect(pulled).toBeLessThan(64);
	});

	it("treats a failed request or a malformed body as unknown policy", async () => {
		const failures: FetchImpl[] = [
			respond(() => new Response("down", { status: 500 })),
			respond(() => new Response("<html>", { status: 200 })),
			async () => {
				throw new TypeError("socket reset");
			},
		];
		for (const fetch of failures) {
			expect(await fetchFactoryDroidManagedSettings("token", { fetch })).toBeNull();
		}
	});
});
