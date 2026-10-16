# Hashline wrong-location bug — reproduction

Standalone repros for the bug found while scoping the `pi-edit` port
(branch `port/hashline-native`). Kept out of the test suite because they
target a known-broken path; promote them if the fix lands in TypeScript.

## The bug

`tryRecoverHashlineWithCache` (`packages/coding-agent/src/edit/modes/hashline.ts:1528`)
can apply an edit to the **wrong location, silently**.

When anchors go stale, recovery reconstructs a "previous" file by overlaying
cached read-snapshot lines onto current content, replays the edits against
that reconstruction, then 3-way merges the diff back with
`HASHLINE_RECOVERY_FUZZ_FACTOR = 3` (lines 1554-1555).

`Diff.applyPatch` commits to the *first* site whose context matches within
tolerance and returns a string either way. When the target line is duplicated
earlier in the file — `return x;`, a bare `}`, a repeated import — the first
match is often not the anchored one. The edit lands in the wrong function and
reports success; the model believes it edited the intended code.

## Reproducing

```
bun local/hashline-repro/fork-recovery.ts
```

Expected output on the current implementation:

```
shift by 2 (prepended import)        -> recovered  [CORRECT]
duplicate target line earlier in file -> recovered  [WRONG PLACE]   <-- the bug
anchored line rewritten on disk       -> null (correct: rethrows mismatch)
```

`fork-only.ts` drives the non-recovery path for comparison; it must run in its
own process (see below).

## Why the obvious guard does not work

Rejecting when a hunk's context matches more than once fails: the overlay
reconstruction produces text that never existed, so context typically matches
the real file **zero** times, not once.

- reject on `!== 1` — breaks legitimate recoveries (the shift case)
- reject on `> 1`   — the corrupt-overlay case matches 0 and slips through

By the time a patch exists the comparison input is already fiction. A real fix
must track anchor identity through the merge instead of pattern-matching
context afterwards — i.e. keep the exact snapshot and remap against it, which
is what upstream's `crates/pi-edit/src/modes/hashline/recovery.rs` does.

Verified: on the same scenario the vendored Rust engine edits the correct
function and reports `isError: false`.

## napi double-load

Do not import the fork's TypeScript hashline and load a second copy of the
native addon in one process — it segfaults Bun in either load order. Only one
`pi_natives` binary can be installed at a time, so comparisons must run the
two engines in separate processes.