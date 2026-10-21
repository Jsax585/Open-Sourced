# Autopilot

Autopilot is a per-session director for the main agent's turn endings. When
enabled, a settled main-agent turn is inspected by a no-tools responder that
runs on the session's effective model and receives the task, the active goal,
open todos, the last tool action and the available subagents. The responder
returns one decision, which is injected as the next main-agent turn. The mode
never answers a human, never touches tool approval, and fails closed when the
model or its auth is unavailable.

```text
/autopilot                      # toggle for this session
/autopilot on [directive]       # enable, optionally with a binding directive
/autopilot off                  # disable (the directive is kept)
/autopilot status               # strategy, cycles, directive, last decision
/autopilot prompt [text|clear]  # show, set or clear the binding directive
/autopilot max [n|unlimited]    # show or set the cycle limit (0 = unlimited)
```

A bare multi-word or quoted argument sets the directive and enables the mode:

```text
/autopilot always run the unit tests before the e2e suite
/autopilot "prefer the conservative fix"
```

The directive is persisted with the session and is binding for every automatic
decision; it is injected above the generic guidance in both responder prompts.

## Strategies

`autopilot.strategy` selects what starts a responder turn:

| Value        | Behavior                                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `answer`     | Answers closing questions only (the original contract).                                                                                              |
| `continue`   | Also resolves a question-free ending into the next concrete action.                                                                                  |
| `goal-aware` | Default. Adds the goal objective, open todos, last tool activity and available subagents; applies the no-progress reiteration and delegation policy. |

Common rules:

- The responder may answer `done` to end the run; autopilot emits an info
  notice and does not queue another turn.
- A repeated question (or, outside `goal-aware`, a repeated ending) stops the
  run instead of looping. Under `goal-aware`, a repeated text with no tool
  activity reiterates the objective first.
- A subagent's own turn ending is never answered.
- Compaction and handoff rewrite the context; autopilot skips those settles and
  evaluates again once maintenance finishes.

## Goal-aware director

The `goal-aware` context tells the responder whether it should deepen its
understanding before acting and whether delegation is available:

- read the relevant modules, or delegate a read-only `scout` to map entry
  points and call sites, when the next step depends on unfamiliar code;
- delegate a self-contained, parallelizable or specialist slice to a named
  subagent from the context, possibly several independent slices at once;
- otherwise take the smallest direct action toward the objective.

The available-subagent list is rendered from the bundled agents plus the
session's agents, minus `task.disabledAgents`. When the `task` tool is absent,
the prompt states that no subagents are available and prefers direct
investigation or action.

### No tool activity

When a `goal-aware` cycle has the same tool-call/result digest as the previous
cycle, autopilot does not stop. It queues a continuation that restates the
objective, the binding directive and the open todos, and instructs the agent to
take a concrete tool action without asking a question. This is bounded to
**3 reiterations per user prompt**; any tool call resets the budget. After the
third reiteration, the next no-progress cycle stops with `no-progress`.

`maxCycles` is a separate bound on responder/reiteration cycles per user
prompt. It defaults to `0` (unlimited); set a positive value to cap runaway
runs. The setting is global (`autopilot.maxCycles` in `config.yml`), so
`/autopilot max` changes it for every session and re-arms the current prompt's
budget.

## Observability

- `/autopilot status` shows the strategy, cycles/cap, directive and the last
  decision (kind, decision, model, stop reason).
- Every decision and stop is appended as an `autopilot-decision` custom entry,
  giving the status line and future tooling a durable journal.
- Decisions render as compact transcript cards. `Ctrl+O` (the transcript-wide
  tool-output toggle) expands kind, strategy, model, responder latency/tokens
  and the stop reason. Reiterations render as `reiterated the objective`.

## Settings

| Setting               | Default      | Meaning                                            |
| --------------------- | ------------ | -------------------------------------------------- |
| `autopilot.enabled`   | `false`      | Default when the session has no journaled toggle.  |
| `autopilot.strategy`  | `goal-aware` | `answer`, `continue` or `goal-aware`.              |
| `autopilot.maxCycles` | `0`          | Automatic cycles per user prompt; `0` = unlimited. |

The per-session toggle and directive live in the session journal, so resuming
a session restores both. The strategy and cycle limit are global settings.
