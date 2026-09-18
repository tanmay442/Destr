/**
 * WP-8 runtime feature flags.
 *
 * Five independently controlled flags (plan sections 14.1-14.3). There is no
 * global flag: each flag has its own environment key, owner, default, effect,
 * rollout, removal, rollback, metrics, and automatic rollback thresholds.
 * Rollback of any flag preserves grounding, approval, idempotency, error
 * classification, score provenance, budgets, and overload safety (see
 * `WP8_ROLLBACK_PRESERVED_INVARIANTS`). This module only parses flags; it
 * never deploys anything or changes production configuration.
 */

export const WP8_ROLLBACK_PRESERVED_INVARIANTS: readonly string[] = Object.freeze([
  'grounding_policy',
  'approval_policy',
  'idempotency',
  'error_classification',
  'score_provenance',
  'budgets',
  'overload_safety',
]);

export type Wp8FlagName =
  | 'serverProgress'
  | 'embeddingRetrievalCache'
  | 'distributedAdmission'
  | 'durableJudgeQueue'
  | 'routeDurationIncrease';

export interface Wp8FlagDef {
  readonly key: string;
  readonly owner: string;
  readonly defaultEnabled: boolean;
  readonly effect: string;
  readonly rollout: string;
  readonly removal: string;
  readonly rollback: string;
  readonly metrics: readonly string[];
  readonly rollbackThresholds: readonly string[];
  readonly rollbackPreserves: readonly string[];
}

function def(value: Wp8FlagDef): Wp8FlagDef {
  return Object.freeze({
    ...value,
    metrics: Object.freeze([...value.metrics]),
    rollbackThresholds: Object.freeze([...value.rollbackThresholds]),
    rollbackPreserves: Object.freeze([...value.rollbackPreserves]),
  });
}

export const WP8_FLAGS: Readonly<Record<Wp8FlagName, Wp8FlagDef>> = Object.freeze({
  serverProgress: def({
    key: 'WP8_SERVER_PROGRESS_ENABLED',
    owner: 'chat UX on-call',
    defaultEnabled: false,
    effect:
      'When enabled, the route streams server-driven transient progress events ' +
      'from real orchestration phases; when disabled, the previous client-side ' +
      'status behavior remains and no progress events are emitted.',
    rollout: 'Internal users first; verify event-rate and accessibility behavior under load before wider rollout.',
    removal:
      'Remove after server-driven progress is the only progress path and the timer-invented stages are deleted.',
    rollback: 'Set WP8_SERVER_PROGRESS_ENABLED=0 and restart.',
    metrics: Object.freeze([
      'time_to_first_progress_event_p95',
      'progress_events_per_second_per_turn',
      'progress_payload_bytes_p99',
    ]),
    rollbackThresholds: Object.freeze([
      'non-terminal progress events exceed 1/second/turn',
      'p99 serialized progress payload exceeds 512 bytes',
      'time to first progress event exceeds 750ms at p95',
    ]),
    rollbackPreserves: WP8_ROLLBACK_PRESERVED_INVARIANTS,
  }),
  embeddingRetrievalCache: def({
    key: 'WP8_EMBEDDING_RETRIEVAL_CACHE_ENABLED',
    owner: 'retrieval on-call',
    defaultEnabled: false,
    effect:
      'When enabled, query embeddings and retrieval candidates are cached under ' +
      'tenant/corpus/version-aware keys with bounded TTLs; when disabled, every ' +
      'search performs fresh embedding and retrieval work.',
    rollout:
      'Shadow first, then 1%, 5%, 25%, 50%, 100% with stale-version prevention tests green at each step.',
    removal:
      'Remove after the cache matrix runbook is the only documented path and hit-rate/cost evidence is stable.',
    rollback: 'Set WP8_EMBEDDING_RETRIEVAL_CACHE_ENABLED=0 and restart.',
    metrics: Object.freeze([
      'embedding_cache_hit_rate',
      'retrieval_candidate_cache_hit_rate',
      'stale_version_prevention_failures',
      'db_provider_work_saved',
    ]),
    rollbackThresholds: Object.freeze([
      'any stale-version prevention failure',
      'retrieval quality gate regression beyond 2 percentage points',
      'Redis error rate at or above 0.1% outside fault injection',
    ]),
    rollbackPreserves: WP8_ROLLBACK_PRESERVED_INVARIANTS,
  }),
  distributedAdmission: def({
    key: 'WP8_DISTRIBUTED_ADMISSION_ENABLED',
    owner: 'capacity on-call',
    defaultEnabled: false,
    effect:
      'When enabled, distributed per-user active-turn leases plus global and ' +
      'per-provider admission with bounded queues and load shedding guard model, ' +
      'database, and Redis capacity; when disabled, only the existing ' +
      'process-local guards apply.',
    rollout:
      'Shadow first, then 1%, 5%, 25%, 50%, 100% with automatic rollback thresholds for deadline, provider throttle, DB wait, Redis failure, and cost.',
    removal:
      'Remove after distributed admission is the only admission path and the process-local map is a documented fast-path optimization only.',
    rollback: 'Set WP8_DISTRIBUTED_ADMISSION_ENABLED=0 and restart.',
    metrics: Object.freeze([
      'admitted_shed_completed_per_second',
      'queue_wait_p95',
      'provider_throttle_rate',
      'db_pool_wait_p95',
    ]),
    rollbackThresholds: Object.freeze([
      'provider throttle or error rate at or above 0.5% after admission',
      'DB pool wait p95 above 100ms',
      'application deadline outcomes above 0.5% outside injected slow scenarios',
      'capacity-admissible acceptance below 99.5%',
    ]),
    rollbackPreserves: WP8_ROLLBACK_PRESERVED_INVARIANTS,
  }),
  durableJudgeQueue: def({
    key: 'WP8_DURABLE_JUDGE_QUEUE_ENABLED',
    owner: 'evaluation on-call',
    defaultEnabled: false,
    effect:
      'When enabled, sampled quality judges and non-critical analytics are sent ' +
      'to a bounded durable isolated queue with retries and dead-letter handling; ' +
      'when disabled, the existing best-effort scheduling remains.',
    rollout:
      'Move sampled judges to the durable isolated path before the 4,000-active-turn rollout; shed judges before interactive work.',
    removal:
      'Remove after the durable queue is the only judge path and backlog-age alerts have burned in.',
    rollback:
      'Set WP8_DURABLE_JUDGE_QUEUE_ENABLED=0 and restart; judges can additionally be paused independently without affecting interactive turns.',
    metrics: Object.freeze([
      'judge_backlog_age',
      'judge_completion_drop_rate',
      'interactive_p95_delta_with_judges_enabled',
    ]),
    rollbackThresholds: Object.freeze([
      'background work increases interactive p95 latency by more than 5%',
      'judge backlog age exceeds its alert threshold without recovery in 5 minutes',
    ]),
    rollbackPreserves: WP8_ROLLBACK_PRESERVED_INVARIANTS,
  }),
  routeDurationIncrease: def({
    key: 'WP8_ROUTE_DURATION_INCREASE_ENABLED',
    owner: 'platform on-call',
    defaultEnabled: false,
    effect:
      'When enabled, the route uses the WP-8-evidenced extended platform envelope ' +
      'with an application hard stop and mandatory finalization reserve; when ' +
      'disabled, the current 60-second envelope applies. Enabling never increases ' +
      'any agent, token, evidence, retry, or cost budget.',
    rollout:
      'Raise only with interactive SLO, load, cancellation, and tail-reserve evidence, independently from any agent budget change.',
    removal:
      'Remove after the deadline-ledger decision record freezes one envelope; a route-duration rollback must keep the finalization reserve.',
    rollback:
      'Set WP8_ROUTE_DURATION_INCREASE_ENABLED=0 and restart; incompatible higher deadline settings are rejected at startup.',
    metrics: Object.freeze([
      'platform_hard_kills',
      'finalization_reserve_completion_rate',
      'verified_answer_release_p95',
    ]),
    rollbackThresholds: Object.freeze([
      'any unexplained platform hard-timeout kill',
      'post-generation work completes inside the finalization reserve in fewer than 99.9% of evaluated turns',
      'raising maxDuration improves completion only by increasing queue collapse, p99 occupancy, or cost',
    ]),
    rollbackPreserves: WP8_ROLLBACK_PRESERVED_INVARIANTS,
  }),
});

export const WP8_FLAG_NAMES: readonly Wp8FlagName[] = Object.freeze([
  'serverProgress',
  'embeddingRetrievalCache',
  'distributedAdmission',
  'durableJudgeQueue',
  'routeDurationIncrease',
]);

export interface Wp8FlagEnv {
  get(key: string): string | undefined;
}

export interface Wp8FlagResult {
  readonly enabled: boolean;
  readonly source: 'env' | 'default';
}

function parseFlagValue(raw: string): boolean | undefined {
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'on' ||
    normalized === 'yes'
  ) {
    return true;
  }
  if (
    normalized === '0' ||
    normalized === 'false' ||
    normalized === 'off' ||
    normalized === 'no'
  ) {
    return false;
  }
  return undefined;
}

export function readWp8Flag(env: Wp8FlagEnv, name: Wp8FlagName): Wp8FlagResult {
  const flag = WP8_FLAGS[name];
  const raw = env.get(flag.key);
  if (raw === undefined) {
    return Object.freeze({ enabled: flag.defaultEnabled, source: 'default' });
  }
  const parsed = parseFlagValue(raw);
  // Unrecognized values fail safe to the flag default (all WP-8 flags are safe-off).
  return Object.freeze({ enabled: parsed ?? flag.defaultEnabled, source: 'env' });
}

export function readWp8Flags(env: Wp8FlagEnv): Readonly<Record<Wp8FlagName, Wp8FlagResult>> {
  return Object.freeze({
    serverProgress: readWp8Flag(env, 'serverProgress'),
    embeddingRetrievalCache: readWp8Flag(env, 'embeddingRetrievalCache'),
    distributedAdmission: readWp8Flag(env, 'distributedAdmission'),
    durableJudgeQueue: readWp8Flag(env, 'durableJudgeQueue'),
    routeDurationIncrease: readWp8Flag(env, 'routeDurationIncrease'),
  });
}
