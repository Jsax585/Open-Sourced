import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n-browser";
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
		heading: __ompTranslate("Usage"),
		items: [
			{ id: "overview", label: __ompTranslate("Overview"), icon: LayoutGrid, hotkey: "o" },
			{ id: "models", label: __ompTranslate("Models"), icon: Cpu, hotkey: "m" },
			{ id: "providers", label: __ompTranslate("Providers"), icon: PlugZap, hotkey: "p" },
			{ id: "costs", label: __ompTranslate("Costs"), icon: Coins, hotkey: "c" },
		],
	},
	{
		heading: __ompTranslate("Activity"),
		items: [
			{ id: "requests", label: __ompTranslate("Requests"), icon: Activity, hotkey: "r" },
			{ id: "errors", label: __ompTranslate("Errors"), icon: CircleAlert, hotkey: "e" },
			{ id: "traces", label: __ompTranslate("Traces"), icon: SquareChartGantt, hotkey: "t" },
		],
	},
	{
		heading: __ompTranslate("Insights"),
		items: [
			{ id: "tools", label: __ompTranslate("Tools"), icon: Wrench, hotkey: "l" },
			{ id: "frustration", label: __ompTranslate("Frustration"), icon: Frown, hotkey: "f" },
			{ id: "projects", label: __ompTranslate("Projects"), icon: FolderGit2, hotkey: "j" },
			{ id: "gain", label: __ompTranslate("Gain"), icon: Sparkles, hotkey: "g" },
		],
	},
];

export const NAV_ITEMS: readonly NavItem[] = NAV.flatMap(group => group.items);

export const SECTIONS: readonly DashboardSection[] = NAV_ITEMS.map(item => item.id);

export function navItem(section: DashboardSection): NavItem {
	return NAV_ITEMS.find(item => item.id === section) ?? NAV_ITEMS[0];
}
