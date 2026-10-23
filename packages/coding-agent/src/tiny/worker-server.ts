import { type JsonLineReply, JsonLineServer } from "../subprocess/jsonl-server";
import type { TinyWorkerRequest, TinyWorkerResponse } from "./title-protocol";

/** Marker symbol attached to errors caused by bad request payloads rather than broken models. */
export const REQUEST_SCOPED_ERROR = Symbol.for("omp.tiny.requestScopedError");

export interface RequestScopedError extends Error {
	requestScoped?: boolean;
	[REQUEST_SCOPED_ERROR]?: boolean;
}

/** Check whether an error carries a request-scoped validation marker. */
export function isRequestScopedError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as Record<string | symbol, unknown>;
	return candidate.requestScoped === true || candidate[REQUEST_SCOPED_ERROR] === true;
}

/** Mark an error as request-scoped so worker failures do not poison model availability. */
export function markRequestScoped<T extends Error>(error: T): T {
	(error as unknown as Record<string | symbol, unknown>).requestScoped = true;
	(error as unknown as Record<string | symbol, unknown>)[REQUEST_SCOPED_ERROR] = true;
	return error;
}

export interface TinyWorkerServerOptions {
	/** Launch identity echoed in `pong`; clients replace a worker whose tag differs. */
	tag: string;
	/** Idle window (nothing in flight, no request received) after which the process exits. */
	idleMs: number;
	/** Serve one `load`/`chat`/`judge`; `reply.send` reaches only the requesting client. Errors become `error` replies. */
	handle(
		request: Extract<TinyWorkerRequest, { type: "load" | "chat" | "judge" }>,
		reply: JsonLineReply<TinyWorkerResponse>,
	): Promise<void>;
}

/** The ONNX worker's endpoint: answers `ping`/`shutdown` inline and serializes `load`/`chat` through one queue. */
export class TinyWorkerServer {
	#options: TinyWorkerServerOptions;
	#queue = Promise.resolve();
	#server: JsonLineServer<TinyWorkerRequest, TinyWorkerResponse>;

	constructor(options: TinyWorkerServerOptions) {
		this.#options = options;
		this.#server = new JsonLineServer({
			name: "tiny-worker",
			cleanupLabel: "tiny-worker",
			idleMs: options.idleMs,
			banner: endpoint => `omp tiny worker listening on ${endpoint}`,
			onRequest: (request, reply) => this.#dispatch(request, reply),
		});
	}

	/** Bind `endpoint` and serve until idle exit or `shutdown`; resolves once the socket is released. */
	serve(endpoint: string): Promise<void> {
		return this.#server.serve(endpoint);
	}

	#dispatch(request: TinyWorkerRequest, reply: JsonLineReply<TinyWorkerResponse>): void {
		if (request.type === "ping") {
			reply.send({ type: "pong", id: request.id, tag: this.#options.tag });
			return;
		}
		if (request.type === "shutdown") {
			this.#server.exit("shutdown requested");
			return;
		}
		const run = async (): Promise<void> => {
			try {
				await this.#options.handle(request, reply);
			} catch (error) {
				const isRequestScoped = isRequestScopedError(error);
				reply.send({
					type: "error",
					id: request.id,
					error: error instanceof Error ? (error.stack ?? error.message) : String(error),
					...(isRequestScoped ? { fatal: false } : {}),
				});
			}
		};
		this.#queue = this.#server.busy(() => this.#queue.then(run, run));
	}
}
