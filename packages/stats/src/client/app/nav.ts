import { t } from "@oh-my-pi/pi-utils/i18n-browser";
import {
	Activity,
	CircleAlert,
	Coins,
	Cpu,
	FolderGit2,
	Frown,
	LayoutGrid,
	type LucideIcon,
	PlugZap,
	Sparkles,
	SquareChartGantt,
	Wrench,
} from "lucide-react";

export type DashboardSection =
	| "overview"
	| "models"
	| "providers"
	| "costs"
	| "requests"
	| "errors"
	| "traces"
	| "tools"
	| "frustration"
	| "projects"
	| "gain";

export interface NavItem {
	id: DashboardSection;
	label: string;
	icon: LucideIcon;
	/** Second key of the `g <key>` jump shortcut. */
	hotkey: string;
}

export interface NavGroup {
	heading: string;
	items: readonly NavItem[];
}

/** Sidebar structure; the order here is the order on screen. */
export const NAV: readonly NavGroup[] = [
	{
		heading: t("Usage"),
		items: [
			{ id: "overview", label: t("Overview"), icon: LayoutGrid, hotkey: "o" },
			{ id: "models", label: t("Models"), icon: Cpu, hotkey: "m" },
			{ id: "providers", label: t("Providers"), icon: PlugZap, hotkey: "p" },
			{ id: "costs", label: t("Costs"), icon: Coins, hotkey: "c" },
		],
	},
	{
		heading: t("Activity"),
		items: [
			{ id: "requests", label: t("Requests"), icon: Activity, hotkey: "r" },
			{ id: "errors", label: t("Errors"), icon: CircleAlert, hotkey: "e" },
			{ id: "traces", label: t("Traces"), icon: SquareChartGantt, hotkey: "t" },
		],
	},
	{
		heading: t("Insights"),
		items: [
			{ id: "tools", label: t("Tools"), icon: Wrench, hotkey: "l" },
			{ id: "frustration", label: t("Frustration"), icon: Frown, hotkey: "f" },
			{ id: "projects", label: t("Projects"), icon: FolderGit2, hotkey: "j" },
			{ id: "gain", label: t("Gain"), icon: Sparkles, hotkey: "g" },
		],
	},
];

export const NAV_ITEMS: readonly NavItem[] = NAV.flatMap(group => group.items);

export const SECTIONS: readonly DashboardSection[] = NAV_ITEMS.map(item => item.id);

export function navItem(section: DashboardSection): NavItem {
	return NAV_ITEMS.find(item => item.id === section) ?? NAV_ITEMS[0];
}
