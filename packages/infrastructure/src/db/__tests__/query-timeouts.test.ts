import { describe, expect, it, afterEach } from 'vitest';
import {
  DEFAULT_QUERY_CLASS_TIMEOUTS_MS,
  DetachedQueryTracker,
  SHARED_STATEMENT_TIMEOUT_MS,
  assertFitsParentBudget,
  resolveQueryTimeoutMs,
  statementTimeoutStatement,
} from '../query-timeouts';

const trackers: DetachedQueryTracker[] = [];
afterEach(() => {
  while (trackers.length > 0) trackers.pop()?.destroy();
});

describe('query-timeouts class ceilings', () => {
  it('gives every interactive class a ceiling shorter than the shared backstop', () => {
    for (const queryClass of ['retrieval_vector', 'retrieval_lexical', 'history', 'telemetry'] as const) {
      expect(DEFAULT_QUERY_CLASS_TIMEOUTS_MS[queryClass]).toBeLessThan(SHARED_STATEMENT_TIMEOUT_MS);
      expect(resolveQueryTimeoutMs(queryClass)).toBe(DEFAULT_QUERY_CLASS_TIMEOUTS_MS[queryClass]);
    }
    expect(resolveQueryTimeoutMs('persistence')).toBeLessThanOrEqual(SHARED_STATEMENT_TIMEOUT_MS);
    expect(resolveQueryTimeoutMs('background')).toBeLessThanOrEqual(SHARED_STATEMENT_TIMEOUT_MS);
  });

  it('clamps overrides above the shared backstop instead of extending them', () => {
    expect(resolveQueryTimeoutMs('history', { history: 2_000 })).toBe(2_000);
    expect(resolveQueryTimeoutMs('background', { background: 60_000 })).toBe(SHARED_STATEMENT_TIMEOUT_MS);
  });

  it('renders a safe SET LOCAL statement and rejects bad values', () => {
    expect(statementTimeoutStatement(2_000)).toBe("SET LOCAL statement_timeout = '2000ms'");
    expect(() => statementTimeoutStatement(0)).toThrow(/positive integer/);
    expect(() => statementTimeoutStatement(1.5)).toThrow(/positive integer/);
    expect(() => statementTimeoutStatement(Number.NaN)).toThrow(/positive integer/);
  });

  it('rejects child timeouts that exceed the remaining parent budget', () => {
    expect(() => assertFitsParentBudget(2_000, 10_000, 'history')).not.toThrow();
    expect(() => assertFitsParentBudget(11_000, 10_000, 'retrieval')).toThrow(/exceeds remaining parent budget/);
  });
});

describe('detached-query telemetry', () => {
  it('tracks a cancelled caller until the database work ends', () => {
    const now = { current: 6_000_000 };
    const tracker = new DetachedQueryTracker({ now: () => now.current });
    trackers.push(tracker);
    tracker.track({ queryId: 'q-1', queryClass: 'retrieval_vector' });
    expect(tracker.stats()).toMatchObject({ tracked: 1, stillDetached: 1 });
    now.current += 1_500;
    expect(tracker.end('q-1', 'cancelled_by_db')).toBe(true);
    expect(tracker.stats()).toMatchObject({
      tracked: 1,
      cancelledByDb: 1,
      stillDetached: 0,
      maxDetachedMs: 1_500,
    });
    expect(tracker.end('q-1', 'completed')).toBe(false);
  });

  it('marks detached work that outlives its timeout', () => {
    const now = { current: 7_000_000 };
    const tracker = new DetachedQueryTracker({ now: () => now.current });
    trackers.push(tracker);
    tracker.track({ queryId: 'q-slow', queryClass: 'retrieval_lexical', timeoutMs: 4_000 });
    now.current += 5_000;
    expect(tracker.sweepTimeouts()).toEqual(['q-slow']);
    expect(tracker.stats()).toMatchObject({ timeoutReached: 1, stillDetached: 0 });
  });

  it('records completions that finish after cancellation', () => {
    const tracker = new DetachedQueryTracker({ now: () => 0 });
    trackers.push(tracker);
    tracker.track({ queryId: 'q-done', queryClass: 'history' });
    expect(tracker.end('q-done', 'completed')).toBe(true);
    expect(tracker.stats().completed).toBe(1);
  });
});
