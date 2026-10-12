# session

> Let the agent rename the session, move it to another directory between steps, and manage the current repository's git worktrees.

## Source
- Entry: `packages/coding-agent/src/tools/session.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/session.md`
- Key collaborators:
  - `packages/coding-agent/src/session/agent-session.ts` — queues a requested move and applies it from the `onTurnEnd` hook (`requestWorkspaceMove`, `setWorkspaceRelocator`).
  - `packages/coding-agent/src/modes/controllers/command-controller.ts` — interactive relocator (`relocateForAgent`), reusing the `/move` relocation.
  - `packages/coding-agent/src/session/session-worktree.ts` — `createSessionWorktree`, shared with `/wt`.
  - `packages/coding-agent/src/sdk.ts` — builds `ToolSession.sessionControl` for top-level sessions.

## Availability and approval
- `session.enabled` defaults to `false`; enable it in **Settings → Tools**.
- Top-level sessions only. Subagents and advisors have no `sessionControl`, so the tool is not created for them.
- Approval tier by op: `worktree_list` is `read`, `rename` is `write`, `move`, `worktree_create`, and `worktree_remove` are `exec`.

## Inputs

| Field | Type | Used by | Description |
| --- | --- | --- | --- |
| `op` | `"rename" \| "move" \| "worktree_list" \| "worktree_create" \| "worktree_remove"` | all | Dispatch selector. |
| `title` | `string` | `rename` | New session title. Stored as a user-set title, so automatic titling no longer replaces it. |
| `path` | `string` | `move`, `worktree_remove` | Existing directory (`move`) or registered worktree path (`worktree_remove`). Relative paths resolve against the session's current directory. |
| `branch` | `string` | `worktree_create` | New branch created from `HEAD`. Existing branch names are refused. |
| `carryChanges` | `boolean` | `worktree_create` | Copy uncommitted changes into the new worktree. Default `false` (clean checkout), unlike `/wt`, which always carries them. |
| `move` | `boolean` | `worktree_create` | Also queue a `move` into the new worktree. |
| `force` | `boolean` | `worktree_remove` | Remove a worktree that has uncommitted changes, discarding them. |

## Move timing
`move` does not relocate immediately. It queues the directory, and `AgentSession` applies it at the next turn boundary: the current tool batch has finished in the old directory, its messages are persisted, and the next provider request runs in the new one. Tool calls issued in the same step as `move` still run in the old directory.

The relocation is the one `/move` performs. In the interactive mode that includes the BTW gate, the process cwd, project settings, skills, commands, and todos. Only the interactive mode registers a relocator, because moving changes `process.cwd()` for every session in the process. In RPC, ACP, print, and SDK hosts `move` and `worktree_create` with `move: true` fail up front with `This host cannot move the session workspace. Ask the user to run /move.` (nothing is created), and the user can still run `/move`.

A queued move is dropped when the run is aborted or a new run starts. If the move fails, a warning notice is shown and the next step gets a hidden note saying so.

## worktree_remove guards
- The path must be a registered worktree of the repository (`git worktree list`).
- The primary checkout is refused.
- A path containing the session's working directory, any additional workspace directory, or a pending move target is refused.
- A worktree with uncommitted changes (staged, unstaged, or untracked) is refused unless `force: true`.
- A worktree locked with `git worktree lock` is refused unless `force: true`.
- Mutating ops run exclusively (never overlapping another `session` call in the same batch). Only `worktree_list` may overlap.
- The branch is kept.

## Limits
- `worktree.cleanSource` is not applied by `worktree_create`.
- Over `xd://session` (the default `tools.xdev` presentation) the call is a `write`, so harnesses that gate by tool name see it as a `write` to a protocol path rather than as op-level `session` calls.
