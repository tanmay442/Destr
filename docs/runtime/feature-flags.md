# Runtime Feature Flags — Lifecycle Inventory (WP-9)

Secret-free. Source of truth for parsing is
`packages/application/src/runtime/wp8-flags.ts` (`WP8_FLAGS`, `readWp8Flag`,
`readWp8Flags`); on any conflict that module wins. Companion record:
`docs/runtime/wp8-flags-rollback.md`. Parsing everywhere: `1`/`true`/`on`/`yes`
enable, `0`/`false`/`off`/`no` disable (case-insensitive, whitespace allowed);
unset uses the default; unrecognized values fail safe to the default.

WP-9 deletes the seven rollout/experiment flags below and keeps exactly one
agentic search path: the structured orchestrator
(`packages/application/src/agent/search/search-orchestrator.ts`), wired
unconditionally in `src/composition.ts` and selected in agentic mode in
`packages/application/src/agent/turn-tools.ts` (see
`docs/wp9-migration-notes.md`).

## Removed in WP-9

| Flag | Reason | Rollback replacement (no flag) |
|---|---|---|
| `TOOL_CATALOG_ENABLED` | Catalog is the only tool assembly; `isCatalogEnabled` deleted (was `chat-tools-compat.ts`, now `agent/turn-tools.ts`), legacy `buildChatTools` assembly already gone since WP-5 | None — `buildCatalogToolsForTurn` always builds the catalog; rollback is a revertible commit |
| `SEARCH_STRUCTURED_PLANNER_ENABLED` | Orchestrator is the agentic search path; `search-flags.ts` deleted | Agentic mode uses the orchestrator when `structuredSearch` is wired; `AGENTIC_ENABLED=false` selects normal-direct retrieval |
| `SEARCH_PLANNER_SHADOW` | No shadow comparison in the request path | Removed; comparison lives in offline eval (`scripts/eval/wp4-retrieval.ts`) |
| `SEARCH_QUERY2DOC_ENABLED` | Experimental expansion never wired (read-and-ignored by design since WP-4) | Removed outright; no replacement path |
| `SUPPORT_AGENT_ENABLED` | `agent-flags.ts` deleted; `SupportAgent` loop is the only agent path, one-step no-tools fallback removed (`turn.ts:848-850`) | None — rollback is a revertible commit (pinned by `support-agent-wp5-gaps.test.ts`) |
| `GROUNDED_RELEASE_ENABLED` | `grounding-flags.ts` deleted; the release policy always runs with fail-closed release (`grounding-check.test.ts:334-340`) | None — the disabled path's fail-closed behavior (deterministic validation, no grader call, safe response, no cache write of unverified answers) is now the only behavior |
| `WP8_ROUTE_DURATION_INCREASE_ENABLED` | `routeDurationIncrease` removed from `wp8-flags.ts` (now four flags, `wp8-flags.ts:1-27,157-167`); the definition was unread by production — no caller of `readWp8Flag`/`readWp8Flags` consumed it — and unsafe to wire without load evidence | None — the route stays pinned at `maxDuration = 60` with a build assertion against `CHAT_ROUTE_MAX_DURATION_SECS` (`src/app/api/chat/route.ts:13-26`); any future increase requires a decision-record update in `docs/runtime/route-duration-decision.md` first |

Note: `docs/agent-tool-extension-guide.md` §2 is a consistent historical
record ("the flag and the legacy assembly below were deleted") — it agrees
with this inventory and needs no update. `docs/runtime/wp8-flags-rollback.md`
was updated to match (route-duration rows removed, wiring statuses current).

## Retained

### `AGENTIC_ENABLED` (effectively the global retrieval kill-switch)

- Owner: not declared in a flag module (acting: chat agent on-call).
- Default: on (`packages/domain/src/constants.ts:52`; `env.ts:148` parses
  `!== 'false'`).
- Effect: `retrievalMode: AGENTIC_ENABLED ? 'agentic' : 'normal'`
  (`config/app.config.ts:85`); `turn.ts:331` forces `effectiveMode = 'normal'`;
  `src/lib/config/runtime.ts:100,182-183` forces `normal` over DB overrides
  with a warning; aux models resolve to `undefined` so graders/rewriters are
  absent (`packages/infrastructure/src/llm/index.ts:159`).
- Rollout/removal: not declared in code — TBD (this is the supported
  normal-direct rollback, not a candidate for removal).
- Rollback: `AGENTIC_ENABLED=false` selects normal-direct search; never
  restores fail-open grounding, unauthorized writes, or unbounded overload
  (see invariants below).
- Metrics: turn `mode` (`vector` vs `agentic`, `turn.ts:333`), retrieval
  diagnostics per call.

### `WP8_SERVER_PROGRESS_ENABLED`

- Owner: chat UX on-call. Default: off (`wp8-flags.ts:52-75`).
- Effect: route streams server-driven transient progress events from real
  orchestration phases; off keeps previous client-side status behavior with no
  progress events.
- Rollout: internal users first; verify event-rate and accessibility under load.
- Removal: after server-driven progress is the only progress path and
  timer-invented stages are deleted.
- Rollback: `WP8_SERVER_PROGRESS_ENABLED=0` + restart.
- Metrics: `time_to_first_progress_event_p95`,
  `progress_events_per_second_per_turn`, `progress_payload_bytes_p99`.
  Auto-rollback: >1 non-terminal event/s/turn, p99 payload >512 B, first event
  >750 ms at p95. Wired: `turn.ts:201`, `chat-chunks.ts:19`.

### `WP8_DISTRIBUTED_ADMISSION_ENABLED`

- Owner: capacity on-call. Default: off (`wp8-flags.ts:102-129`).
- Effect: distributed per-user active-turn leases plus global/per-provider
  admission with bounded queues and load shedding; off leaves only
  process-local guards.
- Rollout: shadow, then 1/5/25/50/100% with deadline, throttle, DB-wait,
  Redis-failure, and cost thresholds green.
- Removal: after distributed admission is the only admission path and the
  process-local map is a documented fast-path only.
- Rollback: `WP8_DISTRIBUTED_ADMISSION_ENABLED=0` + restart.
- Metrics: `admitted_shed_completed_per_second`, `queue_wait_p95`,
  `provider_throttle_rate`, `db_pool_wait_p95`. Auto-rollback: provider
  throttle/error ≥0.5% after admission, DB pool wait p95 >100 ms, deadline
  outcomes >0.5% outside injected slowness, admissible acceptance <99.5%.
  Wired (WP-9 cutover): the request path (`src/admission.ts`) consults the
  `AdmissionController` (per-user, global, provider ceilings; typed 429/503 +
  `Retry-After`); the distributed per-user lease reuses the slots key scheme
  when the flag is on. Global/provider ceilings stay process-local
  best-effort (see capacity model); cross-instance shared counters are future
  work.

### `WP8_DURABLE_JUDGE_QUEUE_ENABLED`

- Owner: evaluation on-call. Default: off (`wp8-flags.ts:130-155`).
- Effect: sampled judges and non-critical analytics go to a bounded durable
  isolated queue with retries + dead-letter handling; off keeps best-effort
  scheduling.
- Rollout: move sampled judges to the durable path before any 4,000-active-turn
  rollout; judges shed before interactive work.
- Removal: after the durable queue is the only judge path and backlog-age
  alerts have burned in.
- Rollback: `WP8_DURABLE_JUDGE_QUEUE_ENABLED=0` + restart; judges can also be
  paused independently without affecting interactive turns.
- Metrics: `judge_backlog_age`, `judge_completion_drop_rate`,
  `interactive_p95_delta_with_judges_enabled`. Auto-rollback: background work
  lifts interactive p95 >5%, or backlog age exceeds its alert threshold for 5
  minutes without recovery. Wired: `handler.ts:122`.

### `WP8_EMBEDDING_RETRIEVAL_CACHE_ENABLED`

- Owner: retrieval on-call. Default: off (`wp8-flags.ts:76-101`).
- Effect: query embeddings and retrieval candidates cached under
  tenant/corpus/version-aware keys with bounded TTLs; off performs fresh
  embedding + retrieval every search.
- Rollout: shadow, then 1/5/25/50/100% with stale-version prevention green.
- Removal: after the cache matrix (`docs/runtime/cache-matrix.md`) is the only
  documented path and hit-rate/cost evidence is stable.
- Rollback: `WP8_EMBEDDING_RETRIEVAL_CACHE_ENABLED=0` + restart.
- Metrics: `embedding_cache_hit_rate`,
  `retrieval_candidate_cache_hit_rate`, `stale_version_prevention_failures`,
  `db_provider_work_saved`. Auto-rollback: any stale-version failure,
  quality regression >2 points, Redis errors ≥0.1% outside fault injection.
- Status: WIRED in WP-9. `src/composition.ts` wraps the search
  `EmbeddingService` with the versioned cache and provides the
  candidate-cache port to `searchChunks` (per-modality pools, fresh-content
  rehydration, turn-local exclusion preserved) when the flag is on; flag-off
  serves raw embeddings and uncached retrieval. Versioned keys with
  stale-version rejection enforced at the adapter layer.

## Retrieval family (brief; env-driven, not WP-8 flags)

- `HYBRID_ENABLED` (default on), `RERANKER_PROVIDER` (`cosine` default; `local`
  / `cohere` opt-in), `LEXICAL_SEARCH_MODE` (`weighted_websearch` default;
  `content_plain` is the authoritative rollback kill switch),
  `ANSWER_CACHE_ENABLED` (default on; first-turn query-keyed only),
  `TRACE_ENABLED` (default off) — parsed in
  `packages/infrastructure/src/config/env.ts:131-156`, defaults in
  `packages/domain/src/constants.ts`.
- `CACHE_LEASE_MODE` (`strict` in production, `degraded` explicit local
  fallback) — parsed in `src/lib/env.ts:36` and `src/composition.ts:128`
  (route/composition layer, not the infrastructure env module).
- `SEED_LEGACY_SPLITTER` — retained seed tooling only
  (`packages/cli/src/commands/deps.ts:32`); not a runtime path.

## Rollback invariants (never violated)

`WP8_ROLLBACK_PRESERVED_INVARIANTS` (`wp8-flags.ts:13-21`): `grounding_policy`,
`approval_policy`, `idempotency`, `error_classification`, `score_provenance`,
`budgets`, `overload_safety`. Rollback must never restore fail-open
grounding (unverified answers streamed as verified or cached as grounded),
unauthorized writes (ticket creation without explicit intent or scoped
approval), or unbounded overload (fan-out, queue, or pool growth beyond the
budgeted ceilings). Rolling back admission or caches keeps correctness-critical
idempotency; rolling back route duration keeps the finalization reserve; judges
pause without affecting interactive turns.
