import { afterEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

// DEC 2048 in-band resize reports (`CSI 48;rows;cols;yPx;xPx t`) are
// terminal->host data. #15.10.3 taught ProcessTerminal to reassemble a report
// split at the `\x1b[4` type field, but a pty read can also tear the report
// before that field or bundle its body with the next report's introducer. On
// a wide iTerm2 window the composer filled with `48;50;200;1700;2900`
// repeatedly, and the stdin trace showed the actual delivery:
//
//   "\x1b[48;50;200;1700;2900\x1b["   body without its `t`, next introducer
//
// Report fragments are never keystrokes, so none of these shapes may reach the
// input handler.

const REPORT_BODY = "48;50;200;1700;2900";

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
const stdoutColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const stdoutRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

/**
 * Deliver `data`, then wait out the StdinBuffer's internal flush so a partial
 * escape is emitted as its own event.
 *
 * Genuine delay required: the flush is armed inside StdinBuffer on the wall
 * clock and exposes no completion signal, so fake timers cannot drive this
 * split (same constraint as issue-8542-repro.test.ts). Bounded by
 * PARTIAL_HOLD_MAX_MS (150ms).
 */
async function emitAndFlush(data: string): Promise<void> {
	process.stdin.emit("data", data);
	await Bun.sleep(200);
}

describe("DEC 2048 report fragments split across stdin reads", () => {
	let terminal: ProcessTerminal | undefined;
	let previousHeadless = false;
	let spies: Array<{ mockRestore(): void }> = [];
	const captured: string[] = [];

	function setup(): void {
		previousHeadless = setTerminalHeadless(false);
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
		Object.defineProperty(process.stdout, "columns", { value: 200, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 50, configurable: true });
		spies = [
			vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin),
			vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin),
			vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin),
			vi.spyOn(process.stdout, "write").mockImplementation(() => true),
			vi.spyOn(process, "kill").mockImplementation(() => true),
		];
		captured.length = 0;
		terminal = new ProcessTerminal();
		terminal.start(
			data => captured.push(data),
			() => {},
		);
	}

	afterEach(() => {
		terminal?.stop();
		terminal = undefined;
		for (const spy of spies) spy.mockRestore();
		spies = [];
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
		restoreProperty(process.stdout, "columns", stdoutColumnsDescriptor);
		restoreProperty(process.stdout, "rows", stdoutRowsDescriptor);
		setTerminalHeadless(previousHeadless);
	});

	it("types neither the body nor the terminator of a report whose introducer was flushed alone", async () => {
		setup();
		// Confirm DEC 2048 support the way iTerm2/kitty/WezTerm answer DECRQM.
		process.stdin.emit("data", "\x1b[?2048;1$y");
		await emitAndFlush("\x1b[");
		process.stdin.emit("data", REPORT_BODY);
		process.stdin.emit("data", "t");

		expect(captured.join("")).toBe("");
	});

	it("keeps reassembling a report split at the type field", async () => {
		setup();
		process.stdin.emit("data", "\x1b[?2048;1$y");
		await emitAndFlush("\x1b[4");
		process.stdin.emit("data", "8;50;200;1700;2900t");

		expect(captured.join("")).toBe("");
	});

	it("swallows a body bundled with the next report's introducer", async () => {
		setup();
		process.stdin.emit("data", "\x1b[?2048;1$y");
		// The exact delivery the iTerm2 trace captured: the body arrives
		// without its `t` and the next report's `\x1b[` rides in the same read.
		await emitAndFlush("\x1b[48;50;200;1700;2900\x1b[");
		process.stdin.emit("data", REPORT_BODY);
		process.stdin.emit("data", "t");

		expect(captured.join("")).toBe("");
	});

	it("applies and swallows a body that arrives without its terminator", async () => {
		setup();
		process.stdin.emit("data", "\x1b[?2048;1$y");
		await emitAndFlush("\x1b[48;50;200;1700;2900");
		process.stdin.emit("data", "t");

		expect(captured.join("")).toBe("");
	});

	it("still forwards a split CSI key after a held introducer", async () => {
		setup();
		process.stdin.emit("data", "\x1b[?2048;1$y");
		await emitAndFlush("\x1b[");
		process.stdin.emit("data", "A");

		expect(captured.join("")).toBe("\x1b[A");
	});
});
