/**
 * Clean dispose drains an in-flight auto-learn capture before session_shutdown.
 *
 * A one-prompt session's managed-skill collector relies on its `session_shutdown`
 * handler to sweep each `managed-skills/<name>/SKILL.md` and flush to the
 * ingester. The capture turn writes that SKILL.md, so `dispose()` MUST let the in-flight
 * capture settle before `session_shutdown` fires — not abort it in
 * `beginDispose()` and not emit the event ahead of the drain.
 *
 * Pins:
 *   1. `dispose()` neither aborts nor abandons an in-flight capture: the capture
 *      completes first, `session_shutdown` handlers run after it.
 *   2. A capture that exceeds the drain budget (`OMP_AUTOLEARN_DRAIN_MS`) is
 *      aborted so it cannot outlive dispose().
 *   3. No capture in flight means the drain returns immediately (~0ms) even
 *      with a large drain budget armed.
 *   4. `abort()` — an explicit interrupt — still aborts the capture immediately.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession auto-learn capture disposal", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	const originalDrainMs = process.env.OMP_AUTOLEARN_DRAIN_MS;

	afterEach(async () => {
		const current = session;
		session = undefined;
		if (current) await current.dispose();
		authStorage?.close();
		authStorage = undefined;
		if (originalDrainMs === undefined) delete process.env.OMP_AUTOLEARN_DRAIN_MS;
		else process.env.OMP_AUTOLEARN_DRAIN_MS = originalDrainMs;
	});

	async function createSession(
		onSessionShutdown: () => void,
		sessionManager: SessionManager = SessionManager.inMemory(),
	): Promise<AgentSession> {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_shutdown", () => {
					onSessionShutdown();
				});
			},
			process.cwd(),
			new EventBus(),
			runtime,
			"autolearn-dispose-test",
		);
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const extensionRunner = new ExtensionRunner([extension], runtime, process.cwd(), sessionManager, modelRegistry);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: createMockModel({ responses: [] }).stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "autolearn.enabled": true }),
			modelRegistry,
			extensionRunner,
		});
		return session;
	}

	it("drains an in-flight capture to completion before session_shutdown handlers run", async () => {
		const order: string[] = [];
		const s = await createSession(() => order.push("session_shutdown"));
		const gate = Promise.withResolvers<void>();
		let captureSignal: AbortSignal | undefined;
		const capturePromise = s.runAutolearnCapture(async signal => {
			captureSignal = signal;
			order.push("capture-start");
			await gate.promise;
			order.push("capture-done");
		});

		const disposePromise = s.dispose();
		// Let dispose advance past beginDispose() to the drain await: with the
		// bug it synchronously aborts the capture in beginDispose() or schedules
		// session_shutdown ahead of the drain.
		await Promise.resolve();
		await Promise.resolve();
		expect(captureSignal?.aborted).toBe(false);
		expect(order).toEqual(["capture-start"]);

		gate.resolve();
		await Promise.all([disposePromise, capturePromise]);
		expect(order).toEqual(["capture-start", "capture-done", "session_shutdown"]);
		expect(captureSignal?.aborted).toBe(false);
	});

	it("aborts the capture when it exceeds the drain budget so it cannot outlive dispose", async () => {
		process.env.OMP_AUTOLEARN_DRAIN_MS = "100";
		const order: string[] = [];
		const s = await createSession(() => order.push("session_shutdown"));
		let captureSignal: AbortSignal | undefined;
		const captureStarted = Promise.withResolvers<void>();
		const capturePromise = s.runAutolearnCapture(async signal => {
			captureSignal = signal;
			captureStarted.resolve();
			const aborted = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			await aborted.promise;
			order.push("capture-aborted");
		});
		await captureStarted.promise;

		const startedAt = performance.now();
		await s.dispose();
		// The gated capture never settles on its own; dispose must abort it at
		// the budget instead of awaiting it forever.
		expect(performance.now() - startedAt).toBeLessThan(5_000);
		expect(captureSignal?.aborted).toBe(true);
		await capturePromise;
		expect(order).toEqual(["capture-aborted", "session_shutdown"]);
	});

	it("returns from the drain immediately when no capture is in flight", async () => {
		// A full-minute budget armed: any accidental wait would blow the bound.
		process.env.OMP_AUTOLEARN_DRAIN_MS = "60000";
		const s = await createSession(() => {});
		const startedAt = performance.now();
		await s.dispose();
		expect(performance.now() - startedAt).toBeLessThan(5_000);
	});

	it("abort() still aborts an in-flight capture immediately", async () => {
		const s = await createSession(() => {});
		let captureSignal: AbortSignal | undefined;
		const captureStarted = Promise.withResolvers<void>();
		const capturePromise = s.runAutolearnCapture(async signal => {
			captureSignal = signal;
			captureStarted.resolve();
			const aborted = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			await aborted.promise;
		});
		await captureStarted.promise;

		const abortPromise = s.abort();
		expect(captureSignal?.aborted).toBe(true);
		await abortPromise;
		await capturePromise;
	});

	it("caps the drain on signal exits so session_shutdown still runs before the forced exit", async () => {
		// postmortem force-terminates the process 10s after cleanup starts, so a
		// signal-triggered dispose cannot honor a full drain budget: the process
		// would die mid-drain and session_shutdown (the collector's sweep/flush)
		// would never fire. The cap, not the env budget, must bound the wait.
		process.env.OMP_AUTOLEARN_DRAIN_MS = "60000";
		const order: string[] = [];
		const s = await createSession(() => order.push("session_shutdown"));
		let captureSignal: AbortSignal | undefined;
		const captureStarted = Promise.withResolvers<void>();
		const capturePromise = s.runAutolearnCapture(async signal => {
			captureSignal = signal;
			captureStarted.resolve();
			const aborted = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			await aborted.promise;
			order.push("capture-aborted");
		});
		await captureStarted.promise;

		const startedAt = performance.now();
		await s.dispose({ reason: postmortem.Reason.SIGTERM });
		const elapsedMs = performance.now() - startedAt;
		expect(elapsedMs).toBeLessThan(10_000);
		expect(captureSignal?.aborted).toBe(true);
		await capturePromise;
		expect(order).toEqual(["capture-aborted", "session_shutdown"]);
	}, 15_000);

	it("aborts an in-flight capture when the cwd rollback of a failed switch fails (no dispose will drain)", async () => {
		const sourceDir = TempDir.createSync("@pi-autolearn-rollback-source-");
		const targetDir = TempDir.createSync("@pi-autolearn-rollback-target-");
		const sourceManager = SessionManager.create(sourceDir.path(), sourceDir.path());
		const s = await createSession(() => {}, sourceManager);
		const targetManager = SessionManager.create(targetDir.path(), targetDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		await targetManager.close();
		expect(targetSessionFile).toBeString();

		let captureSignal: AbortSignal | undefined;
		let capturePromise: Promise<void> | undefined;
		let callbackCount = 0;
		const onCwdChange = async () => {
			const call = callbackCount++;
			if (call === 0) {
				// A capture starting in the switch's async gap survives the
				// switch's own abort(); the abandoned rollback must kill it.
				capturePromise = s.runAutolearnCapture(async signal => {
					captureSignal = signal;
					const aborted = Promise.withResolvers<void>();
					signal.addEventListener("abort", () => aborted.resolve(), { once: true });
					await aborted.promise;
				});
				throw new Error("settings reload failed");
			}
			throw new Error("cwd restore denied");
		};

		await expect(s.switchSession(targetSessionFile!, { onCwdChange })).rejects.toThrow(
			/settings reload failed.*cwd restore denied.*process may remain in/,
		);
		expect(captureSignal?.aborted).toBe(true);
		expect(s.isDisposed).toBe(true);
		await capturePromise;
		sourceDir.removeSync();
		targetDir.removeSync();
	});
});
