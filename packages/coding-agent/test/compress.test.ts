import { describe, expect, type Mock, spyOn, test } from "bun:test";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resolveCliArgv } from "@oh-my-pi/pi-coding-agent/cli-commands";
import { resolveCompressTargets, runCompressCommand } from "@oh-my-pi/pi-coding-agent/compress/index";
import { CompressProtocol } from "@oh-my-pi/pi-coding-agent/compress/protocol";
import * as compressSession from "@oh-my-pi/pi-coding-agent/compress/session";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

const SOURCE = "The timeout parameter defaults to thirty seconds when no value is supplied by the caller.";
const PACKAGE_ROOT = path.join(import.meta.dir, "..");

describe("compress protocol", () => {
	test("approve before any draft is rejected", () => {
		const protocol = new CompressProtocol(SOURCE);
		expect(() => protocol.accept("looks fine")).toThrow(/Call rewrite before approve/);
		expect(protocol.approved).toBe(false);
	});

	test("approve is gated on the review turn for the newest draft", () => {
		const protocol = new CompressProtocol(SOURCE);
		protocol.submit("Default 30s.", []);

		expect(() => protocol.accept("premature")).toThrow(/has not been reviewed/);
		expect(protocol.approved).toBe(false);

		protocol.markReviewed(1);
		expect(protocol.accept("reviewed and correct").round).toBe(1);
		expect(protocol.approved).toBe(true);
		expect(protocol.verdict).toBe("reviewed and correct");
	});

	test("a new draft supersedes an approval and needs its own review", () => {
		const protocol = new CompressProtocol(SOURCE);
		protocol.submit("Default 30s.", []);
		protocol.markReviewed(1);
		protocol.accept("accepted");

		protocol.submit("timeout: default 30s.", []);
		expect(protocol.approved).toBe(false);
		expect(protocol.verdict).toBeUndefined();
		expect(protocol.rounds).toBe(2);
		expect(protocol.latest?.round).toBe(2);
		expect(() => protocol.accept("again")).toThrow(/has not been reviewed/);
	});

	test("declared losses are copied onto the draft", () => {
		const protocol = new CompressProtocol(SOURCE);
		const losses = [{ content: "when no value is supplied by the caller", reason: "implied by default" }];
		const draft = protocol.submit("Default 30s.", losses);
		losses[0] = { content: "mutated", reason: "mutated" };
		expect(draft.losses).toEqual([
			{ content: "when no value is supplied by the caller", reason: "implied by default" },
		]);
	});

	test("metrics measure the draft against the source and report growth as a negative ratio", () => {
		const protocol = new CompressProtocol(SOURCE);
		const shrunk = protocol.metrics({ round: 1, text: "Default 30s.", losses: [] });
		expect(shrunk.sourceWords).toBe(15);
		expect(shrunk.draftWords).toBe(2);
		expect(shrunk.draftTokens).toBeLessThan(shrunk.sourceTokens);
		expect(shrunk.ratio).toBeGreaterThan(0);

		const grown = protocol.metrics({ round: 1, text: `${SOURCE} ${SOURCE}`, losses: [] });
		expect(grown.ratio).toBeLessThan(0);
	});

	test("an empty source yields zero sizes instead of dividing by zero", () => {
		const protocol = new CompressProtocol("");
		expect(protocol.sourceWords).toBe(0);
		expect(protocol.sourceTokens).toBe(0);
		expect(protocol.metrics({ round: 1, text: "anything", losses: [] }).ratio).toBe(0);
	});
});

describe("compress targets", () => {
	test("expands globs, dedupes overlapping patterns, and sorts", async () => {
		const targets = await resolveCompressTargets(["src/compress/*.ts", "src/compress/types.ts"], PACKAGE_ROOT);
		expect(targets).toEqual([...targets].sort());
		expect(targets.filter(target => target.endsWith("types.ts"))).toHaveLength(1);
		expect(targets.some(target => target.endsWith("protocol.ts"))).toBe(true);
	});

	test("a pattern matching nothing fails loudly", async () => {
		await expect(resolveCompressTargets(["src/compress/*.nope"], PACKAGE_ROOT)).rejects.toThrow(/No files matched/);
	});

	test("a missing literal path fails instead of being skipped", async () => {
		await expect(resolveCompressTargets(["definitely-not-here.md"], PACKAGE_ROOT)).rejects.toThrow(/Not a file/);
	});
});

describe("compress command", () => {
	test("keeps fallback across actual automatic draft-review rounds", async () => {
		const tempDir = TempDir.createSync("@pi-compress-fallback-");
		const sourcePath = tempDir.join("source.txt");
		const outputPath = tempDir.join("compressed.txt");
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const fallback = getBundledModel("openai-codex", "gpt-5.6-sol")!;
		const primaryId = `${primary.provider}/${primary.id}`;
		const fallbackId = `${fallback.provider}/${fallback.id}`;
		const requested: string[] = [];
		const mock = createMockModel({
			responses: [
				{ throw: "rate limit exceeded retry-after-ms=60000" },
				{ content: [{ type: "toolCall", name: "rewrite", arguments: { text: "Default 30s.", losses: [] } }] },
				{ content: ["Ready for review."] },
				{
					content: [
						{ type: "toolCall", name: "rewrite", arguments: { text: "Timeout: default 30s.", losses: [] } },
					],
				},
				{ content: ["Ready for another review."] },
				{ content: [{ type: "toolCall", name: "approve", arguments: { verdict: "Preserves the default." } }] },
				{ content: ["Approved."] },
			],
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime(primary.provider, "primary-test-key");
		authStorage.keys.setRuntime(fallback.provider, "fallback-test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": { default: [`${fallbackId}:low`] },
			"retry.fallbackRevertPolicy": "next-turn",
		});
		settings.setModelRole("default", primaryId);
		let session: AgentSession | undefined;
		let promptSpy: Mock<AgentSession["prompt"]> | undefined;
		// Replace only session discovery/configuration. The command, real AgentSession,
		// fallback machinery, agent loop, and both compressor protocol tools run normally.
		const factorySpy = spyOn(compressSession, "createCompressSession").mockImplementation(async options => {
			const created = await createAgentSession({
				cwd: tempDir.path(),
				settings,
				authStorage,
				modelRegistry,
				model: primary,
				sessionManager: SessionManager.inMemory(tempDir.path()),
				cacheWarming: false,
				customTools: [options.protocol.rewriteTool(), options.protocol.approveTool()],
				toolNames: ["rewrite", "approve"],
				restrictToolNames: true,
				allowRestrictedCustomTools: true,
				systemPrompt: ["Compress the source; use rewrite, then approve only after review."],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableIrc: false,
				enableLsp: false,
				hasUI: false,
				autoApprove: true,
				agentId: options.agentId,
			});
			session = created.session;
			session.agent.streamFn = (model, context, streamOptions) => {
				requested.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, streamOptions);
			};
			promptSpy = spyOn(session, "prompt");
			return { session, model: primaryId };
		});
		try {
			await initTheme();
			await Bun.write(sourcePath, SOURCE);
			const result = await runCompressCommand({
				files: [sourcePath],
				output: outputPath,
				maxRounds: 3,
				concurrency: 1,
			});
			expect(factorySpy).toHaveBeenCalledTimes(1);
			expect(promptSpy?.mock.calls.map(([, options]) => options?.admissionOrigin)).toEqual([
				"new-turn",
				"continuation",
				"continuation",
			]);
			expect(promptSpy?.mock.calls[1]?.[0]).toContain("# Review draft 1");
			expect(promptSpy?.mock.calls[2]?.[0]).toContain("# Review draft 2");
			expect(requested).toEqual([primaryId, ...Array(6).fill(fallbackId)]);
			expect(result.files[0]?.status).toBe("approved");
			expect(result.files[0]?.rounds).toBe(2);
			expect(result.files[0]?.verdict).toBe("Preserves the default.");
			expect(await Bun.file(outputPath).text()).toBe("Timeout: default 30s.\n");
		} finally {
			promptSpy?.mockRestore();
			factorySpy.mockRestore();
			await session?.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
	});

	test("rejects a non-positive round budget before opening a session", async () => {
		await expect(runCompressCommand({ files: ["missing.md"], maxRounds: 0 })).rejects.toThrow(
			/--rounds must be a positive integer/,
		);
	});

	test("rejects a non-positive concurrency", async () => {
		await expect(runCompressCommand({ files: ["missing.md"], concurrency: 0 })).rejects.toThrow(
			/--agents must be a positive integer/,
		);
	});

	test("rejects writing to two destinations at once", async () => {
		await expect(runCompressCommand({ files: ["missing.md"], inPlace: true, output: "out.md" })).rejects.toThrow(
			/mutually exclusive/,
		);
	});

	test("routes compress as a top-level command", () => {
		expect(resolveCliArgv(["compress", "notes.md", "-r", "2"])).toEqual({
			argv: ["compress", "notes.md", "-r", "2"],
		});
	});
});
