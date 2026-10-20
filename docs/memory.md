# Autonomous Memory

omp supports five memory modes. Memory is disabled by default; select one backend via `/settings` or `config.yml`:

| `memory.backend` | Storage and behavior                                                   | Guide                                                   |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `off`            | No memory backend                                                      | —                                                       |
| `local`          | Project-scoped summaries and lessons generated from persisted sessions | This page                                               |
| `hindsight`      | Remote, bank-scoped Hindsight memory                                   | [Hindsight](#hindsight-remote-backend)                  |
| `mnemopi`        | Local Mnemopi SQLite memory                                            | [Mnemopi memory backend](./mnemosyne-memory-backend.md) |
| `sharpshooter`   | Friction-gated project decision files (architecture/product/style), consolidated in the background | [Sharpshooter](#sharpshooter-backend) |

Enable the local summary pipeline:

```yaml
memory:
  backend: local
```

## Usage

### What gets injected

At session start, if a consolidated summary or manually captured lesson exists for the current project, it is injected into the system prompt as a **Memory Guidance** block. The summary and lessons share `memories.summaryInjectionTokenLimit`.

If startup consolidation finishes after the first prompt build, the active session's summary snapshot is refreshed. Captured lessons remain pinned to the initial snapshot, so a concurrent `learn` call still affects only later sessions.

- Treat memory as heuristic context — useful for process and prior decisions, not authoritative on current repo state.
- Cite the memory artifact path when memory changes the plan, and pair it with current-repo evidence before acting.
- Prefer repo state and user instruction when they conflict with memory; treat conflicting memory as stale.

### Reading memory artifacts

The agent can read memory files directly using `memory://` URLs with the `read` tool:

| URL                                    | Content                              |
| -------------------------------------- | ------------------------------------ |
| `memory://root`                        | Compact summary injected at startup  |
| `memory://root/MEMORY.md`              | Full long-term memory document       |
| `memory://root/learned.md`             | Lessons captured by the `learn` tool |
| `memory://root/skills/<name>/SKILL.md` | A generated skill playbook           |
| `memory://<memory-id>`                 | Full Mnemopi memory row (working or episodic) with a YAML frontmatter metadata header; only available when `memory.backend` is `mnemopi` |

The `memory://<memory-id>` form returns the full stored row rather than the clipped recall preview (recall content that exceeds the preview cap ends with a trailing `…`); agents are instructed to read it before any `memory_edit update`.

The `memory://root[/…]` rows are file-backed and only exist with `memory.backend: local`, which populates the on-disk memory root via the consolidation pipeline. Under `hindsight` or `mnemopi` the root is never written, so those URLs do not resolve — use `recall`/`reflect` (and `read memory://<memory-id>` on `mnemopi`) instead.

### `/memory` slash command

| Subcommand            | Effect                                                    |
| --------------------- | --------------------------------------------------------- |
| `view`                | Show the current backend injection payload                |
| `stats`               | Show backend-specific memory statistics, when supported   |
| `diagnose`            | Show backend-specific diagnostics, when supported         |
| `queue`               | Show pending memory deltas awaiting consolidation         |
| `sync`                | Run memory consolidation now                              |
| `clear` / `reset`     | Delete active backend memory data/artifacts               |
| `enqueue` / `rebuild` | Force consolidation/retention work for the active backend |
| `mm …`                | Hindsight mental-model maintenance (`list`/`show`/`refresh`/`history`/`seed`/`delete`/`reload`); unsupported in ACP mode |

### Capturing lessons

Enable `autolearn.enabled` to make the `learn` tool available:

```yaml
autolearn:
  enabled: true
```

With the local backend active, `learn` saves explicit durable lessons to the project's `learned.md`. Lessons are newest-first, deduplicated, secret-redacted, capped at 100 entries, and injected starting with the next session; a `learn` call does not mutate the active session's prompt-cache prefix. Each lesson's content is capped at 2,000 characters and optional context at 400 characters. Structured memory search, `recall`, `retain`, `reflect`, and `memory_edit` are not available for the local backend.

## How it works

Local summary memories are built by a background pipeline that runs at startup; `/memory enqueue` marks consolidation work that the next startup picks up. The pipeline is skipped for subagents and for sessions that are not persisted to a session file.

**Phase 1 — per-session extraction:** For each past session that has changed since it was last processed, a model reads the session history and extracts durable signal: technical decisions, constraints, resolved failures, recurring workflows. Sessions that are too recent, too old, currently active, or beyond the configured scan/age limits are skipped. Each extraction produces a raw memory block and a short synopsis for that session.

**Phase 2 — consolidation:** After extraction, a second model pass reads all per-session extractions and produces three generated outputs written to disk:

- `MEMORY.md` — a curated long-term memory document
- `memory_summary.md` — the compact text injected at session start
- `skills/` — reusable procedural playbooks, each in its own subdirectory

The separately maintained `learned.md` is not overwritten by consolidation.

Phase 2 uses a lease and heartbeat to prevent double-running when multiple processes start simultaneously. Stale skill directories from prior runs are pruned automatically.

Consolidated output is redacted for common secret/token patterns before `MEMORY.md`, `memory_summary.md`, or generated skills are written to disk.

### Extraction behavior

Memory extraction and consolidation behavior is driven by static prompt files in `packages/coding-agent/src/prompts/memories/`.

| File                      | Purpose                                          | Variables                                   |
| ------------------------- | ------------------------------------------------ | ------------------------------------------- |
| `stage_one_system.md`     | System prompt for per-session extraction         | —                                           |
| `stage_one_input.md`      | User-turn template wrapping session content      | `{{thread_id}}`, `{{response_items_json}}`  |
| `consolidation_system.md` | System prompt for cross-session consolidation    | —                                           |
| `consolidation.md`        | User-turn prompt for cross-session consolidation | `{{raw_memories}}`, `{{rollout_summaries}}` |
| `read-path.md`            | Memory guidance injected into live sessions      | `{{memory_summary}}`, `{{learned}}`         |

### Model selection

Memory piggybacks on the model role system.

| Phase                   | Role                                                                | Purpose                          |
| ----------------------- | ------------------------------------------------------------------- | -------------------------------- |
| Phase 1 (extraction)    | `default`                                                           | Per-session knowledge extraction |
| Phase 2 (consolidation) | `smol` (falls back to `default`, then current/first registry model) | Cross-session synthesis          |

If the requested memory role is not configured, memory model resolution falls back to the `default` role, then the active session model, then the first model in the registry.

## Configuration

| Setting                               | Default | Description                                                                                                                              |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`                      | `off`   | Select `local` for this pipeline; legacy `memories.enabled: true` is migrated to `memory.backend: local` when no explicit backend is set |
| `memories.maxRolloutAgeDays`          | `30`    | Sessions older than this are not processed                                                                                               |
| `memories.minRolloutIdleHours`        | `12`    | Sessions active more recently than this are skipped                                                                                      |
| `memories.maxRolloutsPerStartup`      | `64`    | Cap on sessions processed in a single startup                                                                                            |
| `memories.threadScanLimit`            | `300`   | Maximum recent session records scanned at startup                                                                                        |
| `memories.maxRawMemoriesForGlobal`    | `200`   | Maximum per-session extractions supplied to global consolidation                                                                         |
| `memories.stage1Concurrency`          | `8`     | Concurrent per-session extraction jobs                                                                                                   |
| `memories.stage1LeaseSeconds`         | `120`   | Extraction job lease duration                                                                                                            |
| `memories.stage1RetryDelaySeconds`    | `120`   | Delay before a failed extraction becomes claimable again                                                                                 |
| `memories.phase2LeaseSeconds`         | `180`   | Consolidation lease duration                                                                                                             |
| `memories.phase2RetryDelaySeconds`    | `180`   | Delay before failed consolidation is retried                                                                                             |
| `memories.phase2HeartbeatSeconds`     | `30`    | Consolidation lease heartbeat interval                                                                                                   |
| `memories.rolloutPayloadPercent`      | `0.7`   | Fraction of the selected model's context budget available to rollout payloads                                                            |
| `memories.phase1InputTokenLimit`      | `4000`  | Per-session extraction input cap                                                                                                         |
| `memories.fallbackTokenLimit`         | `16000` | Model token budget used when the model has no finite declared context window                                                             |
| `memories.summaryInjectionTokenLimit` | `5000`  | Shared approximate token cap for the summary and captured lessons injected into the system prompt                                        |

## Hindsight remote backend

Hindsight requires a reachable [Hindsight](https://hindsight.vectorize.io/) server. The default endpoint is `http://localhost:8888`; set a token when the server requires authentication:

```yaml
memory:
  backend: hindsight
hindsight:
  apiUrl: http://localhost:8888
  apiToken: ${HINDSIGHT_API_TOKEN}
```

`HINDSIGHT_*` environment variables override `hindsight.*` settings, which override built-in defaults. See the [complete Hindsight environment-variable table](./environment-variables.md#hindsight-memory-backend) for all 18 supported overrides, accepted values, parsing rules, precedence, and defaults.

By default, Hindsight uses `per-project-tagged` scoping: writes go to a shared bank with a project tag, while recall includes project-tagged and untagged global memories. `per-project` isolates each working-directory project in its own bank; `global` uses one shared bank. An explicit `hindsight.bankId` selects the bank base. Changes to the bank ID, prefix, or scoping rebuild the primary session state so later operations use the new scope. A failed outgoing handoff remains pending and is retried before the next prompt, enqueue, compaction recall, or mental-model reload rather than silently keeping the old route.

Both project-scoped modes name the project the same way: take the repository's primary checkout root (so every linked worktree of one repository resolves to the same directory), then lowercase its basename. A checkout at `~/code/General` therefore tags `project:general`. Tags are matched literally, so this fold is what keeps one repository in one memory scope no matter how the path is capitalised.

The primary session recalls on its first model turn (`hindsight.autoRecall: true`) and automatically retains completed conversation turns every three user turns by default. `/memory enqueue` flushes queued tool retains and forces retention of the current session. At agent end, the primary state schedules cadence-based retention and flushes the retain queue. Starting, switching, or forking a session and disposing its state drain pending retains and conversation-source receipts before replacing or closing the originating ledger. Request failures and configured timeouts are logged and leave the coding session usable. Subagents alias the parent's client, bank, and scope for explicit `recall`, `retain`, and `reflect` calls, but do not run their own automatic recall or retention.

Conversation retention follows the selected session branch, not abandoned entries in the session ledger. Rewinding, navigating the tree, or reloading rewritten history reconciles previously tracked sources without waiting for another user turn: full-session documents are replaced, and abandoned last-turn windows or empty sources are deleted. Revisiting a shortened or deleted source restores its previously retained content under the same document ID; unchanged surviving last-turn windows are reused instead of duplicated. Branch synchronization repairs tracked sources without triggering cadence-based retention of new content. Failed reconciliation requests are logged without failing local navigation, and unfinished replacements remain retryable on the next synchronization. These server-side source changes can remove derived memories and cannot be undone by reverting the client. Previously untracked historical documents are not inventoried or cleaned up retroactively.

Moving to a different project first finishes the outgoing conversation segment in its original bank and project tags, even below the normal retention cadence. The move waits for that write; a failure stops the move before the session changes directory. A live receipt that already covers the unchanged outgoing messages, including a cadence-retained last-turn window, is reused instead of uploaded again. Destination installation also reuses the completed outgoing handoff. Destination messages start a separate segment, including when returning to an earlier project. Linked worktrees of the same repository remain one project and keep one full-session document. Segment ownership and source receipts survive reopening and forks; a fork uses independent document IDs rather than overwriting the parent's sources.

Resuming another session finishes the outgoing ledger before loading the target, including below-cadence turns. A cross-project resume binds the target's own scope without uploading its existing history under the source project's tags. Changing `hindsight.apiUrl` or `hindsight.apiToken` likewise finishes the outgoing segment through its original service client before binding the new account, even when bank and project tags are unchanged.

With `hindsight.autoRetain: false`, automatic completion, move, rewind, tree-navigation, and reload paths neither upload nor delete conversation sources. Explicit `/memory enqueue` remains available to retain the selected conversation. This setting does not disable explicit tool-retain requests.

Explicit `/memory enqueue` uploads unfinished historical segments in their original scope and resends the active segment even when its receipt is unchanged, allowing recovery after server-side source loss. Full-session retention replaces the existing document; last-turn retention creates a fresh window, as on an ordinary explicit retain. Automatic scope handoffs still reuse unchanged receipts without resending.

Recall is injected as background context, not instructions, and recalled memory is also available as extra context during compaction. The first-turn recall is stored in the session file, so resuming, switching to, or forking the session sends it unchanged instead of recalling again; a context reset, a different bank or tag filter, or a branch that edits the first prompt recalls afresh. Hindsight memories cannot be looked up by id, so changes to them since the recall are not reported. Mental models are still reloaded when a new process starts. Selecting Hindsight exposes `recall`, `retain`, and `reflect`; `memory_edit` is not available because upstream Hindsight memories are not edited through this backend.

`/memory view`, `/memory stats`, `/memory diagnose`, and `/memory enqueue` operate through the active Hindsight state. `/memory clear` first drains pending retains, then clears only the local session state and recall cache. It **does not delete the server-side bank**; delete that bank with the Hindsight UI or API.

## Sharpshooter backend

Sharpshooter keeps three short project decision files — `architecture.md`, `product.md`, and `style.md` — and injects them into the system prompt. It needs no server; files live under `<agentDir>/memories/sharpshooter/<bank>/`, where the bank is derived from the working directory, so each project has its own decisions.

```yaml
memory:
  backend: sharpshooter
sharpshooter:
  minPromptLength: 4
  intervalMinutes: 5
```

**Extraction:** each user prompt in the main session (subagents are skipped) goes to the extraction model, which records durable decisions the user made — architecture, product, and style decisions, constraints, rejected approaches, and corrections — as deltas in a per-session queue. Slash commands and prompts shorter than `sharpshooter.minPromptLength` characters are not sent; a session runs one extraction at a time, and a prompt that arrives while one is running is not extracted. Short replies such as "opt 2" are resolved against the preceding assistant message, but at the default of 16 characters they are too short to be sent — lower `sharpshooter.minPromptLength` to capture them.

**Consolidation:** a scheduler checks every minute and, once `sharpshooter.intervalMinutes` have passed since the last run, applies the queued deltas to the three files in one model pass and removes them from the queue. `/memory enqueue` consolidates immediately; `/memory queue` lists pending deltas and `/memory clear` deletes the project's files and queue.

| Setting                            | Default    | Description                                                                                                                                                                                                                 |
| ---------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`                   | `off`      | Set to `sharpshooter` to enable this backend                                                                                                                                                                                |
| `sharpshooter.model`               | unset      | Model selector for extraction and consolidation; unset uses the `smol` role                                                                                                                                                 |
| `sharpshooter.minPromptLength`     | `16`       | Prompts shorter than this many characters are not sent for extraction; values below `2` act as `2`. Characters are counted as displayed (one CJK character or emoji is one), the same in every language, so Chinese users may lower it to capture short replies such as "用方案二" |
| `sharpshooter.intervalMinutes`     | `5`        | Minimum minutes between consolidation runs                                                                                                                                                                                  |
| `sharpshooter.injectionTokenLimit` | `15000`    | Approximate token cap for the decision files injected into the system prompt                                                                                                                                                |

## Key files

- `packages/coding-agent/src/memories/index.ts` — pipeline orchestration, injection, clear/enqueue entry points (the `/memory` command routes here via `packages/coding-agent/src/memory-backend/local-backend.ts`)
- `packages/coding-agent/src/memories/storage.ts` — SQLite-backed job queue and thread registry
- `packages/coding-agent/src/prompts/memories/` — memory prompt templates
- `packages/coding-agent/src/internal-urls/memory-protocol.ts` — `memory://` URL handler
