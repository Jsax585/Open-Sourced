# Benchmark-gated model quality policy

Score-ordered model/quotafallback driven by measured benchmark evidence instead of
hardcoded model chains. Extensions register evidence; the host admits, ranks, and
verifies. This document covers the target-score contract, the model-database
cache, Kiro transport evidence, and rollout requirements. The extension API
surface is documented under [Model admission policies](./extensions.md#model-admission-policies).

## Implementation files

- [`../packages/ai/src/model-policy.ts`](../packages/ai/src/model-policy.ts) — scopes, admission, ranking, per-transport wire assertions
- [`../packages/ai/src/thinking-budgets.ts`](../packages/ai/src/thinking-budgets.ts) — effort plumbing shared with admission
- [`../packages/coding-agent/src/extensibility/extensions/loader.ts`](../packages/coding-agent/src/extensibility/extensions/loader.ts) — `requiredModelPolicies` manifest gate, per-session factory binding
- [`../packages/coding-agent/src/extensibility/extensions/runner.ts`](../packages/coding-agent/src/extensibility/extensions/runner.ts) — owner-scope callback inference
- [`../packages/coding-agent/src/extensibility/extensions/types.ts`](../packages/coding-agent/src/extensibility/extensions/types.ts) — `PreparedExtension.error`, `registerModelPolicy`
- [`../packages/coding-agent/src/config/model-resolver.ts`](../packages/coding-agent/src/config/model-resolver.ts) — policy-aware role resolution
- [`../packages/agent/src/compaction/`](../packages/agent/src/compaction/) — policy admission in native and Codex compaction paths

## Target-score policy

The reference policy (`model-quality`, shipped as a stock-runtime extension, not
core) admits a model/effort pair only when measured Artificial Analysis Agentic
Index evidence for that exact model and named effort meets `targetScore`
(default 40.2, inclusive boundary). Matching uses catalog-reviewed logical and
billing identities; friendly labels, bare wire-route aliases, and `Pro` serving
variants never borrow scores, and token-budget surfaces never inherit named
effort scores. A null measurement is unknown, never zero. Conflicting duplicate
evidence and malformed snapshots are rejected. With no complete snapshot, stale
snapshot after an unpersisted revocation, initialization failure, or corrupt
cache, the policy denies all inference rather than reverting to an unrestricted
model. `targetScore` reconfigures at a turn boundary without reparsing unchanged
evidence. Ranking is score order; it cannot grant admission.

## Model-database cache

Snapshots persist in an `omp_model_quality_cache` table inside the native model
database resolved by `ctx.modelRegistry.getCacheDbPath()`. Native provider
tables, schema version, journal mode, and recovery behavior are untouched, and
no credentials are stored in benchmark metadata. Refresh is online-first on a
24-hour interval; source failures retain the last complete snapshot while
persistence failures deny admission until a refresh succeeds. Corrupt plugin
evidence is replaced by a complete online snapshot without touching native
tables (covered by plugin cache tests alongside native refresh coexistence).

## Kiro transport evidence

The Kiro adapter is an out-of-tree omp extension; it is not part of this change
and is cited only as independent exercise of the hook. Kiro GPT-5.6 models
advertise only identity-mapped efforts (`low`, `medium`, `high`, `xhigh`, `max`;
`minimal`→`low` and `off`→`none` aliases are not admitted as exact efforts).
Against live cached evidence at the default target, the admitted sets are:

- `kiro/gpt-5.6-terra`: `xhigh` (41.4), `max` (43.2)
- `kiro/gpt-5.6-luna`: `max` (42.1)
- `kiro/gpt-5.6-sol`: `high` (44.2), `xhigh` (47.4), `max` (50.2)

The adapter transmits the admitted effort in the official root
`additionalModelRequestFields` document, and the payload hook cannot change the
serialized model or effort before HTTP dispatch (provider suite:
`tests/kiro-stream.test.mjs`, `tests/hardening.test.mjs`). End to end with
ordinary retry/fallback disabled: a below-floor primary is denied by the policy
and the call completes on `kiro/gpt-5.6-sol` with the scored effort.

## Rollout requirements

- Ship on the stock omp runtime plus the extension. No runtime fork: fleet
  nodes keep stock omp; only the extension and its `targetScore` setting deploy.
- A host containing the model-policy API is required. The extension manifest
  declares `requiredModelPolicies: ["model-quality"]`; older hosts cannot
  enforce it and must refuse the extension rather than run it unrestricted.
- Verified native policy transports are OpenAI chat/Responses/Codex/Azure,
  OpenRouter, Anthropic Messages, and Google Gemini API/CLI/Vertex. Other
  transports deny under a policy until their final request is verifiable.
- An extension-owned custom transport may declare `modelPolicyEffort: true`
  only if it faithfully transports canonical reasoning and explicit off
  controls through final serialization including payload hooks; a CLI fallback
  that cannot attest the exact model/effort must not declare it.
- `AA_API_KEY` (or the `artificial-analysis` auth-storage key) is needed only
  for online refresh; a seeded validated cache is sufficient for offline,
  air-gapped admission.
