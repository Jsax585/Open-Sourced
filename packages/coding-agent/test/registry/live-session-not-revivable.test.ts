import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
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

describe("a session this process is running is not a revivable transcript", () => {
	let registry: AgentRegistry;
	let bus: IrcBus;
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
		revived = [];
		// Stands in for the real persisted reviver: records that a cold revive
		// was started for an id, which is the second agent loop this defect ran.
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

	it("keeps the running session out of the roster scan and still restores its parked siblings", async () => {
		using tempDir = TempDir.createSync("@omp-live-session-roster-");
		const tree = await buildTree(tempDir);
		await runLaneHere(tree.laneFile);

		await ensurePersistedRoster(registry, tree.laneFile);

		expect(registry.get("Lane")).toBeUndefined();
		expect(
			registry
				.list()
				.filter(ref => ref.sessionFile === tree.laneFile)
				.map(ref => ref.id),
		).toEqual([MAIN_AGENT_ID]);
		// A transcript nothing here writes is still restored as a revivable peer.
		expect(registry.get("Parked")).toMatchObject({ status: "parked", session: null, sessionFile: tree.parkedFile });
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

		expect(registry.get("Lane")).toBeUndefined();
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
		// The next scan drops the phantom instead of re-confirming it.
		await ensurePersistedRoster(registry, tree.laneFile);
		expect(registry.get("Lane")).toBeUndefined();
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
});
