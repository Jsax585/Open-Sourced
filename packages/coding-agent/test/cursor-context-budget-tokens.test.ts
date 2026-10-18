import { describe, expect, it } from "bun:test";
import { resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveModelCompactionSettings } from "@oh-my-pi/pi-coding-agent/session/model-compaction-threshold";
import { resolveCursorContextBudgetTokens } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";

function bundled(provider: "cursor" | "anthropic", id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`missing bundled model ${provider}/${id}`);
	return model;
}

describe("resolveCursorContextBudgetTokens", () => {
	const cursor = bundled("cursor", "gemini-3.8-flash");

	it("budgets a Cursor turn at the model's compaction threshold", () => {
		const settings = Settings.isolated();
		const threshold = resolveThresholdTokens(
			cursor.contextWindow ?? 0,
			resolveModelCompactionSettings(settings, cursor),
		);

		expect(resolveCursorContextBudgetTokens(settings, cursor)).toBe(threshold);
	});

	it("leaves models whose tool loop runs on the client alone", () => {
		expect(resolveCursorContextBudgetTokens(Settings.isolated(), bundled("anthropic", "claude-opus-5-5"))).toBe(
			undefined,
		);
	});

	it("stays off when the post-turn check would not compact and continue", () => {
		// Stopping the turn would leave the work stalled behind a status message.
		for (const overrides of [
			{ "compaction.enabled": false },
			{ "compaction.autoContinue": false },
			// Configured, but Cursor has no native compaction and no endpoint is set,
			// so a threshold pass never selects it.
			{ "compaction.methodOrder": ["remote"] },
		]) {
			expect(resolveCursorContextBudgetTokens(Settings.isolated(overrides), cursor)).toBe(undefined);
		}
	});
});
