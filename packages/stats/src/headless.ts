import { closeDb } from "./db";
import { statsLive } from "./live";

/**
 * Keep the stats ingester running without starting the dashboard server or
 * opening a browser. The session watcher normally keeps the event loop alive;
 * the interval also covers a profile whose sessions directory does not exist
 * yet.
 */
export async function runHeadlessStats(): Promise<never> {
	const live = statsLive();
	const keepAlive = setInterval(() => {}, 60_000);
	let shuttingDown = false;
	const unsubscribe = live.subscribe(status => {
		if (status.sync.phase === "error" && status.sync.error) {
			console.error(`Live stats sync failed: ${status.sync.error}`);
		}
	});
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		unsubscribe();
		live.stop();
		clearInterval(keepAlive);
		closeDb();
		console.log("\nShutting down...");
		process.exit(0);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	live.start();
	console.log("Following session files without opening the dashboard.");
	console.log("Press Ctrl+C to stop\n");

	const { promise } = Promise.withResolvers<never>();
	return promise;
}
