One cell per call; top-level state persists, including across compaction.{{#if spawns}} Subagents have separate kernels.{{/if}}
{{#if spawns}}{{#if eagerDelegation}}For 2+ independent items, use a named `workpool()`; results auto-deliver.{{#if waitTool}} If blocked, leave `eval` and call `wait`.{{/if}}{{/if}}{{/if}}
{{#if py}}Python: plain Python subprocess, not IPython (no `get_ipython()`, `obj?`, or `%matplotlib`). Magics like `%pip`, `%load`, `%time` and `!cmd` are rewritten to Python. Top-level `await` works; `asyncio.run(…)` fails.{{/if}}
{{#if js}}JS: Bun (`Bun.file`, `Bun.write`, `Bun.$`); top-level `await`/`return` work.{{/if}}
On error, retry only the failed step; earlier steps may have taken effect.
{{#if codeMode}}

<code_mode>
Batch known dependent steps in one cell, awaiting prerequisites before using their results.{{#if js}} Use `Promise.all` for independent JS calls.{{/if}}{{#if py}} Use `asyncio.gather` for independent Python calls.{{/if}}
Call approved registered tools via `await tool.<name>(args)`, using their documented parameter objects. Discover names with the `read` tool at `xd://` and docs at `xd://<tool>`; inside eval, use `await tool.read({"path": "xd://<tool>"})`.
Results are a string or an object with `text`, optional `details`/`images`, and `hasError`.{{#if js}} Text: `typeof r === "string" ? r : r.text`.{{/if}}{{#if py}} Python: `r if isinstance(r, str) else r["text"]`.{{/if}} Read `path:raw` for machine-parsable file text instead of numbered previews.
Inspect returned `hasError` flags as well as exceptions before continuing dependent steps; retry only failed steps. Display only results relevant to the task, not every intermediate payload.
Keep orchestration and session control calls direct, including `task`, `ask`, `wait`, `yield`, `checkpoint`, `rewind`, `new_context`, and `goal`.
</code_mode>
{{/if}}

<prelude>
{{#ifAll py js}}Python helpers: sync, kwargs; JS helpers: async, ONE trailing options object.{{else}}{{#if py}}Sync; kwargs.{{/if}}{{#if js}}Async; ONE trailing options object.{{/if}}{{/ifAll}}
```
display(value)  print(value, ...)  log(message)  phase(title)
read(path, offset?, limit?)  write(path, content)  env(key?, value?)  output(*ids, format?, query?, offset?, limit?)
{{#if codeMode}}await {{else}}{{#if js}}await {{/if}}{{/if}}tool.<name>(args) — session tool; `args` is its parameter object
wait(handles, timeout?=None, raise_errors?=True) — agent/completion barrier, ordered results{{#if js}}; JS: wait(handles, { timeout, raiseErrors }){{/if}}; `raise_errors=False` retains failures.
```
</prelude>

{{#if inlineTopics}}
{{{inlineTopics}}}
{{else}}
<namespaces>
More globals; `read` the linked docs before first use:
- `judge`, `{{#if py}}judge_batch{{else}}judgeBatch{{/if}}`, `completion`: classification, bulk judgment, model calls → `xd://eval/judge`
- `%load`{{#if py}}, `%pip`{{/if}}{{#if js}}, `%bun add`{{/if}}, `budget`{{#if evalTools}}, `@tool`/`tool(fn)`{{/if}}: setup, installs, utilities → `xd://eval/helpers`
{{#if spawns}}
- `agent`, `workpool`: background subagents, DAG waves → `xd://eval/agents`
{{/if}}
{{#each preludes}}
- `{{name}}`: {{summary}} → `xd://eval/{{name}}`
{{/each}}
</namespaces>
{{/if}}

<critical>
NEVER repeat successful setup. Kernel-loss notice means reload setup.
</critical>

{{#if autoBackgroundEnabled}}Long cells may auto-background and deliver later; the kernel stays busy. `timeout: 0` disables the cell deadline, not the foreground wait.{{/if}}
