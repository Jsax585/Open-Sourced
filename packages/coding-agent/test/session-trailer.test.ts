import { describe, expect, it } from "bun:test";
import { withSessionTrailer } from "@oh-my-pi/pi-coding-agent/utils/session-trailer";

const ID = "01a13dca-e979-7264-af32-f654ef57a6f5";
const TRAILER = `Omp-Session: ${ID}`;

describe("withSessionTrailer", () => {
	it("adds nothing without a well-formed session id", () => {
		expect(withSessionTrailer("fix: x\n", "")).toBe("fix: x\n");
		expect(withSessionTrailer("fix: x\n", "not-a-session")).toBe("fix: x\n");
		expect(withSessionTrailer("fix: x\n", ID.toUpperCase())).toBe("fix: x\n");
	});

	it("opens a trailer paragraph after a subject that only looks like a trailer", () => {
		expect(withSessionTrailer("fix: x", ID)).toBe(`fix: x\n\n${TRAILER}\n`);
	});

	it("opens a trailer paragraph after a prose body", () => {
		expect(withSessionTrailer("subject\n\nbody text\n\n", ID)).toBe(`subject\n\nbody text\n\n${TRAILER}\n`);
	});

	it("joins an existing trailer block, so git reads both", () => {
		expect(withSessionTrailer('speedup\n\nResult: {"status":"keep"}', ID)).toBe(
			`speedup\n\nResult: {"status":"keep"}\n${TRAILER}\n`,
		);
	});

	it("joins a mixed last paragraph only where git reads it as trailers", () => {
		expect(withSessionTrailer("subject\n\nFixes #12\nSigned-off-by: A <a@b>", ID)).toBe(
			`subject\n\nFixes #12\nSigned-off-by: A <a@b>\n${TRAILER}\n`,
		);
		expect(withSessionTrailer(`subject\n\nFixes rocq-prover/rocq#22632\n${TRAILER}`, ID)).toBe(
			`subject\n\nFixes rocq-prover/rocq#22632\n${TRAILER}\n\n${TRAILER}\n`,
		);
	});

	it("leaves a message that already carries the trailer unchanged, so an amend never repeats it", () => {
		const message = `subject\n\n${TRAILER}\n`;
		expect(withSessionTrailer(message, ID)).toBe(message);
	});
});
