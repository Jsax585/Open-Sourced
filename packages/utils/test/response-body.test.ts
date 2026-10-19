import { describe, expect, it } from "bun:test";
import { readBodyCapped } from "../src/response-body";

function chunkedResponse(chunks: number, chunkSize: number): { response: Response; pulled: () => number } {
	let pulled = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulled += 1;
			if (pulled > chunks) controller.close();
			else controller.enqueue(new Uint8Array(chunkSize).fill(97));
		},
	});
	return { response: new Response(stream), pulled: () => pulled };
}

describe("readBodyCapped", () => {
	it("returns the whole body under the cap", async () => {
		const body = await readBodyCapped(new Response("hello"), 1024);
		expect(body?.truncated).toBe(false);
		expect(body?.bytes.toString("utf8")).toBe("hello");
	});

	it("stops reading at the cap when the body arrives as many tiny chunks", async () => {
		const { response, pulled } = chunkedResponse(10_000, 1);
		const body = await readBodyCapped(response, 16);
		expect(body?.truncated).toBe(true);
		expect(body?.bytes.byteLength).toBe(16);
		expect(pulled()).toBeLessThan(100);
	});
});
