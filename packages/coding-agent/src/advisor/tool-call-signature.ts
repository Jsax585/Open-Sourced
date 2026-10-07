import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

const LEGACY_INTENT_FIELD = "__intent";

function withoutIntent(args: unknown): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const { [INTENT_FIELD]: _intent, [LEGACY_INTENT_FIELD]: _legacyIntent, ...rest } = args as Record<string, unknown>;
	return rest;
}

/**
 * Stable identity for one tool call: name plus arguments with object keys
 * sorted and the agent-authored intent dropped, so cosmetic argument
 * reordering or a reworded intent never hides a genuine repeat.
 */
export function toolCallSignature(name: string, args: unknown): string {
	return stableStringifyJson([name, withoutIntent(args)]);
}

/** Stable arguments without agent-authored intent, for loop diagnostics. */
export function toolCallArgumentsSignature(args: unknown): string {
	return stableStringifyJson(withoutIntent(args));
}
