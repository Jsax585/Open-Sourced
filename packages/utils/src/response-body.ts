/**
 * Read a response body up to `maxBytes`, stopping once the cap is crossed.
 * `bytes` never exceeds the cap; `truncated` reports whether the body was cut
 * mid-stream. Returns `null` when the response carries no readable body.
 */
export async function readBodyCapped(
	response: Response,
	maxBytes: number,
): Promise<{ bytes: Buffer; truncated: boolean } | null> {
	const reader = response.body?.getReader();
	if (!reader) return null;

	// One buffer grown up to the cap: a body delivered as many tiny (or empty)
	// chunks must not retain one object per chunk.
	let buffer = new Uint8Array(Math.min(maxBytes, 64 * 1024));
	let size = 0;
	let truncated = false;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;

			const accepted = Math.min(value.byteLength, maxBytes - size);
			if (size + accepted > buffer.byteLength) {
				const grown = new Uint8Array(Math.min(maxBytes, Math.max(size + accepted, buffer.byteLength * 2)));
				grown.set(buffer.subarray(0, size));
				buffer = grown;
			}
			buffer.set(value.subarray(0, accepted), size);
			size += accepted;
			if (accepted < value.byteLength) {
				// Crossing chunk: keep the head up to the cap, mark the body cut and
				// stop reading so an oversized response cannot balloon memory.
				truncated = true;
				await reader.cancel().catch(() => undefined);
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}

	return { bytes: Buffer.from(buffer.buffer, buffer.byteOffset, size), truncated };
}
