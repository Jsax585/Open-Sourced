import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { encodeStream } from "@oh-my-pi/pi-ai/providers/anthropic-messages-server";
import { ConnectFrameDecoder, frameConnectMessage } from "@oh-my-pi/pi-ai/providers/connect-frame";
import { buildGrpcRequest, streamCursor, type ToolCallState } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model, Tool, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	type AgentClientMessage,
	AgentClientMessageSchema,
	type AgentRunRequest,
	type AgentServerMessage,
	AgentServerMessageSchema,
	ConversationStateStructureSchema,
	ExecServerMessageSchema,
	InteractionUpdateSchema,
	ReadArgsSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, decodeJsonValue, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

const readTool: Tool = {
	name: "read",
	description: "client-schema-canary",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

function model(baseUrl = ""): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-external-fixture",
		name: "Cursor external fixture",
		provider: "cursor",
		api: "cursor-agent",
		baseUrl,
		reasoning: false,
		input: ["text"],
		contextWindow: 100000,
		maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

function frame(message: AgentServerMessage["message"]): Buffer {
	return frameConnectMessage(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message })));
}

function readFrame(id: string): Buffer {
	return frame({
		case: "execServerMessage",
		value: create(ExecServerMessageSchema, {
			id: 1,
			execId: id,
			message: {
				case: "readArgs",
				value: create(ReadArgsSchema, {
					path: "README.md",
					offset: 12,
					limit: 4,
					toolCallId: id,
				}),
			},
		}),
	});
}

function completeFrames(): Buffer {
	return Buffer.concat([
		frame({
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "done" }) },
			}),
		}),
		frame({
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
			}),
		}),
	]);
}

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();
afterEach(() => {
	for (const session of sessions) session.destroy();
	sessions.clear();
	server?.close();
	server = undefined;
});

async function fixture(script: (request: AgentRunRequest, index: number) => Buffer) {
	const requests: AgentRunRequest[] = [];
	const replies: AgentClientMessage[] = [];
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		const decoder = new ConnectFrameDecoder();
		stream.on("data", (chunk: Buffer) => {
			for (const { payload } of decoder.decode(chunk)) {
				const message = fromBinary(AgentClientMessageSchema, payload);
				if (message.message.case !== "runRequest") {
					replies.push(message);
					continue;
				}
				requests.push(message.message.value);
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
				stream.write(script(message.message.value, requests.length - 1));
				stream.end();
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture did not bind a port");
	return { requests, replies, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("Cursor external handoff transport", () => {
	it("streams the exact read input through Anthropic, rotates after handoff and reuses ordinary turns", async () => {
		const { baseUrl, requests, replies } = await fixture((request, index) =>
			index === 1
				? Buffer.concat([
						frame({
							case: "conversationCheckpointUpdate",
							value: create(ConversationStateStructureSchema, {
								rootPromptMessagesJson: request.conversationState?.rootPromptMessagesJson,
								pendingToolCalls: ["read-external", "read-parallel"],
							}),
						}),
						readFrame("read-external"),
						readFrame("read-parallel"),
					])
				: completeFrames(),
		);
		const context: Context = { tools: [readTool], messages: [{ role: "user", content: "hello", timestamp: 1 }] };
		const options = { apiKey: "test-token", sessionId: crypto.randomUUID(), externalToolExecutor: true };
		const first = await streamCursor(model(baseUrl), context, options).result();
		expect(first.stopReason).toBe("stop");
		context.messages.push(first, { role: "user", content: "read the file", timestamp: 2 });

		const stream = streamCursor(model(baseUrl), context, options);
		const sse = await new Response(encodeStream(stream, "cursor-fixture")).text();
		const handoff = await stream.result();
		const events = sse
			.split("\n")
			.filter(line => line.startsWith("data: "))
			.map(line => JSON.parse(line.slice(6)));
		const starts = events.filter(
			event => event.type === "content_block_start" && event.content_block.type === "tool_use",
		);
		expect(starts.map(event => event.content_block.name)).toEqual(["read"]);
		const input = events
			.filter(event => event.type === "content_block_delta" && event.delta.type === "input_json_delta")
			.map(event => event.delta.partial_json)
			.join("");
		expect(JSON.parse(input)).toEqual({ path: "README.md:raw:12+4" });
		expect(events.find(event => event.type === "message_delta")?.delta.stop_reason).toBe("tool_use");
		expect(handoff.stopReason).toBe("toolUse");
		expect(handoff.content.filter(block => block.type === "toolCall").map(block => block.id)).toEqual([
			"read-external",
		]);
		expect(
			handoff.content
				.filter(block => block.type === "toolCall")
				.every(block => !(block as ToolCallState)[kCursorExecResolved]),
		).toBe(true);
		expect(replies.filter(message => message.message.case === "execClientMessage")).toEqual([]);

		const result: ToolResultMessage = {
			role: "toolResult",
			toolName: "read",
			toolCallId: "read-external",
			content: [{ type: "text", text: "client read result" }],
			isError: false,
			timestamp: 3,
		};
		context.messages.push(handoff, result);
		const third = await streamCursor(model(baseUrl), context, options).result();
		expect(third.stopReason).toBe("stop");
		context.messages.push(third, { role: "user", content: "thanks", timestamp: 4 });
		expect((await streamCursor(model(baseUrl), context, options).result()).stopReason).toBe("stop");
		expect(requests).toHaveLength(4);
		expect(requests[0].conversationId).toBe(options.sessionId);
		expect(requests[1].conversationId).toBe(requests[0].conversationId);
		expect(requests[2].conversationId).not.toBe(requests[1].conversationId);
		expect(requests[3].conversationId).toBe(requests[2].conversationId);
		expect(requests[2].conversationState?.pendingToolCalls).toEqual([]);

		// Decode reconstructed history and the advertised catalog at the protocol
		// boundary: the result must pair with CallDynamicTool, not a native read.
		const blobStore = new Map<string, Uint8Array>();
		const built = await buildGrpcRequest(model(), { ...context, messages: context.messages.slice(0, -2) }, options, {
			conversationId: "replay",
			blobStore,
		});
		const messages = built.conversationState.rootPromptMessagesJson.map(id =>
			JSON.parse(new TextDecoder().decode(blobStore.get(Buffer.from(id).toString("hex")))),
		);
		const call = messages
			.flatMap(message => (Array.isArray(message.content) ? message.content : []))
			.find(item => item.type === "tool-call");
		const replayedResult = messages
			.flatMap(message => (Array.isArray(message.content) ? message.content : []))
			.find(item => item.type === "tool-result");
		expect(call).toEqual({
			type: "tool-call",
			toolCallId: "read-external",
			toolName: "CallDynamicTool",
			args: { namespace: "pi-agent", toolName: "read", arguments: { path: "README.md:raw:12+4" } },
		});
		expect(replayedResult).toMatchObject({
			type: "tool-result",
			toolCallId: "read-external",
			toolName: "CallDynamicTool",
			result: "client read result",
		});
		for (const request of requests) {
			expect(request.mcpTools?.mcpTools.map(tool => tool.name)).toEqual(["pi-agent-read"]);
			expect(decodeJsonValue(request.mcpTools!.mcpTools[0].inputSchema)).toMatchObject({
				properties: { path: { type: "string" } },
				required: ["path"],
			});
		}
		expect(
			messages
				.filter(message => message.role === "system")
				.some(message => message.content.includes("client-schema-canary")),
		).toBe(false);
	});

	it("rebuilds trailing external tool results under a fresh conversation after a gateway restart", async () => {
		const { baseUrl, requests } = await fixture(() => completeFrames());
		const context: Context = { tools: [readTool], messages: [{ role: "user", content: "read", timestamp: 1 }] };
		const previous = await streamCursor(model(baseUrl), context, { apiKey: "test-token" }).result();
		previous.stopReason = "toolUse";
		previous.content = [{ type: "toolCall", id: "old-read", name: "read", arguments: { path: "README.md" } }];
		context.messages.push(previous, {
			role: "toolResult",
			toolCallId: "old-read",
			toolName: "read",
			content: [{ type: "text", text: "read before restart" }],
			isError: false,
			timestamp: 2,
		});
		const sessionId = crypto.randomUUID();
		expect(
			(
				await streamCursor(model(baseUrl), context, {
					apiKey: "test-token",
					sessionId,
					externalToolExecutor: true,
				}).result()
			).stopReason,
		).toBe("stop");
		expect(requests[1].conversationId).not.toBe(sessionId);
		expect(requests[1].conversationState?.pendingToolCalls).toEqual([]);
	});
});
