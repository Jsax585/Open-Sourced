/**
 * Automatic session-title settings: which generator names a session, how its
 * card icon shows, and whether a todo replan refreshes it.
 */
import { t } from "@oh-my-pi/pi-utils/i18n";
import { register } from "../config/registry";

/** The `title.icons` styles. */
export const TITLE_ICONS = ["nf+emoji", "emoji", "boring"] as const;
/** How a session title shows its card icon: see {@link cfgTitleIcons}. */
export type TitleIcons = (typeof TITLE_ICONS)[number];

export const cfgTitleIcons = register({
	id: "title.icons",
	type: "enum",
	values: TITLE_ICONS,
	default: "nf+emoji",
	ui: {
		tab: "appearance",
		group: "Display",
		label: t("Title Icons"),
		description: t("Icon and short code that head new generated or /rename session titles"),
		options: [
			{
				value: "nf+emoji",
				label: t("Nerd Font + Emoji"),
				description: t("Nerd Font glyph where the Nerd Font symbol preset renders it, else the emoji (default)"),
			},
			{ value: "emoji", label: t("Emoji"), description: t("Always the emoji") },
			{ value: "boring", label: t("Boring"), description: t("Plain title: no icon or code") },
		],
	},
});

export const cfgTitleGenerator = register({
	id: "title.generator",
	type: "enum",
	values: ["fork", "tiny"] as const,
	default: "fork",
	ui: {
		tab: "tasks",
		group: "Modes",
		label: t("Title Generator"),
		description: t("What names an untitled session from the user's messages"),
		options: [
			{
				value: "fork",
				label: t("Fork"),
				description:
					t("A side turn of the reply on the session's model: reads its prompt cache, adds the card icon (default)"),
			},
			{ value: "tiny", label: t("Tiny"), description: t("The title model role only; plain titles without a card") },
		],
	},
});

export const cfgTitleRefreshOnReplan = register({
	id: "title.refreshOnReplan",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: t("Refresh Title on Replan"),
		description: t("Refresh generated session titles after todo init replans unless the title was set by the user"),
	},
});
