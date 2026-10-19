import * as fs from "node:fs";
import { suppressTerminalOutput } from "../../src/terminal-output-guard";
fs.appendFileSync(process.argv[2], "boot\n");
fs.appendFileSync(process.argv[2], `saved=${suppressTerminalOutput()}\n`);
