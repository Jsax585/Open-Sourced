import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("AgentSession auto-learn pass across dispose", () => {
	let tempDir: string;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-autolearn-settle-"));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		await removeWithRetries(tempDir);
	});

	async function createSession(): Promise<AgentSession> {
		authStorage = await AuthStorage.create(":memory:");
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
					systemPrompt: ["Test"],
					tools: [],
				},
				streamFn: createMockModel({ handler: () => ({ content: ["reply"] }) }).stream,
			}),
			sessionManager: SessionManager.create(tempDir, path.join(tempDir, "sessions")),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
		});
		return session;
	}

	/** Starts a pass that reports whether it was aborted and only finishes on `gate`. */
	function startPass(live: AgentSession, settle: boolean) {
		const gate = Promise.withResolvers<void>();
		let aborted = false;
		const run = live.runAutolearnCapture(
			async signal => {
				if (signal.aborted) aborted = true;
				else signal.addEventListener("abort", () => (aborted = true));
				await gate.promise;
				return true;
			},
			{ settle },
		);
		return { run, gate, aborted: () => aborted };
	}

	it("lets a settle pass finish on a one-shot dispose instead of aborting it", async () => {
		const live = await createSession();
		const { run, gate, aborted } = startPass(live, true);

		// `omp -p`/JSON prints its answer and disposes immediately; the pass must
		// still be given its budget rather than cancelled on the way out.
		const disposing = live.dispose({ awaitAutolearnSettle: true });
		await new Promise(resolve => setTimeout(resolve, 25));
		expect(aborted()).toBe(false);

		gate.resolve();
		await disposing;
		expect(await run).toBe(true);
		expect(aborted()).toBe(false);
	});

	it("still aborts a settle pass on an interactive or signal teardown", async () => {
		const live = await createSession();
		const { run, gate, aborted } = startPass(live, true);

		const disposing = live.dispose();
		expect(aborted()).toBe(true);
		gate.resolve();
		expect(await run).toBe(true);
		await disposing;
	});

	it("still aborts a mid-turn capture pass on a one-shot dispose", async () => {
		const live = await createSession();
		const run = live.runAutolearnCapture(async signal => {
			await new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("aborted")));
			});
			return true;
		});

		const disposing = live.dispose({ awaitAutolearnSettle: true });
		// The cancelled pass reports that it never ran, so its stop is not billed
		// as a paid request.
		expect(await run).toBe(false);
		await disposing;
	});

	it("reports a pass as not started while another one is in flight", async () => {
		const live = await createSession();
		const gate = Promise.withResolvers<void>();
		const first = live.runAutolearnCapture(async () => {
			await gate.promise;
			return true;
		});
		expect(await live.runAutolearnCapture(async () => true)).toBe(false);
		gate.resolve();
		expect(await first).toBe(true);
	});
});
