import { createHash } from 'node:crypto';
import { z } from 'zod';
import { logger } from '@app/domain';

/**
 * Tracked cache matrix (WP-8 Task B, F-34/F-43 partial).
 *
 * Five layers with separate keys, tenancy, versions, TTL, invalidation,
 * eligibility, failure mode, stampede control, telemetry, cost, and rollback:
 *
 * - `turn_result`: idempotent retry/resume for one user and turn id.
 *   Correctness-sensitive; never shared across turns; failures fail closed.
 * - `verified_answer`: reuse of a verified first-turn answer. User-scoped,
 *   exact-normalized; only `verified` grounding decisions are eligible.
 * - `embedding`: reuse of query embeddings. Tenant/model/version-scoped.
 * - `retrieval_candidate`: reuse of candidate ids/scores with query
 *   provenance. Tenant/corpus/index/config-scoped. Backfill and dedup stay
 *   turn-local after cached candidates are loaded.
 * - `provider_prompt`: prefix reuse inside model calls. Keys are owned by
 *   infrastructure adapters; this matrix records the policy row only, and
 *   reuse must be observed per step (see `agent/prompt/prefix-version.ts`),
 *   never assumed from configuration.
 *
 * Rules enforced here: no cross-user answer reuse without an explicit
 * auth/privacy design (fail closed on tenant mismatch); only verified answers
 * cached; versioned keys with stale-version rejection; bounded distributed
 * single-flight with fan-in cap and bounded wait; correctness-critical
 * idempotency never silently fail-open; embedding and retrieval caching behind
 * independent flags.
 */

export const CACHE_MATRIX_VERSION = 'cache-matrix-v1' as const;

export const CacheLayerIdSchema = z.enum([
  'turn_result',
  'verified_answer',
  'embedding',
  'retrieval_candidate',
  'provider_prompt',
]);
export type CacheLayerId = z.infer<typeof CacheLayerIdSchema>;

export const CacheFailureActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('fail_closed'), reason: z.string().min(1).max(200) }),
  z.object({
    action: z.literal('fail_open_degraded'),
    reason: z.string().min(1).max(200),
    duplicateSlotRequired: z.literal(true),
  }),
]);
export type CacheFailureAction = z.infer<typeof CacheFailureActionSchema>;

export interface CacheLayerPolicy {
  readonly layer: CacheLayerId;
  readonly purpose: string;
  readonly tenancy: string;
  readonly keyFields: readonly string[];
  readonly versionFields: readonly string[];
  readonly ttlMs: number;
  readonly invalidationTriggers: readonly string[];
  readonly eligibility: string;
  readonly failureMode: 'fail_closed' | 'fail_open';
  readonly stampedeControl: string;
  readonly telemetry: readonly string[];
  readonly costNote: string;
  readonly rollback: string;
}

function freezePolicy(policy: CacheLayerPolicy): CacheLayerPolicy {
  return Object.freeze({
    ...policy,
    keyFields: Object.freeze([...policy.keyFields]),
    versionFields: Object.freeze([...policy.versionFields]),
    invalidationTriggers: Object.freeze([...policy.invalidationTriggers]),
    telemetry: Object.freeze([...policy.telemetry]),
  });
}

export const TURN_RESULT_TTL_MS = 15 * 60 * 1_000;
export const VERIFIED_ANSWER_TTL_MS = 60 * 60 * 1_000;
export const EMBEDDING_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const RETRIEVAL_CANDIDATE_TTL_MS = 30 * 60 * 1_000;

/**
 * Policy defaults. TTLs are starting values subject to the WP-8 capacity and
 * cost runs, not release promises.
 */
export const CACHE_MATRIX: Record<CacheLayerId, CacheLayerPolicy> = Object.freeze({
  turn_result: freezePolicy({
    layer: 'turn_result',
    purpose: 'Idempotent retry/resume for one user and turn id.',
    tenancy: 'user_turn: never shared across turns or users.',
    keyFields: ['matrixVersion', 'userIdHash', 'turnId', 'turnFingerprint'],
    versionFields: ['matrixVersion', 'turnFingerprint'],
    ttlMs: TURN_RESULT_TTL_MS,
    invalidationTriggers: ['turn completion', 'turn cancellation', 'TTL expiry'],
    eligibility: 'Same userId and turnId only; fingerprint must match.',
    failureMode: 'fail_closed',
    stampedeControl: 'Correctness-critical: no duplicate execution without the idempotency lease.',
    telemetry: ['hit', 'miss', 'fingerprint_mismatch', 'fail_closed'],
    costNote: 'Small payloads; cost is Redis ops, not model tokens.',
    rollback: 'Disable reads; writes remain so retries stay idempotent.',
  }),
  verified_answer: freezePolicy({
    layer: 'verified_answer',
    purpose: 'Reuse a verified first-turn answer for an exact-normalized query.',
    tenancy: 'user: never shared across users without an explicit auth/privacy design.',
    keyFields: ['matrixVersion', 'userIdHash', 'normalizedQueryHash', 'promptVersion', 'toolCatalogVersion', 'schemaDigest'],
    versionFields: ['matrixVersion', 'promptVersion', 'toolCatalogVersion', 'schemaDigest'],
    ttlMs: VERIFIED_ANSWER_TTL_MS,
    invalidationTriggers: ['TTL expiry', 'prompt/catalog rotation', 'explicit user correction'],
    eligibility: 'Grounding decision verified only; rejected/unverified never stored.',
    failureMode: 'fail_open',
    stampedeControl: 'Bounded single-flight for identical queries; capped duplicate generations.',
    telemetry: ['hit', 'miss', 'ineligible_decision', 'fail_open_degraded'],
    costNote: 'Saves a full turn on hit; expected hit rate limited by exact normalization.',
    rollback: 'Disable reads first, then writes; force re-verification.',
  }),
  embedding: freezePolicy({
    layer: 'embedding',
    purpose: 'Reuse query embeddings across turns and subquestions.',
    tenancy: 'tenant: key includes tenantId; mismatch fails closed.',
    keyFields: ['matrixVersion', 'tenantId', 'normalizedQueryHash', 'embeddingModelId', 'embeddingModelVersion', 'dimensions'],
    versionFields: ['matrixVersion', 'embeddingModelId', 'embeddingModelVersion', 'dimensions'],
    ttlMs: EMBEDDING_CACHE_TTL_MS,
    invalidationTriggers: ['TTL expiry', 'embedding model/version change', 'dimension change'],
    eligibility: 'Independent embeddingCacheEnabled flag; normalized query required.',
    failureMode: 'fail_open',
    stampedeControl: 'Bounded single-flight per key; stale versions rejected, never served.',
    telemetry: ['hit', 'miss', 'stale_version', 'fail_open_degraded'],
    costNote: 'Saves embedding provider calls; Redis payload is small dense vectors.',
    rollback: 'Independent flag off; callers recompute embeddings.',
  }),
  retrieval_candidate: freezePolicy({
    layer: 'retrieval_candidate',
    purpose: 'Reuse candidate ids/scores with score and query provenance.',
    tenancy: 'tenant_corpus: key includes tenantId and corpus/index versions.',
    keyFields: ['matrixVersion', 'tenantId', 'corpusVersion', 'indexVersion', 'normalizedQueryHash', 'modality', 'filterHash', 'retrievalConfigVersion'],
    versionFields: ['matrixVersion', 'corpusVersion', 'indexVersion', 'retrievalConfigVersion'],
    ttlMs: RETRIEVAL_CANDIDATE_TTL_MS,
    invalidationTriggers: ['TTL expiry', 'corpus/index/config version change', 'filter change'],
    eligibility: 'Independent retrievalCacheEnabled flag; cached entries retain score and query provenance.',
    failureMode: 'fail_open',
    stampedeControl: 'Bounded single-flight per key; dedup/backfill stay turn-local after load.',
    telemetry: ['hit', 'miss', 'stale_version', 'fail_open_degraded'],
    costNote: 'Saves vector/lexical DB work; entries are ids and scores, not document text.',
    rollback: 'Independent flag off; retrieval executes uncached.',
  }),
  provider_prompt: freezePolicy({
    layer: 'provider_prompt',
    purpose: 'Discount/reuse an identical input prefix within model calls. Does not skip the call.',
    tenancy: 'provider_prefix: key owned by the infrastructure adapter.',
    keyFields: ['adapter-owned: prefixVersion digest plus adapter key material'],
    versionFields: ['systemPromptVersion', 'toolCatalogVersion', 'schemaDigest', 'historyShapeVersion'],
    ttlMs: -1,
    invalidationTriggers: ['prefix version rotation (any contract change)'],
    eligibility: 'Capability-gated (automatic/explicit); observed per-step telemetry only.',
    failureMode: 'fail_open',
    stampedeControl: 'Not applicable: the call is never skipped.',
    telemetry: ['reported', 'unsupported', 'missing', 'parse_error', 'billable_cost', 'completeness'],
    costNote: 'Priced with provider-specific cache read/write rates; never claimed from configuration.',
    rollback: 'Prefix identity stays versioned; adapters drop explicit key material.',
  }),
});

export function getCacheLayerPolicy(layer: CacheLayerId): CacheLayerPolicy {
  return CACHE_MATRIX[layer];
}

function hashSegment(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

const KeyInputBaseSchema = z.object({
  matrixVersion: z.literal(CACHE_MATRIX_VERSION).default(CACHE_MATRIX_VERSION),
});

export const TurnResultKeyInputSchema = KeyInputBaseSchema.extend({
  userId: z.string().min(1).max(200),
  turnId: z.string().min(1).max(200),
  turnFingerprint: z.string().min(1).max(500),
});
export type TurnResultKeyInput = z.infer<typeof TurnResultKeyInputSchema>;

/** Turn-result keys are bound to one user and turn; never shared across turns. */
export function buildTurnResultKey(input: unknown): string {
  const parsed = TurnResultKeyInputSchema.parse(input);
  return `tr:${parsed.matrixVersion}:u${hashSegment(parsed.userId)}:t${parsed.turnId}:f${hashSegment(parsed.turnFingerprint)}`;
}

export const VerifiedAnswerKeyInputSchema = KeyInputBaseSchema.extend({
  userId: z.string().min(1).max(200),
  normalizedQuery: z.string().min(1).max(2_000),
  promptVersion: z.string().min(1).max(200),
  toolCatalogVersion: z.string().min(1).max(200),
  schemaDigest: z.string().min(1).max(200),
});
export type VerifiedAnswerKeyInput = z.infer<typeof VerifiedAnswerKeyInputSchema>;

/** Verified-answer keys are user-scoped and exact-normalized. No cross-user reuse. */
export function buildVerifiedAnswerKey(input: unknown): string {
  const parsed = VerifiedAnswerKeyInputSchema.parse(input);
  return `va:${parsed.matrixVersion}:u${hashSegment(parsed.userId)}:q${hashSegment(parsed.normalizedQuery)}:p${hashSegment(`${parsed.promptVersion}\0${parsed.toolCatalogVersion}\0${parsed.schemaDigest}`)}`;
}

export const EmbeddingKeyInputSchema = KeyInputBaseSchema.extend({
  tenantId: z.string().min(1).max(200),
  normalizedQuery: z.string().min(1).max(4_000),
  embeddingModelId: z.string().min(1).max(200),
  embeddingModelVersion: z.string().min(1).max(200),
  dimensions: z.number().int().positive().max(10_000),
});
export type EmbeddingKeyInput = z.infer<typeof EmbeddingKeyInputSchema>;

export function buildEmbeddingKey(input: unknown): string {
  const parsed = EmbeddingKeyInputSchema.parse(input);
  return `emb:${parsed.matrixVersion}:t${parsed.tenantId}:m${parsed.embeddingModelId}:v${parsed.embeddingModelVersion}:d${parsed.dimensions}:q${hashSegment(parsed.normalizedQuery)}`;
}

export const RetrievalCandidateKeyInputSchema = KeyInputBaseSchema.extend({
  tenantId: z.string().min(1).max(200),
  corpusVersion: z.string().min(1).max(200),
  indexVersion: z.string().min(1).max(200),
  normalizedQuery: z.string().min(1).max(2_000),
  modality: z.enum(['vector', 'lexical', 'fused']),
  filterHash: z.string().min(1).max(200),
  retrievalConfigVersion: z.string().min(1).max(200),
});
export type RetrievalCandidateKeyInput = z.infer<typeof RetrievalCandidateKeyInputSchema>;

export function buildRetrievalCandidateKey(input: unknown): string {
  const parsed = RetrievalCandidateKeyInputSchema.parse(input);
  return `rc:${parsed.matrixVersion}:t${parsed.tenantId}:c${parsed.corpusVersion}:i${parsed.indexVersion}:${parsed.modality}:f${parsed.filterHash}:v${parsed.retrievalConfigVersion}:q${hashSegment(parsed.normalizedQuery)}`;
}

export const GroundingDecisionSchema = z.enum(['verified', 'rejected', 'unverified']);
export type CacheEligibilityDecision = z.infer<typeof GroundingDecisionSchema>;

/**
 * Only verified final answers may be cached. Error, timeout, rejected, and
 * unverified states are never positive answer entries. Exhaustive by schema.
 */
export function isVerifiedAnswerEligible(decision: CacheEligibilityDecision): boolean {
  switch (decision) {
    case 'verified':
      return true;
    case 'rejected':
    case 'unverified':
      return false;
    default: {
      const exhaustive: never = decision;
      throw new Error(`cache-matrix: unhandled grounding decision ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Turn-result and verified-answer layers never allow cross-user reuse. */
export function isCrossUserReuseAllowed(layer: CacheLayerId): boolean {
  switch (layer) {
    case 'turn_result':
    case 'verified_answer':
      return false;
    case 'embedding':
    case 'retrieval_candidate':
    case 'provider_prompt':
      return false;
    default: {
      const exhaustive: never = layer;
      throw new Error(`cache-matrix: unhandled layer ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Tenant mismatch fails closed: cached entries are never served across tenants. */
export function assertTenantMatch(cachedTenantId: string, requestTenantId: string): void {
  if (cachedTenantId !== requestTenantId) {
    logger.warn('cache.tenant_mismatch_rejected', {
      layer: 'tenant_scoped',
      failClosed: true,
    });
    throw new Error('cache-matrix: tenant mismatch; cached entry is not reusable across tenants');
  }
}

export const CacheFeatureFlagsSchema = z.object({
  embeddingCacheEnabled: z.boolean(),
  retrievalCacheEnabled: z.boolean(),
});
export type CacheFeatureFlags = z.infer<typeof CacheFeatureFlagsSchema>;

/** Independent flags: embedding and retrieval caching roll back separately. */
export function isLayerEnabled(flags: CacheFeatureFlags, layer: CacheLayerId): boolean {
  switch (layer) {
    case 'embedding':
      return flags.embeddingCacheEnabled;
    case 'retrieval_candidate':
      return flags.retrievalCacheEnabled;
    case 'turn_result':
    case 'verified_answer':
    case 'provider_prompt':
      return true;
    default: {
      const exhaustive: never = layer;
      throw new Error(`cache-matrix: unhandled layer ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Failure policy. Turn-result/idempotency failures fail closed (correctness
 * over availability); optional layers degrade fail-open with a duplicate-work
 * slot requirement so Redis degradation cannot cause unlimited stampedes.
 */
export function resolveCacheFailure(layer: CacheLayerId, errorCode: string): CacheFailureAction {
  const reason = `${layer}_redis_${errorCode}`.slice(0, 200);
  switch (layer) {
    case 'turn_result':
      logger.warn('cache.fail_closed', { layer, reason });
      return Object.freeze({ action: 'fail_closed', reason });
    case 'verified_answer':
    case 'embedding':
    case 'retrieval_candidate':
    case 'provider_prompt':
      return Object.freeze({ action: 'fail_open_degraded', reason, duplicateSlotRequired: true as const });
    default: {
      const exhaustive: never = layer;
      throw new Error(`cache-matrix: unhandled layer ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Correctness-critical idempotency never silently fail-open: even when the
 * caller cannot reach coordination, the guarded write must be rejected with
 * an explicit reason, never executed unguarded.
 */
export function resolveIdempotencyFailure(errorCode: string): CacheFailureAction {
  const reason = `idempotency_redis_${errorCode}`.slice(0, 200);
  logger.warn('cache.idempotency_fail_closed', { reason });
  return Object.freeze({ action: 'fail_closed', reason });
}

export const STAMPEDE_DEFAULT_MAX_DUPLICATE_GENERATIONS = 3 as const;

/** Stampede cap: at most `max` duplicate generations during degradation. */
export function admitDuplicateWork(activeDuplicates: number, max: number): boolean {
  if (!Number.isInteger(activeDuplicates) || activeDuplicates < 0) return false;
  if (!Number.isInteger(max) || max < 1) return false;
  return activeDuplicates < max;
}

export const CacheAccessTelemetrySchema = z.object({
  layer: CacheLayerIdSchema,
  outcome: z.enum(['hit', 'miss', 'stale_version', 'ineligible', 'fail_closed', 'fail_open_degraded']),
  latencyMs: z.number().int().min(0).nullable(),
});
export type CacheAccessTelemetry = z.infer<typeof CacheAccessTelemetrySchema>;

export function buildCacheTelemetry(input: unknown): CacheAccessTelemetry {
  return Object.freeze(CacheAccessTelemetrySchema.parse(input));
}

export const SingleFlightConfigSchema = z.object({
  maxWaitMs: z.number().int().min(1).max(30_000),
  maxFanIn: z.number().int().min(1).max(1_000),
});
export type SingleFlightConfig = z.infer<typeof SingleFlightConfigSchema>;

export type SingleFlightOutcome<T> =
  | { readonly status: 'executed'; readonly value: T; readonly coalescedCount: number }
  | { readonly status: 'coalesced'; readonly value: T }
  | { readonly status: 'wait_timeout'; readonly waitedMs: number }
  | { readonly status: 'fan_in_exceeded' }
  | { readonly status: 'error'; readonly reason: 'loader_error' };

export interface BoundedSingleFlight<T> {
  run(key: string, loader: () => Promise<T>): Promise<SingleFlightOutcome<T>>;
  pendingCount(): number;
}

interface FlightWaiter<T> {
  readonly resolve: (value: SingleFlightOutcome<T>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Distributed single-flight policy with bounded wait and fan-in.
 *
 * Identical expensive work coalesces onto one leader. Waiters give up after
 * `maxWaitMs` (typed `wait_timeout`, never an unbounded wait); arrivals past
 * `maxFanIn` are rejected with `fan_in_exceeded` so a hot key cannot pin
 * unbounded memory. Leader errors settle waiters as typed `error` without
 * leaking error text. Every timer is cleared on settle; `pendingCount` must
 * return to zero (asserted in tests for timer/semaphore cleanup).
 */
export function createBoundedSingleFlight<T>(config: unknown): BoundedSingleFlight<T> {
  const parsed = SingleFlightConfigSchema.parse(config);
  const flights = new Map<string, Array<FlightWaiter<T>>>();

  function settle(key: string): void {
    const waiters = flights.get(key);
    if (waiters !== undefined) {
      for (const waiter of waiters) clearTimeout(waiter.timer);
      flights.delete(key);
    }
  }

  async function run(key: string, loader: () => Promise<T>): Promise<SingleFlightOutcome<T>> {
    const existing = flights.get(key);
    if (existing === undefined) {
      const waiters: Array<FlightWaiter<T>> = [];
      flights.set(key, waiters);
      try {
        const value = await loader();
        const coalescedCount = waiters.length;
        for (const waiter of waiters) waiter.resolve({ status: 'coalesced', value });
        return Object.freeze({ status: 'executed', value, coalescedCount });
      } catch {
        for (const waiter of waiters) waiter.resolve({ status: 'error', reason: 'loader_error' });
        return Object.freeze({ status: 'error', reason: 'loader_error' });
      } finally {
        settle(key);
      }
    }
    if (existing.length >= parsed.maxFanIn) {
      return Object.freeze({ status: 'fan_in_exceeded' });
    }
    const waitedStart = Date.now();
    const outcome = await new Promise<SingleFlightOutcome<T>>((resolve) => {
      const timer = setTimeout(() => {
        const current = flights.get(key);
        if (current !== undefined) {
          const index = current.findIndex((waiter) => waiter.resolve === resolveWrapper);
          if (index >= 0) current.splice(index, 1);
        }
        resolve({ status: 'wait_timeout', waitedMs: Date.now() - waitedStart });
      }, parsed.maxWaitMs);
      const resolveWrapper = (value: SingleFlightOutcome<T>): void => {
        clearTimeout(timer);
        resolve(value);
      };
      existing.push({ resolve: resolveWrapper, timer });
    });
    return outcome;
  }

  return {
    run,
    pendingCount: () => flights.size,
  };
}
