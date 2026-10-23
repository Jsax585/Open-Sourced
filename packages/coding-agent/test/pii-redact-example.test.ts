/**
 * Behavioral coverage for the pii-redact example extension.
 * Proves error-result scrubbing, multimodal block order, PAW fail-open
 * fallback, and structured provider payload redaction.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import piiRedactExtension, {
	buildPawArgs,
	mapTextBlocks,
	redactStructuredPayload,
	redactText,
	regexRedact,
} from "../examples/extensions/pii-redact";

const EXAMPLE_PATH = path.resolve(import.meta.dir, "../examples/extensions/pii-redact.ts");
const PLACEHOLDER = "[PII]";

describe("pii-redact example helpers", () => {
	it("buildPawArgs puts --placeholder before the redact subcommand", () => {
		expect(buildPawArgs("hi", PLACEHOLDER)).toEqual(["--placeholder", PLACEHOLDER, "redact", "--text", "hi"]);
	});

	it("regexRedact scrubs email/phone/ssn", () => {
		const input = "mail a@b.co phone 555-123-4567 ssn 123-45-6789";
		expect(regexRedact(input, PLACEHOLDER)).toBe(`mail ${PLACEHOLDER} phone ${PLACEHOLDER} ssn ${PLACEHOLDER}`);
	});

	it("treats replacement tokens in configured placeholders literally", () => {
		for (const placeholder of ["$&", "$`", "$'", "$$", "[PII $&]"]) {
			expect(regexRedact("a@b.co | 555-123-4567 | 123-45-6789", placeholder)).toBe(
				`${placeholder} | ${placeholder} | ${placeholder}`,
			);
		}
	});

	it("mapTextBlocks preserves multimodal block order", () => {
		const content = [
			{ type: "text", text: "before a@b.co" },
			{ type: "image", url: "img://1" },
			{ type: "text", text: "after 555-123-4567" },
		];
		const mapped = mapTextBlocks(content, text => regexRedact(text, PLACEHOLDER)) as Array<Record<string, unknown>>;
		expect(mapped).toEqual([
			{ type: "text", text: `before ${PLACEHOLDER}` },
			{ type: "image", url: "img://1" },
			{ type: "text", text: `after ${PLACEHOLDER}` },
		]);
	});

	it("redactStructuredPayload walks provider request objects", () => {
		const payload = {
			model: "gpt",
			input: [{ role: "user", content: "reach me at secret@example.com" }],
			tools: [{ name: "bash", arguments: { cmd: "echo 123-45-6789" } }],
		};
		expect(redactStructuredPayload(payload, PLACEHOLDER)).toEqual({
			model: "gpt",
			input: [{ role: "user", content: `reach me at ${PLACEHOLDER}` }],
			tools: [{ name: "bash", arguments: { cmd: `echo ${PLACEHOLDER}` } }],
		});
	});

	it("preserves binary and non-plain provider values without copying them", () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const buffer = new ArrayBuffer(4);
		const view = new DataView(buffer);
		const date = new Date(0);
		const payload = { bytes, buffer, view, date, nested: [{ text: "a@b.co" }] };
		const redacted = redactStructuredPayload(payload, PLACEHOLDER) as typeof payload;
		expect(redacted.bytes).toBe(bytes);
		expect(redacted.buffer).toBe(buffer);
		expect(redacted.view).toBe(view);
		expect(redacted.date).toBe(date);
		expect(redacted.nested).toEqual([{ text: PLACEHOLDER }]);
		expect(payload.nested).toEqual([{ text: "a@b.co" }]);
	});

	it("continues walking null-prototype JSON records", () => {
		const record = Object.assign(Object.create(null), { email: "a@b.co" });
		expect(redactStructuredPayload({ record }, PLACEHOLDER)).toEqual({ record: { email: PLACEHOLDER } });
	});

	it("redactText falls back to regex when PAW exec throws", async () => {
		const previous = process.env.PAW_PII_CMD;
		process.env.PAW_PII_CMD = "missing-paw-binary-that-does-not-exist";
		const warn = vi.fn();
		const pi = {
			exec: async () => {
				throw new Error("spawn ENOENT");
			},
			logger: { warn },
		} as unknown as ExtensionAPI;
		try {
			const out = await redactText(pi, "write a@b.co", PLACEHOLDER);
			expect(out).toBe(`write ${PLACEHOLDER}`);
			expect(warn).toHaveBeenCalled();
			const first = warn.mock.calls[0]?.[1];
			expect(first).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.PAW_PII_CMD;
			else process.env.PAW_PII_CMD = previous;
		}
	});

	it("redactText falls back without logging detector stderr", async () => {
		const previous = process.env.PAW_PII_CMD;
		process.env.PAW_PII_CMD = "paw-pii";
		const warn = vi.fn();
		const pi = {
			exec: async () => ({
				code: 2,
				stdout: "",
				stderr: "ECHOED_SECRET a@b.co",
				killed: false,
			}),
			logger: { warn },
		} as unknown as ExtensionAPI;
		try {
			const out = await redactText(pi, "ssn 123-45-6789", PLACEHOLDER);
			expect(out).toBe(`ssn ${PLACEHOLDER}`);
			expect(JSON.stringify(warn.mock.calls)).not.toContain("ECHOED_SECRET");
			expect(JSON.stringify(warn.mock.calls)).not.toContain("a@b.co");
			expect(warn.mock.calls[0]?.[1]).toEqual({ code: 2, killed: false });
		} finally {
			if (previous === undefined) delete process.env.PAW_PII_CMD;
			else process.env.PAW_PII_CMD = previous;
		}
	});
});

describe("pii-redact example extension events", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	afterEach(() => {
		authStorage?.close();
		tempDir?.removeSync();
		delete process.env.PAW_PII_DISABLE;
	});

	async function loadExampleRunner() {
		tempDir = TempDir.createSync("@pii-redact-ex-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		const extensionsDir = path.join(tempDir.path(), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const dest = path.join(extensionsDir, "pii-redact.ts");
		fs.copyFileSync(EXAMPLE_PATH, dest);
		const result = await loadExtensions([dest], tempDir.path());
		expect(result.errors).toEqual([]);
		const sessionManager = SessionManager.inMemory();
		return new ExtensionRunner(result.extensions, result.runtime, tempDir.path(), sessionManager, modelRegistry);
	}

	it("scrubs failed tool_result content", async () => {
		const runner = await loadExampleRunner();
		const replaced = await runner.emitToolResult({
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "cat secrets" },
			content: [{ type: "text", text: "Permission denied for a@b.co" }],
			details: undefined,
			isError: true,
		});
		expect(replaced?.content).toEqual([{ type: "text", text: `Permission denied for ${PLACEHOLDER}` }]);
	});

	it("scrubs persisted tool details while preserving binary metadata", async () => {
		const runner = await loadExampleRunner();
		const binary = new Uint8Array([1, 2, 3]);
		const details = {
			customInput: "reply to alice@example.org",
			fields: [{ note: "call 555-123-4567", ssn: "123-45-6789" }],
			binary,
		};
		const replaced = await runner.emitToolResult({
			type: "tool_result",
			toolName: "Ask",
			toolCallId: "ask1",
			input: {},
			content: [{ type: "text", text: "saved" }],
			details,
			isError: false,
		} as never);
		const redacted = replaced?.details as typeof details;
		expect(redacted.customInput).toBe(`reply to ${PLACEHOLDER}`);
		expect(redacted.fields).toEqual([{ note: `call ${PLACEHOLDER}`, ssn: PLACEHOLDER }]);
		expect(redacted.binary).toBe(binary);
		expect(details.customInput).toBe("reply to alice@example.org");
		expect(details.fields[0]?.note).toBe("call 555-123-4567");
	});

	it("does not change tool details when example redaction is disabled", async () => {
		process.env.PAW_PII_DISABLE = "1";
		const runner = await loadExampleRunner();
		const replaced = await runner.emitToolResult({
			type: "tool_result",
			toolName: "Ask",
			toolCallId: "ask-disabled",
			input: {},
			content: [{ type: "text", text: "visible a@b.co" }],
			details: { customInput: "alice@example.org" },
			isError: false,
		} as never);
		expect(replaced).toBeUndefined();
	});

	it("keeps text/image/text order on context rewrite", async () => {
		const runner = await loadExampleRunner();
		const messages = await runner.emitContext([
			{
				role: "user",
				content: [
					{ type: "text", text: "see a@b.co" },
					{ type: "image", mimeType: "image/png", data: "abc" },
					{ type: "text", text: "then 555-123-4567" },
				],
				timestamp: Date.now(),
			} as never,
		]);
		const content = (messages[0] as { content: unknown[] }).content;
		expect(content[0]).toEqual({ type: "text", text: `see ${PLACEHOLDER}` });
		expect(content[1]).toMatchObject({ type: "image" });
		expect(content[2]).toEqual({ type: "text", text: `then ${PLACEHOLDER}` });
	});

	it("redacts structured before_provider_request payloads", async () => {
		const runner = await loadExampleRunner();
		const payload = await runner.emitBeforeProviderRequest({
			messages: [{ role: "user", content: "call secret@example.com" }],
			system: "never leak 123-45-6789",
		});
		expect(payload).toEqual({
			messages: [{ role: "user", content: `call ${PLACEHOLDER}` }],
			system: `never leak ${PLACEHOLDER}`,
		});
	});

	it("preserves provider binary fields through the registered request handler", async () => {
		const runner = await loadExampleRunner();
		const bytes = new Uint8Array([1, 2, 3]);
		const payload = (await runner.emitBeforeProviderRequest({
			conversationState: { rootPromptMessagesJson: bytes },
			system: "contact a@b.co",
		})) as { conversationState: { rootPromptMessagesJson: Uint8Array }; system: string };
		expect(payload.conversationState.rootPromptMessagesJson).toBe(bytes);
		expect(payload.system).toBe(`contact ${PLACEHOLDER}`);
	});

	it("registers via default export factory", () => {
		const commands: string[] = [];
		const handlers: string[] = [];
		const pi = {
			setLabel: () => {},
			registerCommand: (name: string) => {
				commands.push(name);
			},
			on: (event: string) => {
				handlers.push(event);
			},
		} as unknown as ExtensionAPI;
		piiRedactExtension(pi);
		expect(commands).toContain("pii");
		expect(handlers).toEqual(["tool_result", "context", "before_provider_request"]);
	});
});
