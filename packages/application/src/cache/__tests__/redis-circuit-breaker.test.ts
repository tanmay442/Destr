import { describe, expect, it } from 'vitest';
import {
  classifyLayerForBreaker,
  createRedisCircuitBreaker,
  type RedisCircuitBreaker,
} from '../redis-circuit-breaker';
import type { CacheLayerId } from '../cache-matrix';

function manualClock(startMs = 1_000): { readonly now: () => number; readonly advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function breakerFixture(clock: () => number): RedisCircuitBreaker {
  return createRedisCircuitBreaker(
    { failureThreshold: 3, successThreshold: 2, openMs: 1_000, maxDuplicateWork: 2 },
    clock,
  );
}

const OPTIONAL_LAYERS: readonly CacheLayerId[] = ['verified_answer', 'embedding', 'retrieval_candidate'];

describe('classifyLayerForBreaker', () => {
  it('treats idempotency as correctness-critical and caches as optional', () => {
    expect(classifyLayerForBreaker('turn_result')).toBe('correctness_critical');
    for (const layer of OPTIONAL_LAYERS) expect(classifyLayerForBreaker(layer)).toBe('optional');
    expect(classifyLayerForBreaker('provider_prompt')).toBe('optional');
  });
});

describe('redis circuit breaker', () => {
  it('starts closed and admits every layer', () => {
    const clock = manualClock();
    const breaker = breakerFixture(clock.now);
    expect(breaker.getState()).toBe('closed');
    expect(breaker.admit('turn_result')).toEqual({ decision: 'allow' });
    expect(breaker.admit('embedding')).toEqual({ decision: 'allow' });
  });

  it('opens after the failure threshold and separates fail-closed from fail-open', () => {
    const clock = manualClock();
    const breaker = breakerFixture(clock.now);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('closed');
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');
    expect(breaker.admit('turn_result')).toEqual({
      decision: 'reject_fail_closed',
      reason: 'idempotency_redis_unavailable',
    });
    const degraded = breaker.admit('embedding');
    expect(degraded).toEqual({
      decision: 'degrade_fail_open',
      reason: 'optional_cache_breaker_open',
      duplicateSlot: true,
    });
  });

  it('counts timeouts as failures and resets on success while closed', () => {
    const clock = manualClock();
    const breaker = breakerFixture(clock.now);
    breaker.recordTimeout();
    breaker.recordTimeout();
    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
    breaker.recordTimeout();
    breaker.recordTimeout();
    breaker.recordTimeout();
    expect(breaker.getState()).toBe('open');
  });

  it('caps duplicate work so degradation cannot stampede generation', () => {
    const clock = manualClock();
    const breaker = breakerFixture(clock.now);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.tryAcquireDuplicateSlot()).toBe(true);
    expect(breaker.tryAcquireDuplicateSlot()).toBe(true);
    expect(breaker.tryAcquireDuplicateSlot()).toBe(false);
    expect(breaker.activeDuplicateCount()).toBe(2);
    expect(breaker.admit('embedding').decision).toBe('degrade_fail_open');
    const degraded = breaker.admit('embedding');
    if (degraded.decision !== 'degrade_fail_open') throw new Error('expected degradation');
    expect(degraded.duplicateSlot).toBe(false);
    breaker.releaseDuplicateSlot();
    const readmitted = breaker.admit('embedding');
    if (readmitted.decision !== 'degrade_fail_open') throw new Error('expected degradation');
    expect(readmitted.duplicateSlot).toBe(true);
    breaker.releaseDuplicateSlot();
    breaker.releaseDuplicateSlot();
    expect(breaker.activeDuplicateCount()).toBe(0);
  });

  it('half-opens after the window and closes after enough probes', () => {
    const clock = manualClock();
    const breaker = breakerFixture(clock.now);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');
    clock.advance(999);
    expect(breaker.getState()).toBe('open');
    clock.advance(1);
    expect(breaker.getState()).toBe('half_open');
    expect(breaker.admit('turn_result')).toEqual({ decision: 'allow' });
    breaker.recordSuccess();
    expect(breaker.getState()).toBe('half_open');
    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.admit('turn_result')).toEqual({ decision: 'allow' });
  });

  it('re-opens when a half-open probe fails', () => {
    const clock = manualClock();
    const breaker = breakerFixture(clock.now);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    clock.advance(1_000);
    expect(breaker.getState()).toBe('half_open');
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');
    expect(breaker.admit('turn_result').decision).toBe('reject_fail_closed');
  });

  it('exposes a frozen snapshot and works with the default clock', () => {
    const clock = manualClock();
    const breaker = breakerFixture(clock.now);
    const snapshot = breaker.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.state).toBe('closed');
    const defaultClock = createRedisCircuitBreaker({
      failureThreshold: 1,
      successThreshold: 1,
      openMs: 50,
      maxDuplicateWork: 1,
    });
    expect(defaultClock.admit('turn_result')).toEqual({ decision: 'allow' });
  });
});
