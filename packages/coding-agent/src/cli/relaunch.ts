import { execReplace } from "@oh-my-pi/pi-natives";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import chalk from "@oh-my-pi/pi-utils/chalk";

export async function relaunch(cmd: string[], label: string): Promise<void> {
	await postmortem.cleanup();
	await postmortem.drainStdout();
	if (process.platform !== "win32") {
		try {
			execReplace(cmd); // never returns on success
		} catch (err) {
			process.stderr.write(`${chalk.red(`${label} exec failed: ${err instanceof Error ? err.message : err}`)}\n`);
		}
	}
	try {
		const child = Bun.spawn(cmd, {
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		await postmortem.quit(await child.exited);
	} catch (err) {
		process.stderr.write(`${chalk.red(`${label} spawn failed: ${err instanceof Error ? err.message : err}`)}\n`);
		await postmortem.quit(1);
	}
}
