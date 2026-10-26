import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import {
	collectNativeReplayRegexSecretValues,
	obfuscateMessages,
	obfuscateNativeReplay,
} from "../src/secrets/message-transform";
import { SecretObfuscator } from "../src/secrets/obfuscator";

function assistant(secret: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: secret },
			{ type: "thinking", thinking: secret, thinkingSignature: "signature" },
			{
				type: "toolCall",
				id: "call",
				name: "read",
				arguments: { nested: [secret] },
				intent: secret,
				rawBlock: secret,
			},
		],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

describe("import context secret transformations", () => {
	it("redacts snapshot messages exactly like outbound messages without touching image bytes or source data", () => {
		const secret = "IMPORT_SECRET_123";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const image = { type: "image" as const, data: secret, mimeType: "image/png" };
		const messages: Message[] = [
			{ role: "user", content: [{ type: "text", text: secret }, image], timestamp: 1 },
			assistant(secret),
			{
				role: "toolResult",
				toolCallId: "call",
				toolName: "read",
				content: [{ type: "text", text: secret }],
				isError: false,
				timestamp: 3,
			},
		];
		const opaque = { type: "compaction", encrypted_content: secret };
		const original = {
			preserveData: { importedContext: { version: 1, messages }, unrelated: secret },
			providerPayload: { type: "openaiResponsesHistory" as const, provider: "openai", items: [opaque] },
		};
		const snapshot = structuredClone(original);
		const result = obfuscateNativeReplay(obfuscator, original, new Set());
		expect(result.preserveData.importedContext.messages).toEqual(obfuscateMessages(obfuscator, messages));
		expect(result.preserveData.importedContext.version).toBe(1);
		const user = result.preserveData.importedContext.messages[0];
		if (user?.role !== "user" || typeof user.content === "string") throw new Error("Missing user image");
		expect(user.content[1]).toBe(image);
		expect(result.providerPayload).toBe(original.providerPayload);
		expect(result.preserveData.unrelated).toBe(secret);
		expect(original).toEqual(snapshot);
		expect(obfuscateNativeReplay(obfuscator, result, new Set())).toBe(result);
	});

	it("includes snapshot regex secrets in outer batch collision protection", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);
		const replay = {
			role: "user" as const,
			content: "replacement",
			timestamp: 2,
			preserveData: { importedContext: { version: 1, messages: [assistant("tok_abc123")] } },
		};
		const values = new Set<string>();
		collectNativeReplayRegexSecretValues(obfuscator, replay, values);
		expect(values).toEqual(new Set(["tok_abc123"]));
		const messages: Message[] = [{ role: "user", content: "OTHERSECRET", timestamp: 1 }, replay];
		const result = obfuscateMessages(obfuscator, messages);
		expect(JSON.stringify(result)).not.toContain("tok_abc123");
		expect(JSON.stringify(result[0])).not.toContain("TOKABC123_");
		expect(obfuscateMessages(obfuscator, result)).toBe(result);
	});

	it("rejects malformed and unknown-version snapshots through core validation", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "fixture-secret" }]);
		for (const carrier of [
			{ version: 2, messages: [] },
			{ version: 1, messages: "invalid" },
		]) {
			const message = { preserveData: { importedContext: carrier } };
			expect(() => collectNativeReplayRegexSecretValues(obfuscator, message, new Set())).toThrow();
			expect(() => obfuscateNativeReplay(obfuscator, message, new Set())).toThrow();
		}
	});
});
