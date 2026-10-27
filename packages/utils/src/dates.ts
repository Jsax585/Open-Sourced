import { t } from "@oh-my-pi/pi-utils/i18n";
/** Behavior-compatible reimplementation of date-fns's used surface. */

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
] as const;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const TOKENS = [
	"MMMM",
	"yyyy",
	"EEEE",
	"MMM",
	"EEE",
	"yy",
	"MM",
	"dd",
	"HH",
	"hh",
	"mm",
	"ss",
	"M",
	"d",
	"H",
	"h",
	"m",
	"s",
	"a",
] as const;

function pad(value: number, length = 2): string {
	return String(value).padStart(length, "0");
}

function tokenValue(date: Date, token: (typeof TOKENS)[number]): string {
	const month = date.getMonth();
	const weekday = date.getDay();
	const hours = date.getHours();
	const hours12 = hours % 12 || 12;

	switch (token) {
		case "yyyy":
			return pad(date.getFullYear(), 4);
		case "yy":
			return pad(date.getFullYear() % 100);
		case "MMMM":
			return MONTHS[month];
		case "MMM":
			return MONTHS[month].slice(0, 3);
		case "MM":
			return pad(month + 1);
		case "M":
			return String(month + 1);
		case "dd":
			return pad(date.getDate());
		case "d":
			return String(date.getDate());
		case "EEEE":
			return WEEKDAYS[weekday];
		case "EEE":
			return WEEKDAYS[weekday].slice(0, 3);
		case "HH":
			return pad(hours);
		case "H":
			return String(hours);
		case "hh":
			return pad(hours12);
		case "h":
			return String(hours12);
		case "mm":
			return pad(date.getMinutes());
		case "m":
			return String(date.getMinutes());
		case "ss":
			return pad(date.getSeconds());
		case "s":
			return String(date.getSeconds());
		case "a":
			return hours < 12 ? "AM" : "PM";
	}
}

function asDate(value: Date | number): Date {
	const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
	if (Number.isNaN(date.getTime())) throw new RangeError("Invalid time value");
	return date;
}

/** Format a date with the supported date-fns v4 tokens and quoted literals. */
export function format(value: Date | number, pattern: string): string {
	const date = asDate(value);
	let result = "";

	for (let index = 0; index < pattern.length;) {
		if (pattern[index] === "'") {
			if (pattern[index + 1] === "'") {
				result += "'";
				index += 2;
				continue;
			}

			index++;
			while (index < pattern.length) {
				if (pattern[index] !== "'") {
					result += pattern[index++];
					continue;
				}
				if (pattern[index + 1] === "'") {
					result += "'";
					index += 2;
					continue;
				}
				index++;
				break;
			}
			continue;
		}

		const rest = pattern.slice(index);
		const token = TOKENS.find(candidate => rest.startsWith(candidate));
		if (token) {
			result += tokenValue(date, token);
			index += token.length;
			continue;
		}

		const character = pattern[index++];
		if (/[A-Za-z]/.test(character)) {
			throw new RangeError(`Format string contains an unescaped latin alphabet character \`${character}\``);
		}
		result += character;
	}

	return result;
}

function completedMonths(earlier: Date, later: Date): number {
	let months = (later.getFullYear() - earlier.getFullYear()) * 12 + later.getMonth() - earlier.getMonth();
	if (months === 0) return 0;

	const candidate = new Date(earlier);
	candidate.setDate(1);
	candidate.setFullYear(earlier.getFullYear(), earlier.getMonth() + months, 1);
	const lastDay = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0).getDate();
	candidate.setDate(Math.min(earlier.getDate(), lastDay));
	if (candidate.getTime() > later.getTime()) months--;
	return months;
}

function distanceWords(earlier: Date, later: Date): string {
	const seconds = (later.getTime() - earlier.getTime()) / 1_000;
	const timezoneOffset = (later.getTimezoneOffset() - earlier.getTimezoneOffset()) * 60;
	const minutes = Math.round((seconds - timezoneOffset) / 60);

	if (minutes < 2) return minutes === 0 ? t("less than a minute") : t("1 minute");
	if (minutes < 45) return t("{0} minutes", `${(minutes)}`);
	if (minutes < 90) return t("about 1 hour");
	if (minutes < 1_440) return t("about {0} hours", `${(Math.round(minutes / 60))}`);
	if (minutes < 2_520) return t("1 day");
	if (minutes < 43_200) return t("{0} days", `${(Math.round(minutes / 1440))}`);
	if (minutes < 86_400) return t("about {0} month{1}", `${(Math.round(minutes / 43200))}`, `${(Math.round(minutes / 43200) === 1 ? "" : "s")}`);

	const months = completedMonths(earlier, later);
	if (months < 12) return t("{0} months", `${(Math.round(minutes / 43200))}`);

	const years = Math.trunc(months / 12);
	const remainingMonths = months % 12;
	if (remainingMonths < 3) return t("about {0} year{1}", `${(years)}`, `${(years === 1 ? "" : "s")}`);
	if (remainingMonths < 9) return t("over {0} year{1}", `${(years)}`, `${(years === 1 ? "" : "s")}`);
	return t("almost {0} years", `${(years + 1)}`);
}

/** Describe the distance from a date to now using date-fns's thresholds and Korean labels. */
export function formatDistanceToNow(value: Date | number, options: { addSuffix?: boolean } = {}): string {
	const date = asDate(value);
	const now = new Date(Date.now());
	const isFuture = date.getTime() > now.getTime();
	const words = isFuture ? distanceWords(now, date) : distanceWords(date, now);
	if (!options.addSuffix) return words;
	return isFuture ? t("in {0}\u0004packages/tui/src/tools/task.ts:renderAgentProgress.waitLabel", `${words}`) : t("{0} ago", `${words}`);
}
