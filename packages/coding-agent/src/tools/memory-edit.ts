import { t } from "@oh-my-pi/pi-utils/i18n";
import { type } from "@oh-my-pi/omptype";
import { prompt } from "@oh-my-pi/pi-utils";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import memoryEditDescription from "../prompts/tools/memory-edit.md" with { type: "text" };
import { sessionMemoryToolRefs } from "../memory-backend/tool-names";
import type { ToolSession } from ".";

import { cfgMemoryBackend } from "../memory-backend/settings";

const memoryEditSchema = type({
	op: type("'update' | 'forget' | 'invalidate'").describe("memory edit operation"),
	id: type("string").describe("memory id from recall output"),
	"content?": type("string").describe("replacement content for update"),
	"importance?": type("number").describe("replacement importance for update (0–1)"),
	"replacement_id?": type("string").describe("replacement memory id for invalidate"),
});

export type MemoryEditParams = typeof memoryEditSchema.infer;

export class MemoryEditTool implements AgentTool<typeof memoryEditSchema> {
	readonly name = "memory_edit";
	readonly approval = "read" as const;
	readonly label = t("Memory Edit");
	get description(): string {
		return prompt.render(memoryEditDescription, {
			toolRefs: sessionMemoryToolRefs(this.session),
		});
	}
	readonly parameters = memoryEditSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Update, forget, or invalidate Mnemopi memories";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryEditTool | null {
		const backend = cfgMemoryBackend.get(session.settings);
		if (backend !== "mnemopi") return null;
		return new MemoryEditTool(session);
	}

	async execute(_id: string, params: MemoryEditParams): Promise<AgentToolResult> {
		const state = this.session.getMnemopiSessionState?.();
		if (!state) {
			throw new Error(t("Mnemopi backend is not initialised for this session."));
		}
		if (params.op === "update" && params.content === undefined && params.importance === undefined) {
			throw new Error(t("memory_edit update requires content or importance."));
		}

		const importance = params.importance === undefined ? undefined : Math.max(0, Math.min(1, params.importance));
		const result = state.editScopedMemory(params.op, params.id, {
			content: params.content,
			importance,
			replacementId: params.replacement_id,
		});
		const location = result.bank ? ` in bank ${result.bank}${result.store ? ` (${result.store})` : ""}` : "";
		const text =
			result.status === "not_found"
				? t("Memory {0} was not found{1}.", `${params.id}`, `${location}`)
				: result.status === "not_editable"
					? t("Memory {0} is a read-only fact{1}; it cannot be edited. Read it with memory://{2}.", `${params.id}`, `${location}`, `${params.id}`)
					: t("Memory {0} {1}{2}.", `${params.id}`, `${result.status}`, `${location}`);
		return {
			content: [{ type: "text", text }],
			details: result,
		};
	}
}
