import { describe, expect, it } from "bun:test";
import { readBodyCapped } from "@oh-my-pi/pi-utils/response-body";

describe("readBodyCapped", () => {
	it("returns capped bytes and releases the reader without awaiting cancellation", async () => {
		const cancellation = Promise.withResolvers<void>();
		let cancelled = false;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					controller.enqueue(new TextEncoder().encode("oversized"));
				},
				cancel() {
					cancelled = true;
					return cancellation.promise;
				},
			}),
		);

		try {
			const body = await readBodyCapped(response, 4);
			expect(body?.bytes.toString()).toBe("over");
			expect(body?.truncated).toBe(true);
			expect(cancelled).toBe(true);
			expect(response.body?.locked).toBe(false);
		} finally {
			cancellation.resolve();
		}
	}, 1_000);
});
