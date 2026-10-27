/**
 * Settings Capability
 *
 * Configuration settings from various sources (JSON, TOML, etc.)
 */
import { t } from "@oh-my-pi/pi-utils/i18n";
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A settings file.
 */
export interface Settings {
	/** Absolute path to settings file */
	path: string;
	/** Parsed settings data */
	data: Record<string, unknown>;
	/** Source level */
	level: "user" | "project";
	/** Source metadata */
	_source: SourceMeta;
}

export const settingsCapability = defineCapability<Settings>({
	id: "settings",
	displayName: t("Settings"),
	description: t("Configuration settings from various sources"),
	// Settings are merged, not deduplicated by key
	key: () => undefined,
	validate: settings => {
		if (!settings.path) return t("Missing path");
		if (!settings.data || typeof settings.data !== "object") return t("Missing or invalid data");
		return undefined;
	},
});
