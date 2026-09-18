import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AgentEventEnvelopeSchema,
  EVENT_VERSION,
  PersistenceStatusSchema,
  TokenFieldStatusSchema,
  assertEventVersion,
} from './agent-event';
import type { TokenFieldStatus } from './agent-event';
import { redactAttributes } from './redaction';
import { computeStepCost } from './usage-normalizer';
import type { NormalizedStepUsage, TokenPriceRates } from './usage-normalizer';

export { EVENT_VERSION };

/**
 * WP-8 additive observability families (runtime/capacity scope).
 *
 * Extension-only: every schema reuses the WP-7 {@link AgentEventEnvelopeSchema}
 * shape and the same {@link EVENT_VERSION}. No second telemetry model is
 * created and no existing family is changed. The authoritative turn terminal
 * remains `turn.terminal` from `./agent-event`; no WP-8 family is terminal
 * (see N4 disposition below and `isWp8TerminalEvent`).
 *
 * Storage (WP-7 STORAGE_DECISION.md, unchanged): compact turn summaries via
 * the existing Postgres path, low-cardinality counters via the metrics
 * backend, sampled detailed traces behind the narrow `TraceStore` port. There
 * is no per-step JSONB trajectory table; see `WP8_STORAGE_PLACEMENT`.
 *
 * N-dispositions affecting WP-8 (WP-7 reviewer follow-ups):
 * - N1 (corpus fingerprint coverage): `fingerprintWp8Context` requires
 *   `corpusId` + `documentSnapshotId`; omitting them throws.
 * - N2 (numeric-label hardening): every numeric field is a bounded integer
 *   (`WP8_NUMERIC_BOUNDS`); NaN/Infinity/floats/negatives/over-max reject.
 * - N3 (free-string reason codes): every WP-8 reason/outcome/decision field
 *   is a `z.enum`; no free-string reason codes exist in WP-8 families.
 * - N4 (eviction/terminal interaction): `cache.evicted` (and every other
 *   WP-8 event) is never terminal; eviction after `turn.terminal` preserves
 *   exactly-one-terminal via `assertWp8ExactlyOneTerminal`.
 * - N6 (sampling-parameter fingerprinting): sampling rates + seed are part
 *   of the fingerprinted context; changing them rotates the fingerprint.
 */

export const WP8_NUMERIC_BOUNDS = Object.freeze({
  maxCount: 10_000_000,
  maxTokens: 100_000_000,
  maxLatencyMs: 3_600_000,
  maxPayloadBytes: 4096,
  maxQueueDepth: 100_000,
  maxCostMicros: 1_000_000_000_000,
  maxStepNumber: 1000,
});

function boundedCount(max: number = WP8_NUMERIC_BOUNDS.maxCount): z.ZodNumber {
  return z.number().int().min(0).max(max);
}

function boundedLatency(): z.ZodNumber {
  return z.number().int().min(0).max(WP8_NUMERIC_BOUNDS.maxLatencyMs);
}

// ---------------------------------------------------------------------------
// Cache activity family
// ---------------------------------------------------------------------------

export const WP8_CACHE_LAYERS = [
  'answer',
  'embedding',
  'retrieval_candidates',
  'prompt_prefix',
  'turn_result',
] as const;
export const Wp8CacheLayerSchema = z.enum(WP8_CACHE_LAYERS);

export const WP8_CACHE_LOOKUP_OUTCOMES = ['hit', 'miss', 'skipped', 'error'] as const;
export const Wp8CacheLookupOutcomeSchema = z.enum(WP8_CACHE_LOOKUP_OUTCOMES);

export const WP8_CACHE_LOOKUP_REASONS = [
  'verified_entry',
  'version_match',
  'tenant_match',
  'ttl_expired',
  'stale_version',
  'tenant_mismatch',
  'corpus_mismatch',
  'degraded_store',
  'disabled_by_flag',
  'not_eligible',
] as const;
export const Wp8CacheLookupReasonSchema = z.enum(WP8_CACHE_LOOKUP_REASONS);

export const WP8_CACHE_STORE_OUTCOMES = ['stored', 'skipped', 'failed'] as const;
export const Wp8CacheStoreOutcomeSchema = z.enum(WP8_CACHE_STORE_OUTCOMES);

export const WP8_CACHE_STORE_REASONS = [
  'verified_only',
  'versioned_key',
  'bounded_ttl',
  'unverified_excluded',
  'error_excluded',
  'degraded_store',
  'disabled_by_flag',
] as const;
export const Wp8CacheStoreReasonSchema = z.enum(WP8_CACHE_STORE_REASONS);

export const WP8_EVICTION_REASONS = [
  'ttl_expired',
  'capacity_pressure',
  'version_rotation',
  'explicit_invalidation',
] as const;
export const Wp8EvictionReasonSchema = z.enum(WP8_EVICTION_REASONS);

const CacheLookupSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('cache.lookup'),
  cacheLayer: Wp8CacheLayerSchema,
  outcome: Wp8CacheLookupOutcomeSchema,
  reason: Wp8CacheLookupReasonSchema,
  latencyMs: boundedLatency(),
});

const CacheStoreSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('cache.store'),
  cacheLayer: Wp8CacheLayerSchema,
  outcome: Wp8CacheStoreOutcomeSchema,
  reason: Wp8CacheStoreReasonSchema,
});

const CacheEvictedSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('cache.evicted'),
  cacheLayer: Wp8CacheLayerSchema,
  reason: Wp8EvictionReasonSchema,
  evictedCount: boundedCount(),
});

// ---------------------------------------------------------------------------
// Admission / lease / queue family
// ---------------------------------------------------------------------------

export const WP8_LEASE_ACTIONS = ['acquired', 'released', 'expired'] as const;
export const Wp8LeaseActionSchema = z.enum(WP8_LEASE_ACTIONS);

export const WP8_LEASE_KINDS = ['user_turn', 'provider_slot', 'global_slot'] as const;
export const Wp8LeaseKindSchema = z.enum(WP8_LEASE_KINDS);

export const WP8_LEASE_REASONS = [
  'within_capacity',
  'duplicate_lease',
  'cancelled',
  'deadline_exceeded',
  'capacity_exceeded',
] as const;
export const Wp8LeaseReasonSchema = z.enum(WP8_LEASE_REASONS);

export const WP8_QUEUE_ACTIONS = ['enqueued', 'dequeued', 'shed'] as const;
export const Wp8QueueActionSchema = z.enum(WP8_QUEUE_ACTIONS);

export const WP8_QUEUE_KINDS = ['interactive', 'background'] as const;
export const Wp8QueueKindSchema = z.enum(WP8_QUEUE_KINDS);

export const WP8_SHED_REASONS = [
  'queue_full',
  'queue_deadline_exceeded',
  'provider_throttle',
  'priority_preempted',
] as const;
export const Wp8ShedReasonSchema = z.enum(WP8_SHED_REASONS);

const AdmissionLeaseSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('admission.lease'),
  action: Wp8LeaseActionSchema,
  leaseKind: Wp8LeaseKindSchema,
  reason: Wp8LeaseReasonSchema,
});

const AdmissionQueueSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('admission.queue'),
  action: Wp8QueueActionSchema,
  queueKind: Wp8QueueKindSchema,
  queueDepth: boundedCount(WP8_NUMERIC_BOUNDS.maxQueueDepth),
  waitMs: boundedLatency(),
  shedReason: Wp8ShedReasonSchema.optional(),
});

export const WP8_CAPACITY_REJECTION_REASONS = [
  'user_lease_ceiling',
  'global_concurrency',
  'provider_throttle',
  'db_pool_saturated',
  'redis_degraded',
  'queue_full',
  'deadline_insufficient',
] as const;
export const Wp8CapacityRejectionReasonSchema = z.enum(WP8_CAPACITY_REJECTION_REASONS);

const CapacityRejectedSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('capacity.rejected'),
  reason: Wp8CapacityRejectionReasonSchema,
  retryAfterMs: boundedLatency().nullable(),
  shedBeforeModelWork: z.literal(true),
});

// ---------------------------------------------------------------------------
// Progress / stream family (server-driven, sanitized)
// ---------------------------------------------------------------------------

export const WP8_PROGRESS_PHASES = [
  'accepted',
  'checking_cache',
  'planning',
  'searching',
  'reranking',
  'reading_sources',
  'drafting',
  'verifying',
  'saving',
  'complete',
  'degraded',
] as const;
export const Wp8ProgressPhaseSchema = z.enum(WP8_PROGRESS_PHASES);

export const WP8_PROGRESS_LABEL_CODES = [
  'progress_searching_docs',
  'progress_checking_sources',
  'progress_planning',
  'progress_drafting',
  'progress_verifying',
  'progress_saving',
  'progress_degraded_fallback',
  'progress_complete',
] as const;
export const Wp8ProgressLabelCodeSchema = z.enum(WP8_PROGRESS_LABEL_CODES);

const ProgressEmittedSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('progress.emitted'),
  phase: Wp8ProgressPhaseSchema,
  labelCode: Wp8ProgressLabelCodeSchema,
  completed: boundedCount().nullable(),
  total: boundedCount().nullable(),
  payloadBytes: boundedCount(WP8_NUMERIC_BOUNDS.maxPayloadBytes),
});

export const WP8_HEARTBEAT_REASONS = ['silence_keepalive', 'backlog_notice'] as const;
export const Wp8HeartbeatReasonSchema = z.enum(WP8_HEARTBEAT_REASONS);

const StreamHeartbeatSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('stream.heartbeat'),
  reason: Wp8HeartbeatReasonSchema,
  intervalMs: boundedLatency(),
});

// ---------------------------------------------------------------------------
// Deadline / budget family
// ---------------------------------------------------------------------------

export const WP8_DEADLINE_PHASES = [
  'admission',
  'cache_lookup',
  'model_loop',
  'retrieval',
  'verification',
  'finalization',
] as const;
export const Wp8DeadlinePhaseSchema = z.enum(WP8_DEADLINE_PHASES);

export const WP8_DEADLINE_OUTCOMES = ['started', 'completed', 'skipped', 'stopped'] as const;
export const Wp8DeadlineOutcomeSchema = z.enum(WP8_DEADLINE_OUTCOMES);

export const WP8_DEADLINE_STOP_REASONS = [
  'budget_exhausted',
  'deadline_exceeded',
  'cancelled',
  'p95_guard',
  'dependency_timeout',
] as const;
export const Wp8DeadlineStopReasonSchema = z.enum(WP8_DEADLINE_STOP_REASONS);

const DeadlinePhaseSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('deadline.phase'),
  phase: Wp8DeadlinePhaseSchema,
  outcome: Wp8DeadlineOutcomeSchema,
  remainingMs: boundedLatency(),
  stopReason: Wp8DeadlineStopReasonSchema.optional(),
});

export const WP8_BUDGET_KINDS = [
  'model_steps',
  'tool_calls',
  'search_calls',
  'physical_retrievals',
  'evidence_tokens',
  'cost_micros',
] as const;
export const Wp8BudgetKindSchema = z.enum(WP8_BUDGET_KINDS);

export const WP8_BUDGET_OUTCOMES = ['within_budget', 'exhausted'] as const;
export const Wp8BudgetOutcomeSchema = z.enum(WP8_BUDGET_OUTCOMES);

const BudgetExhaustedSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('budget.exhausted'),
  budgetKind: Wp8BudgetKindSchema,
  outcome: Wp8BudgetOutcomeSchema,
  used: boundedCount(WP8_NUMERIC_BOUNDS.maxCostMicros),
  limit: boundedCount(WP8_NUMERIC_BOUNDS.maxCostMicros),
});

// ---------------------------------------------------------------------------
// Dependency / pool family
// ---------------------------------------------------------------------------

export const WP8_DEPENDENCIES = [
  'redis',
  'postgres_pooled',
  'postgres_direct',
  'model_provider',
  'embedding_provider',
  'reranker',
] as const;
export const Wp8DependencySchema = z.enum(WP8_DEPENDENCIES);

export const WP8_DEPENDENCY_OUTCOMES = ['ok', 'timeout', 'error', 'cancelled', 'degraded'] as const;
export const Wp8DependencyOutcomeSchema = z.enum(WP8_DEPENDENCY_OUTCOMES);

const DependencyCallSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('dependency.call'),
  dependency: Wp8DependencySchema,
  outcome: Wp8DependencyOutcomeSchema,
  latencyMs: boundedLatency(),
  orphaned: z.boolean(),
});

export const WP8_POOL_KINDS = ['neon_pooled', 'neon_direct', 'redis'] as const;
export const Wp8PoolKindSchema = z.enum(WP8_POOL_KINDS);

export const WP8_POOL_WAIT_OUTCOMES = ['acquired', 'timed_out', 'cancelled'] as const;
export const Wp8PoolWaitOutcomeSchema = z.enum(WP8_POOL_WAIT_OUTCOMES);

const PoolWaitSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('pool.wait'),
  poolKind: Wp8PoolKindSchema,
  outcome: Wp8PoolWaitOutcomeSchema,
  waitMs: boundedLatency(),
  waitingCount: boundedCount(WP8_NUMERIC_BOUNDS.maxQueueDepth),
});

export const WP8_QUERY_CLASSES = ['vector', 'lexical', 'history', 'telemetry', 'persistence'] as const;
export const Wp8QueryClassSchema = z.enum(WP8_QUERY_CLASSES);

export const WP8_QUERY_OUTCOMES = ['completed', 'timeout', 'cancelled', 'error'] as const;
export const Wp8QueryOutcomeSchema = z.enum(WP8_QUERY_OUTCOMES);

const PoolQuerySchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('pool.query'),
  poolKind: Wp8PoolKindSchema,
  queryClass: Wp8QueryClassSchema,
  outcome: Wp8QueryOutcomeSchema,
  latencyMs: boundedLatency(),
  orphaned: z.boolean(),
});

// ---------------------------------------------------------------------------
// Persistence family (explicit persistence status, no trajectory table)
// ---------------------------------------------------------------------------

export const WP8_PERSISTENCE_STORES = [
  'turn_summary',
  'metrics_counter',
  'trace_sample',
  'queue_enqueue',
  'history_write',
] as const;
export const Wp8PersistenceStoreSchema = z.enum(WP8_PERSISTENCE_STORES);

export const WP8_PERSISTENCE_REASONS = [
  'write_ok',
  'queue_backpressure',
  'store_unavailable',
  'retention_skip',
  'sampled_out',
  'cancelled',
] as const;
export const Wp8PersistenceReasonSchema = z.enum(WP8_PERSISTENCE_REASONS);

const PersistenceResultSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('persistence.result'),
  store: Wp8PersistenceStoreSchema,
  persistenceStatus: PersistenceStatusSchema,
  reason: Wp8PersistenceReasonSchema,
});

// ---------------------------------------------------------------------------
// Background queue family
// ---------------------------------------------------------------------------

export const WP8_BACKGROUND_JOBS = ['sampled_judge', 'analytics_flush', 'trace_export'] as const;
export const Wp8BackgroundJobSchema = z.enum(WP8_BACKGROUND_JOBS);

export const WP8_BACKGROUND_ACTIONS = [
  'enqueued',
  'started',
  'completed',
  'dropped',
  'dead_lettered',
] as const;
export const Wp8BackgroundActionSchema = z.enum(WP8_BACKGROUND_ACTIONS);

export const WP8_BACKGROUND_DROP_REASONS = [
  'backlog_full',
  'shed_for_interactive',
  'ttl_expired',
  'retry_exhausted',
] as const;
export const Wp8BackgroundDropReasonSchema = z.enum(WP8_BACKGROUND_DROP_REASONS);

const BackgroundJobSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('background.job'),
  jobKind: Wp8BackgroundJobSchema,
  action: Wp8BackgroundActionSchema,
  attemptCount: boundedCount(1000),
  backlogAgeMs: boundedLatency().nullable(),
  dropReason: Wp8BackgroundDropReasonSchema.optional(),
}).refine(
  (value) =>
    value.action === 'dropped' || value.action === 'dead_lettered'
      ? value.dropReason !== undefined
      : true,
  { message: 'background.job dropped/dead_lettered requires a bounded dropReason' },
);

// ---------------------------------------------------------------------------
// Circuit breaker family
// ---------------------------------------------------------------------------

export const WP8_BREAKERS = ['redis_cache', 'model_provider', 'database', 'embedding'] as const;
export const Wp8BreakerSchema = z.enum(WP8_BREAKERS);

export const WP8_BREAKER_STATES = ['closed', 'open', 'half_open'] as const;
export const Wp8BreakerStateSchema = z.enum(WP8_BREAKER_STATES);

export const WP8_BREAKER_REASONS = [
  'error_threshold',
  'timeout_threshold',
  'probe_success',
  'manual_reset',
  'cooldown_elapsed',
] as const;
export const Wp8BreakerReasonSchema = z.enum(WP8_BREAKER_REASONS);

const BreakerTransitionSchema = AgentEventEnvelopeSchema.extend({
  eventType: z.literal('breaker.transition'),
  breaker: Wp8BreakerSchema,
  fromState: Wp8BreakerStateSchema,
  toState: Wp8BreakerStateSchema,
  reason: Wp8BreakerReasonSchema,
});

// ---------------------------------------------------------------------------
// Union, constructors, terminal authority, ordering
// ---------------------------------------------------------------------------

export const Wp8EventSchema = z.discriminatedUnion('eventType', [
  CacheLookupSchema,
  CacheStoreSchema,
  CacheEvictedSchema,
  AdmissionLeaseSchema,
  AdmissionQueueSchema,
  CapacityRejectedSchema,
  ProgressEmittedSchema,
  StreamHeartbeatSchema,
  DeadlinePhaseSchema,
  BudgetExhaustedSchema,
  DependencyCallSchema,
  PoolWaitSchema,
  PoolQuerySchema,
  PersistenceResultSchema,
  BackgroundJobSchema,
  BreakerTransitionSchema,
]);
export type Wp8Event = z.infer<typeof Wp8EventSchema>;
export type Wp8EventType = Wp8Event['eventType'];

export const WP8_EVENT_TYPES: readonly Wp8EventType[] = Object.freeze([
  'cache.lookup',
  'cache.store',
  'cache.evicted',
  'admission.lease',
  'admission.queue',
  'capacity.rejected',
  'progress.emitted',
  'stream.heartbeat',
  'deadline.phase',
  'budget.exhausted',
  'dependency.call',
  'pool.wait',
  'pool.query',
  'persistence.result',
  'background.job',
  'breaker.transition',
]);

function deepFreezeValue<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const entry of value) deepFreezeValue(entry);
    } else {
      for (const entry of Object.values(value)) deepFreezeValue(entry);
    }
    Object.freeze(value);
  }
  return value;
}

export function createWp8Event(input: unknown): Wp8Event {
  return deepFreezeValue(Wp8EventSchema.parse(input));
}

export function assertWp8EventVersion(event: { readonly eventVersion: number }): void {
  assertEventVersion(event);
}

/**
 * N4: no WP-8 family is terminal. The only authoritative turn terminal is
 * `turn.terminal` from `./agent-event`. Cache eviction, breaker transitions,
 * shed actions, and every other WP-8 outcome never create a terminal.
 */
const WP8_TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set<string>();

export function isWp8TerminalEvent(event: Pick<Wp8Event, 'eventType'>): boolean {
  return WP8_TERMINAL_EVENT_TYPES.has(event.eventType);
}

export interface Wp8OrderableEvent {
  readonly eventVersion: number;
  readonly eventType: string;
  readonly turnId: string;
  readonly startedAt: string;
}

export function assertWp8ExactlyOneTerminal(
  events: readonly Wp8OrderableEvent[],
): Wp8OrderableEvent {
  const terminals = events.filter((event) => event.eventType === 'turn.terminal');
  if (terminals.length !== 1) {
    throw new Error(
      `assertWp8ExactlyOneTerminal: expected exactly one turn.terminal event, found ${terminals.length}`,
    );
  }
  const terminal = terminals[0];
  if (terminal === undefined) throw new Error('assertWp8ExactlyOneTerminal: terminal missing');
  return terminal;
}

export function validateWp8EventOrdering(events: readonly Wp8OrderableEvent[]): void {
  for (const event of events) {
    assertEventVersion(event);
    if (Number.isNaN(Date.parse(event.startedAt))) {
      throw new Error('validateWp8EventOrdering: startedAt must be an ISO-8601 date string');
    }
  }
  const byTurn = new Map<string, Wp8OrderableEvent[]>();
  for (const event of events) {
    const group = byTurn.get(event.turnId) ?? [];
    group.push(event);
    byTurn.set(event.turnId, group);
  }
  for (const [turnId, group] of byTurn) {
    const terminals = group.filter((event) => event.eventType === 'turn.terminal');
    if (terminals.length === 0) continue;
    if (terminals.length > 1) {
      throw new Error(
        `validateWp8EventOrdering: turn ${turnId} has ${terminals.length} terminal events`,
      );
    }
    const starts = group.filter((event) => event.eventType === 'turn.started');
    if (starts.length === 0) {
      throw new Error(
        `validateWp8EventOrdering: turn ${turnId} has a terminal event without turn.started`,
      );
    }
    const earliestStart = Math.min(...starts.map((event) => Date.parse(event.startedAt)));
    for (const terminal of terminals) {
      if (Date.parse(terminal.startedAt) < earliestStart) {
        throw new Error(
          `validateWp8EventOrdering: turn ${turnId} terminal predates turn.started`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Redaction for WP-8 events (reuses WP-7 policy)
// ---------------------------------------------------------------------------

export function redactWp8Event(event: Wp8Event): Wp8Event {
  const { redacted } = redactAttributes(event.attributes);
  return createWp8Event({ ...event, attributes: { ...redacted } });
}

// ---------------------------------------------------------------------------
// Bounded counters (metrics backend shape; no high-cardinality labels)
// ---------------------------------------------------------------------------

export const WP8_COUNTER_NAMES: readonly string[] = Object.freeze(
  WP8_EVENT_TYPES.map((eventType) => `wp8.${eventType}`),
);

function wp8OutcomeLabel(event: Wp8Event): string {
  switch (event.eventType) {
    case 'cache.lookup':
    case 'cache.store':
    case 'pool.wait':
    case 'pool.query':
    case 'dependency.call':
    case 'deadline.phase':
    case 'budget.exhausted':
      return event.outcome;
    case 'cache.evicted':
    case 'capacity.rejected':
    case 'stream.heartbeat':
      return event.reason;
    case 'admission.lease':
    case 'admission.queue':
    case 'background.job':
      return event.action;
    case 'progress.emitted':
      return event.phase;
    case 'persistence.result':
      return event.persistenceStatus;
    case 'breaker.transition':
      return event.toState;
  }
}

export function buildWp8Counters(events: readonly Wp8Event[]): Readonly<Record<string, number>> {
  const counters: Record<string, number> = {};
  for (const event of events) {
    const key = `wp8.${event.eventType}:${wp8OutcomeLabel(event)}`;
    counters[key] = (counters[key] ?? 0) + 1;
  }
  return Object.freeze({ ...counters });
}

export function assertWp8CounterKeysBounded(counters: Readonly<Record<string, number>>): void {
  for (const key of Object.keys(counters)) {
    const [name, label] = key.split(':');
    if (name === undefined || label === undefined || key.split(':').length !== 2) {
      throw new Error(`assertWp8CounterKeysBounded: malformed counter key ${key}`);
    }
    if (!WP8_COUNTER_NAMES.includes(name)) {
      throw new Error(`assertWp8CounterKeysBounded: unknown counter family ${name}`);
    }
    if (!/^[a-z][a-z_]*$/.test(label)) {
      throw new Error(`assertWp8CounterKeysBounded: unbounded counter label ${label}`);
    }
    const value = counters[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error(`assertWp8CounterKeysBounded: invalid counter value for ${key}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Storage placement (WP-7 decision, unchanged): no per-step JSONB table
// ---------------------------------------------------------------------------

export const WP8_STORAGE_PLACEMENT = Object.freeze({
  turnSummary: 'existing_postgres_chat_events_path',
  counters: 'metrics_backend_bounded_counters',
  sampledTraces: 'trace_store_port_sampled_only',
  backgroundJobs: 'existing_durable_queue',
  rollups: 'narrow_rebuildable_rollup_store',
});

export const WP8_STORAGE_FORBIDDEN = Object.freeze([
  'per_step_jsonb_trajectory_table',
  'unbounded_event_payload_column',
  'primary_db_full_trace_retention',
]);

export function describeWp8StoragePlacement(eventType: Wp8EventType): string {
  switch (eventType) {
    case 'persistence.result':
      return WP8_STORAGE_PLACEMENT.turnSummary;
    case 'background.job':
      return WP8_STORAGE_PLACEMENT.backgroundJobs;
    case 'cache.lookup':
    case 'cache.store':
    case 'cache.evicted':
    case 'admission.lease':
    case 'admission.queue':
    case 'capacity.rejected':
    case 'deadline.phase':
    case 'budget.exhausted':
    case 'dependency.call':
    case 'pool.wait':
    case 'pool.query':
    case 'breaker.transition':
      return WP8_STORAGE_PLACEMENT.counters;
    case 'progress.emitted':
    case 'stream.heartbeat':
      return WP8_STORAGE_PLACEMENT.sampledTraces;
  }
}

// ---------------------------------------------------------------------------
// Sampling-aware fingerprint (N1 corpus coverage + N6 sampling params)
// ---------------------------------------------------------------------------

export const WP8_FINGERPRINT_VERSION = 1 as const;

export const Wp8SamplingSchema = z.object({
  traceSampleRate: z.number().min(0).max(1),
  judgeSampleRate: z.number().min(0).max(1),
  seed: z.string().min(1).max(200),
});
export type Wp8Sampling = z.infer<typeof Wp8SamplingSchema>;

export const Wp8FingerprintInputSchema = z.object({
  corpusId: z.string().min(1).max(200),
  documentSnapshotId: z.string().min(1).max(200),
  configHash: z.string().min(1).max(200),
  promptVersion: z.string().min(1).max(200),
  toolCatalogVersion: z.string().min(1).max(200),
  schemaDigest: z.string().min(1).max(200),
  priceVersion: z.string().min(1).max(200),
  sampling: Wp8SamplingSchema,
});
export type Wp8FingerprintInput = z.infer<typeof Wp8FingerprintInputSchema>;

export function fingerprintWp8Context(input: unknown): string {
  const parsed = Wp8FingerprintInputSchema.parse(input);
  const canonical = JSON.stringify({ v: WP8_FINGERPRINT_VERSION, ...parsed });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Per-step cost telemetry (F-32 cost part): labels, not values
// ---------------------------------------------------------------------------

export const WP8_PROVIDERS = ['openai_compatible', 'google', 'local'] as const;
export const Wp8ProviderSchema = z.enum(WP8_PROVIDERS);
export type Wp8Provider = z.infer<typeof Wp8ProviderSchema>;

const HexDigestSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[0-9a-f]+$/, { message: 'schemaDigest must be lowercase hex' });

export const Wp8StepCostTelemetrySchema = z.object({
  stepNumber: z.number().int().min(1).max(WP8_NUMERIC_BOUNDS.maxStepNumber),
  provider: Wp8ProviderSchema,
  providerStatus: TokenFieldStatusSchema,
  timeToFirstTokenMs: boundedLatency().nullable(),
  latencyMs: boundedLatency().nullable(),
  promptVersion: z.string().min(1).max(100),
  toolCatalogVersion: z.string().min(1).max(100),
  schemaDigest: HexDigestSchema,
  billableMicros: boundedCount(WP8_NUMERIC_BOUNDS.maxCostMicros),
  costCompleteness: z.enum(['complete', 'partial', 'unknown']),
});
export type Wp8StepCostTelemetry = z.infer<typeof Wp8StepCostTelemetrySchema>;

/**
 * Derive the per-step provider cache status from normalized token fields.
 * Missing is never reported as zero: all-missing stays `missing`, and any
 * `unsupported` is preserved unless a field was actually reported.
 */
export function deriveProviderCacheStatus(usage: NormalizedStepUsage): TokenFieldStatus {
  const fields = [usage.cacheReadTokens, usage.cacheWriteTokens, usage.uncachedTokens];
  if (fields.some((field) => field.status === 'parse_error')) return 'parse_error';
  if (fields.some((field) => field.status === 'reported')) return 'reported';
  if (fields.some((field) => field.status === 'unsupported')) return 'unsupported';
  return 'missing';
}

export interface Wp8StepCostTelemetryInput {
  readonly stepNumber: number;
  readonly provider: Wp8Provider;
  readonly usage: NormalizedStepUsage;
  readonly rates: TokenPriceRates;
  readonly timeToFirstTokenMs: number | null;
  readonly latencyMs: number | null;
  readonly promptVersion: string;
  readonly toolCatalogVersion: string;
  readonly schemaDigest: string;
}

export function buildWp8StepCostTelemetry(input: Wp8StepCostTelemetryInput): Wp8StepCostTelemetry {
  const cost = computeStepCost(input.usage, input.rates);
  return Object.freeze(
    Wp8StepCostTelemetrySchema.parse({
      stepNumber: input.stepNumber,
      provider: input.provider,
      providerStatus: deriveProviderCacheStatus(input.usage),
      timeToFirstTokenMs: input.timeToFirstTokenMs,
      latencyMs: input.latencyMs,
      promptVersion: input.promptVersion,
      toolCatalogVersion: input.toolCatalogVersion,
      schemaDigest: input.schemaDigest,
      billableMicros: cost.micros,
      costCompleteness: cost.completeness,
    }),
  );
}

export const WP8_STEP_LABEL_KEYS = Object.freeze([
  'provider',
  'modelId',
  'promptVersion',
  'toolCatalogVersion',
  'schemaDigest',
  'cacheStatus',
  'completeness',
]);

const WP8_SAFE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/+-]*$/;
const WP8_SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /sk-[A-Za-z0-9]{8,}/,
  /bearer\s+[A-Za-z0-9\-._~+/=]{8,}/i,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]);

export interface Wp8StepLabelInput {
  readonly provider: Wp8Provider;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly toolCatalogVersion: string;
  readonly schemaDigest: string;
  readonly cacheStatus: TokenFieldStatus;
  readonly completeness: 'complete' | 'partial' | 'unknown';
}

/**
 * Provider/model/prompt/tool-catalog/schema-digest are carried as bounded
 * metric labels, never as free-form values. Application code holds no
 * provider-specific request fields; capability facts stay in infrastructure
 * adapters.
 */
export function wp8StepCostLabels(input: Wp8StepLabelInput): Readonly<Record<string, string>> {
  const labels: Record<string, string> = {
    provider: input.provider,
    modelId: input.modelId,
    promptVersion: input.promptVersion,
    toolCatalogVersion: input.toolCatalogVersion,
    schemaDigest: input.schemaDigest,
    cacheStatus: input.cacheStatus,
    completeness: input.completeness,
  };
  assertWp8StepLabelsSafe(labels);
  return Object.freeze({ ...labels });
}

export function assertWp8StepLabelsSafe(labels: Readonly<Record<string, string>>): void {
  const allowed = new Set<string>(WP8_STEP_LABEL_KEYS);
  for (const key of Object.keys(labels).sort()) {
    const value = labels[key];
    if (value === undefined) throw new Error(`assertWp8StepLabelsSafe: label ${key} is undefined`);
    if (!allowed.has(key)) {
      throw new Error(`assertWp8StepLabelsSafe: unbounded label key ${key}`);
    }
    if (value.length === 0 || value.length > 128) {
      throw new Error(`assertWp8StepLabelsSafe: unbounded label length for ${key}`);
    }
    if (!WP8_SAFE_LABEL_PATTERN.test(value)) {
      throw new Error(`assertWp8StepLabelsSafe: unbounded label value for ${key}`);
    }
    if (WP8_SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new Error(`assertWp8StepLabelsSafe: secret-shaped label value for ${key}`);
    }
  }
  const modelId = labels['modelId'];
  if (
    modelId !== undefined &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(modelId)
  ) {
    throw new Error('assertWp8StepLabelsSafe: modelId must not be an opaque identifier');
  }
}

// ---------------------------------------------------------------------------
// Rollup consistency: turn cost equals the sum of per-step costs
// ---------------------------------------------------------------------------

export interface Wp8CostRollup {
  readonly micros: number;
  readonly completeness: 'complete' | 'partial' | 'unknown';
  readonly perStepMicros: readonly number[];
}

export function rollupWp8StepCosts(
  steps: readonly NormalizedStepUsage[],
  rates: TokenPriceRates,
): Wp8CostRollup {
  const perStepMicros = steps.map((step) => computeStepCost(step, rates).micros);
  const micros = perStepMicros.reduce((sum, value) => sum + value, 0);
  const costs = steps.map((step) => computeStepCost(step, rates));
  const unknown = costs.flatMap((cost) => cost.unknownComponents);
  const computed = costs.some((cost) => cost.completeness !== 'unknown');
  const complete = steps.length > 0 && unknown.length === 0;
  const completeness = complete ? 'complete' : computed ? 'partial' : 'unknown';
  return Object.freeze({
    micros,
    completeness,
    perStepMicros: Object.freeze([...perStepMicros]),
  });
}
