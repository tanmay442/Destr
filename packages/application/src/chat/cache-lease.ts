import type { AnswerCache } from '@app/domain';

export interface CacheLease {
  distributed: boolean;
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}

interface LocalLeaseEntry {
  token: symbol;
  expiresAt: number;
}

const MAX_LOCAL_LEASES = 256;
const localLeases = new Map<string, LocalLeaseEntry>();

function leaseTtlMs(ttlSec: number): number {
  return Number.isFinite(ttlSec) ? Math.max(1_000, Math.ceil(ttlSec * 1_000)) : 60_000;
}

function removeExpiredLeases(now: number): void {
  for (const [key, lease] of localLeases) {
    if (lease.expiresAt <= now) localLeases.delete(key);
  }
}

function evictOldestLease(): void {
  const oldest = localLeases.keys().next().value;
  if (oldest !== undefined) localLeases.delete(oldest);
}

function createLocalLease(key: string, ttlMs: number): CacheLease {
  const token = Symbol(key);
  return {
    distributed: false,
    async acquire() {
      const now = Date.now();
      removeExpiredLeases(now);
      const existing = localLeases.get(key);
      if (existing && existing.expiresAt > now) return false;
      while (localLeases.size >= MAX_LOCAL_LEASES) evictOldestLease();
      localLeases.set(key, { token, expiresAt: now + ttlMs });
      return true;
    },
    async release() {
      const existing = localLeases.get(key);
      if (existing?.token === token) localLeases.delete(key);
    },
  };
}

export function createCacheLease(cache: AnswerCache, key: string, ttlSec: number): CacheLease {
  if (!cache.lease) return createLocalLease(key, leaseTtlMs(ttlSec));

  const lease = cache.lease;
  const localLease = createLocalLease(key, leaseTtlMs(ttlSec));
  let token: string | null = null;
  let usingLocalFallback = false;
  return {
    distributed: true,
    async acquire() {
      try {
        token = await lease.tryAcquire(key, ttlSec);
        return token !== null;
      } catch {
        usingLocalFallback = true;
        return localLease.acquire();
      }
    },
    async release() {
      const acquiredToken = token;
      token = null;
      if (acquiredToken !== null) {
        try {
          await lease.release(key, acquiredToken);
        } catch {
        }
      }
      if (usingLocalFallback) {
        usingLocalFallback = false;
        await localLease.release();
      }
    },
  };
}

export async function waitForCachedAnswer(
  cache: AnswerCache,
  key: string,
  timeoutMs = 500,
): Promise<string | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let delayMs = 25;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delayMs, Math.max(1, deadline - Date.now()))));
    const value = await cache.get(key).catch(() => null);
    if (value) return value;
    delayMs = Math.min(delayMs * 2, 100);
  }
  return null;
}
