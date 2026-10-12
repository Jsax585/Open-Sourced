Rename this session, move it to another directory, and manage the current repository's git worktrees.

<instruction>
Select via `op`.
- `rename`: retitle the session with `title`.
- `move`: relocate the session's working directory to `path` (existing directory). The move takes effect at the next step boundary, after the current tool batch finishes. Calls issued in the same step still run in the old directory. Do destination-dependent work in your next step, never alongside `move`.
- `worktree_list`: list the repository's worktrees with branch, uncommitted-change state, and which one this session works in.
- `worktree_create`: create a linked worktree on new branch `branch`, branched from `HEAD`, under the agent-managed worktree base. Default is a clean checkout; `carryChanges: true` copies uncommitted changes in. `move: true` also queues a `move` into it.
- `worktree_remove`: remove the worktree at `path`. Refuses the primary checkout, any directory this session works in, and trees with uncommitted changes. `force: true` discards those changes; use it only when the user asked. The branch is kept.
</instruction>

<critical>
Use `move` and `worktree_create` only when the user asked to move the session or create a worktree.
</critical>
