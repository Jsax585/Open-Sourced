{{#when kind "==" "captured"}}
{{#if branchName}}
Isolation: changes captured on branch `{{branchName}}` (apply=false). Not merged.
{{else}}
{{#if rootPatchPath}}
Isolation: changes captured at `{{rootPatchPath}}` (apply=false). Not applied.
{{else}}
{{#if nestedCount}}
Isolation: changes captured for {{pluralize nestedCount "nested repository" "nested repositories"}} (apply=false). Not applied.
{{else}}
Isolation: no changes captured.
{{/if}}
{{/if}}
{{/if}}
{{#list nestedPatchPaths prefix="- nested repository patch: `" suffix="`"}}{{this}}{{/list}}
{{/when}}
{{#when kind "==" "capture-error"}}
<system-notification>Isolation: {{error}}</system-notification>
{{#if branchName}}
Captured branch preserved as {{branchName}}.
{{/if}}
{{#if rootPatchPath}}
- patch: `{{rootPatchPath}}`
{{/if}}
{{#list nestedPatchPaths prefix="- nested repository patch: `" suffix="`"}}{{this}}{{/list}}
{{/when}}
{{#when kind "==" "nested-apply-failed"}}
<system-notification>Some nested repository patches failed to apply: {{error}}{{#if nestedPatchPaths}}
Captured nested patches preserved at:
{{#list nestedPatchPaths prefix="- "}}{{this}}{{/list}}{{/if}}</system-notification>
{{/when}}
{{#when kind "==" "not-applied"}}
<system-notification>Patches were not applied and must be handled manually.</system-notification>

{{#if rootPatchPath}}
Patch artifact:
- {{rootPatchPath}}
{{/if}}
{{#if nestedPatchPaths}}
Nested repository patches (not applied):
{{#list nestedPatchPaths prefix="- "}}{{this}}{{/list}}
{{/if}}
{{/when}}
{{#when kind "==" "branch-merge-failed"}}
<system-notification>Branch merge failed: {{branchName}}.
{{#if conflict}}
Conflict: {{conflict}}
{{/if}}
The unmerged branch remains for manual resolution.</system-notification>
{{#if nestedPatchPaths}}
Nested repository patches (not applied):
{{#list nestedPatchPaths prefix="- "}}{{this}}{{/list}}
{{/if}}
{{/when}}
{{#when kind "==" "branch-capture-failed"}}
<system-notification>Branch merge failed while capturing the task branch: {{error}}
Task outputs are preserved but changes were not applied.</system-notification>
{{#if rootPatchPath}}
Patch artifact:
- {{rootPatchPath}}
{{/if}}
{{#if nestedPatchPaths}}
Nested repository patches (not applied):
{{#list nestedPatchPaths prefix="- "}}{{this}}{{/list}}
{{/if}}
{{/when}}
{{#when kind "==" "merge-error"}}
<system-notification>Merge phase failed: {{error}}
Task outputs are preserved but changes were not applied.</system-notification>
{{#if branchName}}
Unmerged branch preserved as {{branchName}} for manual resolution.
{{/if}}
{{#if rootPatchPath}}
Patch artifact:
- {{rootPatchPath}}
{{/if}}
{{#if nestedPatchPaths}}
Nested repository patches (not applied):
{{#list nestedPatchPaths prefix="- "}}{{this}}{{/list}}
{{/if}}
{{/when}}
{{#when kind "==" "follow-up-pending"}}
<system-notification>Isolation: this turn's changes were not captured: {{error}}
They stay in the isolated workspace until the agent is released, which writes root-repository changes to {{rootPatchPath}} and nested-repository changes to patch files beside it{{#if branchName}}, and commits root-repository changes to branch {{branchName}}{{/if}}.</system-notification>
{{/when}}
{{#when kind "==" "follow-up-superseded"}}
<system-notification>Isolation: this turn's changes were not landed: the agent started another turn before they were captured. They land with its next turn whose result reaches you, or stay in the isolated workspace until it is released.</system-notification>
{{/when}}
