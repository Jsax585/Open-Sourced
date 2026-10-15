import { createRequire } from "node:module";
import * as path from "node:path";
import { isMainThread, parentPort, Worker } from "node:worker_threads";
import * as logger from "../../../utils/src/logger";
import type { WorkProfile } from "../../native";
import { initLoaderContext, loadNative } from "../../native/loader-state.js";

interface MaintenanceResult {
	evicted: number;
	nextCheckMs: number;
}

interface NativeBindings {
	reclaimIdleParseCache(): Promise<MaintenanceResult>;
	getWorkProfile(lastSeconds: number): WorkProfile;
}

type WorkerReply =
	| { kind: "ready" }
	| { kind: "result"; result: MaintenanceResult }
	| { kind: "error"; message: string };

function nextMessage(worker: Worker): Promise<WorkerReply> {
	const deferred = Promise.withResolvers<WorkerReply>();
	const cleanup = () => {
		worker.off("message", onMessage);
		worker.off("error", onError);
		worker.off("exit", onExit);
	};
	const onMessage = (message: WorkerReply) => {
		cleanup();
		deferred.resolve(message);
	};
	const onError = (error: Error) => {
		cleanup();
		deferred.reject(error);
	};
	const onExit = (code: number) => onError(new Error(`Worker exited before replying (${code})`));
	worker.once("message", onMessage);
	worker.once("error", onError);
	worker.once("exit", onExit);
	return deferred.promise;
}

async function requestReclamation(worker: Worker): Promise<MaintenanceResult> {
	const pending = nextMessage(worker);
	worker.postMessage("reclaim");
	const reply = await pending;
	if (reply.kind !== "result") throw new Error(JSON.stringify(reply));
	return reply.result;
}

async function runWorkers(root: string): Promise<void> {
	const bindings = loadNative() as unknown as NativeBindings;
	const workers: Worker[] = [];
	const startWorker = async () => {
		const worker = new Worker(import.meta.path);
		workers.push(worker);
		const ready = await nextMessage(worker);
		if (ready.kind !== "ready") throw new Error(JSON.stringify(ready));
		return worker;
	};
	try {
		const owner = await startWorker();
		const first = await requestReclamation(owner);
		await owner.terminate();
		await Bun.sleep(25);
		const replacement = await startWorker();
		const peer = await startWorker();
		const results = [
			first,
			...(await Promise.all([
				bindings.reclaimIdleParseCache(),
				requestReclamation(replacement),
				requestReclamation(peer),
			])),
		];
		await Bun.write(
			path.join(root, "result.json"),
			JSON.stringify({ results, summary: bindings.getWorkProfile(60).summary }),
		);
	} finally {
		await Promise.all(workers.map(worker => worker.terminate()));
	}
}

async function runFaultInjection(root: string, token: string): Promise<void> {
	const require = createRequire(import.meta.url);
	let bindings: NativeBindings | undefined;
	for (const candidate of initLoaderContext().candidates) {
		if (!(await Bun.file(candidate).exists())) continue;
		bindings = require(candidate) as NativeBindings;
		break;
	}
	if (!bindings) throw new Error("No workspace native addon found");
	const originalReclaim = bindings.reclaimIdleParseCache;
	const originalSetTimeout = globalThis.setTimeout;
	const timers: Array<{ callback: () => void; handle: Timer }> = [];
	const delays: number[] = [];
	let attempts = 0;
	logger.setTransports({ file: path.join(root, "logs"), console: false });
	try {
		bindings.reclaimIdleParseCache = async () => {
			attempts++;
			if (attempts === 1) return { evicted: 0, nextCheckMs: 1_234 };
			if (attempts === 2) return 0 as unknown as MaintenanceResult;
			throw new Error(token);
		};
		Object.defineProperty(globalThis, "setTimeout", {
			value: Object.assign(
				(callback: Bun.TimerHandler, delay = 0, ...args: unknown[]): Timer => {
					const handle = originalSetTimeout(() => {}, 2_147_483_647);
					delays.push(delay);
					timers.push({ callback: () => callback(...args), handle });
					return handle;
				},
				{ __promisify__: originalSetTimeout.__promisify__ },
			),
		});
		loadNative();
		for (let index = 0; index < 3; index++) {
			const timer = timers.shift();
			if (!timer) throw new Error("Loader did not schedule its next maintenance callback");
			clearTimeout(timer.handle);
			await timer.callback();
		}
		logger.flush();
		await Bun.write(path.join(root, "result.json"), JSON.stringify({ delays, attempts }));
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		bindings.reclaimIdleParseCache = originalReclaim;
		for (const timer of timers) clearTimeout(timer.handle);
		logger.setTransports({ file: false, console: false });
	}
}

if (!isMainThread) {
	const port = parentPort;
	if (!port) throw new Error("Worker has no parent port");
	const bindings = loadNative() as unknown as NativeBindings;
	port.on("message", async () => {
		try {
			port.postMessage({ kind: "result", result: await bindings.reclaimIdleParseCache() });
		} catch (error) {
			port.postMessage({ kind: "error", message: String(error) });
		}
	});
	port.postMessage({ kind: "ready" });
} else {
	const [scenario, root, token] = process.argv.slice(2);
	if (!root) throw new Error("Probe requires an isolated output directory");
	switch (scenario) {
		case "workers":
			await runWorkers(root);
			break;
		case "exit":
			loadNative();
			await Bun.write(path.join(root, "loaded"), "loaded");
			break;
		case "fault-injection":
			if (!token) throw new Error("Fault injection requires a unique error marker");
			await runFaultInjection(root, token);
			break;
		default:
			throw new Error(`Unknown probe scenario: ${scenario}`);
	}
}
