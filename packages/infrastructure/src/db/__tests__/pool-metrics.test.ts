import { describe, expect, it, afterEach } from 'vitest';
import {
  PoolWaitTracker,
  assertBoundedPoolVariants,
  assertPooledNeonEndpoint,
  assertSanePoolMax,
  collectPoolStats,
  poolVariantKey,
  tryAttachPoolLifecycle,
} from '../pool-metrics';

const trackers: PoolWaitTracker[] = [];
afterEach(() => {
  while (trackers.length > 0) trackers.pop()?.destroy();
});

describe('pool-metrics collection', () => {
  it('reads total/idle/busy/waiting from a pg-style pool', () => {
    expect(collectPoolStats({ totalCount: 5, idleCount: 2, waitingCount: 1, options: { max: 5 } })).toEqual({
      total: 5,
      idle: 2,
      busy: 3,
      waiting: 1,
      maxSize: 5,
    });
  });

  it('reports unknown instead of crashing for drivers without counters', () => {
    expect(collectPoolStats({})).toEqual({ total: null, idle: null, busy: null, waiting: null, maxSize: null });
    expect(collectPoolStats(null)).toEqual({ total: null, idle: null, busy: null, waiting: null, maxSize: null });
    expect(collectPoolStats('pool')).toEqual({ total: null, idle: null, busy: null, waiting: null, maxSize: null });
  });

  it('computes a stable variant key per effective runtime config', () => {
    const base = {
      databaseUrl: 'postgres://user:secret@host.example:5432/db?sslmode=require',
      poolMax: 5,
      isNeon: false,
      isPooledNeon: false,
      sslMode: 'require',
    };
    expect(poolVariantKey(base)).toBe(poolVariantKey({ ...base, databaseUrl: 'postgres://other:xxx@host.example:5432/db?sslmode=require' }));
    expect(poolVariantKey(base)).not.toBe(poolVariantKey({ ...base, poolMax: 10 }));
  });

  it('bounds the number of live pool variants', () => {
    expect(() => assertBoundedPoolVariants(['a', 'a', 'b'])).not.toThrow();
    expect(() => assertBoundedPoolVariants(['a', 'b', 'c', 'd', 'e'])).toThrow(/exceed the cap/);
  });

  it('rejects poolMax=1 and oversized pools', () => {
    expect(() => assertSanePoolMax(1)).toThrow(/>= 2/);
    expect(() => assertSanePoolMax(21)).toThrow(/hard maximum/);
    expect(() => assertSanePoolMax(5)).not.toThrow();
  });

  it('asserts the pooled Neon endpoint in production only', () => {
    expect(assertPooledNeonEndpoint({ isProduction: false, isNeon: true, isPooledNeon: false }).kind)
      .toBe('not_applicable');
    expect(assertPooledNeonEndpoint({ isProduction: true, isNeon: false, isPooledNeon: false }).kind)
      .toBe('not_applicable');
    expect(assertPooledNeonEndpoint({ isProduction: true, isNeon: true, isPooledNeon: true }).kind).toBe('ok');
    const violation = assertPooledNeonEndpoint({
      isProduction: true,
      isNeon: true,
      isPooledNeon: false,
      hostname: 'ep-foo.us-east-2.aws.neon.tech',
    });
    expect(violation.kind).toBe('violation');
  });

  it('attaches pool lifecycle only when the runtime exposes a hook, never crashing', () => {
    let shutdowns = 0;
    const attached = tryAttachPoolLifecycle(
      { end: async () => {} },
      { onShutdown: () => { shutdowns += 1; } },
    );
    expect(attached.supported).toBe(true);
    expect(shutdowns).toBe(1);
    const unsupported = tryAttachPoolLifecycle({ end: async () => {} });
    expect(unsupported.supported).toBe(false);
    if (unsupported.supported) throw new Error('expected unsupported');
    expect(unsupported.reason).toContain('No pool lifecycle hook');
    expect(tryAttachPoolLifecycle({}).supported).toBe(false);
    expect(tryAttachPoolLifecycle(null as unknown as { end?: unknown }, { onShutdown: () => {} }).supported).toBe(false);
  });
});

describe('pool-wait metrics', () => {
  it('records waits with p50/p95 and timeout counts', () => {
    const tracker = new PoolWaitTracker();
    trackers.push(tracker);
    for (let i = 1; i <= 100; i += 1) tracker.recordWait(i);
    tracker.recordWait(5_000, { timedOut: true });
    const snapshot = tracker.snapshot();
    expect(snapshot.samples).toBe(101);
    expect(snapshot.timeouts).toBe(1);
    expect(snapshot.maxWaitMs).toBe(5_000);
    expect(snapshot.p50WaitMs).toBeLessThanOrEqual(60);
    expect(snapshot.p95WaitMs).toBeLessThanOrEqual(100);
  });

  it('raises an alert after five consecutive growing waiter windows', () => {
    const tracker = new PoolWaitTracker();
    trackers.push(tracker);
    for (const waiting of [1, 2, 3, 4, 5, 6]) tracker.observeWaiting(waiting);
    const snapshot = tracker.snapshot();
    expect(snapshot.waiterGrowthStreak).toBe(5);
    expect(snapshot.waiterGrowthAlert).toBe(true);
    tracker.observeWaiting(0);
    expect(tracker.snapshot().waiterGrowthStreak).toBe(0);
  });

  it('does not alert on flat or falling waiter counts', () => {
    const tracker = new PoolWaitTracker();
    trackers.push(tracker);
    for (const waiting of [3, 3, 2, 4, 1, 0]) tracker.observeWaiting(waiting);
    expect(tracker.snapshot().waiterGrowthAlert).toBe(false);
  });
});
