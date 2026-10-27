import { t } from "@oh-my-pi/pi-utils/i18n-browser";
import { type LucideIcon, Monitor, Moon, Sun } from "lucide-react";
import { type ThemePreference, useThemePreference } from "../useSystemTheme";

const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
	system: "light",
	light: "dark",
	dark: "system",
};

const PREFERENCE_ICON: Record<ThemePreference, LucideIcon> = {
	system: Monitor,
	light: Sun,
	dark: Moon,
};

const PREFERENCE_LABEL: Record<ThemePreference, string> = {
	system: t("System theme"),
	light: t("Light theme"),
	dark: t("Dark theme"),
};

/** Cycles system → light → dark. */
export function ThemeToggle() {
	const { preference, setPreference } = useThemePreference();
	const Icon = PREFERENCE_ICON[preference];

	return (
		<button
			type="button"
			className="btn"
			data-variant="ghost"
			data-icon="true"
			onClick={() => setPreference(NEXT_PREFERENCE[preference])}
			aria-label={t("{0} (click to switch)", `${PREFERENCE_LABEL[preference]}`)}
			title={t("{0} — click to switch", `${PREFERENCE_LABEL[preference]}`)}
		>
			<Icon size={15} />
		</button>
	);
}
