import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager, type AgentReviver } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * A session that only records what was delivered to it: these tests are about
 * which session a message reaches, not what the agent does with it.
 */
interface FakeSession {
	session: AgentSession;
	delivered: IrcMessage[];
}

function makeFakeSession(): FakeSession {
	const delivered: IrcMessage[] = [];
	const session = {
		isStreaming: false,
		deliverIrcMessage: async (msg: IrcMessage) => {
			delivered.push(msg);
			return "injected" as const;
		},
		emitIrcRelayObservation: () => {},
		dispose: async () => {},
	};
	return { session: session as unknown as AgentSession, delivered };
}

/** A transcript a roster scan accepts: header, persisted contract, one turn. */
async function writeTranscript(sessionDir: string, name: string, cwd: string): Promise<string> {
	fs.mkdirSync(sessionDir, { recursive: true });
	const manager = SessionManager.create(cwd, sessionDir, new FileSessionStorage());
	await manager.ensureOnDisk();
	manager.appendSessionInit({ systemPrompt: ["lane prompt"], task: "lane task", tools: ["read"] });
	manager.appendMessage({ role: "user", content: "earlier work", timestamp: Date.now() });
	const created = manager.getSessionFile();
	if (!created) throw new Error("Expected a persisted session file");
	await manager.close();
	const target = path.join(sessionDir, `${name}.jsonl`);
	fs.renameSync(created, target);
	return target;
}

/**
 * Branch tips in a transcript: one writer leaves one, a second writer
 * appending beside it leaves two.
 */
async function leaves(sessionFile: string): Promise<number> {
	const entries = Bun.JSONL.parse(await Bun.file(sessionFile).text()) as Array<{ id?: string; parentId?: string }>;
	const tips = new Set(entries.flatMap(entry => (entry.id === undefined ? [] : [entry.id])));
	for (const entry of entries) {
		if (entry.parentId !== undefined) tips.delete(entry.parentId);
	}
	return tips.size;
}

function jsonlFilesIn(dir: string): string[] {
	return fs
		.readdirSync(dir)
		.filter(name => name.endsWith(".jsonl"))
		.sort();
}

/** The root transcript, the lane transcript inside its artifacts tree, and a parked sibling. */
interface Tree {
	dir: string;
	rootFile: string;
	laneFile: string;
	parkedFile: string;
}

async function buildTree(tempDir: TempDir): Promise<Tree> {
	const dir = tempDir.path();
	const rootFile = await writeTranscript(dir, "root", dir);
	const artifacts = path.join(dir, "root");
	const laneFile = await writeTranscript(artifacts, "Lane", dir);
	const parkedFile = await writeTranscript(artifacts, "Parked", dir);
	return { dir, rootFile, laneFile, parkedFile };
}

const SESSION_MANAGER_MODULE = path.join(import.meta.dir, "../../src/session/session-manager.ts");
const SESSION_STORAGE_MODULE = path.join(import.meta.dir, "../../src/session/session-storage.ts");

/**
 * A second omp process running one transcript as its own session: it opens the
 * journal and takes the writer claim, exactly as a pane resumed on that file
 * does, then holds both until it is told to exit. The lease it takes is the
 * only thing this process can see of it, which is the point.
 */
class HoldingProcess {
	readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;

	private constructor(child: Bun.Subprocess<"pipe", "pipe", "pipe">) {
		this.#child = child;
	}

	static async run(tempDir: TempDir, sessionFile: string): Promise<HoldingProcess> {
		const script = tempDir.join("holding-process.ts");
		await Bun.write(
			script,
			[
				`import { SessionManager } from ${JSON.stringify(SESSION_MANAGER_MODULE)};`,
				`import { FileSessionStorage } from ${JSON.stringify(SESSION_STORAGE_MODULE)};`,
				"const manager = await SessionManager.open(process.argv[2], process.argv[3], new FileSessionStorage(), {",
				"	suppressBreadcrumb: true,",
				"	throwIfMissing: true,",
				"});",
				"manager.claimForWriting();",
				'process.stdout.write("held\\n");',
				"for await (const line of console) {",
				'	if (line === "close") break;',
				"}",
				"await manager.close();",
			].join("\n"),
		);
		const child = Bun.spawn([process.execPath, script, sessionFile, path.dirname(sessionFile)], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			// The live `process.env` (Bun.spawn defaults to the launch env), so
			// the other process meets this test's private session-owner leases.
			env: process.env,
		});
		const holder = new HoldingProcess(child);
		const reader = child.stdout.getReader();
		const { done, value } = await reader.read();
		reader.releaseLock();
		if (done || !new TextDecoder().decode(value).startsWith("held")) {
			throw new Error(`The holding process never claimed the journal: ${await new Response(child.stderr).text()}`);
		}
		return holder;
	}

	async close(): Promise<void> {
		this.#child.stdin.write("close\n");
		this.#child.stdin.end();
		await this.#child.exited;
	}
}

describe("a session this process is running is not a revivable transcript", () => {
	let registry: AgentRegistry;
	let bus: IrcBus;
	let lifecycle: AgentLifecycleManager;
	let revived: string[];
	const openManagers: SessionManager[] = [];

	/**
	 * Run the lane transcript as this process's own session, the way
	 * `omp --resume <lane>.jsonl` does: open it, take the writer claim the way
	 * a session going live does (`createAgentSession`), and register it as the
	 * live main agent. It appends nothing — a restored pane nobody has typed
	 * into yet is the state this has to hold in.
	 */
	async function runLaneHere(laneFile: string): Promise<FakeSession> {
		const manager = await SessionManager.open(laneFile, path.dirname(laneFile), new FileSessionStorage(), {
			suppressBreadcrumb: true,
			throwIfMissing: true,
		});
		openManagers.push(manager);
		manager.claimForWriting();
		const main = makeFakeSession();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			session: main.session,
			sessionFile: laneFile,
		});
		return main;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
		bus = IrcBus.global();
		lifecycle = AgentLifecycleManager.global();
		revived = [];
		// Stands in for the real persisted reviver: records that a cold revive
		// was started for an id, which is the second agent loop this defect ran.
		lifecycle.setPersistedSubagentReviverFactory(
			async (ref: AgentRef) => {
				if (!ref.sessionFile) return undefined;
				const revive: AgentReviver = async () => {
					revived.push(ref.id);
					return makeFakeSession().session;
				};
				return revive;
			},
			() => 0,
		);
	});

	afterEach(async () => {
		for (const manager of openManagers.splice(0)) await manager.close();
		await AgentLifecycleManager.global().dispose();
	});

	it("keeps the running session out of the roster scan and still restores its parked siblings", async () => {
		using tempDir = TempDir.createSync("@omp-live-session-roster-");
		const tree = await buildTree(tempDir);
		await runLaneHere(tree.laneFile);

		await ensurePersistedRoster(registry, tree.laneFile);

		// One ref for one session: the roster lists it under the id it runs as.
		expect(registry.list().map(ref => ref.id)).toEqual([MAIN_AGENT_ID, "Parked"]);
		expect(
			registry
				.list()
				.filter(ref => ref.sessionFile === tree.laneFile)
				.map(ref => ref.id),
		).toEqual([MAIN_AGENT_ID]);
		// A transcript nothing here writes is still restored as a revivable peer.
		expect(registry.get("Parked")).toMatchObject({ status: "parked", session: null, sessionFile: tree.parkedFile });
	});

	it("resolves the running session's transcript name to it for messages, hub focus and task resume", async () => {
		using tempDir = TempDir.createSync("@omp-live-session-name-");
		const tree = await buildTree(tempDir);
		const main = await runLaneHere(tree.laneFile);
		const before = await leaves(tree.laneFile);
		await ensurePersistedRoster(registry, tree.laneFile);

		// The name a peer, the Agent Hub and a `task` resume all resolve.
		expect(registry.get("Lane")?.id).toBe(MAIN_AGENT_ID);
		// `task` resume (runSubagentFollowUpTurn) and Agent Hub focus both start
		// here, and answered `Unknown agent "Lane"` before this.
		expect(await lifecycle.ensureLive("Lane")).toBe(main.session);
		expect(revived).toEqual([]);
		// Agent Hub focus: the running session is the view, so focusing the name
		// it answers to returns to main instead of attaching a second view.
		const focus = new SessionFocusController({} as InteractiveModeContext, registry, () => lifecycle);
		await focus.focusAgent("Lane");
		expect(focus.focusedAgentId).toBeUndefined();
		// Nothing reopened the journal to get there.
		expect(await leaves(tree.laneFile)).toBe(before);
	});

	it("holds when a running session adopts the transcript through a session switch", async () => {
		using tempDir = TempDir.createSync("@omp-live-session-switch-");
		const tree = await buildTree(tempDir);
		const manager = await SessionManager.open(tree.rootFile, path.dirname(tree.rootFile), new FileSessionStorage(), {
			suppressBreadcrumb: true,
			throwIfMissing: true,
		});
		openManagers.push(manager);
		manager.claimForWriting();
		// `switchSession` — the extension API, RPC `switch_session`, ACP load —
		// hands this running loop another transcript, with nothing written yet.
		await manager.setSessionFile(tree.laneFile);
		const main = makeFakeSession();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			session: main.session,
			sessionFile: tree.laneFile,
		});

		await ensurePersistedRoster(registry, tree.laneFile);
		const receipt = await bus.send({ from: "Worker", to: "Lane", body: "ping" });

		expect(registry.get("Lane")?.id).toBe(MAIN_AGENT_ID);
		expect(receipt.outcome).toBe("injected");
		expect(main.delivered.map(msg => msg.body)).toEqual(["ping"]);
		expect(revived).toEqual([]);
	});

	it("delivers a worker's message for the running session to it instead of reviving a second loop", async () => {
		using tempDir = TempDir.createSync("@omp-live-session-send-");
		const tree = await buildTree(tempDir);
		const main = await runLaneHere(tree.laneFile);
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: makeFakeSession().session,
			sessionFile: path.join(tree.dir, "root", "Worker.jsonl"),
		});
		await ensurePersistedRoster(registry, tree.laneFile);
		const before = await leaves(tree.laneFile);

		const receipt = await bus.send({ from: "Worker", to: "Lane", body: "status?" });

		expect(receipt.outcome).toBe("injected");
		expect(receipt.to).toBe(MAIN_AGENT_ID);
		expect(main.delivered.map(msg => msg.body)).toEqual(["status?"]);
		expect(revived).toEqual([]);
		expect(await leaves(tree.laneFile)).toBe(before);
		expect(jsonlFilesIn(path.join(tree.dir, "root"))).toEqual(["Lane.jsonl", "Parked.jsonl"]);
	});

	it("refuses the running session's own message to its transcript name", async () => {
		using tempDir = TempDir.createSync("@omp-live-session-self-send-");
		const tree = await buildTree(tempDir);
		const main = await runLaneHere(tree.laneFile);
		await ensurePersistedRoster(registry, tree.laneFile);

		const receipt = await bus.send({ from: MAIN_AGENT_ID, to: "Lane", body: "hello me" });

		expect(receipt).toMatchObject({ to: "Lane", outcome: "failed" });
		expect(receipt.error).toContain("own transcript");
		expect(main.delivered).toEqual([]);
		expect(revived).toEqual([]);
	});

	it("routes to the running session even when a ref for its transcript is already registered", async () => {
		using tempDir = TempDir.createSync("@omp-live-session-stale-ref-");
		const tree = await buildTree(tempDir);
		const main = await runLaneHere(tree.laneFile);
		// What a scan that ran before this process took the journal leaves
		// behind, and what re-registration after a kill recreates.
		registry.register({
			id: "Lane",
			displayName: "Lane",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: tree.laneFile,
			status: "parked",
		});
		const before = await leaves(tree.laneFile);

		const receipt = await bus.send({ from: "Worker", to: "Lane", body: "ping" });

		expect(receipt.outcome).toBe("injected");
		expect(main.delivered.map(msg => msg.body)).toEqual(["ping"]);
		expect(revived).toEqual([]);
		expect(await leaves(tree.laneFile)).toBe(before);
		// Reaching the live session repairs the registry: the dead ref is gone
		// and the name answers for the agent that received the message.
		expect(registry.list().map(ref => ref.id)).toEqual([MAIN_AGENT_ID]);
		expect(registry.get("Lane")?.id).toBe(MAIN_AGENT_ID);
	});

	it("still revives a parked subagent no session here is running", async () => {
		using tempDir = TempDir.createSync("@omp-live-session-other-");
		const tree = await buildTree(tempDir);
		await runLaneHere(tree.laneFile);
		await ensurePersistedRoster(registry, tree.laneFile);

		const receipt = await bus.send({ from: "Worker", to: "Parked", body: "resume" });

		expect(receipt.outcome).toBe("revived");
		expect(revived).toEqual(["Parked"]);
	});

	it("offers no copy of a running session's transcript, and says what to do with it", async () => {
		using tempDir = TempDir.createSync("@omp-live-session-copy-");
		const tree = await buildTree(tempDir);
		await runLaneHere(tree.laneFile);
		// A plain copy of a live transcript carries its session id, so a second
		// loop on it would be a second loop under that id.
		const copyFile = path.join(tree.dir, "root", "Copy.jsonl");
		fs.copyFileSync(tree.laneFile, copyFile);

		await ensurePersistedRoster(registry, tree.laneFile);
		const receipt = await bus.send({ from: "Worker", to: "Copy", body: "resume" });

		expect(registry.get("Copy")).toBeUndefined();
		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toContain("copy of the transcript this session is running");
		expect(receipt.error).toContain(`omp --resume ${copyFile}`);
		expect(revived).toEqual([]);
	});

	it("restores the copy once the session that held its id has closed", async () => {
		using tempDir = TempDir.createSync("@omp-live-session-copy-free-");
		const tree = await buildTree(tempDir);
		await runLaneHere(tree.laneFile);
		const copyFile = path.join(tree.dir, "root", "Copy.jsonl");
		fs.copyFileSync(tree.laneFile, copyFile);
		await ensurePersistedRoster(registry, tree.laneFile);
		expect(registry.get("Copy")).toBeUndefined();

		for (const manager of openManagers.splice(0)) await manager.close();
		registry.unregister(MAIN_AGENT_ID);
		await ensurePersistedRoster(registry, tree.laneFile);

		expect(registry.get("Copy")).toMatchObject({ status: "parked", session: null, sessionFile: copyFile });
	});

	/**
	 * What a cold revive does to the journal before its session exists:
	 * `createAgentSession` opens the transcript and claims it as its writer,
	 * and only then attaches the session to the ref. A liveness probe during
	 * that window sees a claimed journal with no live ref behind it, which is
	 * this process's own revive, not a foreign session.
	 */
	function gatedReviver(sessionFile: string): { started: Promise<void>; release: () => void; sessions: number } {
		const started = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const state = { started: started.promise, release: () => gate.resolve(), sessions: 0 };
		lifecycle.setPersistedSubagentReviverFactory(
			async (ref: AgentRef) => {
				if (ref.sessionFile !== sessionFile) return undefined;
				const revive: AgentReviver = async () => {
					const manager = await SessionManager.open(
						sessionFile,
						path.dirname(sessionFile),
						new FileSessionStorage(),
						{
							suppressBreadcrumb: true,
							throwIfMissing: true,
						},
					);
					openManagers.push(manager);
					manager.claimForWriting();
					started.resolve();
					await gate.promise;
					state.sessions++;
					revived.push(ref.id);
					return makeFakeSession().session;
				};
				return revive;
			},
			() => 0,
		);
		return state;
	}

	it("joins a revive in flight instead of reading its claim as a live session", async () => {
		using tempDir = TempDir.createSync("@omp-live-session-revive-race-");
		const tree = await buildTree(tempDir);
		await runLaneHere(tree.laneFile);
		await ensurePersistedRoster(registry, tree.laneFile);
		const reviver = gatedReviver(tree.parkedFile);

		const first = lifecycle.ensureLive("Parked");
		await reviver.started;
		const second = lifecycle.ensureLive("Parked");
		reviver.release();

		expect(await second).toBe(await first);
		expect(reviver.sessions).toBe(1);
		expect(revived).toEqual(["Parked"]);
	});

	it("leaves a ref alone while this process is opening its transcript", async () => {
		using tempDir = TempDir.createSync("@omp-live-session-scan-race-");
		const tree = await buildTree(tempDir);
		await runLaneHere(tree.laneFile);
		await ensurePersistedRoster(registry, tree.laneFile);
		const parked = registry.get("Parked");
		const reviver = gatedReviver(tree.parkedFile);

		const revive = lifecycle.ensureLive("Parked");
		await reviver.started;
		// A peer send mid-revive re-scans the tree; the ref being revived must
		// survive it, or the revive fails and the agent disappears.
		await ensurePersistedRoster(registry, tree.laneFile);
		expect(registry.get("Parked")).toBe(parked);
		reviver.release();

		expect(await revive).toBeTruthy();
		expect(registry.get("Parked")?.session).toBeTruthy();
	});

	it("neither suppresses nor re-registers a subagent running in this process", async () => {
		using tempDir = TempDir.createSync("@omp-live-session-live-sub-");
		const tree = await buildTree(tempDir);
		await runLaneHere(tree.laneFile);
		// A spawned subagent of this process: its own ref, its own journal,
		// claimed by the loop that writes it.
		const manager = await SessionManager.open(
			tree.parkedFile,
			path.dirname(tree.parkedFile),
			new FileSessionStorage(),
			{
				suppressBreadcrumb: true,
				throwIfMissing: true,
			},
		);
		openManagers.push(manager);
		manager.claimForWriting();
		const worker = registry.register({
			id: "Parked",
			displayName: "Parked",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: makeFakeSession().session,
			sessionFile: tree.parkedFile,
			status: "running",
		});

		await ensurePersistedRoster(registry, tree.laneFile);
		await ensurePersistedRoster(registry, tree.laneFile);

		expect(registry.get("Parked")).toBe(worker);
		expect(registry.get("Parked")?.status).toBe("running");
		// It is a live agent, not a refused transcript: a message reaches it.
		const receipt = await bus.send({ from: MAIN_AGENT_ID, to: "Parked", body: "ping" });
		expect(receipt.outcome).toBe("injected");
		expect(revived).toEqual([]);
	});
});

describe("a session another omp process is running is not a revivable transcript", () => {
	let registry: AgentRegistry;
	let bus: IrcBus;
	let revived: string[];
	const openManagers: SessionManager[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
		bus = IrcBus.global();
		revived = [];
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			async (ref: AgentRef) => {
				if (!ref.sessionFile) return undefined;
				const revive: AgentReviver = async () => {
					revived.push(ref.id);
					return makeFakeSession().session;
				};
				return revive;
			},
			() => 0,
		);
	});

	afterEach(async () => {
		for (const manager of openManagers.splice(0)) await manager.close();
		await AgentLifecycleManager.global().dispose();
	});

	/** This process is one pane of the tree; the holding process is another. */
	async function runSiblingPaneHere(sessionFile: string): Promise<FakeSession> {
		const manager = await SessionManager.open(sessionFile, path.dirname(sessionFile), new FileSessionStorage(), {
			suppressBreadcrumb: true,
			throwIfMissing: true,
		});
		openManagers.push(manager);
		manager.claimForWriting();
		const main = makeFakeSession();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			session: main.session,
			sessionFile,
		});
		return main;
	}

	it("leaves a live pane's transcript out of a second process's roster and refuses to revive it", async () => {
		using tempDir = TempDir.createSync("@omp-cross-process-live-");
		const tree = await buildTree(tempDir);
		const holder = await HoldingProcess.run(tempDir, tree.laneFile);
		try {
			await runSiblingPaneHere(tree.parkedFile);
			const before = await leaves(tree.laneFile);

			await ensurePersistedRoster(registry, tree.parkedFile);
			const receipt = await bus.send({ from: MAIN_AGENT_ID, to: "Lane", body: "status?" });

			expect(registry.get("Lane")).toBeUndefined();
			expect(receipt.outcome).toBe("failed");
			expect(receipt.error).toContain("another omp process is running");
			expect(revived).toEqual([]);
			// No clone of the running agent, by any name: nothing opened that
			// journal and nothing was diverted to a sibling file beside it.
			expect(await leaves(tree.laneFile)).toBe(before);
			expect(jsonlFilesIn(path.join(tree.dir, "root"))).toEqual(["Lane.jsonl", "Parked.jsonl"]);
		} finally {
			await holder.close();
		}
	}, 30_000);

	it("restores that transcript once the process running it exits", async () => {
		using tempDir = TempDir.createSync("@omp-cross-process-exited-");
		const tree = await buildTree(tempDir);
		const holder = await HoldingProcess.run(tempDir, tree.laneFile);
		await runSiblingPaneHere(tree.parkedFile);
		await ensurePersistedRoster(registry, tree.parkedFile);
		expect(registry.get("Lane")).toBeUndefined();

		await holder.close();
		await ensurePersistedRoster(registry, tree.parkedFile);

		expect(registry.get("Lane")).toMatchObject({ status: "parked", session: null, sessionFile: tree.laneFile });
		const receipt = await bus.send({ from: MAIN_AGENT_ID, to: "Lane", body: "resume" });
		expect(receipt.outcome).toBe("revived");
		expect(revived).toEqual(["Lane"]);
	}, 30_000);
});
