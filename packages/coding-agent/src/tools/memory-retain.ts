import { t } from "@oh-my-pi/pi-utils/i18n";
import type { MemoryRetainDetails } from "@oh-my-pi/pi-tui/tools/memory";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt, withLoopPhase } from "@oh-my-pi/pi-utils";
import { isHindsightConfigured, loadHindsightConfig } from "../hindsight/config";
import retainDescription from "../prompts/tools/retain.md" with { type: "text" };
import type { ToolSession } from ".";

import { cfgMemoryBackend } from "../memory-backend/settings";
import { isGlobalMemoryScopeAvailable } from "../mnemopi/settings";

const memoryRetainSchemaBase = type({
	items: type({
		content: type("string").describe("information to remember"),
		"context?": type("string").describe("source context"),
	})
		.array()
		.atLeastLength(1)
		.describe("memories to retain"),
});

/** Offered only where a shared bank exists; see {@link isGlobalMemoryScopeAvailable}. */
const memoryRetainSchemaWithScope = type({
	items: type({
		content: type("string").describe("information to remember"),
		"context?": type("string").describe("source context"),
		"scope?": type("'project' | 'global'").describe(
			"storage scope; defaults to project, global is for durable cross-project knowledge",
		),
	})
		.array()
		.atLeastLength(1)
		.describe("memories to retain"),
});

type MemoryRetainSchema = typeof memoryRetainSchemaBase | typeof memoryRetainSchemaWithScope;

export type MemoryRetainParams = typeof memoryRetainSchemaWithScope.infer;
export class MemoryRetainTool implements AgentTool<MemoryRetainSchema, MemoryRetainDetails> {
	readonly name = "retain";
	/** A global item reaches every project's recall, so it needs the same approval as a file write. */
	readonly approval = (args: unknown) =>
		(args as Partial<MemoryRetainParams>).items?.some(item => item.scope === "global") ? "write" : "read";
	readonly label = t("Retain");
	get description(): string {
		return prompt.render(retainDescription, { globalScope: isGlobalMemoryScopeAvailable(this.session.settings) });
	}
	get parameters(): MemoryRetainSchema {
		return isGlobalMemoryScopeAvailable(this.session.settings) ? memoryRetainSchemaWithScope : memoryRetainSchemaBase;
	}
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Store important facts in long-term memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRetainTool | null {
		const backend = cfgMemoryBackend.get(session.settings);
		if (backend !== "hindsight" && backend !== "mnemopi") return null;
		if (backend === "hindsight" && !isHindsightConfigured(loadHindsightConfig(session.settings))) return null;
		return new MemoryRetainTool(session);
	}

	async execute(_id: string, params: MemoryRetainParams): Promise<AgentToolResult<MemoryRetainDetails>> {
		const backend = cfgMemoryBackend.get(this.session.settings);
		if (backend === "mnemopi") {
			const state = this.session.getMnemopiSessionState?.();
			if (!state) {
				throw new Error(t("Mnemopi backend is not initialised for this session."));
			}
			return withLoopPhase("mnemopi.retain", () => {
				// Resolve the global bank first, so an unsupported scoping mode rejects the batch before any item is stored.
				const globalTarget = params.items.some(item => item.scope === "global")
					? state.getGlobalRetainTarget()
					: undefined;

				// A failed write stored nothing. Stop there and say why, and what the batch
				// kept, so the caller retries only what failed instead of trusting a
				// success count.
				const storedIds: string[] = [];
				for (const [index, item] of params.items.entries()) {
					let id: string;
					try {
						id = state.rememberScoped(
							item.content,
							{
								source: "coding-agent-retain",
								importance: 0.75,
								metadata: {
									session_id: state.sessionId,
									cwd: state.session.sessionManager.getCwd(),
									context: item.context ?? null,
									tool: "retain",
								},
								scope: "bank",
								extract: true,
								extractEntities: true,
								veracity: "tool",
								memoryType: "fact",
							},
							item.scope === "global" ? globalTarget : undefined,
						);
					} catch (error) {
						const reason = error instanceof Error ? error.message : String(error);
						const kept =
							storedIds.length === 0
								? t("Nothing was stored.")
								: t("Stored before the failure and kept: {0}.", `${storedIds.map((storedId, storedIndex) => t("item {0} (id {1})", `${storedIndex + 1}`, `${storedId}`)).join(", ")}`);
						const untried = index + 1 < params.items.length ? t(" Later items were not attempted.") : "";
						throw new Error(
							t("Mnemopi did not store item {1} of {0}: {2}. {3}{4}", `${params.items.length}`, `${index + 1}`, `${reason}`, `${kept}`, `${untried}`),
							{ cause: error },
						);
					}
					storedIds.push(id);
				}

				const count = params.items.length;
				const noun = t("memory");
				return {
					content: [{ type: "text", text: t("{1} {0} stored.", `${noun}`, `${count}`) }],
					details: { count },
				};
			});
		}

		const state = this.session.getHindsightSessionState?.();
		if (!state) {
			throw new Error(t("Hindsight backend is not initialised for this session."));
		}
		if (params.items.some(item => item.scope === "global")) {
			throw new Error(t("Global memory scope is only available with the Mnemopi backend."));
		}

		// Push every item onto the session-owned queue and return immediately.
		// The queue flushes either when it reaches its batch threshold or when
		// its debounce timer fires. If the eventual batch fails, the queue
		// surfaces a UI-only warning notice — the LLM is not informed.
		for (const item of params.items) {
			state.enqueueRetain(item.content, item.context);
		}

		const count = params.items.length;
		const noun = t("memory");
		return {
			content: [{ type: "text", text: t("{1} {0} queued.", `${noun}`, `${count}`) }],
			details: { count },
		};
	}
}
