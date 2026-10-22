/**
 * Date/cwd reminder injection.
 *
 * The system prompt must stay byte-stable so open-weight chat templates that
 * render tool schemas *after* the system content keep their prefix cache
 * (#7404). The per-request date/cwd line used to live at the tail of the
 * system prompt (`project-prompt.md`), which invalidated the whole tool array
 * on every directory change or day rollover. It now rides on the first user
 * turn of each provider request instead: built at request time, deterministic
 * per `(date, cwd)`, with placements recorded as append-only session entries
 * so historical turns remain byte-identical across persisted resume (#15343).
 */
import type { Context, Message, UserMessage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import dateCwdReminderTemplate from "../prompts/system/date-cwd-reminder.md" with { type: "text" };
import { getPersistedSessionEntryId, setPersistedSessionEntryId, type SessionEntry } from "./session-entries";

export const DATE_CWD_REMINDER_CUSTOM_TYPE = "date-cwd-reminder";

export type DateCwdReminderPlacement = "prefix" | "control";

export interface DateCwdReminderEntryData {
	reminder: string;
	placement: DateCwdReminderPlacement;
	turnId?: string;
}

/** The date/cwd reminder entry payload if `entry` is one, otherwise null. */
export function dateCwdReminderOfEntry(entry: SessionEntry): DateCwdReminderEntryData | null {
	if (entry.type !== "custom" || entry.customType !== DATE_CWD_REMINDER_CUSTOM_TYPE) return null;
	const data = entry.data as Partial<DateCwdReminderEntryData> | undefined;
	if (!data || typeof data.reminder !== "string") return null;
	if (data.placement !== "prefix" && data.placement !== "control") return null;
	return {
		reminder: data.reminder,
		placement: data.placement,
		turnId: typeof data.turnId === "string" ? data.turnId : undefined,
	};
}

/** Renders the reminder text for the given local calendar date and cwd. */
export function renderDateCwdReminder(date: string, cwd: string): string {
	return prompt.render(dateCwdReminderTemplate, { date, cwd }).trim();
}

function messageStartsWithReminder(message: UserMessage, reminder: string): boolean {
	if (typeof message.content === "string") return message.content.startsWith(reminder);
	return message.content[0]?.type === "text" && message.content[0].text === reminder;
}

function injectReminder(message: UserMessage, reminder: string): UserMessage {
	const content: UserMessage["content"] =
		typeof message.content === "string"
			? `${reminder}\n\n${message.content}`
			: [{ type: "text", text: reminder }, ...message.content];
	return { ...message, content };
}

function ensureInjectedReminder(message: UserMessage, reminder: string): UserMessage {
	if (messageStartsWithReminder(message, reminder)) return message;
	return injectReminder(message, reminder);
}

function extractReminderText(message: UserMessage): string | undefined {
	const text =
		typeof message.content === "string"
			? message.content
			: message.content[0]?.type === "text"
				? message.content[0].text
				: undefined;
	if (!text || !text.startsWith("<system-reminder>")) return undefined;
	const endIdx = text.indexOf("</system-reminder>");
	if (endIdx === -1) return undefined;
	return text.slice(0, endIdx + "</system-reminder>".length);
}

function isWireMessage(msg: unknown): msg is Message {
	if (!msg || typeof msg !== "object") return false;
	const role = (msg as { role?: unknown }).role;
	return role === "user" || role === "assistant" || role === "developer" || role === "toolResult";
}

/** Developer turns the injector inserted; every other output message maps to an input one. */
const reminderControls = new WeakSet<Message>();

/** Whether `message` is a developer turn a {@link DateCwdReminderInjector} inserted. */
export function isDateCwdReminderControl(message: Message): boolean {
	return reminderControls.has(message);
}

export interface DateCwdReminderSessionHost {
	getBranchView(): readonly SessionEntry[];
	appendCustomEntry(customType: string, data?: unknown): string;
	getLeafId(): string | null;
}

/**
 * Keeps volatile date/cwd reminders append-only across provider requests.
 *
 * The first value is attached to the first user turn. A changed value attaches
 * to a newly appended user turn or a persistent developer turn, leaving every
 * previously sent message byte-identical. Injected reminders are persisted as
 * dedicated session entries so resumed sessions rebuild historical turns
 * faithfully.
 */
export class DateCwdReminderInjector {
	#host: DateCwdReminderSessionHost | undefined;
	#root: UserMessage | undefined;
	#currentReminder: string | undefined;
	#injections = new Map<Message, Message>();
	#controls: Array<{ anchor: Message; message: Message }> = [];
	#seen = new WeakSet<object>();
	#rebuilt = false;

	#recordedPrefixes = new Map<string, string>();
	#recordedControls = new Map<string, Array<{ reminder: string; timestamp: number }>>();
	#seenEntryIds = new Set<string>();
	#lastRecordedReminder: string | undefined;

	constructor(host?: DateCwdReminderSessionHost) {
		this.#host = host;
	}

	/**
	 * Rebuilds state from persisted date-cwd-reminder entries.
	 * If no reminder entries exist on the branch (e.g. older transcripts),
	 * state is left clean to preserve fallback behavior.
	 */
	rebuild(branch?: readonly SessionEntry[]): void {
		const entries = branch ?? this.#host?.getBranchView();
		this.#injections.clear();
		this.#controls = [];
		this.#root = undefined;
		this.#currentReminder = undefined;
		this.#seen = new WeakSet<object>();
		this.#recordedPrefixes.clear();
		this.#recordedControls.clear();
		this.#seenEntryIds.clear();
		this.#lastRecordedReminder = undefined;

		if (!entries || entries.length === 0) {
			this.#rebuilt = true;
			return;
		}

		let hasReminderEntries = false;
		for (const entry of entries) {
			if (dateCwdReminderOfEntry(entry)) {
				hasReminderEntries = true;
				break;
			}
		}

		if (!hasReminderEntries) {
			this.#rebuilt = true;
			return;
		}

		let lastAssistantIdx = -1;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i]!;
			if (entry.type === "message" && entry.message.role === "assistant") {
				lastAssistantIdx = i;
				break;
			}
		}

		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i]!;
			if (i <= lastAssistantIdx) {
				this.#seenEntryIds.add(entry.id);
			}
			if (entry.type === "message" && isWireMessage(entry.message)) {
				if (getPersistedSessionEntryId(entry.message) === undefined) {
					setPersistedSessionEntryId(entry.message, entry.id);
				}
			}

			const data = dateCwdReminderOfEntry(entry);
			if (!data) continue;

			this.#lastRecordedReminder = data.reminder;
			const targetId = data.turnId ?? entry.parentId;
			if (!targetId) continue;

			if (data.placement === "prefix") {
				this.#recordedPrefixes.set(targetId, data.reminder);
			} else if (data.placement === "control") {
				const existing = this.#recordedControls.get(targetId);
				const timestamp = new Date(entry.timestamp).getTime() || Date.now();
				if (existing) {
					existing.push({ reminder: data.reminder, timestamp });
				} else {
					this.#recordedControls.set(targetId, [{ reminder: data.reminder, timestamp }]);
				}
			}
		}

		this.#rebuilt = true;
	}

	/** Apply the current reminder while preserving all earlier injected bytes. */
	transform(context: Context, date: string, cwd: string): Context {
		if (!context.systemPrompt || context.systemPrompt.length === 0 || context.messages.length === 0) return context;
		if (!this.#rebuilt && this.#host) {
			this.rebuild(this.#host.getBranchView());
		}
		const reminder = renderDateCwdReminder(date, cwd);
		const messages = this.#inject(context.messages, reminder);
		return messages === context.messages ? context : { ...context, messages };
	}

	#inject(messages: Message[], reminder: string): Message[] {
		const firstUser = messages.find((message): message is UserMessage => message.role === "user");
		if (!firstUser) return messages;

		for (const message of messages) {
			const entryId = getPersistedSessionEntryId(message);
			if (entryId !== undefined) {
				if (this.#seenEntryIds.has(entryId)) {
					this.#seen.add(message);
				}
				const recordedPrefix = this.#recordedPrefixes.get(entryId);
				if (recordedPrefix !== undefined && !this.#injections.has(message) && message.role === "user") {
					this.#injections.set(message, ensureInjectedReminder(message as UserMessage, recordedPrefix));
				}
				const recordedControls = this.#recordedControls.get(entryId);
				if (recordedControls && !this.#controls.some(c => c.anchor === message)) {
					for (const ctrl of recordedControls) {
						const controlMsg: Message = {
							role: "developer",
							content: ctrl.reminder,
							synthetic: true,
							timestamp: ctrl.timestamp,
						};
						reminderControls.add(controlMsg);
						this.#controls.push({ anchor: message, message: controlMsg });
					}
				}
			}
		}

		if (this.#root !== firstUser) {
			const present = new Set<Message>(messages);
			for (const message of this.#injections.keys()) {
				if (!present.has(message)) this.#injections.delete(message);
			}
			this.#controls = this.#controls.filter(control => present.has(control.anchor));
			this.#root = firstUser;

			const existingInjection = this.#injections.get(firstUser);
			if (existingInjection) {
				const entryId = getPersistedSessionEntryId(firstUser);
				this.#currentReminder =
					(entryId ? this.#recordedPrefixes.get(entryId) : undefined) ??
					this.#lastRecordedReminder ??
					extractReminderText(existingInjection as UserMessage) ??
					reminder;
			} else {
				if (this.#lastRecordedReminder !== undefined) {
					this.#currentReminder = this.#lastRecordedReminder;
				} else if (this.#seen.has(firstUser)) {
					this.#currentReminder = extractReminderText(firstUser);
				} else {
					this.#currentReminder = reminder;
					this.#injections.set(firstUser, injectReminder(firstUser, reminder));
					this.#recordReminder({ reminder, placement: "prefix" }, firstUser);
				}
			}
		}

		if (this.#currentReminder !== reminder) {
			let newUser: UserMessage | undefined;
			for (let index = messages.length - 1; index >= 0; index--) {
				const candidate = messages[index]!;
				if (candidate.role === "user" && !this.#seen.has(candidate)) {
					newUser = candidate;
					break;
				}
			}
			if (newUser) {
				this.#injections.set(newUser, injectReminder(newUser, reminder));
				this.#recordReminder({ reminder, placement: "prefix" }, newUser);
			} else {
				const anchor = messages.at(-1)!;
				const control: Message = {
					role: "developer",
					content: reminder,
					synthetic: true,
					timestamp: Date.now(),
				};
				reminderControls.add(control);
				this.#controls.push({ anchor, message: control });
				this.#recordReminder({ reminder, placement: "control" }, anchor);
			}
			this.#currentReminder = reminder;
		}

		const controlsByAnchor = new Map<Message, Message[]>();
		for (const control of this.#controls) {
			const controls = controlsByAnchor.get(control.anchor);
			if (controls) controls.push(control.message);
			else controlsByAnchor.set(control.anchor, [control.message]);
		}

		let changed = false;
		const out: Message[] = [];
		for (const message of messages) {
			const injected = this.#injections.get(message);
			out.push(injected ?? message);
			if (injected) changed = true;
			const controls = controlsByAnchor.get(message);
			if (controls) {
				out.push(...controls);
				changed = true;
			}
			this.#seen.add(message);
		}
		return changed ? out : messages;
	}

	#recordReminder(data: { reminder: string; placement: DateCwdReminderPlacement }, target: Message): void {
		if (!this.#host) return;
		let turnId = getPersistedSessionEntryId(target);
		if (!turnId) {
			const leafId = this.#host.getLeafId();
			turnId = leafId ?? undefined;
		}
		this.#host.appendCustomEntry(DATE_CWD_REMINDER_CUSTOM_TYPE, {
			reminder: data.reminder,
			placement: data.placement,
			...(turnId ? { turnId } : {}),
		});
	}
}
