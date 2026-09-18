import { z } from 'zod';
import { logger } from '@app/domain';

/**
 * Pool observability and lifecycle helpers (WP-8, F-36).
 *
 * - `collectPoolStats` reads total/idle/busy/waiting from a pg/Neon pool
 *   without ever throwing: drivers that do not expose a counter report it
 *   as unknown instead of crashing the request path.
 * - `PoolWaitTracker` records pool-checkout wait times with p50/p95 and
 *   detects monotonically growing waiter queues (five consecutive growing
 *   measurement windows), which is the early signal for pool saturation.
 * - `poolVariantKey` / `assertBoundedPoolVariants` keep the number of
 *   distinct live pool configurations small: one stable pool per effective
 *   runtime config (see `packages/infrastructure/src/db/pool.ts`).
 * - `assertSanePoolMax` rejects poolMax=1 (a single connection serializes and
 *   starves cancellation paths) and poolMax above the configured hard maximum.
 * - `assertPooledNeonEndpoint` requires Neon's pooled endpoint in production
 *   and reports not-applicable elsewhere.
 * - `tryAttachPoolLifecycle` registers pool shutdown with the runtime when
 *   the runtime exposes an on-shutdown hook, and reports unsupported without
 *   crashing when it does not. No implicit global Vercel hook is assumed.
 */

export const PoolStatsSchema = z.object({
  total: z.number().int().min(0).nullable(),
  idle: z.number().int().min(0).nullable(),
  busy: z.number().int().min(0).nullable(),
  waiting: z.number().int().min(0).nullable(),
  maxSize: z.number().int().min(0).nullable(),
});
export type PoolStats = z.infer<typeof PoolStatsSchema>;

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function readPoolField(pool: Record<string, unknown>, names: readonly string[]): number | null {
  for (const name of names) {
    const value = readCount(pool[name]);
    if (value !== null) return value;
  }
  return null;
}

export function collectPoolStats(pool: unknown): PoolStats {
  if (typeof pool !== 'object' || pool === null) {
    return { total: null, idle: null, busy: null, waiting: null, maxSize: null };
  }
  const record = pool as Record<string, unknown>;
  const total = readPoolField(record, ['totalCount', 'total', 'size']);
  const idle = readPoolField(record, ['idleCount', 'idle', 'available']);
  const waiting = readPoolField(record, ['waitingCount', 'waiting', 'pending', 'queueSize']);
  const options = typeof record.options === 'object' && record.options !== null
    ? (record.options as Record<string, unknown>)
    : null;
  const maxSize = readPoolField(record, ['max', 'maxSize', 'poolMax'])
    ?? (options !== null ? readPoolField(options, ['max', 'maxSize']) : null);
  const busy = total !== null && idle !== null ? Math.max(0, total - idle) : null;
  return { total, idle, busy, waiting, maxSize };
}

export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (!(p >= 0 && p <= 1)) throw new Error(`percentile: p must be in [0,1], received ${p}`);
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  const value = sorted[index];
  if (value === undefined) return null;
  return value;
}

export interface PoolWaitSnapshot {
  readonly samples: number;
  readonly timeouts: number;
  readonly maxWaitMs: number | null;
  readonly p50WaitMs: number | null;
  readonly p95WaitMs: number | null;
  readonly waiterGrowthStreak: number;
  readonly waiterGrowthAlert: boolean;
  readonly lastWaiting: number | null;
}

/**
 * Records checkout waits and waiter-queue observations. `observeWaiting`
 * should be called once per measurement window with the current waiting
 * count; five consecutive windows of strictly increasing waiting counts
 * raise `waiterGrowthAlert` (pool saturation early warning per §12.6).
 */
export class PoolWaitTracker {
  private waits: number[] = [];
  private timeouts = 0;
  private maxWaitMs: number | null = null;
  private lastWaiting: number | null = null;
  private growthStreak = 0;
  private alert = false;
  private destroyed = false;

  recordWait(waitMs: number, opts: { readonly timedOut?: boolean | undefined } = {}): void {
    this.throwIfDestroyed();
    if (!Number.isFinite(waitMs) || waitMs < 0) {
      throw new Error(`pool-wait-tracker: waitMs must be a finite number >= 0, received ${waitMs}`);
    }
    this.waits.push(waitMs);
    if (this.maxWaitMs === null || waitMs > this.maxWaitMs) this.maxWaitMs = waitMs;
    if (opts.timedOut === true) this.timeouts += 1;
    if (this.waits.length > 10_000) this.waits.splice(0, this.waits.length - 10_000);
  }

  observeWaiting(waiting: number): void {
    this.throwIfDestroyed();
    if (!Number.isInteger(waiting) || waiting < 0) {
      throw new Error(`pool-wait-tracker: waiting must be an integer >= 0, received ${waiting}`);
    }
    if (this.lastWaiting !== null && waiting > this.lastWaiting) {
      this.growthStreak += 1;
    } else {
      this.growthStreak = 0;
    }
    this.lastWaiting = waiting;
    if (this.growthStreak >= 5) {
      if (!this.alert) logger.warn('db.pool.waiter_growth_alert', { streak: this.growthStreak, waiting });
      this.alert = true;
    }
  }

  snapshot(): PoolWaitSnapshot {
    this.throwIfDestroyed();
    const sorted = [...this.waits].sort((a, b) => a - b);
    return Object.freeze({
      samples: this.waits.length,
      timeouts: this.timeouts,
      maxWaitMs: this.maxWaitMs,
      p50WaitMs: percentile(sorted, 0.5),
      p95WaitMs: percentile(sorted, 0.95),
      waiterGrowthStreak: this.growthStreak,
      waiterGrowthAlert: this.alert,
      lastWaiting: this.lastWaiting,
    });
  }

  destroy(): void {
    this.waits = [];
    this.destroyed = true;
  }

  private throwIfDestroyed(): void {
    if (this.destroyed) throw new Error('pool-wait-tracker: instance destroyed');
  }
}

export const PoolVariantConfigSchema = z.object({
  databaseUrl: z.string().min(1).optional(),
  poolMax: z.number().int().min(1).max(100),
  isNeon: z.boolean(),
  isPooledNeon: z.boolean(),
  sslMode: z.string().min(1).optional(),
});
export type PoolVariantConfig = z.infer<typeof PoolVariantConfigSchema>;

/** Mirror of the pool cache key in `db/pool.ts` (URL redacted to host only). */
export function poolVariantKey(config: PoolVariantConfig): string {
  const parsed = PoolVariantConfigSchema.parse(config);
  let host = 'missing-url';
  if (parsed.databaseUrl !== undefined) {
    try {
      host = new URL(parsed.databaseUrl).host.toLowerCase();
    } catch {
      host = 'invalid-url';
    }
  }
  return JSON.stringify({
    host,
    poolMax: parsed.poolMax,
    driver: parsed.isNeon ? 'neon' : 'pg',
    isPooledNeon: parsed.isPooledNeon,
    sslMode: parsed.sslMode ?? null,
  });
}

export const MAX_POOL_VARIANTS = 4;
export const MAX_DATABASE_POOL_SIZE_HARD = 20;

export function assertBoundedPoolVariants(keys: readonly string[], maxVariants: number = MAX_POOL_VARIANTS): void {
  if (!Number.isInteger(maxVariants) || maxVariants < 1) {
    throw new Error(`assertBoundedPoolVariants: maxVariants must be an integer >= 1, received ${maxVariants}`);
  }
  const distinct = new Set(keys).size;
  if (distinct > maxVariants) {
    throw new Error(
      `assertBoundedPoolVariants: ${distinct} distinct pool configurations exceed the cap of ${maxVariants}; ` +
        'keep one stable pool per effective runtime config.',
    );
  }
}

/** poolMax=1 serializes all queries and starves cancellation; larger pools do not create DB capacity. */
export function assertSanePoolMax(poolMax: number): void {
  if (!Number.isInteger(poolMax) || poolMax < 2) {
    throw new Error(`assertSanePoolMax: poolMax must be an integer >= 2, received ${poolMax}`);
  }
  if (poolMax > MAX_DATABASE_POOL_SIZE_HARD) {
    throw new Error(
      `assertSanePoolMax: poolMax ${poolMax} exceeds the hard maximum ${MAX_DATABASE_POOL_SIZE_HARD}; ` +
        'a larger pool does not create database capacity.',
    );
  }
}

export type PooledEndpointCheck =
  | { readonly kind: 'ok' }
  | { readonly kind: 'not_applicable'; readonly reason: string }
  | { readonly kind: 'violation'; readonly reason: string };

/** Production Neon traffic must use the pooled endpoint; elsewhere the check does not apply. */
export function assertPooledNeonEndpoint(input: {
  readonly isProduction: boolean;
  readonly isNeon: boolean;
  readonly isPooledNeon: boolean;
  readonly hostname?: string | undefined;
}): PooledEndpointCheck {
  if (!input.isProduction) return { kind: 'not_applicable', reason: 'non-production runtime' };
  if (!input.isNeon) return { kind: 'not_applicable', reason: 'non-Neon database' };
  if (input.isPooledNeon) return { kind: 'ok' };
  return {
    kind: 'violation',
    reason: `Production Neon URL ${input.hostname ?? '(unknown host)'} is not using a pooled endpoint.`,
  };
}

export interface PoolLifecycleHook {
  onShutdown(callback: () => Promise<void> | void): void;
}

export type PoolLifecycleAttachment =
  | { readonly supported: true; readonly detail: string }
  | { readonly supported: false; readonly reason: string };

/**
 * Attach pool shutdown to a runtime-provided hook. Guarded by design: when
 * the runtime exposes no lifecycle hook, this reports unsupported and never
 * throws, so request paths cannot crash on runtimes without the helper.
 */
export function tryAttachPoolLifecycle(
  pool: { readonly end?: unknown },
  hook?: PoolLifecycleHook | undefined,
): PoolLifecycleAttachment {
  if (hook === undefined || hook === null) {
    return {
      supported: false,
      reason: 'No pool lifecycle hook is exposed by this runtime; pool shutdown stays with process exit. This is expected outside Fluid/hook-providing runtimes.',
    };
  }
  if (typeof hook.onShutdown !== 'function') {
    return { supported: false, reason: 'Provided lifecycle hook has no onShutdown function.' };
  }
  if (typeof pool !== 'object' || pool === null || typeof pool.end !== 'function') {
    return { supported: false, reason: 'Pool has no end() to register with the lifecycle hook.' };
  }
  try {
    const end = pool.end as () => Promise<void> | void;
    hook.onShutdown(() => {
      try {
        const result = end();
        if (result !== undefined && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((error: unknown) => {
            logger.warn('db.pool.lifecycle_end_failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      } catch (error) {
        logger.warn('db.pool.lifecycle_end_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return { supported: true, detail: 'Pool end() registered with the runtime shutdown hook.' };
  } catch (error) {
    return {
      supported: false,
      reason: `Lifecycle registration threw and was contained: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
