# pi-daybook

Generate Obsidian-style **daily / weekly session notes** summarizing the work
you did across all your repos with Pi.

The `/daybook` command scans your session history over a chosen period, asks the
active model to write a narrative summary (Summary / Highlights / Sessions
grouped by repo), appends a full token/cost usage breakdown, and writes an
Obsidian note with frontmatter and topical `#tags`.

## Usage

```
/daybook               # pick a period interactively (defaults to today)
/daybook today
/daybook yesterday
/daybook week          # this ISO week → YYYY-Www.md
/daybook last-week
/daybook 3d            # last 3 days
```

## `/daybook-usage`

Updates **only** the Token Usage section of the period's note — no model call,
no narrative. Same period arguments as `/daybook`.

```
/daybook-usage         # pick a period interactively
/daybook-usage today
/daybook-usage week
/daybook-usage 3d
```

The section has a per-model table and a per-session table (folder, models,
messages, input / output / cache-read / cache-write tokens, total tokens, cache
hit rate, cost), each with a **Total** row.

## Output

Both commands write into the period's note: `YYYY-MM-DD.md` (daily) or
`YYYY-Www.md` (ISO week), in the first of:

- the `--daybook-dir <path>` CLI flag,
- the `OMP_DAYBOOK_DIR` environment variable,
- the `daybook.folder` setting,
- `~/Obsidian/Daily Notes/`.

If the note does not exist it is created from a template, or empty when none is
set. Daily notes use `daybook.template`; weekly notes use `daybook.weeklyTemplate`
and fall back to `daybook.template` when that is unset. A configured template that
cannot be read is an error.

Template variables, using Obsidian's `{{name}}` style:

| Variable | Value |
|---|---|
| `{{title}}` | note name (`2026-10-01` or `2026-W40`) |
| `{{date}}` | anchor day, `YYYY-MM-DD` |
| `{{start}}` / `{{end}}` | weekly only: the week's Monday / Sunday |
| `{{days}}` | weekly only: `[[YYYY-MM-DD]]` links to each daily note of the week |

Any other `{{...}}` is left for Obsidian's Templates plugin to fill.

Notes are merged, never overwritten. daybook owns two regions delimited by
Obsidian comments (hidden in reading view):

```markdown
# Agent Sessions
%% daybook %%
## Summary
## Highlights
## Sessions
#daybook #refactor #testing
%% /daybook %%

# Token Usage
%% daybook-usage %%
## By model
## By session
%% /daybook-usage %%
```

Only text between a region's markers is replaced on re-run; everything else
(frontmatter, hand-written sections) is kept. Put the marker pairs in your
template to control placement; otherwise they are appended with the headings
above. A note with only one marker of a pair is refused rather than guessed at.

Example Obsidian setup:

```yaml
daybook:
  folder: ~/Notes/Vault/DailyNotes
  template: ~/Notes/Vault/Templates/Daily_Template.md
  weeklyTemplate: ~/Notes/Vault/Templates/Weekly_Template.md
```