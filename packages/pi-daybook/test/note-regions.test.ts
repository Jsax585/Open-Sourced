import { describe, expect, it } from "bun:test";
import {
	type Period,
	renderTemplate,
	SUMMARY_REGION,
	templateVars,
	USAGE_REGION,
	upsertRegion,
} from "../src/extension";

const TEMPLATE = `---
id: "{{title}}"
aliases: []
tags:
  - daily-notes
---

# Activities

# Follow ups

# Meetings

# Agent Sessions
%% daybook %%
%% /daybook %%

# Token Usage
%% daybook-usage %%
%% /daybook-usage %%

[[daily]] [[notes]]
`;

describe("upsertRegion", () => {
	it("fills template regions in place and keeps everything else", () => {
		const note = renderTemplate(TEMPLATE, { title: "2026-10-01", date: "2026-10-01" });
		const out = upsertRegion(upsertRegion(note, SUMMARY_REGION, "## Summary\nDid things"), USAGE_REGION, "| t |");
		expect(out).toContain('id: "2026-10-01"');
		expect(out).toContain("%% daybook %%\n## Summary\nDid things\n%% /daybook %%");
		expect(out).toContain("%% daybook-usage %%\n| t |\n%% /daybook-usage %%");
		// No duplicate headings: the template already had them.
		expect(out.match(/# Agent Sessions/g)).toHaveLength(1);
		expect(out.endsWith("[[daily]] [[notes]]\n")).toBe(true);
	});

	it("rerun replaces only the region, preserving hand-written notes", () => {
		const first = upsertRegion(TEMPLATE, SUMMARY_REGION, "old summary");
		const edited = first.replace("# Activities\n", "# Activities\n* wrote by hand\n");
		const second = upsertRegion(edited, SUMMARY_REGION, "new summary");
		expect(second).toContain("* wrote by hand");
		expect(second).toContain("new summary");
		expect(second).not.toContain("old summary");
	});

	it("appends heading and region to a pre-existing note without markers", () => {
		const note = "---\nid: x\n---\n\n# Activities\n* manual\n";
		const out = upsertRegion(note, USAGE_REGION, "| t |");
		expect(out).toBe(
			"---\nid: x\n---\n\n# Activities\n* manual\n\n# Token Usage\n%% daybook-usage %%\n| t |\n%% /daybook-usage %%\n",
		);
		// Idempotent on re-run: no second heading.
		expect(upsertRegion(out, USAGE_REGION, "| t |")).toBe(out);
	});

	it("does not confuse the summary end marker with the usage region", () => {
		const out = upsertRegion(TEMPLATE, USAGE_REGION, "usage");
		expect(out).toContain("%% daybook %%\n%% /daybook %%");
	});

	it("refuses to write when markers are unbalanced", () => {
		expect(() => upsertRegion("# x\n%% daybook %%\nstuff\n", SUMMARY_REGION, "new")).toThrow(/Malformed/);
		expect(() => upsertRegion("%% /daybook %%\n%% daybook %%\n", SUMMARY_REGION, "new")).toThrow(/Malformed/);
	});
});

describe("weekly template variables", () => {
	// Wednesday 2026-09-30 sits in ISO week 40 (Mon 2026-09-28 .. Sun 2026-10-04).
	const week: Period = {
		kind: "weekly",
		label: "this week",
		startMs: new Date(2026, 8, 28).getTime(),
		endMs: new Date(2026, 8, 30, 12).getTime(),
		anchor: new Date(2026, 8, 30, 12),
	};

	it("fills title, Mon-Sun range, and links to every daily note in the week", () => {
		const out = renderTemplate("{{title}} {{start}}..{{end}}\n{{days}}", templateVars(week));
		expect(out.split("\n")[0]).toBe("2026-W40 2026-09-28..2026-10-04");
		expect(out.match(/\[\[\d{4}-\d{2}-\d{2}\]\]/g)).toEqual([
			"[[2026-09-28]]",
			"[[2026-09-29]]",
			"[[2026-09-30]]",
			"[[2026-10-01]]",
			"[[2026-10-02]]",
			"[[2026-10-03]]",
			"[[2026-10-04]]",
		]);
	});

	it("leaves variables it does not own for Obsidian to fill", () => {
		expect(renderTemplate("{{time}} {{title}}", templateVars(week))).toBe("{{time}} 2026-W40");
		// Daily periods have no week range, so weekly-only variables stay untouched.
		expect(renderTemplate("{{start}}", templateVars({ ...week, kind: "daily" }))).toBe("{{start}}");
	});
});
