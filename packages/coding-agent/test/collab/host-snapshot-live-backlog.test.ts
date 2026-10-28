/**
 * Contract: a guest joining a busy session never ends the room.
 *
 * A large session's welcome snapshot is one lazy batch that holds the head of
 * the host's shared FIFO for as long as the uplink takes to drain it. Every
 * live frame the agent emits meanwhile — tool events, entries, state — queues
 * behind it as its own entry and must not trip the send queue's admission cap,
 * which would end sharing for every guest (#17286).
 *
 * Drives the production `CollabHost` over the in-memory relay.
 */
import { afterEach, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type {
	AgentSessionEvent,
	AgentSessionEventListener,
} from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import {
	type HostObservations,
	instrumentRelay,
	makeHostContext,
	makeSnapshot,
	waitFor,
} from "./helpers/throttled-host";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	uninstallInMemoryRelay();
});

it("queues a busy agent's live frames behind a draining welcome snapshot instead of ending the room", async () => {
	const relay = installInMemoryRelay();
	// Throttled: the first 512 KB snapshot chunk crosses the high-water mark and
	// nothing drains it until the test says so — a snapshot still in flight.
	const probe = instrumentRelay(relay, { throttle: true });
	const snapshot = makeSnapshot();
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const ctx = makeHostContext(snapshot, seen);
	const listeners: AgentSessionEventListener[] = [];
	const subscribe = ctx.session.subscribe.bind(ctx.session);
	ctx.session.subscribe = listener => {
		listeners.push(listener);
		return subscribe(listener);
	};
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners.slice()) listener(event);
	};
	const host = new CollabHost(ctx);
	cleanups.push(() => void host.stop("test done"));

	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const hostWs = probe.hostSocket();

	const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => guest.close());
	const received: CollabFrame[] = [];
	guest.onFrame = (frame: CollabFrame) => received.push(frame);
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "joiner" });
	guest.connect();
	await waitFor(() => received.some(frame => frame.t === "welcome"), "guest never received its welcome");
	await waitFor(() => seen.participantCounts.some(count => count > 0), "host never registered the guest");
	// The snapshot is stuck mid-drain, as on a slow relay.
	expect(received.some(frame => frame.t === "snapshot-chunk" && frame.final)).toBe(false);

	// A busy agent: many short tool calls while the snapshot drains, none of
	// them a supersedable `message_update`.
	const calls = 400;
	for (let i = 0; i < calls; i++) {
		emit({ type: "tool_execution_start", toolCallId: `call-${i}`, toolName: "read", args: { path: `f${i}` } });
		emit({
			type: "tool_execution_end",
			toolCallId: `call-${i}`,
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
	}
	// Admission refusal ends the room synchronously inside the emitting call.
	expect(seen.notices.filter(notice => notice.includes("Collab ended"))).toEqual([]);

	const throttledSend = hostWs.send.bind(hostWs);
	hostWs.send = data => {
		throttledSend(data);
		hostWs.bufferedAmount = 0;
	};
	hostWs.bufferedAmount = 0;
	await waitFor(
		() =>
			received.filter(
				frame => frame.t === "event" && (frame.event as AgentSessionEvent).type === "tool_execution_end",
			).length === calls,
		"guest never received every tool event",
		10_000,
	);

	// The guest's replica completes before any live frame lands, and every live
	// frame arrives in emission order.
	const finalAt = received.findIndex(frame => frame.t === "snapshot-chunk" && frame.final);
	const firstLiveAt = received.findIndex(frame => frame.t === "event");
	expect(finalAt).toBeGreaterThan(-1);
	expect(firstLiveAt).toBeGreaterThan(finalAt);
	const toolCalls = received.flatMap(frame => {
		if (frame.t !== "event") return [];
		const event = frame.event as AgentSessionEvent;
		return event.type === "tool_execution_start" || event.type === "tool_execution_end"
			? [`${event.type}:${event.toolCallId}`]
			: [];
	});
	expect(toolCalls).toEqual(
		Array.from({ length: calls }, (_, i) => [
			`tool_execution_start:call-${i}`,
			`tool_execution_end:call-${i}`,
		]).flat(),
	);
	expect(seen.notices.filter(notice => notice.includes("Collab ended"))).toEqual([]);
}, 20_000);
