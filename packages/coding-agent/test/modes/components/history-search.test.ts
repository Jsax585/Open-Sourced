import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { HistorySearchComponent, type HistorySearchScope } from "@oh-my-pi/pi-tui/overlays/history-search";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

function source(label: string, prompts: string[]): HistorySearchScope {
	const entries = prompts.map(prompt => ({ prompt, created_at: 1 }));
	return {
		label,
		getRecent: limit => entries.slice(0, limit),
		search: (query, limit) => entries.filter(entry => entry.prompt.includes(query)).slice(0, limit),
	};
}

function render(component: HistorySearchComponent): string {
	return Bun.stripANSI(component.render(80).join("\n"));
}

describe("HistorySearchComponent", () => {
	it("cycles bound sources in both directions while retaining the query and resetting selection", () => {
		const selected: string[] = [];
		const component = new HistorySearchComponent(
			[
				source("conversation", ["deploy session first", "deploy session second", "unrelated"]),
				source("folder", ["deploy folder first", "deploy folder second"]),
				source("everywhere", ["deploy global"]),
			],
			prompt => selected.push(prompt),
			() => {},
		);
		for (const char of "deploy") component.handleInput(char);
		expect(render(component)).not.toContain("unrelated");
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		component.handleInput("\t");
		expect(render(component)).toContain("deploy folder first");
		expect(render(component)).not.toContain("deploy session");
		component.handleInput("\r");
		component.handleInput("\x1b[Z");
		component.handleInput("\r");
		component.handleInput("\x1b[Z");
		component.handleInput("\r");
		expect(selected).toEqual([
			"deploy session second",
			"deploy folder first",
			"deploy session first",
			"deploy global",
		]);
	});

	it("clears stale selectable results on read failure and retries on the next input", () => {
		let fail = false;
		const selected: string[] = [];
		const backing = source("folder", ["deploy release"]);
		const component = new HistorySearchComponent(
			[
				{
					...backing,
					search: (query, limit) => {
						if (fail) throw new Error("read failed");
						return backing.search(query, limit);
					},
				},
			],
			prompt => selected.push(prompt),
			() => {},
		);
		fail = true;
		component.handleInput("d");
		component.handleInput("\r");
		expect(selected).toEqual([]);
		expect(render(component)).not.toContain("deploy release");
		fail = false;
		component.handleInput("\x1b[D"); // Retry the unchanged query after the failed read.
		component.handleInput("\r");
		expect(selected).toEqual(["deploy release"]);
	});

	it("moves the query cursor with Left/Right instead of cycling the scope", () => {
		const component = new HistorySearchComponent(
			[source("folder", ["abc folder"]), source("conversation", ["abc conversation"])],
			() => {},
			() => {},
		);

		// Left/Right belong to the query field, not the scope ring: `handleTabSwitchKey` would
		// consume them and cycle the scope, so the insertion below would land at the end of the
		// query and the title would move off the initial scope.
		for (const char of "abc") component.handleInput(char);
		expect(component.title).toBe("History (folder)");
		expect(render(component)).toContain("abc folder");

		component.handleInput("\x1b[D"); // Left
		component.handleInput("z");

		expect(component.title).toBe("History (folder)");
		expect(render(component)).not.toContain("abc folder");

		// Right must move the cursor back toward the end: typing then appends ("abzcy"),
		// where an unhandled Right would leave the cursor before "c" and yield "abzyc".
		component.handleInput("\x1b[C"); // Right
		component.handleInput("y");
		expect(component.title).toBe("History (folder)");
		expect(render(component)).toContain("abzcy");
	});
});

describe("HistorySearchComponent debounced search", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function countingStorage(prompts: string[]): { storage: HistorySearchScope; searches: string[] } {
		const base = source("folder", prompts);
		const searches: string[] = [];
		const storage: HistorySearchScope = {
			label: base.label,
			getRecent: limit => base.getRecent(limit),
			search: (query, limit) => {
				searches.push(query);
				return base.search(query, limit);
			},
		};
		return { storage, searches };
	}

	it("switches scope immediately and cancels the pending previous-scope query", () => {
		vi.useFakeTimers();
		const selected: string[] = [];
		const component = new HistorySearchComponent(
			[source("conversation", ["deploy old session"]), source("folder", ["deploy folder"])],
			prompt => selected.push(prompt),
			() => {},
		);
		let renders = 0;
		component.setOnRequestRender(() => renders++);
		for (const char of "deploy") component.handleInput(char);
		component.handleInput("\t");
		expect(render(component)).toContain("deploy folder");
		expect(render(component)).not.toContain("deploy old session");
		component.handleInput("\r");
		vi.advanceTimersByTime(150);
		expect(selected).toEqual(["deploy folder"]);
		expect(renders).toBe(0);
	});

	it("searches once after the quiet period and requests a repaint", () => {
		vi.useFakeTimers();
		const { storage, searches } = countingStorage(["deploy the needle rollback", "routine status update"]);
		const component = new HistorySearchComponent(
			[storage],
			() => {},
			() => {},
		);
		let renders = 0;
		component.setOnRequestRender(() => renders++);

		for (const char of "needle") component.handleInput(char);
		expect(searches).toEqual([]);
		expect(render(component)).toContain("routine status update");

		vi.advanceTimersByTime(150);
		expect(searches).toEqual(["needle"]);
		expect(renders).toBe(1);
		expect(render(component)).not.toContain("routine status update");
	});

	it("skips the search when only the cursor moves", () => {
		vi.useFakeTimers();
		const { storage, searches } = countingStorage(["deploy the needle rollback"]);
		const component = new HistorySearchComponent(
			[storage],
			() => {},
			() => {},
		);
		component.setOnRequestRender(() => {});
		for (const char of "needle") component.handleInput(char);
		vi.advanceTimersByTime(150);
		component.handleInput("\x1b[D");
		component.handleInput("\x1b[C");
		component.handleInput(" ");
		vi.advanceTimersByTime(150);
		expect(searches).toEqual(["needle"]);
	});

	it("uses fresh results when Enter arrives before the debounce fires", () => {
		vi.useFakeTimers();
		const { storage } = countingStorage(["routine status update", "needle in a haystack"]);
		const selected: string[] = [];
		const component = new HistorySearchComponent(
			[storage],
			prompt => selected.push(prompt),
			() => {},
		);
		let renders = 0;
		component.setOnRequestRender(() => renders++);
		for (const char of "needle") component.handleInput(char);
		component.handleInput("\n");
		expect(selected).toEqual(["needle in a haystack"]);
		vi.advanceTimersByTime(150);
		expect(renders).toBe(0);
	});

	it("ignores a list pick of a row from the previous query while the search is pending", () => {
		vi.useFakeTimers();
		const stale = { prompt: "routine status update", created_at: 1 };
		const { storage } = countingStorage([stale.prompt, "needle in a haystack"]);
		const selected: string[] = [];
		const component = new HistorySearchComponent(
			[storage],
			prompt => selected.push(prompt),
			() => {},
		);
		component.setOnRequestRender(() => {});
		for (const char of "needle") component.handleInput(char);
		// The row is still on screen: the debounce has not refreshed results yet.
		const staleKey = `${stale.created_at}-${Bun.hash(stale.prompt).toString(36)}`;
		component.handleNativeEvent({ type: "activate", key: "list", item: staleKey });
		expect(selected).toEqual([]);
		expect(render(component)).not.toContain("routine status update");
	});

	it("shows recent history immediately when the query is cleared", () => {
		vi.useFakeTimers();
		const { storage } = countingStorage(["routine status update", "needle in a haystack"]);
		const component = new HistorySearchComponent(
			[storage],
			() => {},
			() => {},
		);
		component.setOnRequestRender(() => {});
		for (const char of "h") component.handleInput(char);
		vi.advanceTimersByTime(150);
		expect(render(component)).not.toContain("routine status update");
		component.handleInput("\x7f");
		expect(render(component)).toContain("routine status update");
	});
});
