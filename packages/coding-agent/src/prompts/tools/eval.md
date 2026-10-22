One cell per call; top-level state persists, including across compaction.{{#if spawns}} Subagents have separate kernels.{{/if}}
{{#if spawns}}{{#if eagerDelegation}}For 2+ independent items, use a named `workpool()`; results auto-deliver.{{#if waitTool}} If blocked, leave `eval` and call `wait`.{{/if}}{{/if}}{{/if}}
{{#if py}}Python: plain Python subprocess, not IPython (no `get_ipython()`, `obj?`, or `%matplotlib`). Magics like `%pip`, `%load`, `%time` and `!cmd` are rewritten to Python. Top-level `await` works; `asyncio.run(…)` fails.{{/if}}
{{#if js}}JS: Bun (`Bun.file`, `Bun.write`, `Bun.$`); top-level `await`/`return` work.{{/if}}
On error, retry only the failed step; earlier steps may have taken effect.
Printing an image{{#if py}} or figure{{/if}} attaches it.

<prelude>
`await` marks async helpers; the rest are sync.
{{#if py}}
Python (kwargs):
```py
print(value, ...)  log(message)  phase(title)  env(key?, value?)
read(path, offset?, limit?)  write(path, content)  output(*ids, format?, query?, offset?, limit?)
wait(handles, timeout?=None, raise_errors?=True)
await tool.<name>(args)
```
{{/if}}
{{#if js}}
JS (positional args or ONE trailing options object):
```js
print(value, ...)  log(message)  phase(title)  env(key?, value?)
await read(path, offset?, limit?)  await write(path, content)  await output(...ids, { format?, query?, offset?, limit? })
await wait(handles, { timeout?, raiseErrors? })
await tool.<name>(args)
```
{{/if}}
- `wait(handles, …)`: agent/completion barrier, ordered results; {{#ifAll py js}}`raise_errors=False` / `raiseErrors: false`{{else}}{{#if py}}`raise_errors=False`{{else}}`raiseErrors: false`{{/if}}{{/ifAll}} retains failures.
- `tool.<name>(args)`: session tool; `args` is its parameter object.
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
