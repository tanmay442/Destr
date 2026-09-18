import { z } from 'zod';
import { logger } from '@app/domain';
import { CacheLayerIdSchema, type CacheLayerId } from './cache-matrix';

/**
 * Redis degradation circuit breaker (WP-8 Task B, F-43).
 *
 * Separates correctness-critical idempotency (fail closed) from optional
 * caches (fail open with capped duplicate work):
 *
 * - `turn_result` idempotency is correctness-critical. When coordination is
 *   unavailable the guarded write is rejected (`reject_fail_closed`), never
 *   executed unguarded. Idempotency never silently fail-open.
 * - `verified_answer`, `embedding`, and `retrieval_candidate` lookups degrade
 *   to `degrade_fail_open`: the caller serves a miss and may regenerate, but
 *   only with a duplicate-work slot. The slot cap bounds the generation
 *   stampede during Redis degradation instead of choosing between an
 *   unlimited stampede and total outage.
 * - `provider_prompt` reuse is adapter-owned and never skipped; breaker state
 *   does not change model-call behavior for that layer.
 *
 * State is clock-driven with an injectable `now()` (default `Date.now`) so
 * tests are deterministic with no timers to clean up: `closed` admits all;
 * `open` rejects/degrades until `openMs` elapses; `half_open` admits probes
 * until `successThreshold` consecutive successes close the breaker or any
 * failure re-opens it.
 */

export const RedisCircuitBreakerConfigSchema = z.object({
  failureThreshold: z.number().int().min(1).max(100),
  successThreshold: z.number().int().min(1).max(100),
  openMs: z.number().int().min(1).max(3_600_000),
  maxDuplicateWork: z.number().int().min(1).max(1_000),
});
export type RedisCircuitBreakerConfig = z.infer<typeof RedisCircuitBreakerConfigSchema>;

export const BreakerStateSchema = z.enum(['closed', 'open', 'half_open']);
export type BreakerState = z.infer<typeof BreakerStateSchema>;

export type CacheLayerClass = 'correctness_critical' | 'optional';

/** Idempotency coordination is correctness-critical; answer/candidate caches are optional. */
export function classifyLayerForBreaker(layer: CacheLayerId): CacheLayerClass {
  switch (layer) {
    case 'turn_result':
      return 'correctness_critical';
    case 'verified_answer':
    case 'embedding':
    case 'retrieval_candidate':
      return 'optional';
    case 'provider_prompt':
      return 'optional';
    default: {
      const exhaustive: never = layer;
      throw new Error(`redis-circuit-breaker: unhandled layer ${JSON.stringify(exhaustive)}`);
    }
  }
}

export type BreakerAdmission =
  | { readonly decision: 'allow' }
  | { readonly decision: 'reject_fail_closed'; readonly reason: 'idempotency_redis_unavailable' }
  | {
      readonly decision: 'degrade_fail_open';
      readonly reason: 'optional_cache_breaker_open';
      readonly duplicateSlot: boolean;
    };

export interface BreakerSnapshot {
  readonly state: BreakerState;
  readonly consecutiveFailures: number;
  readonly halfOpenSuccesses: number;
  readonly activeDuplicates: number;
  readonly openedAt: number | null;
}

export interface RedisCircuitBreaker {
  getState(now?: number): BreakerState;
  admit(layer: CacheLayerId, now?: number): BreakerAdmission;
  recordSuccess(): void;
  recordFailure(): void;
  recordTimeout(): void;
  tryAcquireDuplicateSlot(): boolean;
  releaseDuplicateSlot(): void;
  activeDuplicateCount(): number;
  snapshot(now?: number): BreakerSnapshot;
}

export function createRedisCircuitBreaker(
  config: unknown,
  clock: () => number = Date.now,
): RedisCircuitBreaker {
  const parsed = RedisCircuitBreakerConfigSchema.parse(config);
  let state: BreakerState = 'closed';
  let consecutiveFailures = 0;
  let halfOpenSuccesses = 0;
  let openedAt: number | null = null;
  let activeDuplicates = 0;

  function transition(next: BreakerState, reason: string): void {
    if (next === state) return;
    const from = state;
    state = next;
    if (next === 'open') {
      openedAt = clock();
      halfOpenSuccesses = 0;
    }
    if (next === 'closed') {
      consecutiveFailures = 0;
      halfOpenSuccesses = 0;
      openedAt = null;
    }
    if (next === 'half_open') halfOpenSuccesses = 0;
    logger.warn('redis.breaker_transition', { from, to: next, reason });
  }

  function refresh(now: number): void {
    if (state === 'open' && openedAt !== null && now - openedAt >= parsed.openMs) {
      transition('half_open', 'open_window_elapsed');
    }
  }

  function currentState(now?: number): BreakerState {
    refresh(now ?? clock());
    return state;
  }

  return {
    getState: (now?: number) => currentState(now),

    admit: (layer: CacheLayerId, now?: number): BreakerAdmission => {
      const validated = CacheLayerIdSchema.parse(layer);
      const effective = currentState(now);
      if (effective === 'closed' || effective === 'half_open') return Object.freeze({ decision: 'allow' });
      if (classifyLayerForBreaker(validated) === 'correctness_critical') {
        return Object.freeze({ decision: 'reject_fail_closed', reason: 'idempotency_redis_unavailable' });
      }
      const slot = activeDuplicates < parsed.maxDuplicateWork;
      return Object.freeze({
        decision: 'degrade_fail_open',
        reason: 'optional_cache_breaker_open',
        duplicateSlot: slot,
      });
    },

    recordSuccess: () => {
      if (state === 'half_open') {
        halfOpenSuccesses += 1;
        if (halfOpenSuccesses >= parsed.successThreshold) transition('closed', 'half_open_probes_succeeded');
        return;
      }
      consecutiveFailures = 0;
      if (state === 'open') refresh(clock());
    },

    recordFailure: () => {
      if (state === 'half_open') {
        transition('open', 'half_open_probe_failed');
        return;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= parsed.failureThreshold) transition('open', 'failure_threshold_reached');
    },

    recordTimeout: () => {
      if (state === 'half_open') {
        transition('open', 'half_open_probe_timed_out');
        return;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= parsed.failureThreshold) transition('open', 'timeout_threshold_reached');
    },

    tryAcquireDuplicateSlot: () => {
      if (activeDuplicates >= parsed.maxDuplicateWork) return false;
      activeDuplicates += 1;
      return true;
    },

    releaseDuplicateSlot: () => {
      activeDuplicates = Math.max(0, activeDuplicates - 1);
    },

    activeDuplicateCount: () => activeDuplicates,

    snapshot: (now?: number) =>
      Object.freeze({
        state: currentState(now),
        consecutiveFailures,
        halfOpenSuccesses,
        activeDuplicates,
        openedAt,
      }),
  };
}
