import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as dapModule from "@oh-my-pi/pi-coding-agent/dap";
import { DapClient, dapSessionManager, HOST_DAP_ADAPTER } from "@oh-my-pi/pi-coding-agent/dap";
import { RpcHostDebugBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-debug";
import { dispatchRpcControlFrame, type RpcInputFrameDeps } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcHostDapClose, RpcHostDapMessage } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { DebugTool, type DebugParams } from "@oh-my-pi/pi-coding-agent/tools/debug";

type HostFrame = RpcHostDapMessage | RpcHostDapClose;
type DapRequest = { seq: number; type: "request"; command: string; arguments?: Record<string, unknown> };

/**
 * Scripted editor host: answers the `debug` tool's DAP requests from its own
 * "session" (one thread, one frame, one scope, one variable), as an editor
 * would from the debugger it already runs.
 */
class FakeHost {
	readonly requests: DapRequest[] = [];
	readonly frames: HostFrame[] = [];
	readonly bridge: RpcHostDebugBridge;
	/** Commands the host leaves unanswered (to observe pending work). */
	readonly hold = new Set<string>();
	#seq = 1000;

	constructor() {
		this.bridge = new RpcHostDebugBridge(frame => {
			this.frames.push(frame);
			if (frame.type === "host_dap_message") queueMicrotask(() => this.#onMessage(frame));
		});
	}

	#send(sessionId: string, message: Record<string, unknown>): void {
		this.bridge.handleMessage({ type: "host_dap_message", sessionId, message: { seq: ++this.#seq, ...message } });
	}

	#event(sessionId: string, event: string, body?: unknown): void {
		this.#send(sessionId, { type: "event", event, ...(body === undefined ? {} : { body }) });
	}

	#onMessage(frame: RpcHostDapMessage): void {
		const request = frame.message as DapRequest;
		if (request.type !== "request") return;
		this.requests.push(request);
		if (this.hold.has(request.command)) return;
		const respond = (body?: unknown) =>
			this.#send(frame.sessionId, {
				type: "response",
				request_seq: request.seq,
				command: request.command,
				success: true,
				...(body === undefined ? {} : { body }),
			});
		const stopped = (reason: string) => this.#event(frame.sessionId, "stopped", { reason, threadId: 1 });
		switch (request.command) {
			case "initialize":
				respond({ supportsConfigurationDoneRequest: true, supportsTerminateRequest: true });
				this.#event(frame.sessionId, "initialized");
				return;
			case "setBreakpoints": {
				const breakpoints = (request.arguments?.breakpoints as Array<{ line: number }> | undefined) ?? [];
				respond({ breakpoints: breakpoints.map((bp, i) => ({ id: i + 1, verified: true, line: bp.line })) });
				return;
			}
			case "launch":
			case "attach":
				// The host's session is paused (entry, or the person's own breakpoint).
				respond();
				stopped("entry");
				return;
			case "continue":
				respond({ allThreadsContinued: true });
				stopped("breakpoint");
				return;
			case "next":
				respond();
				stopped("step");
				return;
			case "pause":
				respond();
				stopped("pause");
				return;
			case "threads":
				respond({ threads: [{ id: 1, name: "main" }] });
				return;
			case "stackTrace":
				respond({
					stackFrames: [{ id: 7, name: "main", line: 42, column: 1, source: { path: "/host/src/main.c" } }],
					totalFrames: 1,
				});
				return;
			case "scopes":
				respond({ scopes: [{ name: "Locals", variablesReference: 11, expensive: false }] });
				return;
			case "variables":
				respond({ variables: [{ name: "answer", value: "42", type: "int", variablesReference: 0 }] });
				return;
			case "terminate":
				respond();
				this.#event(frame.sessionId, "terminated");
				return;
			default:
				respond();
		}
	}

	/** The person resumes the shared session from the editor's own debugger UI. */
	resumeFromEditor(): void {
		const sessionId = this.frames[0]?.sessionId ?? "";
		this.#event(sessionId, "continued", { threadId: 1, allThreadsContinued: true });
	}

	commands(): string[] {
		return this.requests.map(request => request.command);
	}
}

function makeTool(): DebugTool {
	const session: ToolSession = {
		cwd: "/host",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "debug.enabled": true }),
	};
	return new DebugTool(session);
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => block.text ?? "").join("\n");
}

let host: FakeHost | undefined;

afterEach(async () => {
	await dapSessionManager.terminate().catch(() => undefined);
	host?.bridge.close("test finished");
	host = undefined;
	vi.restoreAllMocks();
});

describe("RpcHostDebugBridge", () => {
	it("routes every debug action to the host session and never spawns an adapter", async () => {
		const spawn = spyOn(DapClient, "spawn");
		host = new FakeHost();
		host.bridge.setEnabled(true);
		const tool = makeTool();
		const run = (params: DebugParams) => tool.execute("call", params);

		// The program does not exist locally: the host, not OMP, resolves it.
		await run({ action: "launch", program: "build/app" });
		const launch = host.requests.find(request => request.command === "launch");
		expect(launch?.arguments).toMatchObject({ program: "/host/build/app", cwd: "/host" });

		await run({ action: "set_breakpoint", file: "src/main.c", line: 42 });
		const setBreakpoints = host.requests.findLast(request => request.command === "setBreakpoints");
		expect(setBreakpoints?.arguments).toMatchObject({
			source: { path: "/host/src/main.c" },
			breakpoints: [{ line: 42 }],
		});

		const stoppedAt = await run({ action: "continue" });
		expect(stoppedAt.details?.state).toBe("stopped");
		expect(text(await run({ action: "threads" }))).toContain("main");
		expect(text(await run({ action: "stack_trace" }))).toContain("main.c");
		expect(text(await run({ action: "scopes", frame_id: 7 }))).toContain("Locals");
		expect(text(await run({ action: "variables", variable_ref: 11 }))).toContain("answer");
		expect((await run({ action: "step_over" })).details?.state).toBe("stopped");
		host.resumeFromEditor();
		await Bun.sleep(0);
		const paused = await run({ action: "pause" });
		expect(paused.details?.snapshot?.status).toBe("stopped");
		await run({ action: "remove_breakpoint", file: "src/main.c", line: 42 });
		const cleared = host.requests.findLast(request => request.command === "setBreakpoints");
		expect(cleared?.arguments?.breakpoints).toEqual([]);
		await run({ action: "terminate" });

		expect(host.commands()).toEqual(
			expect.arrayContaining([
				"initialize",
				"launch",
				"configurationDone",
				"setBreakpoints",
				"continue",
				"threads",
				"stackTrace",
				"scopes",
				"variables",
				"next",
				"pause",
				"terminate",
			]),
		);
		expect(host.frames.at(-1)).toMatchObject({ type: "host_dap_close" });
		expect(spawn).not.toHaveBeenCalled();
	});

	it("attaches to the host's running session without a pid or port", async () => {
		const spawn = spyOn(DapClient, "spawn");
		host = new FakeHost();
		host.bridge.setEnabled(true);
		await makeTool().execute("call", { action: "attach" });
		expect(host.commands()).toContain("attach");
		expect(spawn).not.toHaveBeenCalled();
	});

	it("fails the pending debug request when the host ends its session", async () => {
		host = new FakeHost();
		host.bridge.setEnabled(true);
		const tool = makeTool();
		await tool.execute("call", { action: "attach" });
		host.hold.add("stackTrace");
		const pending = tool.execute("call", { action: "stack_trace" });
		await Bun.sleep(0);
		const sessionId = host.frames[0]?.sessionId ?? "";
		expect(host.bridge.handleClose({ type: "host_dap_close", sessionId, error: "editor stopped debugging" })).toBe(
			true,
		);
		await expect(pending).rejects.toThrow("editor stopped debugging");
	});

	it("spawns the local adapter again once the host withdraws", async () => {
		host = new FakeHost();
		host.bridge.setEnabled(true);
		host.bridge.setEnabled(false);
		spyOn(dapModule, "selectAttachAdapter").mockReturnValue({ ...HOST_DAP_ADAPTER, name: "lldb-dap" });
		const spawn = spyOn(DapClient, "spawn").mockRejectedValue(new Error("spawned local adapter"));
		await expect(makeTool().execute("call", { action: "attach", pid: 1234 })).rejects.toThrow(
			"spawned local adapter",
		);
		expect(spawn.mock.calls[0]?.[0].adapter.name).toBe("lldb-dap");
		expect(host.frames).toEqual([]);
	});
});

describe("dispatchRpcControlFrame", () => {
	it("hands host_dap frames to the debug bridge ahead of the command queue", () => {
		const received: HostFrame[] = [];
		const deps: RpcInputFrameDeps = {
			handleCommand: async () => {
				throw new Error("host_dap frames are not commands");
			},
			output: () => {},
			errorResponse: (id, command, message) => ({ id, type: "response", command, success: false, error: message }),
			pendingExtensionRequests: new Map(),
			onHostToolResult: () => {},
			onHostToolUpdate: () => {},
			onHostUriResult: () => {},
			onHostDapFrame: frame => received.push(frame),
		};
		const message = {
			type: "host_dap_message",
			sessionId: "s1",
			message: { seq: 1, type: "event", event: "stopped" },
		};
		const close = { type: "host_dap_close", sessionId: "s1" };
		expect(dispatchRpcControlFrame(message, deps)).toBe(true);
		expect(dispatchRpcControlFrame(close, deps)).toBe(true);
		expect(received).toEqual([message, close] as HostFrame[]);
	});
});
