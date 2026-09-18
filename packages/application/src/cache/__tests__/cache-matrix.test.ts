import { afterEach, describe, expect, it } from 'vitest';
import {
  CACHE_MATRIX,
  CACHE_MATRIX_VERSION,
  STAMPEDE_DEFAULT_MAX_DUPLICATE_GENERATIONS,
  admitDuplicateWork,
  assertTenantMatch,
  buildCacheTelemetry,
  buildEmbeddingKey,
  buildRetrievalCandidateKey,
  buildTurnResultKey,
  buildVerifiedAnswerKey,
  createBoundedSingleFlight,
  getCacheLayerPolicy,
  isCrossUserReuseAllowed,
  isLayerEnabled,
  isVerifiedAnswerEligible,
  resolveCacheFailure,
  resolveIdempotencyFailure,
  type BoundedSingleFlight,
  type CacheLayerId,
} from '../cache-matrix';

const ALL_LAYERS: readonly CacheLayerId[] = [
  'turn_result',
  'verified_answer',
  'embedding',
  'retrieval_candidate',
  'provider_prompt',
];

const flights: Array<BoundedSingleFlight<string>> = [];
afterEach(() => {
  for (const flight of flights) expect(flight.pendingCount()).toBe(0);
  flights.length = 0;
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

describe('cache matrix policy table', () => {
  it('covers all five layers with versions, TTL, and rollback', () => {
    expect(Object.keys(CACHE_MATRIX).sort()).toEqual([...ALL_LAYERS].sort());
    for (const layer of ALL_LAYERS) {
      const policy = getCacheLayerPolicy(layer);
      expect(policy.layer).toBe(layer);
      expect(policy.keyFields.length).toBeGreaterThan(0);
      expect(policy.versionFields.length).toBeGreaterThan(0);
      expect(policy.invalidationTriggers.length).toBeGreaterThan(0);
      expect(policy.rollback.length).toBeGreaterThan(0);
      expect(Object.isFrozen(policy)).toBe(true);
    }
    expect(getCacheLayerPolicy('turn_result').failureMode).toBe('fail_closed');
    expect(getCacheLayerPolicy('provider_prompt').keyFields.join(' ')).toMatch(/adapter-owned/);
  });
});

describe('versioned keys and tenancy isolation', () => {
  it('binds turn-result keys to one user and turn', () => {
    const base = { userId: 'user-1', turnId: 'turn-1', turnFingerprint: 'fp-1' };
    const key = buildTurnResultKey(base);
    expect(key).toContain(CACHE_MATRIX_VERSION);
    expect(buildTurnResultKey(base)).toBe(key);
    expect(buildTurnResultKey({ ...base, turnId: 'turn-2' })).not.toBe(key);
    expect(buildTurnResultKey({ ...base, userId: 'user-2' })).not.toBe(key);
    expect(buildTurnResultKey({ ...base, turnFingerprint: 'fp-2' })).not.toBe(key);
  });

  it('scopes verified-answer keys per user with prompt identity', () => {
    const base = {
      userId: 'user-1',
      normalizedQuery: 'how do refunds work',
      promptVersion: 'prompt-prefix-v1:abc',
      toolCatalogVersion: 'tool-catalog-v1',
      schemaDigest: 'digest-1',
    };
    const key = buildVerifiedAnswerKey(base);
    expect(buildVerifiedAnswerKey(base)).toBe(key);
    expect(buildVerifiedAnswerKey({ ...base, userId: 'user-2' })).not.toBe(key);
    expect(buildVerifiedAnswerKey({ ...base, schemaDigest: 'digest-2' })).not.toBe(key);
  });

  it('versions embedding keys by tenant, model, and dimensions', () => {
    const base = {
      tenantId: 'tenant-a',
      normalizedQuery: 'refund policy',
      embeddingModelId: 'embed-model',
      embeddingModelVersion: 'v3',
      dimensions: 768,
    };
    const key = buildEmbeddingKey(base);
    expect(buildEmbeddingKey(base)).toBe(key);
    expect(buildEmbeddingKey({ ...base, tenantId: 'tenant-b' })).not.toBe(key);
    expect(buildEmbeddingKey({ ...base, embeddingModelVersion: 'v4' })).not.toBe(key);
    expect(buildEmbeddingKey({ ...base, dimensions: 1024 })).not.toBe(key);
  });

  it('versions retrieval-candidate keys by corpus, index, modality, filter, and config', () => {
    const base = {
      tenantId: 'tenant-a',
      corpusVersion: 'corpus-7',
      indexVersion: 'index-3',
      normalizedQuery: 'refund policy',
      modality: 'vector',
      filterHash: 'nofilter',
      retrievalConfigVersion: 'retrieval-v2',
    } as const;
    const key = buildRetrievalCandidateKey(base);
    expect(buildRetrievalCandidateKey(base)).toBe(key);
    expect(buildRetrievalCandidateKey({ ...base, corpusVersion: 'corpus-8' })).not.toBe(key);
    expect(buildRetrievalCandidateKey({ ...base, indexVersion: 'index-4' })).not.toBe(key);
    expect(buildRetrievalCandidateKey({ ...base, modality: 'lexical' })).not.toBe(key);
    expect(buildRetrievalCandidateKey({ ...base, tenantId: 'tenant-b' })).not.toBe(key);
  });

  it('never allows cross-user answer reuse and fails closed on tenant mismatch', () => {
    expect(isCrossUserReuseAllowed('turn_result')).toBe(false);
    expect(isCrossUserReuseAllowed('verified_answer')).toBe(false);
    expect(() => assertTenantMatch('tenant-a', 'tenant-a')).not.toThrow();
    expect(() => assertTenantMatch('tenant-a', 'tenant-b')).toThrow(/tenant mismatch/);
  });

  it('caches verified answers only', () => {
    expect(isVerifiedAnswerEligible('verified')).toBe(true);
    expect(isVerifiedAnswerEligible('rejected')).toBe(false);
    expect(isVerifiedAnswerEligible('unverified')).toBe(false);
  });

  it('gates embedding and retrieval caching behind independent flags', () => {
    expect(isLayerEnabled({ embeddingCacheEnabled: true, retrievalCacheEnabled: false }, 'embedding')).toBe(true);
    expect(isLayerEnabled({ embeddingCacheEnabled: true, retrievalCacheEnabled: false }, 'retrieval_candidate')).toBe(false);
    expect(isLayerEnabled({ embeddingCacheEnabled: false, retrievalCacheEnabled: true }, 'embedding')).toBe(false);
    expect(isLayerEnabled({ embeddingCacheEnabled: false, retrievalCacheEnabled: true }, 'retrieval_candidate')).toBe(true);
  });
});

describe('failure modes and stampede caps', () => {
  it('fails turn-result closed and optional layers open with duplicate slots', () => {
    expect(resolveCacheFailure('turn_result', 'timeout')).toEqual({
      action: 'fail_closed',
      reason: 'turn_result_redis_timeout',
    });
    for (const layer of ['verified_answer', 'embedding', 'retrieval_candidate'] as const) {
      expect(resolveCacheFailure(layer, 'timeout')).toEqual({
        action: 'fail_open_degraded',
        reason: `${layer}_redis_timeout`,
        duplicateSlotRequired: true,
      });
    }
  });

  it('never lets idempotency silently fail open', () => {
    const action = resolveIdempotencyFailure('unavailable');
    expect(action.action).toBe('fail_closed');
    if (action.action === 'fail_closed') expect(action.reason).toContain('idempotency');
    else throw new Error('idempotency must fail closed');
  });

  it('caps duplicate generations during degradation', () => {
    expect(STAMPEDE_DEFAULT_MAX_DUPLICATE_GENERATIONS).toBe(3);
    expect(admitDuplicateWork(2, 3)).toBe(true);
    expect(admitDuplicateWork(3, 3)).toBe(false);
    expect(admitDuplicateWork(0, 0)).toBe(false);
    expect(admitDuplicateWork(-1, 3)).toBe(false);
  });

  it('builds bounded cache telemetry', () => {
    expect(buildCacheTelemetry({ layer: 'embedding', outcome: 'stale_version', latencyMs: 4 }).outcome).toBe(
      'stale_version',
    );
    expect(() => buildCacheTelemetry({ layer: 'embedding', outcome: 'hit' })).toThrow();
  });
});

describe('bounded single-flight', () => {
  it('coalesces identical work onto one leader with fan-in counted', async () => {
    const flight = createBoundedSingleFlight<string>({ maxWaitMs: 500, maxFanIn: 10 });
    flights.push(flight);
    const gate = deferred<string>();
    const leader = flight.run('key-a', () => gate.promise);
    const waiterA = flight.run('key-a', () => Promise.resolve('second'));
    const waiterB = flight.run('key-a', () => Promise.resolve('third'));
    expect(flight.pendingCount()).toBe(1);
    gate.resolve('first');
    expect(await leader).toEqual({ status: 'executed', value: 'first', coalescedCount: 2 });
    expect(await waiterA).toEqual({ status: 'coalesced', value: 'first' });
    expect(await waiterB).toEqual({ status: 'coalesced', value: 'first' });
  });

  it('rejects arrivals past the fan-in cap', async () => {
    const flight = createBoundedSingleFlight<string>({ maxWaitMs: 500, maxFanIn: 1 });
    flights.push(flight);
    const gate = deferred<string>();
    const leader = flight.run('key-b', () => gate.promise);
    const waiter = flight.run('key-b', () => Promise.resolve('waiter'));
    expect(await flight.run('key-b', () => Promise.resolve('overflow'))).toEqual({ status: 'fan_in_exceeded' });
    gate.resolve('done');
    expect(await leader).toEqual({ status: 'executed', value: 'done', coalescedCount: 1 });
    expect(await waiter).toEqual({ status: 'coalesced', value: 'done' });
  });

  it('bounds waiter delay with wait_timeout and still settles the leader', async () => {
    const flight = createBoundedSingleFlight<string>({ maxWaitMs: 15, maxFanIn: 10 });
    flights.push(flight);
    const gate = deferred<string>();
    const leader = flight.run('key-c', () => gate.promise);
    const waiter = flight.run('key-c', () => Promise.resolve('late'));
    const outcome = await waiter;
    expect(outcome.status).toBe('wait_timeout');
    gate.resolve('eventual');
    expect(await leader).toEqual({ status: 'executed', value: 'eventual', coalescedCount: 0 });
  });

  it('settles waiters as typed errors without leaking loader text', async () => {
    const flight = createBoundedSingleFlight<string>({ maxWaitMs: 500, maxFanIn: 10 });
    flights.push(flight);
    const gate = deferred<string>();
    const leader = flight.run('key-d', () => gate.promise);
    const waiter = flight.run('key-d', () => Promise.resolve('never'));
    gate.reject(new Error('secret backend detail'));
    expect(await leader).toEqual({ status: 'error', reason: 'loader_error' });
    expect(await waiter).toEqual({ status: 'error', reason: 'loader_error' });
  });
});
