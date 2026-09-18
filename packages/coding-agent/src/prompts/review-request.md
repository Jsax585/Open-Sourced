## Code Review Request

### Mode

{{mode}}

### Changed Files ({{len files}} files, +{{totalAdded}}/-{{totalRemoved}} lines)

{{#if files.length}}
{{#table files headers="File|+/-|Type"}}
{{path}} | +{{linesAdded}}/-{{linesRemoved}} | {{ext}}
{{/table}}
{{else}}
_No files to review._
{{/if}}
{{#if excluded.length}}
### Excluded Files ({{len excluded}})

{{#list excluded prefix="- " join="\n"}}
`{{path}}` (+{{linesAdded}}/-{{linesRemoved}}) — {{reason}}
{{/list}}
{{/if}}

### Distribution Guidelines

{{#when agentCount "==" 1}}Use **1 reviewer agent**.{{else}}Spawn **{{agentCount}} reviewer agents** in parallel.{{/when}}
{{#if multiAgent}}
Group files by locality, e.g.:
- Same directory/module → same agent
- Related functionality → same agent
- Tests with their implementation files → same agent

You **MUST** use Task tool with `agent: "reviewer"` and `tasks` array.
{{/if}}

### Reviewer Instructions

Reviewer **MUST**:
1. Focus ONLY on assigned files
2. {{#if skipDiff}}**MUST** run `git diff`/`git show` for assigned files{{else}}**MUST** use diff hunks below (**MUST NOT** re-run git diff){{/if}}
3. **MAY** read full file context as needed via `read`
4. Call `report_finding` per issue
5. Call `yield` with verdict when done
6. State which assigned files were reviewed, and which were skipped and why

### Coverage

Every one of the {{len files}} files above **MUST** end the review either **reviewed** or
**skipped with a concrete reason**. Reconcile the reviewers' reports against the file list
before you summarize.

Reviewing a file does not cover its counterparts. An implementation file does not cover its
header, interface, schema, or configuration file. Being the smaller or secondary file in a
group is not a reason to skip it.

Your summary **MUST** include a coverage line — `N/M files reviewed` — and list every skipped
file with its reason. If a reviewer returned no account of a file assigned to it, that file
is skipped, not reviewed.

### After Reviews Return

Findings are unfiltered. Reviewers report on limited context and some findings will be
factually wrong about the diff.

If **3 or more findings** were reported in total, run a fact-check pass before presenting them:

1. Use the Task tool with `agent: "review_filter"`, one task per reviewer batch.
2. Give each filter task that batch's diff and its findings, each with a stable id (`<batch>.<n>`).
3. Remove findings whose id comes back in `removals`. Keep everything else.
4. State the number removed in your summary. You **MUST NOT** drop findings silently.

Skip the pass entirely below 3 findings — it is not worth the round trip.

If a filter task fails, times out, or returns nothing usable, **keep all of its findings**.

{{#if skipDiff}}
### Diff Previews

_Full diff too large ({{len files}} files). Showing first ~{{linesPerFile}} lines per file._

{{#list files join="\n\n"}}
#### {{path}}

{{#codeblock lang="diff"}}
{{hunksPreview}}
{{/codeblock}}
{{/list}}
{{else}}

### Diff

<diff>
{{rawDiff}}
</diff>
{{/if}}

{{#if additionalInstructions}}
### Additional Instructions

{{additionalInstructions}}
{{/if}}
