import { describe, expect, it } from "bun:test";
import { withCommitTrailers } from "@oh-my-pi/pi-coding-agent/utils/commit-trailers";

const TRAILER = "Omp-Session: 01a13dca-e979-7264-af32-f654ef57a6f5";

describe("withCommitTrailers", () => {
	it("leaves the message alone when nothing is configured", () => {
		expect(withCommitTrailers("fix: x\n", undefined)).toBe("fix: x\n");
		expect(withCommitTrailers("fix: x\n", "")).toBe("fix: x\n");
	});

	it("ignores a configured line that is not a trailer", () => {
		expect(withCommitTrailers("fix: x\n", "not a trailer")).toBe("fix: x\n");
		expect(withCommitTrailers("fix: x\n", "Empty:")).toBe("fix: x\n");
	});

	it("opens a trailer paragraph after a subject that only looks like a trailer", () => {
		expect(withCommitTrailers("fix: x", TRAILER)).toBe(`fix: x\n\n${TRAILER}\n`);
	});

	it("opens a trailer paragraph after a prose body", () => {
		expect(withCommitTrailers("subject\n\nbody text\n\n", TRAILER)).toBe(`subject\n\nbody text\n\n${TRAILER}\n`);
	});

	it("joins an existing trailer block, so git reads both", () => {
		expect(withCommitTrailers('speedup\n\nResult: {"status":"keep"}', TRAILER)).toBe(
			`speedup\n\nResult: {"status":"keep"}\n${TRAILER}\n`,
		);
	});

	it("joins a mixed last paragraph only where git reads it as trailers", () => {
		expect(withCommitTrailers("subject\n\nFixes #12\nSigned-off-by: A <a@b>", TRAILER)).toBe(
			`subject\n\nFixes #12\nSigned-off-by: A <a@b>\n${TRAILER}\n`,
		);
		expect(withCommitTrailers(`subject\n\nFixes rocq-prover/rocq#22632\n${TRAILER}`, TRAILER)).toBe(
			`subject\n\nFixes rocq-prover/rocq#22632\n${TRAILER}\n\n${TRAILER}\n`,
		);
	});

	it("adds every configured trailer, in order, and skips the ones already there", () => {
		expect(withCommitTrailers("subject", `${TRAILER}\nSigned-off-by: A <a@b>`)).toBe(
			`subject\n\n${TRAILER}\nSigned-off-by: A <a@b>\n`,
		);
		expect(withCommitTrailers(`subject\n\n${TRAILER}`, `${TRAILER}\nSigned-off-by: A <a@b>`)).toBe(
			`subject\n\n${TRAILER}\nSigned-off-by: A <a@b>\n`,
		);
	});

	it("leaves a message that already carries the trailer unchanged, so an amend never repeats it", () => {
		const message = `subject\n\n${TRAILER}\n`;
		expect(withCommitTrailers(message, TRAILER)).toBe(message);
	});
});
