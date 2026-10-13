<system-notice id="context-file-update">
Context files changed on disk after the session loaded them. Where a file below differs from the project context in the system prompt or from earlier in this conversation, follow the version here; files not named here are unchanged.
{{#each updated}}
<file path="{{path}}">
{{content}}
</file>
{{/each}}
{{#each removed}}
`{{this}}` was removed; its earlier instructions no longer apply.
{{/each}}
{{#if allRemoved}}
No context files remain, so the earlier project context no longer applies.
{{/if}}
</system-notice>
