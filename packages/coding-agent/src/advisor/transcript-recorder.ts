import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message, UserMessage } from "@oh-my-pi/pi-ai";
import { getBlobsDir, logger, Snowflake, stringifyJson } from "@oh-my-pi/pi-utils";
import { BlobStore } from "../session/blob-store";
import { currentRuntimeIdentity } from "../session/runtime-identity";
import {
	CURRENT_SESSION_VERSION,
	type SessionHeader,
	type SessionMessageEntry,
	sessionEntryLeafId,
} from "../session/session-entries";
import { normalizeAssistantUsage, visitEntriesFromFileStream } from "../session/session-loader";
import { mintSessionId, SessionManager } from "../session/session-manager";
import { forgetExternalizedImages, prepareEntryForPersistence } from "../session/session-persistence";
import { FileSessionStorage, type SessionStorageWriter } from "../session/session-storage";
import { serializeTitleSlot } from "../session/session-title-slot";
import { fingerprintMessage } from "./message-fingerprint";

/**
 * Reserved transcript stem for advisor session files. Chosen so it cannot
 * collide with a task subagent's `<id>.jsonl` (task ids are reserved against
 * this exact stem in {@link AgentOutputManager}).
 */
export const ADVISOR_TRANSCRIPT_STEM = "__advisor";
export const ADVISOR_TRANSCRIPT_FILENAME = `${ADVISOR_TRANSCRIPT_STEM}.jsonl`;

const JSONL_SUFFIX = ".jsonl";

/**
 * Transcript filename for an advisor: `__advisor.jsonl` for the legacy/default
 * advisor (empty slug), `__advisor.<slug>.jsonl` for a named advisor. The `.`
 * separator keeps named files out of the output manager's `-<n>` bump namespace.
 */
export function advisorTranscriptFilename(slug: string): string {
	return slug ? `${ADVISOR_TRANSCRIPT_STEM}.${slug}${JSONL_SUFFIX}` : ADVISOR_TRANSCRIPT_FILENAME;
}

/** Whether a filename is any advisor transcript (`__advisor.jsonl` or `__advisor.<slug>.jsonl`). */
export function isAdvisorTranscriptName(name: string): boolean {
	return (
		name === ADVISOR_TRANSCRIPT_FILENAME ||
		(name.startsWith(`${ADVISOR_TRANSCRIPT_STEM}.`) && name.endsWith(JSONL_SUFFIX))
	);
}

/** Controls resume-time advisor transcript cost restoration. */
export interface LoadAdvisorTranscriptCostsOptions {
	/** Resolves once active recorder writes are paused at the snapshot boundary. */
	beforeSnapshot?: Promise<unknown>;
	/**
	 * Runs synchronously after every transcript's byte length has been captured
	 * and before parsing begins. Callers release recorder write barriers at this
	 * boundary; later appends remain excluded from the captured disk totals.
	 */
	onSnapshot?: () => void;
	/** Stop metadata discovery and transcript parsing when the owning session is gone. */
	shouldContinue?: () => boolean;
	/**
	 * When provided, receives the distinct providers that billed each advisor
	 * slug (populated only for slugs with nonzero cost), so callers can
	 * re-derive subscription attribution from persisted spend without a second
	 * scan (#10129).
	 */
	providersBySlug?: Map<string, Set<string>>;
}

interface AdvisorTranscriptCostFileSnapshot {
	file: string;
	slug: string;
	maxBytes: number;
}

/**
 * Sum advisor spend already persisted next to a primary session transcript,
 * keyed by advisor slug.
 *
 * Each transcript is read only through the byte length captured before
 * `onSnapshot` runs. This fixed prefix lets resume reconcile the persisted
 * total with advisor turns billed while the asynchronous scan is running,
 * without either dropping or double-counting those concurrent turns.
 *
 * Only the session's own advisors count: subagent advisors write to
 * `<session>/<SubId>/__advisor.jsonl`, and their spend belongs to the subagent,
 * not to this roster. Hence the scan stays at the top level of the directory.
 */
export async function loadAdvisorTranscriptCosts(
	sessionFile: string | undefined,
	options: LoadAdvisorTranscriptCostsOptions = {},
): Promise<Map<string, number>> {
	await options.beforeSnapshot;
	const snapshots: AdvisorTranscriptCostFileSnapshot[] = [];
	if (sessionFile?.endsWith(JSONL_SUFFIX)) {
		const directory = sessionFile.slice(0, -JSONL_SUFFIX.length);
		const dirents = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
		for (const dirent of dirents) {
			if (options.shouldContinue?.() === false) break;
			if (!dirent.isFile() || !isAdvisorTranscriptName(dirent.name)) continue;
			const file = path.join(directory, dirent.name);
			try {
				snapshots.push({
					file,
					slug:
						dirent.name === ADVISOR_TRANSCRIPT_FILENAME
							? ""
							: dirent.name.slice(`${ADVISOR_TRANSCRIPT_STEM}.`.length, -JSONL_SUFFIX.length),
					maxBytes: (await fs.stat(file)).size,
				});
			} catch {}
		}
	}
	options.onSnapshot?.();

	const costs = new Map<string, number>();
	for (const snapshot of snapshots) {
		let total = 0;
		const providers = new Set<string>();
		let validHeader: boolean | undefined;
		try {
			await visitEntriesFromFileStream(
				snapshot.file,
				entry => {
					const isObject = typeof entry === "object" && entry !== null;
					if (validHeader === undefined) {
						validHeader = isObject && entry.type === "session" && typeof entry.id === "string";
						return;
					}
					// A syntactically valid but non-object entry (e.g. a bare
					// `null` line) must cost only itself, not crash entry.type
					// access and discard everything accumulated for this transcript.
					if (!validHeader || !isObject || entry.type !== "message") return;
					const message = entry.message;
					if (!message || typeof message !== "object" || message.role !== "assistant") return;
					// One malformed usage block must cost that entry only, not the
					// whole transcript's total.
					const total_ = message.usage?.cost?.total;
					if (typeof total_ === "number" && Number.isFinite(total_)) {
						total += total_;
						if (total_ > 0 && typeof message.provider === "string" && message.provider) {
							providers.add(message.provider);
						}
					}
				},
				{ maxBytes: snapshot.maxBytes, shouldContinue: options.shouldContinue },
			);
		} catch (err) {
			logger.debug("advisor transcript cost read failed", { file: path.basename(snapshot.file), err: String(err) });
			continue;
		}
		if (total > 0) {
			costs.set(snapshot.slug, total);
			if (options.providersBySlug && providers.size > 0) options.providersBySlug.set(snapshot.slug, providers);
		}
	}
	return costs;
}

/** Result of one streaming pass over an existing transcript. */
interface JournalScan {
	sawEntry: boolean;
	validHeader: boolean;
	/** Header declares a version older than {@link CURRENT_SESSION_VERSION}. */
	legacyVersion: boolean;
	malformedRecords: number;
	leafId: string | null;
}

/** Append position of one open advisor transcript; holds no persisted history. */
interface TranscriptJournal {
	file: string;
	/** Per-file blob store, so image externalization matches the session writer's. */
	blobs: BlobStore;
	/** Append handle; dropped after a failed append because the writer latches its error. */
	writer: SessionStorageWriter | undefined;
	/** Id of the last entry admitted to the chain; the parent of the next one. */
	leafId: string | null;
	/** Serialized lines not yet appended, oldest first. */
	unwritten: string[];
	/**
	 * `unwritten[0]` was handed to a writer whose append then threw, so its bytes
	 * may have reached the file (the failure can follow the write, e.g. a publish
	 * lock or stat error). Set only once an append was actually attempted — errors
	 * from opening the file or writer leave it clear, as nothing was written — and
	 * cleared when the line is acknowledged, found absent, or successfully appended.
	 */
	headAppendUncertain: boolean;
}

/**
 * Append-only persister for an advisor agent's transcript.
 *
 * The advisor is a passive reviewer with its own model usage, so — like a task
 * subagent — its turns are written to a JSONL inside the owning session's
 * artifacts dir (`<session>/__advisor.jsonl`, `<session>/<SubId>/__advisor.jsonl`
 * for subagent advisors). That single file gives the advisor model proper usage
 * attribution in `omp stats` (the stats parser scans the session dir
 * recursively) and a read-only transcript in the Agent Hub, without making the
 * advisor a registered, messageable peer.
 *
 * The target is derived from the *session file* (`getSessionFile()`), never
 * `getArtifactsDir()` — subagents adopt the parent's artifact manager, so the
 * artifacts dir points at the parent root and every subagent advisor would
 * collide. The file path is resolved synchronously when a message finalizes and
 * captured for the queued write, so a `/new`, resume, or session switch in
 * flight can never misattribute an old advisor turn into the new session's file.
 * On such a switch the previous writer is closed and the new file opened on the
 * next recorded turn. The recorder never truncates: the advisor's in-memory
 * context resets/compacts independently, but every billed turn is appended here.
 *
 * Memory stays independent of transcript length: opening an existing file
 * streams it once to recover the last entry id, and an append only retains the
 * serialized lines that could not be written yet (retried in order by the next
 * record, flush or close) — never the persisted history or its message objects.
 */
export class AdvisorTranscriptRecorder {
	readonly #storage = new FileSessionStorage();
	#journal: TranscriptJournal | undefined;
	#file: string | undefined;
	#filename: string;
	/** Serializes the async open/close against appends so records land in order. */
	#queue: Promise<void>;
	/**
	 * Ordered fingerprints of user "session update" deltas persisted since the
	 * last committed advisor turn. The advisor re-delivers the identical batch on
	 * every retry/overflow/refusal loop (issue #9553), and {@link #rollbackFailedTurn}
	 * only cleans the agent's in-memory state — the recorder already wrote the
	 * attempt. Matching a re-delivery positionally against this window skips the
	 * duplicate while still persisting genuinely new content, including two
	 * distinct deltas that happen to render identically (a repeated prompt, or two
	 * tool runs with the same output).
	 */
	#replayWindow: bigint[] = [];
	/** Cursor into {@link #replayWindow}; reset at each delivery attempt via {@link beginTurn}. */
	#replayCursor = 0;
	/** Target file {@link #replayWindow} belongs to; a switch starts a fresh window. */
	#windowFile: string | undefined;

	/**
	 * @param filename Transcript filename within the session dir. Defaults to
	 *   `__advisor.jsonl`; named advisors pass `__advisor.<slug>.jsonl` via
	 *   {@link advisorTranscriptFilename}.
	 * @param after Optional barrier the queue starts behind — used on the advisor
	 *   on→off→on toggle so a fresh recorder's first `open` waits for the prior
	 *   recorder's `close` and the two never hold the same file at once.
	 */
	constructor(
		private readonly resolveSessionFile: () => string | undefined,
		private readonly resolveCwd: () => string,
		filename: string = ADVISOR_TRANSCRIPT_FILENAME,
		after?: Promise<unknown>,
	) {
		this.#filename = filename;
		this.#queue = after
			? after.then(
					() => {},
					() => {},
				)
			: Promise.resolve();
	}

	/**
	 * Persist one finalized advisor message. Assistant turns carry the usage the
	 * stats parser reads; tool results round out the Hub transcript; user deltas
	 * (the advisor's "session update" prompts) are persisted but flagged
	 * `synthetic`/agent-attributed so they never inflate user-message metrics.
	 * Non-conversational message kinds are skipped.
	 */
	record(message: AgentMessage): void {
		let persisted: Message;
		switch (message.role) {
			case "assistant":
			case "toolResult":
				persisted = message;
				break;
			case "user":
				// Clone so the live advisor message stays untouched; mark synthetic so
				// stats' user-message metrics skip these agent-internal review prompts.
				persisted = { ...(message as UserMessage), synthetic: true, attribution: "agent" };
				break;
			default:
				return;
		}
		const sessionFile = this.resolveSessionFile();
		if (!sessionFile?.endsWith(JSONL_SUFFIX)) return;
		const file = path.join(sessionFile.slice(0, -JSONL_SUFFIX.length), this.#filename);
		// A new target file starts a fresh replay window: positions from the prior
		// session's turns must never suppress the new file's first delta.
		if (file !== this.#windowFile) {
			this.#windowFile = file;
			this.#replayWindow = [];
			this.#replayCursor = 0;
		}
		// Skip a re-delivered user delta: on retry/overflow/refusal the advisor
		// re-sends the identical batch in the same order, so a positional match
		// against this turn's window is a replay that adds only bytes. New content
		// — including a delta that renders like an earlier one — diverges from the
		// window and is persisted. Assistant/tool turns are billed work: always
		// written, so cost attribution and the Hub transcript stay intact.
		if (message.role === "user") {
			const fingerprint = fingerprintMessage(message);
			if (fingerprint !== undefined) {
				if (this.#replayCursor < this.#replayWindow.length) {
					if (this.#replayWindow[this.#replayCursor] === fingerprint) {
						this.#replayCursor++;
						return;
					}
					// Divergent retry (e.g. reasoning stripped after a refusal): the
					// window no longer matches, so drop its stale tail and record anew.
					this.#replayWindow.length = this.#replayCursor;
				}
				this.#replayWindow.push(fingerprint);
				this.#replayCursor = this.#replayWindow.length;
			}
		}
		const cwd = this.resolveCwd();
		this.#enqueue(async () => {
			if (file !== this.#file) {
				await this.#closeJournal();
				this.#journal = await this.#openJournal(file, cwd);
				this.#file = file;
			}
			if (this.#journal) await this.#appendMessage(this.#journal, persisted);
		});
	}

	/**
	 * Mark the start of one advisor delivery attempt. Rewinds the replay cursor so
	 * a retry that re-sends the same batch matches this turn's window positionally
	 * and is skipped, while the window itself (persisted-since-commit) is retained.
	 */
	beginTurn(): void {
		this.#replayCursor = 0;
	}

	/**
	 * Mark an advisor turn as committed (its output landed). Clears the replay
	 * window so the next turn's deltas are recorded even when they render like a
	 * committed one — only re-deliveries of an *uncommitted* turn are replays.
	 */
	commitTurn(): void {
		this.#clearReplayWindow();
	}

	/** Discard replay identity for a failed batch that will not be retried. */
	abandonTurn(): void {
		this.#clearReplayWindow();
	}

	/**
	 * Queue a write barrier after all records accepted so far. Once `ready`
	 * resolves, callers may safely snapshot the file length; records accepted
	 * after this call remain queued until `release` settles.
	 */
	blockWritesUntil(release: Promise<unknown>): Promise<void> {
		const ready = Promise.withResolvers<void>();
		this.#enqueue(async () => {
			ready.resolve();
			await release;
		});
		return ready.promise;
	}

	#clearReplayWindow(): void {
		this.#replayWindow = [];
		this.#replayCursor = 0;
	}

	/** Flush pending writes; rejects when a queued line still cannot be appended. */
	flush(): Promise<void> {
		return this.#enqueueResult(async () => {
			const journal = this.#journal;
			if (!journal) return;
			await this.#appendPending(journal);
			await journal.writer?.flush();
		});
	}

	/** Flush and close the writer, releasing the session file. */
	close(): Promise<void> {
		return this.#enqueueResult(() => this.#closeJournal());
	}

	async #closeJournal(): Promise<void> {
		const journal = this.#journal;
		this.#journal = undefined;
		this.#file = undefined;
		if (!journal) return;
		try {
			// Last attempt for lines an earlier transient failure left unwritten.
			await this.#appendPending(journal);
			await journal.writer?.close();
		} catch (err) {
			logger.debug("advisor transcript close failed", { err: String(err) });
		}
		forgetExternalizedImages(journal.blobs);
	}

	/**
	 * Recover the append position of `file` without loading its history: stream
	 * the existing records keeping only the last entry id, and create the title
	 * slot + session header when the file is missing or empty. A file whose first
	 * record is not a session header is left untouched and reported, matching the
	 * session loader's invalid-header rule.
	 */
	async #openJournal(file: string, cwd: string): Promise<TranscriptJournal> {
		let scan = await this.#scanJournal(file);
		if (scan.legacyVersion) {
			// One-time, conservative migration: the session manager's loader holds the
			// whole transcript transiently while it normalizes v1/v2 entries to the
			// current format, rewrites the file atomically, and closes. Appending v3
			// entries under an older header would otherwise corrupt the file's version.
			const manager = await SessionManager.open(file, path.dirname(file), this.#storage, {
				initialCwd: cwd,
				suppressBreadcrumb: true,
			});
			let migrationError: unknown;
			let migrationFailed = false;
			try {
				await manager.rewriteEntries();
				await manager.flush();
			} catch (err) {
				migrationFailed = true;
				migrationError = err;
			}
			// close() before release: release seals the manager and only schedules the
			// writer close, so closing first drains and releases the file handle.
			try {
				await manager.close();
			} catch (closeErr) {
				if (!migrationFailed) {
					migrationFailed = true;
					migrationError = closeErr;
				} else {
					// Never mask the original migration error.
					logger.debug("advisor transcript migration close failed", { err: String(closeErr) });
				}
			}
			manager.releaseRetainedEntries();
			if (migrationFailed) throw migrationError;
			scan = await this.#scanJournal(file);
			if (scan.legacyVersion) {
				throw new Error(`Cannot append to advisor transcript "${file}": legacy header migration did not complete.`);
			}
		}
		return this.#finishOpen(file, cwd, scan);
	}

	/** Stream the transcript once, keeping only header validity/version, the last entry id and malformed count. */
	async #scanJournal(file: string): Promise<JournalScan> {
		const scan: JournalScan = {
			sawEntry: false,
			validHeader: true,
			legacyVersion: false,
			malformedRecords: 0,
			leafId: null,
		};
		await visitEntriesFromFileStream(
			file,
			entry => {
				if (!scan.sawEntry) {
					scan.sawEntry = true;
					scan.validHeader =
						typeof entry === "object" &&
						entry !== null &&
						entry.type === "session" &&
						typeof entry.id === "string";
					// Same rule as migrateToCurrentVersion: a missing version means v1.
					if (scan.validHeader && entry.type === "session") {
						scan.legacyVersion = (entry.version ?? 1) < CURRENT_SESSION_VERSION;
					}
					return scan.validHeader;
				}
				if (
					typeof entry === "object" &&
					entry !== null &&
					entry.type !== "session" &&
					typeof entry.id === "string"
				) {
					scan.leafId = sessionEntryLeafId(entry);
				}
			},
			{
				onMalformedRecord: () => {
					scan.malformedRecords++;
				},
			},
		);
		return scan;
	}

	#finishOpen(file: string, cwd: string, scan: JournalScan): TranscriptJournal {
		if (scan.sawEntry ? !scan.validHeader : scan.malformedRecords > 0) {
			throw new Error(
				`Cannot append to advisor transcript "${file}": the session header is missing or malformed. The file was not modified.`,
			);
		}
		if (!scan.sawEntry) {
			const timestamp = new Date().toISOString();
			const header: SessionHeader = {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: mintSessionId(),
				timestamp,
				cwd: path.resolve(cwd),
			};
			this.#storage.ensureDirSync(path.dirname(file));
			this.#storage.writeTextSync(
				file,
				`${serializeTitleSlot({ updatedAt: timestamp })}${JSON.stringify(header)}\n`,
				{
					expectedSize: this.#storage.existsSync(file) ? this.#storage.statSync(file).size : null,
				},
			);
		}
		return {
			file,
			blobs: new BlobStore(getBlobsDir()),
			writer: undefined,
			leafId: scan.leafId,
			unwritten: [],
			headAppendUncertain: false,
		};
	}

	/** Serialize one message as the next entry of the journal's chain and append it with every earlier unwritten line. */
	async #appendMessage(journal: TranscriptJournal, message: Message): Promise<void> {
		const entry: SessionMessageEntry = {
			type: "message",
			id: Snowflake.next(),
			parentId: journal.leafId,
			timestamp: new Date().toISOString(),
			runtime: currentRuntimeIdentity(),
			message,
		};
		if (message.role === "assistant" && normalizeAssistantUsage(message)) {
			logger.warn("Assistant message recorded with incomplete usage", { id: entry.id });
		}
		const line = stringifyJson(prepareEntryForPersistence(entry, journal.blobs));
		if (typeof line !== "string") throw new Error("Advisor transcript entry did not serialize to JSON");
		// Admit the entry to the chain only after it serialized, so a failure
		// cannot leave the next entry pointing at a parent that was never written.
		journal.leafId = entry.id;
		journal.unwritten.push(`${line}\n`);
		await this.#appendPending(journal);
	}

	/**
	 * Append the lines no earlier attempt managed to write, oldest first. A failed
	 * append (the writer rolls back its partial bytes) discards the writer, whose
	 * error is latched, and rethrows; the remaining lines stay queued so the next
	 * record, flush or close retries them in order instead of losing billed turns.
	 *
	 * An append that threw may nevertheless have landed its whole line, so the
	 * retry first reconciles that one line against the file tail rather than
	 * writing a duplicate entry (which would double its billed usage).
	 */
	async #appendPending(journal: TranscriptJournal): Promise<void> {
		if (journal.unwritten.length === 0) return;
		let writer = journal.writer;
		try {
			if (journal.headAppendUncertain) {
				await this.#reconcileUncertainHead(journal);
				if (journal.unwritten.length === 0) return;
			}
			let separator = "";
			if (!writer?.isOpen()) {
				// A crash or unrolled failure can leave an unterminated record at the
				// tail; end it so the next entry starts on its own line.
				const [, tail] = await this.#storage.readTextSlices(journal.file, 0, 1);
				separator = tail === "" || tail === "\n" ? "" : "\n";
				writer = journal.writer = this.#storage.openWriter(journal.file, { flags: "a" });
			}
			while (journal.unwritten.length > 0) {
				// Stays set if append throws: the bytes may have landed before the error.
				journal.headAppendUncertain = true;
				await writer.append(separator + journal.unwritten[0]);
				journal.headAppendUncertain = false;
				separator = "";
				journal.unwritten.shift();
			}
		} catch (err) {
			journal.writer = undefined;
			await writer?.close().catch(() => {});
			throw err;
		}
	}

	/**
	 * Resolve whether `unwritten[0]`, whose append threw, is already the last
	 * record of the file. Entries carry a unique Snowflake id, so a byte-exact
	 * match of the complete line at the tail can only be that attempt's own bytes:
	 * acknowledge it without re-appending. Anything else (the writer rolled the
	 * bytes back, or only part of the line survived) means it is absent and the
	 * normal ordered retry applies. A failed read rethrows with the line still
	 * pending and uncertain, so the next attempt reconciles again instead of
	 * guessing.
	 */
	async #reconcileUncertainHead(journal: TranscriptJournal): Promise<void> {
		const line = journal.unwritten[0];
		const [, tail] = await this.#storage.readTextSlices(journal.file, 0, Buffer.byteLength(line, "utf8"));
		if (tail === line) journal.unwritten.shift();
		journal.headAppendUncertain = false;
	}

	#enqueue(work: () => Promise<void>): void {
		this.#queue = this.#queue.then(work, work).catch(err => {
			logger.debug("advisor transcript record failed", { err: String(err) });
		});
	}

	#enqueueResult(work: () => Promise<void>): Promise<void> {
		const next = this.#queue.then(work, work);
		this.#queue = next.catch(() => {});
		return next;
	}
}
