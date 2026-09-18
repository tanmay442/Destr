# WP-8 Feature Flags and Rollback

Secret-free. No credentials, personal data, production transcripts, or
proprietary document content.

Source of truth for flag parsing: `packages/application/src/agent/observability/wp8-events.ts`
is telemetry only; flag behavior lives in `packages/application/src/runtime/wp8-flags.ts`
(`WP8_FLAGS`, `readWp8Flag`, `readWp8Flags`). This document mirrors that module;
on any conflict the module wins and this document must be updated.

There is no global flag. Each flag below is independently controlled by its own
environment key. Setting one flag never changes another, and global-sounding
variables (`WP8_ALL_ENABLED`, `WP8_GLOBAL_ENABLED`, `WP8_ENABLED`) are ignored
(pinned by `wp8-flags.test.ts`). Do not deploy or change production
configuration from this work package; flags are parsed only.

## Flags table

| Flag (name / env key) | Owner | Default | Effect when enabled |
|---|---|---|---|
| serverProgress / `WP8_SERVER_PROGRESS_ENABLED` | chat UX on-call | off | Route streams server-driven transient progress events from real orchestration phases. Off: previous client-side status behavior, no progress events emitted. |
| embeddingRetrievalCache / `WP8_EMBEDDING_RETRIEVAL_CACHE_ENABLED` | retrieval on-call | off | Query embeddings and retrieval candidates cached under tenant/corpus/version-aware keys with bounded TTLs. Off: every search performs fresh embedding and retrieval work. |
| distributedAdmission / `WP8_DISTRIBUTED_ADMISSION_ENABLED` | capacity on-call | off | Distributed per-user active-turn leases plus global/per-provider admission with bounded queues and load shedding. Off: only existing process-local guards apply. |
| durableJudgeQueue / `WP8_DURABLE_JUDGE_QUEUE_ENABLED` | evaluation on-call | off | Sampled judges and non-critical analytics go to a bounded durable isolated queue with retries and dead-letter handling. Off: existing best-effort scheduling remains. |
| routeDurationIncrease / `WP8_ROUTE_DURATION_INCREASE_ENABLED` | platform on-call | off | Route uses the WP-8-evidenced extended platform envelope with application hard stop and mandatory finalization reserve. Enabling never increases any agent, token, evidence, retry, or cost budget. Off: current 60-second envelope. |

Parsing: `1`/`true`/`on`/`yes` (any case, surrounding whitespace allowed)
enable; `0`/`false`/`off`/`no` disable; unset uses the default above (all
safe-off); unrecognized values fail safe to the default.

## Rollout order (plan section 14.2)

1. Land contracts, metrics, and test infrastructure with behavior unchanged
   (this work package: telemetry additive, all flags off).
2. Enable server-driven progress for internal users; verify event-rate and
   accessibility behavior under load.
3. Enable embedding/retrieval caches in shadow, then 1%, 5%, 25%, 50%, 100%,
   with stale-version prevention tests green at each step.
4. Enable distributed admission and load shedding in shadow, then 1%, 5%,
   25%, 50%, 100%, with automatic rollback thresholds below.
5. Move sampled judges to the durable isolated path before any
   4,000-active-turn rollout; judges shed before interactive work.
6. Raise the route duration only with interactive SLO, load, cancellation,
   and tail-reserve evidence, independently from any agent budget change.
7. Remove legacy paths only after the rollback window and report comparison.

## Rollback procedure

Per flag (each rollback is one env change plus restart):

- Progress: set `WP8_SERVER_PROGRESS_ENABLED=0` and restart.
- Caches: set `WP8_EMBEDDING_RETRIEVAL_CACHE_ENABLED=0` and restart.
- Admission: set `WP8_DISTRIBUTED_ADMISSION_ENABLED=0` and restart.
- Judges: set `WP8_DURABLE_JUDGE_QUEUE_ENABLED=0` and restart; judges can
  additionally be paused independently without affecting interactive turns.
- Route duration: set `WP8_ROUTE_DURATION_INCREASE_ENABLED=0` and restart;
  incompatible higher deadline settings are rejected at startup, and the
  finalization reserve is preserved.

Rollback preserves grounding policy, approval policy, idempotency, error
classification, score provenance, budgets, and overload safety for every flag
(pinned by `wp8-flags.test.ts` against `WP8_ROLLBACK_PRESERVED_INVARIANTS`).
Rolling back admission or caches never removes correctness-critical
idempotency; rolling back the route duration keeps the finalization reserve.
Background judging can be paused without affecting interactive turns.

## Automatic rollback thresholds

| Flag | Threshold (breach rolls back) |
|---|---|
| serverProgress | Non-terminal progress events exceed 1/second/turn; p99 serialized progress payload exceeds 512 bytes; time to first progress event exceeds 750ms at p95. |
| embeddingRetrievalCache | Any stale-version prevention failure; retrieval quality regression beyond 2 percentage points; Redis error rate at or above 0.1% outside fault injection. |
| distributedAdmission | Provider throttle/error rate at or above 0.5% after admission; DB pool wait p95 above 100ms; application deadline outcomes above 0.5% outside injected slow scenarios; capacity-admissible acceptance below 99.5%. |
| durableJudgeQueue | Background work increases interactive p95 latency by more than 5%; judge backlog age exceeds its alert threshold without recovery in 5 minutes. |
| routeDurationIncrease | Any unexplained platform hard-timeout kill; post-generation work completes inside the finalization reserve in fewer than 99.9% of evaluated turns; longer duration improves completion only via queue collapse, p99 occupancy, or cost. |

## WP-7 reviewer follow-up dispositions affecting WP-8

- N1 (corpus fingerprint coverage): closed for WP-8 scope.
  `fingerprintWp8Context` requires `corpusId` and `documentSnapshotId`;
  omission throws (pinned in `wp8-events.test.ts`).
- N2 (numeric-label hardening): closed for WP-8 scope. Every WP-8 numeric
  field is a bounded integer (`WP8_NUMERIC_BOUNDS`); NaN, Infinity, floats,
  negatives, and over-max values reject (pinned).
- N3 (free-string reason codes): closed for WP-8 scope. All WP-8
  reason/outcome/decision/label-code fields are `z.enum`; free-string
  reasons reject, and dropped background jobs require a bounded
  `dropReason` (pinned).
- N4 (eviction/terminal interaction): closed for WP-8 scope. No WP-8 family
  is terminal (`isWp8TerminalEvent` is always false); `cache.evicted` after
  `turn.terminal` preserves exactly-one-terminal (pinned).
- N6 (sampling-parameter fingerprinting): closed for WP-8 scope. Trace/judge
  sample rates and seed are fingerprinted inputs; changing them rotates the
  fingerprint and non-finite/out-of-range rates reject (pinned).

## Wiring status (WP-8 integration)

- `serverProgress`: WIRED. Turn seam emits accepted/checking_cache/drafting/
  searching/verifying/saving + exactly-one terminal as transient
  `data-agent-progress` parts; the client renders them via AgentProgress with
  a static truthful fallback. Default off = byte-identical streams.
- `durableJudgeQueue`: WIRED. The judge seam enqueues serializable judge jobs
  (idempotent per turn) and pumps the durable queue; shed/unavailable queues
  fall back inline. Remote QStash publish attaches when QSTASH_TOKEN + worker
  URL resolve; the judge-worker consumer route verifies signatures. Default
  off = pre-WP-8 `after()` behavior.
- `distributedAdmission`: PARTIAL. Distributed per-user slot leases guard the
  route (local map is fast-path only); the full admission-controller cutover
  (global/provider ceilings, bounded queue in the request path) is deferred
  to WP-9 activation (modules + flags + capacity-gate coverage land here).
- `embeddingRetrievalCache`: NOT WIRED (deferred). Policy matrix, versioned
  adapters, flags, and capacity-gate coverage land here; search-path
  activation is deferred to WP-9 to avoid retrieval-correctness risk without
  a shadow period.
- `routeDurationIncrease`: NOT WIRED (deferred). 60 s kept; increase requires
  the route-duration decision record + load/deadline gates + cost approval.

Deferred activations preserve all rollback invariants (grounding, approval,
idempotency, error classification, score provenance, budgets, overload
safety) because every deferred path defaults to the pre-WP-8 behavior.

## Residual risks

- Flags are parsed but not yet wired to route/orchestration seams; wiring
  belongs to the WP-8 integration owner and must keep every threshold above
  observable before enabling beyond shadow.
- Provider rate cards used in tests are fixtures, not billing truth; replace
  with versioned price configuration at integration time, keeping unknown
  explicit rather than zero.
- Capacity evidence (4,000-active soak, 20,000 spike) is a separate
  deployment gate and is not claimed by this package.
