/**
 * Double-stop probe. Runs in a PTY subprocess: two ProcessTerminals share the
 * reference-counted output guard; stopping one instance twice (emergency
 * cleanup followed by its owner's teardown) must not release the other
 * instance's acquisition — fd 1/2 stay isolated until the second instance
 * stops.
 */
import * as fs from "node:fs";
import { isTerminalOutputSuppressed } from "@oh-my-pi/pi-utils";
import { ProcessTerminal } from "../../src/terminal";

const state = process.argv[2];
const note = (line: string) => fs.appendFileSync(state, `${line}\n`);

const a = new ProcessTerminal({ conpty: false });
a.start(
	() => {},
	() => {},
);
const b = new ProcessTerminal({ conpty: false });
b.start(
	() => {},
	() => {},
);
note(`after-start=${isTerminalOutputSuppressed()}`);
a.stop();
note(`after-first-stop=${isTerminalOutputSuppressed()}`);
// Emergency cleanup already stopped `a`; the owner's later teardown calls
// stop() again. This must stay a no-op for the shared guard.
a.stop();
note(`after-double-stop=${isTerminalOutputSuppressed()}`);
b.stop();
note(`after-b-stop=${isTerminalOutputSuppressed()}`);
