import { logger } from "@oh-my-pi/pi-utils";
import type { LiveSteerClaim, LiveSteering, UserMessage } from "../../types";

/** Back-off when the source woke but had nothing deliverable (e.g. input still being prepared). */
const EMPTY_CLAIM_BACKOFF_MS = 25;

/**
 * Carries caller steering into a Cursor turn. Cursor runs its tool loop
 * server-side and reads mid-turn input only as hook context on a tool result,
 * so a claimed batch is held for the next result that accepts it instead of
 * waiting for the whole turn to end.
 */
export class CursorSteeringRelay {
	/** Text of every steering message this turn absorbed, trimmed, in delivery order. */
	readonly absorbed: string[] = [];
	readonly #stop = new AbortController();
	readonly #run: Promise<void>;
	#held: LiveSteerClaim | undefined;
	#handedOver: PromiseWithResolvers<void> | undefined;

	constructor(source: LiveSteering) {
		this.#run = this.#loop(source);
	}

	/** The held steering as text, settled as answered by this turn; `undefined` when none is held. */
	take(): string | undefined {
		const claim = this.#held;
		if (!claim) return undefined;
		this.#held = undefined;
		claim.absorb();
		this.#handedOver?.resolve();
		const texts = claim.messages.map(messageText);
		this.absorbed.push(...texts.map(text => text.trim()));
		return texts.join("\n\n");
	}

	/** Stops claiming; steering still held goes back to the caller for its next request. */
	async close(): Promise<void> {
		this.#stop.abort();
		this.#held?.reject();
		this.#held = undefined;
		this.#handedOver?.resolve();
		await this.#run;
	}

	async #loop(source: LiveSteering): Promise<void> {
		const signal = this.#stop.signal;
		try {
			while (!signal.aborted) {
				await source.wait(signal);
				if (signal.aborted) return;
				const claim = await source.claim(signal);
				if (!claim) {
					await Bun.sleep(EMPTY_CLAIM_BACKOFF_MS);
					continue;
				}
				if (signal.aborted || !claim.messages.every(isTextOnly)) {
					// Hook context is text: steering it cannot carry whole, and all
					// input queued behind it, waits for the next request.
					claim.reject();
					return;
				}
				// Hold one batch at a time: later input stays queued behind it, in order.
				this.#held = claim;
				this.#handedOver = Promise.withResolvers();
				await this.#handedOver.promise;
			}
		} catch (error) {
			logger.debug("Cursor steering relay stopped", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

function isTextOnly(message: UserMessage): boolean {
	return typeof message.content === "string" || message.content.every(part => part.type === "text");
}

function messageText(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
}
