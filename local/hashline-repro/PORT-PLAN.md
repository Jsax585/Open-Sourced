# pi-edit port — state and remaining plan

Branch: `port/hashline-native` (7 commits, all inert, all independently revertable).
Baseline for rollback: fork Rust workspace built clean before any of this.

## Why

Reproduced bug: the fork's hashline recovery can apply an edit to the **wrong
location, silently**. See `README.md` in this directory for the mechanism and
`fork-recovery.ts` to reproduce. Upstream's engine gets the same case right.

A cheap TypeScript guard was attempted and **does not work** — the defect is the
reconstruct-then-fuzzy-merge architecture, not a tunable. Details in `README.md`.

## Done — steps 1-5

| commit | contents |
|---|---|
| `707cb9a966` | fix `ShellConfig` test initializer (pre-existing; blocked `cargo test` on unix) |
| `ce9f5803e6` | `panic = "unwind"` + regression test (pre-existing; `catch_unwind` was dead code) |
| `f715c83fba` | `[workspace.dependencies]` + `[workspace.lints.rust]` |
| `aaaaa02d6f` | vendor `pi-diff`, `pi-walker` |
| `fd7dd7015d` | vendor `pi-ast` |
| `5af4604eca` | vendor `pi-edit` (35,486 lines, 167 files) |
| `07b9654790` | napi bridge `edit.rs` + regenerated `index.d.ts` / `index.js` |

All crates vendored **verbatim** from `origin/main`. Full workspace builds and
tests green, zero failures, clippy clean. Nothing in TypeScript imports the
bindings, so the live edit path is unchanged.

## Remaining — step 6 (needs a go/no-go)

Replace the TypeScript edit layer (`packages/coding-agent/src/edit/`, 8,831
lines) with a shim over the napi bindings. Upstream's equivalent shim is 686
lines. ~17 consumer files, including `session/agent-session.ts` and
`tools/write.ts`.

### Costs, all confirmed rather than estimated

- **Different patch language.** `[PATH#TAG]` / `PUT N.=M:` / `+TEXT` versus the
  fork's `@PATH` / `= A..B` / `~TEXT`. Verified empirically: `@src/foo.ts`
  parses to nothing upstream. Models must be retrained on the new syntax.
- **`024b4bf8e8` must be rewritten.** The `/review` anchor validation targets
  the fork's grammar and per-line anchors; it does not translate.
- **`5f21aa5757` is superseded**, as intended.
- **Rollback is build-time, not a setting.** Only one `pi_natives` binary can be
  installed; loading two segfaults Bun in either order. The `edit.engine`
  toggle discussed early on is not achievable.
- **Read tool change is small.** `recordSnapshot(path, text, seenLines)` returns
  the tag; the read tool renders what the engine hands back rather than
  computing hashes itself.

### Sequence

1. TS shim over `editSession` / `editInspect` / `editMode`, replacing
   `edit/index.ts` and `edit/modes/*`.
2. Update the ~17 consumers.
3. Read tool emits `[PATH#TAG]` headers from `recordSnapshot`.
4. Rewrite `024b4bf8e8`'s anchor validation against `#TAG` semantics.
5. Update prompts (`prompts/tools/hashline.md`) — or use the engine's own, via
   `editDescription("hashline")`, which is 5,236 bytes and already correct.

## Environment notes

- `~/.cargo` is read-only from the agent sandbox; builds used
  `CARGO_HOME=/tmp/cargo-home`. Not needed outside the sandbox.
- The native build **installs** its output to both
  `packages/natives/native/` and `node_modules/@oh-my-pi/pi-natives/native/`.
  The current 132 MB binary is a verified **strict superset** of the previous
  117 MB one: all 54 original exports present, 14 new edit bindings added.
- Previous binary backed up at `/tmp/hl-harness/pi_natives.backup.node`.
  **`/tmp` is volatile — copy it somewhere durable if you want it.**
- `main` tracks `origin` (upstream), not `toast`. A `git pull` on `main` would
  try to merge ~19,942 upstream commits. Worth repointing.

## Open question

The reproduction is a plausible failure mode, not a confirmed match for the
bugs originally reported. If observed symptoms differ — wrong *content* rather
than wrong *location*, mangled output, spurious rejections — chase those before
committing to the rewrite.