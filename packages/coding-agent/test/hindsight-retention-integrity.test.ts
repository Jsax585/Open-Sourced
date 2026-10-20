import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { computeBankScope } from "@oh-my-pi/pi-coding-agent/hindsight/bank";
import type { HindsightConfig, HindsightScoping } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import { extractEntryMessages } from "@oh-my-pi/pi-coding-agent/hindsight/transcript";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { asGlobalFetch } from "./helpers/fetch-mock";

interface RetainedItem {
	content: string;
	document_id: string;
	tags?: string[];
	update_mode?: string;
	metadata: Record<string, string>;
}

interface StoredDocument {
	bankId: string;
	item: RetainedItem;
}

interface RecordedRequest {
	method: string;
	bankId: string;
	documentId?: string;
	item?: RetainedItem;
}

const SCOPINGS = ["per-project-tagged", "per-project"] as const satisfies readonly HindsightScoping[];
type ProjectScoping = (typeof SCOPINGS)[number];

const dirs: TempDir[] = [];
const managers: SessionManager[] = [];
const states: HindsightSessionState[] = [];

afterEach(async () => {
	for (const state of states.splice(0)) state.dispose();
	for (const manager of managers.splice(0)) await manager.close();
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) await dir.remove();
});

// Recall, mental models, and seeding stay off so every request observed here is retention traffic.
const config: HindsightConfig = {
	hindsightApiUrl: "http://retention.test",
	hindsightApiToken: null,
	bankId: "personal",
	bankIdPrefix: "",
	scoping: "per-project-tagged",
	bankMission: "",
	retainMission: null,
	autoRecall: false,
	autoRetain: true,
	retainMode: "full-session",
	retainEveryNTurns: 2,
	retainOverlapTurns: 1,
	retainContext: "omp",
	recallBudget: "mid",
	recallMaxTokens: 1024,
	recallTypes: [],
	recallContextTurns: 1,
	recallMaxQueryChars: 800,
	recallPromptPreamble: "",
	debug: false,
	requestTimeoutMs: 30000,
	reflectTimeoutMs: 30000,
	recallTimeoutMs: 30000,
	retainTimeoutMs: 30000,
	mentalModelsEnabled: false,
	mentalModelAutoSeed: false,
	mentalModelMaxRenderChars: 16000,
};

/** Literal bank/tag ownership a project label must map to; deliberately not derived from `computeBankScope`. */
function expectedScope(scoping: ProjectScoping, label: string): { bankId: string; tags?: string[] } {
	return scoping === "per-project"
		? { bankId: `personal-${label}`, tags: undefined }
		: { bankId: "personal", tags: [`project:${label}`] };
}

function expectOwnedBy(document: StoredDocument, scoping: ProjectScoping, label: string): void {
	const scope = expectedScope(scoping, label);
	expect(document.bankId).toBe(scope.bankId);
	expect(document.item.tags).toEqual(scope.tags);
}

/** Fake Hindsight document store keyed by `(bankId, documentId)`, behind a per-test `fetch` spy. */
function transport() {
	const store = new Map<string, StoredDocument>();
	const requests: RecordedRequest[] = [];
	const key = (bankId: string, documentId: string) => `${bankId}\u0000${documentId}`;
	let failRetain = false;
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch((input, init) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const method = init?.method ?? "GET";
			// /v1/default/banks/{bank}[/memories | /documents/{document}]
			const [, , , , bank, resource, document] = url.pathname.split("/");
			const bankId = decodeURIComponent(bank ?? "");
			if (method === "POST" && resource === "memories" && document === undefined) {
				const body: { items: RetainedItem[] } = JSON.parse(String(init?.body));
				const item = body.items[0]!;
				requests.push({ method, bankId, documentId: item.document_id, item });
				if (failRetain) return new Response("retention unavailable", { status: 503 });
				store.set(key(bankId, item.document_id), { bankId, item });
			} else if (method === "DELETE" && resource === "documents" && document !== undefined) {
				const documentId = decodeURIComponent(document);
				requests.push({ method, bankId, documentId });
				store.delete(key(bankId, documentId));
			} else {
				requests.push({ method, bankId });
			}
			return new Response("{}", { status: 200 });
		}),
	);
	return {
		requests,
		documents(): StoredDocument[] {
			return [...store.values()];
		},
		get(bankId: string, documentId: string): StoredDocument | undefined {
			return store.get(key(bankId, documentId));
		},
		/** The single stored document whose source contains `text`. */
		find(text: string): StoredDocument {
			const matches = [...store.values()].filter(document => document.item.content.includes(text));
			expect(matches).toHaveLength(1);
			return matches[0]!;
		},
		fail() {
			failRetain = true;
		},
		recover() {
			failRetain = false;
		},
	};
}

function temporaryRoot(): string {
	const dir = TempDir.createSync("@retention-integrity-");
	dirs.push(dir);
	return dir.path();
}

function stateFor(manager: SessionManager, overrides: Partial<HindsightConfig> = {}): HindsightSessionState {
	const resolved = { ...config, ...overrides };
	const scope = computeBankScope(resolved, manager.getCwd());
	const session = {
		sessionManager: manager,
		getHindsightSessionState: () => state,
	} as unknown as AgentSession;
	const state = new HindsightSessionState({
		sessionId: manager.getSessionId(),
		client: new HindsightApi({ baseUrl: config.hindsightApiUrl! }),
		...scope,
		config: resolved,
		session,
		banksSet: new Set([scope.bankId]),
	});
	state.bindRetentionScope();
	states.push(state);
	return state;
}

function turn(manager: SessionManager, user: string, reply: string): string {
	manager.appendMessage({ role: "user", content: user, timestamp: Date.now() });
	return manager.appendMessage(createAssistantMessage(reply));
}

function inMemory(cwd: string): SessionManager {
	const manager = SessionManager.inMemory(cwd);
	managers.push(manager);
	return manager;
}

/**
 * Write the checkout metadata used by native project discovery, matching git-active-context fixtures.
 * Scope detection only reads HEAD and gitdir/commondir pointers; no commits or Git process are needed.
 */
async function createLinkedWorktree(root: string): Promise<{ repo: string; worktree: string }> {
	const repo = path.join(root, "repo");
	const worktree = path.join(root, "worktree");
	const commonDir = path.join(repo, ".git");
	const gitDir = path.join(commonDir, "worktrees", "worktree");
	await fs.mkdir(gitDir, { recursive: true });
	await fs.mkdir(worktree);
	await Bun.write(path.join(commonDir, "HEAD"), "ref: refs/heads/main\n");
	await Bun.write(path.join(gitDir, "HEAD"), "ref: refs/heads/feature\n");
	await Bun.write(path.join(gitDir, "commondir"), `${path.relative(gitDir, commonDir)}\n`);
	await Bun.write(path.join(worktree, ".git"), `gitdir: ${path.relative(worktree, gitDir)}\n`);
	return { repo, worktree };
}

describe("Hindsight retained-source integrity", () => {
	it("replaces abandoned sources after a rewind without another user turn and does not resend unchanged history", async () => {
		const api = transport();
		const manager = inMemory("/project-a");
		const state = stateFor(manager);
		const durableId = manager.getSessionId();
		const kept = turn(manager, "Keep the first requirement", "Keep the first answer");
		turn(manager, "Abandon the later requirement", "Abandon the later answer");
		await state.maybeRetainOnAgentEnd();
		expect(api.get("personal", durableId)?.item.content).toContain("Abandon the later answer");

		const beforeUnchanged = api.requests.length;
		await state.maybeRetainOnAgentEnd();
		expect(api.requests).toHaveLength(beforeUnchanged);

		manager.branch(kept);
		const selected = extractEntryMessages(manager.getBranch());
		expect(selected.filter(message => message.role === "user")).toHaveLength(1);
		expect(selected.some(message => message.content.includes("Abandon"))).toBe(false);

		const beforeSync = api.requests.length;
		await state.synchronizeRetainedBranch();
		const replacement = api.requests.slice(beforeSync).filter(request => request.method === "POST");
		expect(replacement).toHaveLength(1);
		expect(replacement[0]!.documentId).toBe(durableId);
		expect(replacement[0]!.item?.update_mode).toBe("replace");
		expect(api.documents()).toHaveLength(1);
		const retained = api.get("personal", durableId)!;
		expect(retained.item.content).toContain("Keep the first answer");
		expect(retained.item.content).not.toContain("Abandon");
		expect(state.lastRetainedTurn).toBe(1);

		const synchronized = api.requests.length;
		await state.synchronizeRetainedBranch();
		expect(api.requests).toHaveLength(synchronized);
	});

	it("restores a deleted full-session source when its original leaf is selected again", async () => {
		const api = transport();
		const manager = inMemory("/project-a");
		const state = stateFor(manager);
		const leaf = turn(manager, "Original retained request", "Original retained answer");
		await state.forceRetainCurrentSession();
		const original = api.documents()[0]!;

		manager.resetLeaf();
		await state.synchronizeRetainedBranch();
		expect(api.documents()).toHaveLength(0);
		manager.branch(leaf);
		await state.synchronizeRetainedBranch();

		expect(api.requests.map(request => request.method)).toEqual(["POST", "DELETE", "POST"]);
		expect(api.requests[2]!.documentId).toBe(original.item.document_id);
		expect(api.requests[2]!.item?.update_mode).toBe("replace");
		expect(api.documents()).toEqual([original]);
		expect(api.documents()[0]!.item.content).toContain("Original retained request");
		expect(api.documents()[0]!.item.content).toContain("Original retained answer");

		await state.synchronizeRetainedBranch();
		expect(api.requests).toHaveLength(3);
	});

	it.each([false, true])(
		"restores a previously retained longer prefix after shortening it (empty intermediate: %s) without new turns",
		async emptyIntermediate => {
			const api = transport();
			const manager = inMemory("/project-a");
			const state = stateFor(manager);
			const shorter = turn(manager, "First retained request", "First retained answer");
			const longer = turn(manager, "Retained suffix request", "Retained suffix answer");
			await state.forceRetainCurrentSession();
			const original = api.documents()[0]!;

			manager.branch(shorter);
			await state.synchronizeRetainedBranch();
			expect(api.documents()[0]!.item.content).not.toContain("Retained suffix");
			if (emptyIntermediate) {
				manager.resetLeaf();
				await state.synchronizeRetainedBranch();
				expect(api.documents()).toHaveLength(0);
			}
			manager.branch(longer);
			turn(manager, "Unretained new request", "Unretained new answer");
			const beforeRestore = api.requests.length;
			await state.synchronizeRetainedBranch();

			expect(api.requests.slice(beforeRestore).map(request => request.method)).toEqual(["POST"]);
			expect(api.documents()).toEqual([original]);
			expect(api.documents()[0]!.item.content).not.toContain("Unretained");
			const restored = api.requests.length;
			await state.synchronizeRetainedBranch();
			expect(api.requests).toHaveLength(restored);
		},
	);

	it("retries a last-turn replacement after its invalidated source was deleted and POST failed", async () => {
		const api = transport();
		const manager = inMemory("/project-a");
		const state = stateFor(manager, { retainMode: "last-turn" });
		const kept = turn(manager, "Selected request", "Selected answer");
		turn(manager, "Abandoned request", "Abandoned answer");
		await state.forceRetainCurrentSession();
		manager.branch(kept);
		api.fail();
		await state.maybeRetainOnAgentEnd();
		expect(api.documents()).toHaveLength(0);
		expect(api.requests.map(request => request.method)).toEqual(["POST", "DELETE", "POST"]);

		api.recover();
		await state.synchronizeRetainedBranch();
		expect(api.documents()).toHaveLength(1);
		expect(api.documents()[0]!.item.content).toContain("Selected answer");
		expect(api.documents()[0]!.item.content).not.toContain("Abandoned");
		const repaired = api.requests.length;
		await state.synchronizeRetainedBranch();
		expect(api.requests).toHaveLength(repaired);
	});

	it("restores a deleted last-turn window with the same source id", async () => {
		const api = transport();
		const manager = inMemory("/project-a");
		const state = stateFor(manager, { retainMode: "last-turn" });
		const leaf = turn(manager, "Window request", "Window answer");
		await state.forceRetainCurrentSession();
		const original = api.documents()[0]!;
		manager.resetLeaf();
		await state.synchronizeRetainedBranch();
		manager.branch(leaf);
		await state.synchronizeRetainedBranch();

		expect(api.requests.map(request => request.method)).toEqual(["POST", "DELETE", "POST"]);
		expect(api.requests[2]!.documentId).toBe(original.item.document_id);
		expect(api.requests[2]!.item?.update_mode).toBe("replace");
		expect(api.documents()).toEqual([original]);
		await state.synchronizeRetainedBranch();
		expect(api.requests).toHaveLength(3);
	});

	it("does not restore a deleted source automatically while auto-retain is disabled", async () => {
		const api = transport();
		const manager = inMemory("/project-a");
		const state = stateFor(manager);
		const leaf = turn(manager, "Previously retained request", "Previously retained answer");
		await state.forceRetainCurrentSession();
		manager.resetLeaf();
		await state.synchronizeRetainedBranch();
		state.config.autoRetain = false;
		manager.branch(leaf);

		await state.synchronizeRetainedBranch();
		await state.maybeRetainOnAgentEnd();
		await state.finishRetentionScope();
		await state.prepareForCwdMove("/project-b");
		expect(api.requests.map(request => request.method)).toEqual(["POST", "DELETE"]);
		expect(api.documents()).toHaveLength(0);
	});

	it("branch synchronization restores only previously retained content, not new turns", async () => {
		const api = transport();
		const manager = inMemory("/project-a");
		const state = stateFor(manager, { retainEveryNTurns: 1 });
		const leaf = turn(manager, "Original request", "Original answer");
		await state.maybeRetainOnAgentEnd();
		const original = api.documents()[0]!;
		manager.resetLeaf();
		await state.synchronizeRetainedBranch();
		turn(manager, "Genuinely new branch", "Genuinely new answer");
		await state.synchronizeRetainedBranch();
		expect(api.requests.map(request => request.method)).toEqual(["POST", "DELETE"]);

		manager.branch(leaf);
		turn(manager, "Unretained follow-up", "Unretained follow-up answer");
		await state.synchronizeRetainedBranch();
		expect(api.requests.map(request => request.method)).toEqual(["POST", "DELETE", "POST"]);
		expect(api.documents()).toEqual([original]);
		expect(api.documents()[0]!.item.content).not.toContain("Unretained");
	});

	it("last-turn rewinds delete later windows without duplicating a surviving selected prefix", async () => {
		const api = transport();
		const manager = inMemory("/project-a");
		const state = stateFor(manager, { retainMode: "last-turn" });
		turn(manager, "First request", "First answer");
		const kept = turn(manager, "Second request", "Second answer");
		await state.maybeRetainOnAgentEnd();
		const survivor = api.documents()[0]!;
		turn(manager, "Third request", "Third answer");
		await state.forceRetainCurrentSession();
		const laterId = api.requests[1]!.documentId;

		manager.branch(kept);
		await state.synchronizeRetainedBranch();

		expect(api.requests.map(request => request.method)).toEqual(["POST", "POST", "DELETE"]);
		expect(api.requests[2]!.documentId).toBe(laterId);
		expect(api.documents()).toEqual([survivor]);
		await state.synchronizeRetainedBranch();
		expect(api.requests).toHaveLength(3);
	});

	it("last-turn rewinds still replace an invalidated window when a survivor covers only part of the prefix", async () => {
		const api = transport();
		const manager = inMemory("/project-a");
		const state = stateFor(manager, { retainMode: "last-turn" });
		turn(manager, "First request", "First answer");
		turn(manager, "Second request", "Second answer");
		await state.maybeRetainOnAgentEnd();
		const survivor = api.documents()[0]!;
		const kept = turn(manager, "Uncovered third request", "Uncovered third answer");
		turn(manager, "Abandoned fourth request", "Abandoned fourth answer");
		await state.maybeRetainOnAgentEnd();
		const laterId = api.requests[1]!.documentId;

		manager.branch(kept);
		await state.synchronizeRetainedBranch();

		expect(api.requests.map(request => request.method)).toEqual(["POST", "POST", "DELETE", "POST"]);
		expect(api.requests[2]!.documentId).toBe(laterId);
		expect(api.get("personal", survivor.item.document_id)).toEqual(survivor);
		expect(api.documents()).toHaveLength(2);
		expect(api.requests[3]!.item?.content).toContain("Uncovered third answer");
		expect(api.requests[3]!.item?.content).not.toContain("Abandoned fourth");
		await state.synchronizeRetainedBranch();
		expect(api.requests).toHaveLength(4);
	});

	it("read-only automatic retention neither uploads nor deletes while explicit enqueue remains available", async () => {
		const api = transport();
		const manager = inMemory("/project-a");
		const state = stateFor(manager, { autoRetain: false });
		turn(manager, "Private read-only request", "Private read-only reply");
		await state.prepareForCwdMove("/project-b");
		await state.finishRetentionScope();
		await state.synchronizeRetainedBranch();
		await state.maybeRetainOnAgentEnd();
		expect(api.requests).toHaveLength(0);

		await state.forceRetainCurrentSession();
		expect(api.get("personal", manager.getSessionId())?.item.content).toContain("Private read-only reply");

		const explicitRequests = api.requests.length;
		manager.resetLeaf();
		await state.prepareForCwdMove("/project-b");
		await state.finishRetentionScope();
		await state.synchronizeRetainedBranch();
		await state.maybeRetainOnAgentEnd();
		expect(api.requests).toHaveLength(explicitRequests);
		expect(api.get("personal", manager.getSessionId())?.item.content).toContain("Private read-only reply");
	});

	it("replaces an abandoned assistant reply at the same user-turn count without waiting for cadence", async () => {
		const api = transport();
		const manager = inMemory("/project-a");
		const state = stateFor(manager);
		const user = manager.appendMessage({ role: "user", content: "One unchanged request", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("Abandoned assistant reply"));
		await state.forceRetainCurrentSession();

		manager.branch(user);
		manager.appendMessage(createAssistantMessage("Selected replacement reply"));
		expect(extractEntryMessages(manager.getBranch()).filter(message => message.role === "user")).toHaveLength(1);
		await state.maybeRetainOnAgentEnd();

		expect(api.documents()).toHaveLength(1);
		const retained = api.get("personal", manager.getSessionId())!;
		expect(retained.item.content).toContain("Selected replacement reply");
		expect(retained.item.content).not.toContain("Abandoned assistant reply");
		expect(state.lastRetainedTurn).toBe(1);
	});

	it("provider identity changes do not change the durable retained document or provenance", async () => {
		const api = transport();
		const manager = inMemory("/project-a");
		const state = stateFor(manager);
		const durableId = manager.getSessionId();
		turn(manager, "Stable source request", "Stable source reply");
		await state.forceRetainCurrentSession();
		state.setSessionId("new-provider-routing-id");
		turn(manager, "Same source follow-up", "Same source follow-up reply");
		await state.forceRetainCurrentSession();

		expect(api.documents()).toHaveLength(1);
		const retained = api.get("personal", durableId)!;
		expect(retained.item.content).toContain("Stable source reply");
		expect(retained.item.content).toContain("Same source follow-up reply");
		expect(retained.item.metadata.session_id).toBe(durableId);
		expect(retained.item.metadata.segment_id).toBe(durableId);
		expect(api.requests.some(request => request.documentId?.includes("new-provider-routing-id"))).toBe(false);
	});

	describe.each([...SCOPINGS])("with %s scoping", scoping => {
		const scoped = (overrides: Partial<HindsightConfig> = {}): Partial<HindsightConfig> => ({
			scoping,
			...overrides,
		});

		it.each([
			["full-session", 1],
			["last-turn", 2],
		] as const)(
			"deletes every derived %s document after rewinding the retained branch to empty",
			async (retainMode, documentCount) => {
				const api = transport();
				const manager = inMemory("/project-a");
				const state = stateFor(manager, scoped({ retainMode }));
				const owner = expectedScope(scoping, "project-a");
				turn(manager, "First source", "First answer");
				await state.forceRetainCurrentSession();
				turn(manager, "Second source", "Second answer");
				await state.forceRetainCurrentSession();
				const retained = api.documents();
				expect(retained).toHaveLength(documentCount);
				for (const document of retained) expectOwnedBy(document, scoping, "project-a");

				manager.resetLeaf();
				const beforeSync = api.requests.length;
				await state.synchronizeRetainedBranch();
				const issued = api.requests.slice(beforeSync);
				expect(issued.filter(request => request.method === "POST")).toHaveLength(0);
				const deletions = issued.filter(request => request.method === "DELETE");
				expect(deletions.map(request => request.documentId).sort()).toEqual(
					retained.map(document => document.item.document_id).sort(),
				);
				for (const deletion of deletions) expect(deletion.bankId).toBe(owner.bankId);
				expect(api.documents()).toHaveLength(0);
				expect(extractEntryMessages(manager.getBranch())).toHaveLength(0);

				const synchronized = api.requests.length;
				await state.synchronizeRetainedBranch();
				expect(api.requests).toHaveLength(synchronized);
			},
		);

		it("finishes A in its original scope and isolates B and a return to A across reopen and rewind", async () => {
			const api = transport();
			const root = temporaryRoot();
			const a = path.join(root, "project-a");
			const b = path.join(root, "project-b");
			const sessions = path.join(root, "sessions");
			await fs.mkdir(a);
			await fs.mkdir(b);
			let manager = SessionManager.create(a, sessions);
			managers.push(manager);
			const aState = stateFor(manager, scoped());
			const originalId = manager.getSessionId();
			const aLeaf = turn(manager, "A private requirement", "A private result");

			// Below cadence: only the pre-move finish can upload A.
			await aState.prepareForCwdMove(b);
			const initialA = api.find("A private result");
			expect(initialA.item.document_id).toBe(originalId);
			expectOwnedBy(initialA, scoping, "project-a");
			await manager.moveTo(b, sessions);

			const bState = stateFor(manager, scoped());
			turn(manager, "B isolated requirement", "B isolated result");
			await bState.forceRetainCurrentSession();
			const bDocument = api.find("B isolated result");
			expect(bDocument.item.content).not.toContain("A private");
			expectOwnedBy(bDocument, scoping, "project-b");
			expect(bDocument.item.document_id).not.toBe(originalId);

			await bState.prepareForCwdMove(a);
			await manager.moveTo(a, sessions);
			const returning = stateFor(manager, scoped());
			turn(manager, "A return requirement", "A return result");
			await returning.forceRetainCurrentSession();
			const returnDocument = api.find("A return result");
			expectOwnedBy(returnDocument, scoping, "project-a");
			expect(returnDocument.item.content).not.toContain("A private");
			expect(returnDocument.item.content).not.toContain("B isolated");
			const ids = new Set([originalId, bDocument.item.document_id, returnDocument.item.document_id]);
			expect(ids.size).toBe(3);
			for (const document of api.documents()) expect(document.item.metadata.session_id).toBe(originalId);

			const file = manager.getSessionFile()!;
			await manager.close();
			managers.splice(managers.indexOf(manager), 1);
			manager = await SessionManager.open(file);
			managers.push(manager);
			expect(manager.getSessionId()).toBe(originalId);
			const reopened = stateFor(manager, scoped());
			await reopened.forceRetainCurrentSession();
			expect(api.documents()).toHaveLength(3);
			expect(api.find("A private result").item.document_id).toBe(originalId);
			expectOwnedBy(api.find("B isolated result"), scoping, "project-b");
			expect(api.find("A return result").item.document_id).toBe(returnDocument.item.document_id);

			manager.branch(aLeaf);
			await reopened.synchronizeRetainedBranch();
			expect(api.documents()).toHaveLength(1);
			const survivor = api.find("A private result");
			expect(survivor.item.document_id).toBe(originalId);
			expectOwnedBy(survivor, scoping, "project-a");

			turn(manager, "A post-rewind requirement", "A post-rewind result");
			await reopened.forceRetainCurrentSession();
			const postRewind = api.find("A post-rewind result");
			expect(postRewind.item.document_id).toBe(returnDocument.item.document_id);
			expectOwnedBy(postRewind, scoping, "project-a");
			expect(postRewind.item.content).not.toContain("A private");
			expect(postRewind.item.content).not.toContain("B isolated");
		});

		it("a failed original-scope retain stops the move before destination messages can be classified", async () => {
			const api = transport();
			const manager = inMemory("/project-a");
			const state = stateFor(manager, scoped());
			const source = expectedScope(scoping, "project-a");
			turn(manager, "Original source", "Original result");
			api.fail();

			await expect(state.prepareForCwdMove("/project-b")).rejects.toThrow();
			expect(manager.getCwd()).toBe("/project-a");
			const retains = api.requests.filter(request => request.item);
			expect(retains.length).toBeGreaterThan(0);
			for (const request of api.requests) expect(request.bankId).toBe(source.bankId);
			for (const request of retains) expect(request.item?.tags).toEqual(source.tags);
			expect(api.documents()).toHaveLength(0);
			expect(
				manager
					.getEntries()
					.filter(entry => entry.type === "custom" && entry.customType === "hindsight_retention_segment"),
			).toHaveLength(1);
		});

		it("same-project worktree moves keep one full-session document and its original history", async () => {
			const api = transport();
			const { repo, worktree } = await createLinkedWorktree(temporaryRoot());
			const manager = inMemory(repo);
			const state = stateFor(manager, scoped());
			turn(manager, "Before worktree move", "Before worktree answer");
			await state.forceRetainCurrentSession();

			const beforeMove = api.requests.length;
			await state.prepareForCwdMove(worktree);
			expect(api.requests).toHaveLength(beforeMove);
			await manager.moveTo(worktree);

			const next = stateFor(manager, scoped());
			turn(manager, "After worktree move", "After worktree answer");
			await next.forceRetainCurrentSession();
			expect(api.documents()).toHaveLength(1);
			const retained = api.get(expectedScope(scoping, "repo").bankId, manager.getSessionId())!;
			expect(retained.item.content).toContain("Before worktree answer");
			expect(retained.item.content).toContain("After worktree answer");
			expectOwnedBy(retained, scoping, "repo");
		});

		it("a fork after a cross-scope rewind preserves provenance without overwriting parent sources", async () => {
			const api = transport();
			const manager = inMemory("/project-a");
			const aState = stateFor(manager, scoped());
			const parentId = manager.getSessionId();
			const aLeaf = turn(manager, "Original A request", "Original A result");
			await aState.prepareForCwdMove("/project-b");
			await manager.moveTo("/project-b");

			const bState = stateFor(manager, scoped());
			turn(manager, "Abandoned B request", "Abandoned B result");
			await bState.forceRetainCurrentSession();
			manager.branch(aLeaf);
			await bState.synchronizeRetainedBranch();
			const bLeaf = turn(manager, "Selected B request", "Selected B result");
			await bState.forceRetainCurrentSession();

			const parentDocuments = structuredClone(api.documents());
			expect(parentDocuments.every(document => document.item.metadata.session_id === parentId)).toBe(true);
			manager.createBranchedSession(bLeaf);
			const forkId = manager.getSessionId();
			expect(forkId).not.toBe(parentId);
			const fork = stateFor(manager, scoped());
			await fork.forceRetainCurrentSession();

			for (const parent of parentDocuments) {
				expect(api.get(parent.bankId, parent.item.document_id)).toEqual(parent);
			}
			const forkDocuments = api.documents().filter(document => document.item.metadata.session_id === forkId);
			expect(forkDocuments).toHaveLength(2);
			const parentIds = new Set(parentDocuments.map(document => document.item.document_id));
			for (const document of forkDocuments) expect(parentIds.has(document.item.document_id)).toBe(false);

			const forkA = forkDocuments.find(document => document.item.content.includes("Original A result"))!;
			const forkB = forkDocuments.find(document => document.item.content.includes("Selected B result"))!;
			expect(forkA).toBeDefined();
			expect(forkB).toBeDefined();
			expect(forkA).not.toBe(forkB);
			expectOwnedBy(forkA, scoping, "project-a");
			expectOwnedBy(forkB, scoping, "project-b");
			expect(forkB.item.content).not.toContain("Original A");
			expect(forkB.item.content).not.toContain("Abandoned B");
			expect(forkA.item.content).not.toContain("B result");
		});

		it("windowed retention deletes abandoned windows and retains only the selected replacement branch", async () => {
			const api = transport();
			const manager = inMemory("/project-a");
			const state = stateFor(manager, scoped({ retainMode: "last-turn" }));
			const owner = expectedScope(scoping, "project-a");
			const kept = turn(manager, "Kept user", "Kept answer");
			turn(manager, "First abandoned user", "First abandoned answer");
			await state.forceRetainCurrentSession();
			turn(manager, "Second abandoned user", "Second abandoned answer");
			await state.forceRetainCurrentSession();
			const abandonedIds = api.documents().map(document => document.item.document_id);
			expect(abandonedIds).toHaveLength(2);

			manager.branch(kept);
			const beforeSync = api.requests.length;
			await state.synchronizeRetainedBranch();
			const deletions = api.requests.slice(beforeSync).filter(request => request.method === "DELETE");
			expect(deletions.map(request => request.documentId).sort()).toEqual([...abandonedIds].sort());
			for (const deletion of deletions) expect(deletion.bankId).toBe(owner.bankId);

			const remaining = api.documents();
			expect(remaining).toHaveLength(1);
			const replacement = remaining[0]!;
			expect(abandonedIds).not.toContain(replacement.item.document_id);
			expect(replacement.item.content).toContain("Kept answer");
			expect(replacement.item.content).not.toContain("abandoned");
			expectOwnedBy(replacement, scoping, "project-a");

			const synchronized = api.requests.length;
			await state.synchronizeRetainedBranch();
			expect(api.requests).toHaveLength(synchronized);
		});
	});
});
