import { z } from 'zod';
import { logger } from '@app/domain';

/**
 * Query-class statement timeouts and detached-query telemetry (WP-8, F-38).
 *
 * One 30-second statement timeout for every query class lets a cancelled
 * interactive caller leave database work running until the server timeout.
 * This module assigns each query class its own ceiling — interactive classes
 * are strictly shorter than the shared default — and tracks detached
 * (orphaned) work after caller cancellation until the database work ends or
 * its timeout fires.
 *
 * Suggested initial caps are measurement starting points, not release
 * promises; tune them from p99 service-time data, never upward from load
 * failures. No migration is required: this module changes only per-query
 * `statement_timeout` settings and in-process telemetry.
 */

export const QueryClassSchema = z.enum([
  'retrieval_vector',
  'retrieval_lexical',
  'history',
  'persistence',
  'telemetry',
  'background',
]);
export type QueryClass = z.infer<typeof QueryClassSchema>;

/** Shared server-side backstop inherited from pool.ts. Class ceilings must be shorter. */
export const SHARED_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Initial per-class ceilings for measurement. Interactive classes
 * (retrieval/history/telemetry) are deliberately short; persistence keeps a
 * moderate budget for multi-row writes; background gets the longest budget
 * but still below the shared backstop.
 */
export const DEFAULT_QUERY_CLASS_TIMEOUTS_MS: Readonly<Record<QueryClass, number>> = Object.freeze({
  retrieval_vector: 4_000,
  retrieval_lexical: 4_000,
  history: 2_000,
  persistence: 5_000,
  telemetry: 2_000,
  background: 10_000,
});

const QueryTimeoutOverridesSchema = z.object({
  retrieval_vector: z.number().int().positive().max(60_000),
  retrieval_lexical: z.number().int().positive().max(60_000),
  history: z.number().int().positive().max(60_000),
  persistence: z.number().int().positive().max(60_000),
  telemetry: z.number().int().positive().max(60_000),
  background: z.number().int().positive().max(60_000),
}).partial();
export type QueryTimeoutOverrides = z.infer<typeof QueryTimeoutOverridesSchema>;

export function resolveQueryTimeoutMs(
  queryClass: QueryClass,
  overrides?: QueryTimeoutOverrides | undefined,
): number {
  QueryClassSchema.parse(queryClass);
  const parsedOverrides = overrides === undefined ? {} : QueryTimeoutOverridesSchema.parse(overrides);
  const configured = parsedOverrides[queryClass] ?? DEFAULT_QUERY_CLASS_TIMEOUTS_MS[queryClass];
  if (configured > SHARED_STATEMENT_TIMEOUT_MS) {
    logger.warn('db.query_timeout.clamped_to_shared_backstop', {
      queryClass,
      configured,
      backstop: SHARED_STATEMENT_TIMEOUT_MS,
    });
    return SHARED_STATEMENT_TIMEOUT_MS;
  }
  return configured;
}

/**
 * Render a safely parameterized `SET LOCAL statement_timeout` statement.
 * The value is a validated integer, so interpolation cannot inject SQL.
 */
export function statementTimeoutStatement(timeoutMs: number): string {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) {
    throw new Error(`statementTimeoutStatement: timeoutMs must be a positive integer, received ${timeoutMs}`);
  }
  return `SET LOCAL statement_timeout = '${timeoutMs}ms'`;
}

/** Reject a child timeout that does not fit inside the remaining parent budget. */
export function assertFitsParentBudget(childMs: number, parentRemainingMs: number, label: string): void {
  if (!Number.isFinite(childMs) || !Number.isFinite(parentRemainingMs)) {
    throw new Error(`assertFitsParentBudget(${label}): budgets must be finite numbers`);
  }
  if (childMs > parentRemainingMs) {
    throw new Error(
      `assertFitsParentBudget(${label}): child timeout ${childMs}ms exceeds remaining parent budget ${parentRemainingMs}ms`,
    );
  }
}

export const DetachedQueryEndReasonSchema = z.enum(['completed', 'cancelled_by_db', 'timeout_reached']);
export type DetachedQueryEndReason = z.infer<typeof DetachedQueryEndReasonSchema>;

export interface DetachedQueryStats {
  readonly tracked: number;
  readonly completed: number;
  readonly cancelledByDb: number;
  readonly timeoutReached: number;
  readonly stillDetached: number;
  readonly maxDetachedMs: number | null;
}

/**
 * Tracks orphaned database work after the caller was cancelled: the caller
 * is gone, but the backend may still run until statement_timeout. Each
 * tracked query is measured until it ends (completed/cancelled_by_db) or
 * until its timeout elapses (timeout_reached). Deterministic via injected clock.
 */
export class DetachedQueryTracker {
  private readonly now: () => number;
  private readonly pending = new Map<string, { readonly queryClass: QueryClass; readonly cancelledAtMs: number; readonly timeoutMs: number }>();
  private tracked = 0;
  private completed = 0;
  private cancelledByDb = 0;
  private timeoutReached = 0;
  private maxDetachedMs = 0;
  private destroyed = false;

  constructor(options: { readonly now?: (() => number) | undefined } = {}) {
    this.now = options.now ?? Date.now;
  }

  track(input: { readonly queryId: string; readonly queryClass: QueryClass; readonly timeoutMs?: number | undefined }): void {
    this.throwIfDestroyed();
    const parsed = z.object({
      queryId: z.string().min(1).max(200),
      queryClass: QueryClassSchema,
      timeoutMs: z.number().int().positive().max(3_600_000).optional(),
    }).parse(input);
    const timeoutMs = parsed.timeoutMs ?? resolveQueryTimeoutMs(parsed.queryClass);
    this.pending.set(parsed.queryId, {
      queryClass: parsed.queryClass,
      cancelledAtMs: this.now(),
      timeoutMs,
    });
    this.tracked += 1;
    logger.warn('db.detached.tracked', { queryId: parsed.queryId, queryClass: parsed.queryClass });
  }

  end(queryId: string, reason: DetachedQueryEndReason): boolean {
    this.throwIfDestroyed();
    const entry = this.pending.get(queryId);
    if (entry === undefined) return false;
    this.pending.delete(queryId);
    const detachedMs = this.now() - entry.cancelledAtMs;
    this.maxDetachedMs = Math.max(this.maxDetachedMs, detachedMs);
    switch (reason) {
      case 'completed':
        this.completed += 1;
        break;
      case 'cancelled_by_db':
        this.cancelledByDb += 1;
        break;
      case 'timeout_reached':
        this.timeoutReached += 1;
        break;
    }
    logger.info('db.detached.ended', { queryId, reason, detachedMs });
    return true;
  }

  /** Mark entries whose timeout has elapsed without a database ending. Returns their ids. */
  sweepTimeouts(nowMs?: number): readonly string[] {
    this.throwIfDestroyed();
    const now = nowMs ?? this.now();
    const timedOut: string[] = [];
    for (const [queryId, entry] of this.pending) {
      if (now - entry.cancelledAtMs >= entry.timeoutMs) {
        timedOut.push(queryId);
      }
    }
    for (const queryId of timedOut) {
      this.pending.delete(queryId);
      this.timeoutReached += 1;
      logger.warn('db.detached.timeout_reached', { queryId });
    }
    return Object.freeze(timedOut);
  }

  stats(): DetachedQueryStats {
    return Object.freeze({
      tracked: this.tracked,
      completed: this.completed,
      cancelledByDb: this.cancelledByDb,
      timeoutReached: this.timeoutReached,
      stillDetached: this.pending.size,
      maxDetachedMs: this.tracked === 0 ? null : this.maxDetachedMs,
    });
  }

  destroy(): void {
    this.pending.clear();
    this.destroyed = true;
  }

  private throwIfDestroyed(): void {
    if (this.destroyed) throw new Error('detached-query-tracker: instance destroyed');
  }
}
