import { Snowflake } from "@oh-my-pi/pi-utils";
import {
	type DapAdapterProcess,
	DapClient,
	type DapHostConnector,
	type DapResolvedAdapter,
	type DapSessionManager,
	dapSessionManager,
} from "../../dap";
import { encodeMessageFrame, MessageFramer } from "../../jsonrpc/message-framing";
import type { RpcHostDapClose, RpcHostDapMessage } from "./rpc-types";

type RpcHostDapOutput = (frame: RpcHostDapMessage | RpcHostDapClose) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isRpcHostDapMessage(value: unknown): value is RpcHostDapMessage {
	return (
		isRecord(value) &&
		value.type === "host_dap_message" &&
		typeof value.sessionId === "string" &&
		isRecord(value.message)
	);
}

export function isRpcHostDapClose(value: unknown): value is RpcHostDapClose {
	return isRecord(value) && value.type === "host_dap_close" && typeof value.sessionId === "string";
}

/** One `debug` session whose DAP traffic travels over RPC frames to the host. */
class HostDapSession implements DapAdapterProcess {
	readonly exited: Promise<void>;
	exitCode: number | null = null;
	#error = "";
	#resolveExited: () => void;
	#controller!: ReadableStreamDefaultController<Uint8Array>;
	readonly readable: ReadableStream<Uint8Array>;

	constructor(
		readonly id: string,
		readonly onClose: (session: HostDapSession, notifyHost: boolean) => void,
	) {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.exited = promise;
		this.#resolveExited = resolve;
		this.readable = new ReadableStream<Uint8Array>({
			start: controller => {
				this.#controller = controller;
			},
		});
	}

	deliver(message: Record<string, unknown>): void {
		if (this.exitCode !== null) return;
		this.#controller.enqueue(encodeMessageFrame(message));
	}

	/** Ends the session; `notifyHost` is false when the host itself closed it. */
	end(notifyHost: boolean, error?: string): void {
		if (this.exitCode !== null) return;
		this.exitCode = error ? 1 : 0;
		this.#error = error ?? "";
		try {
			// Erroring the stream surfaces the host's reason on every pending request.
			if (error) this.#controller.error(new Error(error));
			else this.#controller.close();
		} catch {
			/* reader already cancelled */
		}
		this.onClose(this, notifyHost);
		this.#resolveExited();
	}

	kill(): void {
		this.end(true);
	}

	peekStderr(): string {
		return this.#error;
	}
}

/**
 * Lets the RPC host supply the `debug` tool's debugger session.
 *
 * After `set_host_debug { enabled: true }`, `debug` launch/attach connect to
 * the host instead of spawning an adapter: every DAP message the tool sends
 * goes out as a `host_dap_message` frame, and the host's responses and events
 * come back the same way, so the host answers from its own debugger session.
 */
export class RpcHostDebugBridge implements DapHostConnector {
	#output: RpcHostDapOutput;
	#manager: DapSessionManager;
	#sessions = new Map<string, HostDapSession>();

	constructor(output: RpcHostDapOutput, manager: DapSessionManager = dapSessionManager) {
		this.#output = output;
		this.#manager = manager;
	}

	setEnabled(enabled: boolean): boolean {
		this.#manager.setHostConnector(enabled ? this : null);
		return enabled;
	}

	connect(adapter: DapResolvedAdapter, cwd: string): DapClient {
		const session = new HostDapSession(Snowflake.next() as string, (closed, notifyHost) => {
			this.#sessions.delete(closed.id);
			if (notifyHost) this.#output({ type: "host_dap_close", sessionId: closed.id });
		});
		this.#sessions.set(session.id, session);
		const framer = new MessageFramer(Buffer.alloc(0));
		const writeSink = {
			write: (data: string | Uint8Array): number => {
				if (session.exitCode !== null) throw new Error("Host debug session closed");
				const bytes = typeof data === "string" ? Buffer.from(data) : data;
				framer.push(bytes);
				for (const text of framer.drain(() => {})) {
					this.#output({ type: "host_dap_message", sessionId: session.id, message: JSON.parse(text) });
				}
				return bytes.byteLength;
			},
			flush: () => undefined,
		};
		return DapClient.fromTransport(adapter, cwd, { proc: session, readable: session.readable, writeSink });
	}

	handleMessage(frame: RpcHostDapMessage): boolean {
		const session = this.#sessions.get(frame.sessionId);
		if (!session) return false;
		session.deliver(frame.message);
		return true;
	}

	handleClose(frame: RpcHostDapClose): boolean {
		const session = this.#sessions.get(frame.sessionId);
		if (!session) return false;
		session.end(false, frame.error ?? "host closed the debug session");
		return true;
	}

	/** Ends every host session and stops routing `debug` to the host (RPC client gone). */
	close(message: string): void {
		this.#manager.setHostConnector(null);
		for (const session of Array.from(this.#sessions.values())) {
			session.end(false, message);
		}
	}
}
