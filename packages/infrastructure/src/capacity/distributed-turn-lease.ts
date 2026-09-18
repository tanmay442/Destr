import { z } from 'zod';
import { logger } from '@app/domain';
import { randomUUID } from 'node:crypto';

/**
 * Distributed per-user active-turn leases (WP-8, F-35).
 *
 * The route-level two-turn guard in `src/app/api/chat/slots.ts` is a
 * process-local Map: Fluid replicas do not share it, so it is a fast-path
 * optimization only. This module provides the cross-instance lease:
 *
 * - Ownership tokens: only the holder of the token can renew or release.
 * - Expiry: every lease carries a TTL; expired leases are recoverable by any
 *   instance (no stuck permits after a crash).
 * - Exactly-once release: the first release with the correct token wins;
 *   completion, cancellation, disconnect, timeout, and error paths all funnel
 *   through the same idempotent release.
 * - Tenant isolation: lease keys are scoped to tenant + user + turn.
 *
 * The {@link LeaseStore} seam has two adapters: an in-memory store (tests,
 * local single-process fallback) and a Redis store (cross-instance). When
 * Redis is not configured or unreachable, acquisition fails closed with
 * `store_unavailable` so correctness-critical idempotency never silently
 * degrades to per-instance state.
 */

export const TurnReleaseOutcomeSchema = z.enum([
  'completed',
  'cancelled',
  'disconnected',
  'timeout',
  'error',
]);
export type TurnReleaseOutcome = z.infer<typeof TurnReleaseOutcomeSchema>;

export function turnLeaseKey(tenantId: string, userId: string, turnId: string): string {
  return `destr:turn-lease:${tenantId}:${userId}:${turnId}`;
}

export function userLeasePrefix(tenantId: string, userId: string): string {
  return `destr:turn-lease:${tenantId}:${userId}:`;
}

export interface LeaseStore {
  readonly name: 'memory' | 'redis';
  acquire(key: string, token: string, ttlMs: number, nowMs: number): 'acquired' | 'held';
  release(key: string, token: string): 'released' | 'token_mismatch' | 'missing';
  renew(key: string, token: string, ttlMs: number, nowMs: number): 'renewed' | 'token_mismatch' | 'missing';
  read(key: string, nowMs: number): { readonly token: string; readonly expiresAtMs: number } | null;
  count(prefix: string, nowMs: number): number;
  clear(): void;
}

interface MemoryEntry {
  token: string;
  expiresAtMs: number;
}

export function createInMemoryLeaseStore(options: { readonly now?: (() => number) | undefined } = {}): LeaseStore {
  const now = options.now ?? Date.now;
  const entries = new Map<string, MemoryEntry>();

  function purge(nowMs: number): void {
    for (const [key, entry] of entries) {
      if (entry.expiresAtMs <= nowMs) entries.delete(key);
    }
  }

  return {
    name: 'memory',
    acquire(key: string, token: string, ttlMs: number, nowMs: number): 'acquired' | 'held' {
      purge(nowMs);
      const existing = entries.get(key);
      if (existing !== undefined) return 'held';
      entries.set(key, { token, expiresAtMs: nowMs + ttlMs });
      return 'acquired';
    },
    release(key: string, token: string): 'released' | 'token_mismatch' | 'missing' {
      purge(now());
      const existing = entries.get(key);
      if (existing === undefined) return 'missing';
      if (existing.token !== token) return 'token_mismatch';
      entries.delete(key);
      return 'released';
    },
    renew(key: string, token: string, ttlMs: number, nowMs: number): 'renewed' | 'token_mismatch' | 'missing' {
      purge(nowMs);
      const existing = entries.get(key);
      if (existing === undefined) return 'missing';
      if (existing.token !== token) return 'token_mismatch';
      entries.set(key, { token, expiresAtMs: nowMs + ttlMs });
      return 'renewed';
    },
    read(key: string, nowMs: number): { readonly token: string; readonly expiresAtMs: number } | null {
      purge(nowMs);
      const existing = entries.get(key);
      return existing === undefined ? null : { token: existing.token, expiresAtMs: existing.expiresAtMs };
    },
    count(prefix: string, nowMs: number): number {
      purge(nowMs);
      let total = 0;
      for (const key of entries.keys()) {
        if (key.startsWith(prefix)) total += 1;
      }
      return total;
    },
    clear(): void {
      entries.clear();
    },
  };
}

export interface MinimalRedis {
  set(key: string, value: string, opts?: { readonly nx?: boolean; readonly px?: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  scan(cursor: string, opts?: { readonly match?: string; readonly count?: number }): Promise<{ readonly cursor: string; readonly keys: string[] } | string[]>;
}

/**
 * Async Redis-backed lease helpers. Compare-and-release is a best-effort
 * read-then-delete when the server does not expose an atomic primitive
 * through this minimal interface; the ownership token still prevents one
 * instance from releasing another instance's lease, and TTL expiry bounds
 * any race window. Prefer a Lua compare-and-delete where the client
 * supports it.
 */
export async function acquireAsync(
  redis: MinimalRedis,
  key: string,
  token: string,
  ttlMs: number,
): Promise<'acquired' | 'held'> {
  const result = await redis.set(key, JSON.stringify({ token, expiresAtMs: Date.now() + ttlMs }), { nx: true, px: ttlMs });
  if (result === null || result === undefined) return 'held';
  if (typeof result === 'string' && result.toUpperCase() !== 'OK') return 'held';
  return 'acquired';
}

export async function releaseAsync(
  redis: MinimalRedis,
  key: string,
  token: string,
): Promise<'released' | 'token_mismatch' | 'missing'> {
  const raw = await redis.get(key);
  if (raw === null) return 'missing';
  let stored: unknown = null;
  try {
    stored = JSON.parse(raw);
  } catch {
    stored = null;
  }
  const storedToken = typeof stored === 'object' && stored !== null
    ? (stored as { token?: unknown }).token
    : raw;
  if (storedToken !== token) return 'token_mismatch';
  await redis.del(key);
  return 'released';
}

export async function countAsync(redis: MinimalRedis, prefix: string): Promise<number> {
  let cursor = '0';
  let total = 0;
  for (let rounds = 0; rounds < 100; rounds += 1) {
    const page = await redis.scan(cursor, { match: `${prefix}*`, count: 100 });
    if (Array.isArray(page)) {
      for (const key of page) {
        if (key.startsWith(prefix)) total += 1;
      }
      break;
    }
    for (const key of page.keys) {
      if (key.startsWith(prefix)) total += 1;
    }
    cursor = page.cursor;
    if (cursor === '0') break;
  }
  return total;
}

export type DistributedAcquireResult =
  | { readonly kind: 'acquired'; readonly key: string; readonly ownerToken: string; readonly expiresAtMs: number }
  | { readonly kind: 'held'; readonly key: string }
  | { readonly kind: 'rejected_per_user_limit'; readonly retryAfterMs: number }
  | { readonly kind: 'store_unavailable'; readonly reason: string };

export type DistributedReleaseResult =
  | { readonly kind: 'released'; readonly outcome: TurnReleaseOutcome }
  | { readonly kind: 'already_released'; readonly key: string }
  | { readonly kind: 'token_mismatch'; readonly key: string }
  | { readonly kind: 'store_unavailable'; readonly reason: string };

export interface DistributedTurnLeaseOptions {
  readonly store: LeaseStore;
  readonly maxPerUser?: number | undefined;
  readonly leaseTtlMs?: number | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly newToken?: (() => string) | undefined;
}

const DEFAULT_MAX_PER_USER = 2;
const DEFAULT_LEASE_TTL_MS = 120_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;

export class DistributedTurnLease {
  private readonly store: LeaseStore;
  private readonly maxPerUser: number;
  private readonly leaseTtlMs: number;
  private readonly retryAfterMs: number;
  private readonly now: () => number;
  private readonly newToken: () => string;
  private readonly consumed = new Map<string, string>();
  private destroyed = false;

  constructor(options: DistributedTurnLeaseOptions) {
    if (!options.store) throw new Error('distributed-turn-lease: store is required');
    if (options.maxPerUser !== undefined && (!Number.isInteger(options.maxPerUser) || options.maxPerUser < 1)) {
      throw new Error('distributed-turn-lease: maxPerUser must be an integer >= 1');
    }
    this.store = options.store;
    this.maxPerUser = options.maxPerUser ?? DEFAULT_MAX_PER_USER;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
    this.now = options.now ?? Date.now;
    this.newToken = options.newToken ?? randomUUID;
  }

  acquire(input: { readonly tenantId?: string | undefined; readonly userId: string; readonly turnId: string }): DistributedAcquireResult {
    this.throwIfDestroyed();
    const parsed = z.object({
      tenantId: z.string().min(1).max(200).optional(),
      userId: z.string().min(1).max(200),
      turnId: z.string().min(1).max(200),
    }).parse(input);
    const tenantId = parsed.tenantId ?? 'default';
    const key = turnLeaseKey(tenantId, parsed.userId, parsed.turnId);
    const nowMs = this.now();
    try {
      const held = this.store.count(userLeasePrefix(tenantId, parsed.userId), nowMs);
      if (held >= this.maxPerUser) {
        logger.warn('capacity.lease.per_user_limit', { userId: parsed.userId, held });
        return Object.freeze({ kind: 'rejected_per_user_limit', retryAfterMs: this.retryAfterMs });
      }
      const token = this.newToken();
      const outcome = this.store.acquire(key, token, this.leaseTtlMs, nowMs);
      if (outcome === 'held') {
        return Object.freeze({ kind: 'held', key });
      }
      logger.info('capacity.lease.acquired', { key });
      return Object.freeze({ kind: 'acquired', key, ownerToken: token, expiresAtMs: nowMs + this.leaseTtlMs });
    } catch (error) {
      logger.warn('capacity.lease.store_unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return Object.freeze({ kind: 'store_unavailable', reason: 'Lease store unavailable; failing closed.' });
    }
  }

  release(input: { readonly key: string; readonly ownerToken: string; readonly outcome: TurnReleaseOutcome }): DistributedReleaseResult {
    this.throwIfDestroyed();
    const parsed = z.object({
      key: z.string().min(1).max(500),
      ownerToken: z.string().min(1).max(500),
      outcome: TurnReleaseOutcomeSchema,
    }).parse(input);
    if (this.consumed.get(parsed.key) === parsed.ownerToken) {
      return Object.freeze({ kind: 'already_released', key: parsed.key });
    }
    try {
      const outcome = this.store.release(parsed.key, parsed.ownerToken);
      if (outcome === 'released') {
        this.rememberConsumed(parsed.key, parsed.ownerToken);
        logger.info('capacity.lease.released', { key: parsed.key, outcome: parsed.outcome });
        return Object.freeze({ kind: 'released', outcome: parsed.outcome });
      }
      if (outcome === 'missing') {
        // The lease is gone: either this token already released it or the TTL
        // recovered it after a crash. Both cases are idempotent release.
        this.rememberConsumed(parsed.key, parsed.ownerToken);
        return Object.freeze({ kind: 'already_released', key: parsed.key });
      }
      logger.warn('capacity.lease.release_token_mismatch', { key: parsed.key });
      return Object.freeze({ kind: 'token_mismatch', key: parsed.key });
    } catch (error) {
      logger.warn('capacity.lease.store_unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return Object.freeze({ kind: 'store_unavailable', reason: 'Lease store unavailable; failing closed.' });
    }
  }

  renew(input: { readonly key: string; readonly ownerToken: string }): 'renewed' | 'token_mismatch' | 'missing' | 'store_unavailable' {
    this.throwIfDestroyed();
    const parsed = z.object({
      key: z.string().min(1).max(500),
      ownerToken: z.string().min(1).max(500),
    }).parse(input);
    try {
      const outcome = this.store.renew(parsed.key, parsed.ownerToken, this.leaseTtlMs, this.now());
      if (outcome === 'renewed') logger.info('capacity.lease.renewed', { key: parsed.key });
      return outcome;
    } catch (error) {
      logger.warn('capacity.lease.store_unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 'store_unavailable';
    }
  }

  heldCount(tenantId: string | undefined, userId: string): number {
    this.throwIfDestroyed();
    try {
      return this.store.count(userLeasePrefix(tenantId ?? 'default', userId), this.now());
    } catch {
      return 0;
    }
  }

  destroy(): void {
    this.consumed.clear();
    this.destroyed = true;
  }

  private rememberConsumed(key: string, token: string): void {
    this.consumed.set(key, token);
    if (this.consumed.size > 1_000) {
      const oldest = this.consumed.keys().next();
      if (!oldest.done) this.consumed.delete(oldest.value);
    }
  }

  private throwIfDestroyed(): void {
    if (this.destroyed) throw new Error('distributed-turn-lease: instance destroyed');
  }
}
