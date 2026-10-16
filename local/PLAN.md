# Review Command Improvements (from alibaba/open-code-review)

Three contained changes, in dependency order. Each is independently shippable.

## Constraint that shapes all three

`/review` (`bundled/review/index.ts:234`) returns a **prompt string** and exits. There is no
post-run hook, and the command never sees the reviewer agents' findings. Findings live in
`progress.extractedToolData.report_finding` inside the task executor
(`task/executor.ts:822`), which the command has no access to.

Therefore: the filter pass and the coverage reconciliation are **orchestrator-driven** —
instructions embedded in `review-request.md` that the main agent follows after the reviewer
agents return. They are not new machinery in the command. Only change 3 (anchor validation)
touches executable code in a tool.

This keeps all three changes small and avoids restructuring `/review` into a long-lived
stateful command.

---

## 1. Fact-check filter pass

**Goal:** cut false positives by adding an adversarial pass that may only *delete* findings
it can prove wrong. Ported from OCR's `review_filter_task_{system,user}.md`.

The design detail that matters and must not be diluted: the two error types are treated as
asymmetric. Keeping a wrong finding wastes seconds; dropping a right one destroys it
silently. Everything else follows from that.

### New file: `packages/coding-agent/src/prompts/agents/review-filter.md`

Frontmatter, mirroring `reviewer.md`:
- `name: review_filter`
- `tools: read, search, find, bash, ast_grep` — read-only, no `report_finding`
- `model: pi/fast` — this is a cheap pass; do not use `pi/slow`
- `thinking-level: medium`
- `blocking: true`
- `output`: `{ removals: [{ finding_id, ground: "A"|"B", evidence }] }`
  `evidence` is required and must be the literal diff line relied on. Requiring it is what
  stops hand-wavy removals.

Body encodes, in this order:

1. **Asymmetric cost framing.** Stated before any rule, as the reason for the rules.
2. **Protected-subject veto, evaluated first.** Memory safety, concurrency, linkage /
   declaration consistency, behavioral or compatibility change, unused parameter. On these:
   approve regardless of confidence. Outranks both removal grounds.
3. **Ground A** — the finding targets code absent from its subject file's diff. Judged
   against that file alone; the same construct in a sibling file does not rescue it.
4. **Ground B** — a specific diff line literally contradicts the central claim, readable
   straight off the diff with no chain of reasoning. May come from any file in the batch.
5. **Explicit non-grounds.** Low value, unverifiable, disagreement with the recommendation,
   slightly-wrong line citation while the claim holds. All → approve.
6. **Fail open.** No removals → return `{ removals: [] }`. Malformed output is treated by
   the orchestrator as zero removals.

Adapt OCR's wording to our `<criteria>` / `<priority>` house style and tag conventions.
Do not copy its prose verbatim — it is Apache-2.0 and our prompt style is denser.

### Wire-up: `packages/coding-agent/src/prompts/review-request.md`

Add a post-review section instructing the orchestrator:

- After all reviewer agents return, collect findings.
- Skip the filter entirely when total findings < 3 — not worth a round trip.
- Otherwise spawn one `review_filter` agent per reviewer batch, passing that batch's diff
  plus its findings with stable ids (`<batch>.<n>`).
- Drop findings whose id appears in `removals`. Report the count dropped in the summary so
  the pass is never silent.
- On filter failure/timeout: keep everything.

### Register

`task/agents.ts:43` — add `{ fileName: "review-filter.md", template: reviewFilterMd }` plus
the `with { type: "text" }` import.

### Tests

- `test/prompts/review-request.test.ts` — template renders the filter section; section is
  absent when the finding count is below threshold.
- New `test/task/review-filter-agent.test.ts` — agent parses, has no `report_finding` in
  tools, output schema validates a well-formed removal and rejects one missing `evidence`.

### Risk

The filter deletes a real finding. Mitigated by the protected-subject veto, the mandatory
`evidence` field, fail-open, and reporting the drop count. If it proves too aggressive in
practice, tighten by removing Ground A first — it is the more inferential of the two.

---

## 2. Coverage accounting

**Goal:** make an incomplete review visible. Today a 40-file review where an agent silently
covers 12 is indistinguishable from one that covers 40.

### `packages/coding-agent/src/prompts/review-request.md`

The file table already exists (line 10). Add:

- A statement that every listed file must end as **reviewed** or **skipped with a concrete
  reason**, and that the orchestrator reconciles this before summarizing.
- OCR's anti-shortcut clause, which is the load-bearing sentence: reviewing an
  implementation file does not cover its header, interface, or config counterpart; being the
  smaller or secondary member of a group is not a reason to skip.
- A required coverage line in the final summary: `N/M files reviewed`, with skipped files
  and reasons listed.

### `packages/coding-agent/src/prompts/agents/reviewer.md`

Extend `<procedure>` (line 62): the reviewer states which of its assigned files it reviewed
and which it skipped, in the `yield` explanation.

Extend the `output` block (line 9) with an optional `coverage` property:
`{ reviewed: string[], skipped: [{ path, reason }] }`.
Optional, so existing behavior degrades rather than breaks when the model omits it.

### Note on file identity

OCR keys its checklist on `(path, status)` rather than path, because workspace mode can
report the same path twice — a staged deletion followed by an untracked recreation. Our
`parseDiff` (`bundled/review/index.ts:91`) merges staged and unstaged diffs for mode 2
(`index.ts:323`), so we can hit the same collision. Worth confirming against a constructed
repo state; if it reproduces, key on `(path, status)`.

### Tests

- `test/prompts/review-request.test.ts` — coverage requirement renders; file count matches
  the table.
- Reviewer agent output schema accepts a `coverage` object and still accepts its absence.

---

## 3. Anchor validation in `report_finding`

**Goal:** stop mis-anchored findings. `reviewer.md:112` already requires the line range to
overlap the diff; nothing enforces it, and a finding pointing at the wrong line is
effectively invisible in the UI.

This is the only change that touches executable code.

### Scope decision

OCR replaced line numbers with a verbatim `existing_code` snippet plus a deterministic
resolver (`internal/diff/resolver.go`, ~300 lines, with cross-file relocation on top). That
is a better design and a much larger change — it would alter the `report_finding` schema,
`getReportFindingKey` (`task/executor.ts:125`), `ReviewFinding` (`task/types.ts:170`), and
every renderer in `task/render.ts`.

**Not doing that here.** Instead: keep line numbers, validate them. Captures most of the
benefit at a fraction of the blast radius. Revisit snippet-anchoring separately if
validation shows a high miss rate — the rejection telemetry from this change is exactly the
evidence needed to justify it.

### `packages/coding-agent/src/tools/review.ts`

`reportFindingTool.execute` (line 139) currently accepts params unconditionally. Add:

1. Parse the diff for `file_path` — `git diff`/`git show` scoped to that one path, resolved
   against `session.cwd`. Cache per `(cwd, file_path)` for the tool's lifetime; a reviewer
   files several findings per file and re-shelling each time is wasteful.
2. Extract changed-line ranges on the new side from the hunk headers.
3. If `[line_start, line_end]` does not intersect any changed range, return an **error
   result** naming the nearest valid ranges, so the model can retry with a correct anchor.
   Do not silently accept and do not silently drop.
4. If the diff cannot be obtained — file untracked, not a repo, git fails — **accept the
   finding**. Validation must never be the reason a real finding is lost.

Reuse the existing hunk-header parsing in `bundled/review/index.ts:91` rather than writing
a second parser; lift it to a shared module if the import direction is wrong.

### Tests

New `test/tools/report-finding-anchor.test.ts`:
- In-diff range → accepted.
- Out-of-diff range → error result, message names valid ranges.
- Untracked file / git failure → accepted (fail-open).
- Multi-hunk file → a range in any hunk is accepted.
- Range spanning a hunk boundary → accepted if it intersects at all.

---

## Sequencing

1 and 2 are prompt-only and independent; either order. 3 is code and should land last — its
rejection data informs whether the larger snippet-anchoring rewrite is worth doing.

Explicitly out of scope: per-language rule packs, LLM-based file grouping, cross-group
dedup, session manifests. The first two are worth doing later; the last two are OCR
compliance machinery we do not need.

## Verification

`bun test packages/coding-agent/test/prompts packages/coding-agent/test/tools/review.test.ts`,
then a live `/review` against a branch with a known-mis-anchored finding to confirm the
error path returns something the model can act on.