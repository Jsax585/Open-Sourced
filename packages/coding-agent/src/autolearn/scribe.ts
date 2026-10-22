/**
 * Scribe-model resolution and prompt assembly for the auto-learn session-settle
 * pass.
 *
 * Model resolution mirrors `resolveAdvisorRoleSelection`: an explicit
 * `autolearn.model` selector wins outright, otherwise the `smol` role is
 * resolved through its alias (`@smol`) so the configured role, the inherited
 * `default` role, and the built-in fast-model priorities all apply. Undefined
 * means the pass is skipped — the scribe never borrows the primary model, whose
 * tokens the primary turn already spent.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelRoleAlias } from "../config/model-roles";
import { getModelMatchPreferences, resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import autolearnScribeTemplate from "../prompts/system/autolearn-scribe.md" with { type: "text" };

import { formatManagedSkillsForScribe, readManagedSkills } from "./managed-skills";
import { cfgAutolearnModel } from "./settings";

export interface AutoLearnScribeSelection {
	model: Model;
	/** Thinking level configured on the role that supplied `model`, when it named one. */
	thinkingLevel?: ConfiguredThinkingLevel;
}

function select(selector: string, settings: Settings, models: Model[]): AutoLearnScribeSelection | undefined {
	const resolved = resolveModelRoleValue(selector, models, {
		settings,
		matchPreferences: getModelMatchPreferences(settings),
	});
	if (!resolved.model) return undefined;
	// `resolveModelRoleValue` already clamps the level to the model it matched and
	// leaves it undefined when the selector named none, which is the same contract
	// `resolveAdvisorRoleSelection` hands its consumer.
	return { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
}

export function resolveAutolearnScribeModel(
	settings: Settings,
	modelRegistry: ModelRegistry,
): AutoLearnScribeSelection | undefined {
	const selector = cfgAutolearnModel.get(settings);
	if (selector) {
		const explicit = select(selector, settings, modelRegistry.getAll());
		if (explicit) return explicit;
		logger.debug("Auto-learn scribe model selector did not resolve", { selector });
	}

	// Resolve the ROLE, not the raw `modelRoles.smol` value: an unset role is not
	// "no model", it means the built-in fast-model chain (after any inherited
	// `default` role) applies.
	const fallback = select(formatModelRoleAlias("smol"), settings, modelRegistry.getAvailable());
	if (!fallback) logger.debug("Auto-learn scribe skipped: no model available");
	return fallback;
}

/**
 * Build the scribe's extra system-prompt block: its standing instructions plus
 * the current managed-skill bodies.
 *
 * The scribe holds `manage_skill` and `learn` only — no read tool — and
 * `manage_skill(action="update")` replaces a skill's whole body. Without the
 * bodies in front of it, "enhance an existing skill" would silently erase the
 * procedure it was meant to extend, so every existing body is quoted here.
 */
export async function buildAutolearnScribePrompt(agentDir?: string): Promise<string> {
	const skills = await readManagedSkills(agentDir);
	const sections = [autolearnScribeTemplate.trim()];
	const inventory = formatManagedSkillsForScribe(skills);
	if (inventory) sections.push(inventory);
	return sections.join("\n\n");
}
