import type {
  CacheLeaseCoordinator,
  LeaseAcquireResult,
  LeaseHandle,
} from '@app/domain';

interface LocalLeaseEntry {
  token: symbol;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface LocalCacheLeaseCoordinator extends CacheLeaseCoordinator {
  readonly scope: 'local';
  size(): number;
  dispose(): void;
}

const MAX_LOCAL_LEASES = 256;
const DEFAULT_RENEWAL_INTERVAL_FRACTION = 3;

export { DEFAULT_RENEWAL_INTERVAL_FRACTION };

function leaseTtlMs(ttlSec: number): number {
  return Number.isFinite(ttlSec) ? Math.max(1_000, Math.ceil(ttlSec * 1_000)) : 60_000;
}

function positiveTtlSec(ttlSec: number): number {
  return Number.isFinite(ttlSec) && ttlSec > 0 ? ttlSec : 60;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const candidate: unknown = timer;
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    'unref' in candidate &&
    typeof candidate.unref === 'function'
  ) {
    candidate.unref();
  }
}

export { leaseTtlMs, positiveTtlSec, unrefTimer };

/**
 * Creates an isolated, bounded local coordinator. Expiration is scheduled per
 * entry so an idle key is eventually reclaimed without a process-wide timer.
 */
export function createLocalCacheLeaseCoordinator(options: {
  maxLeases?: number;
  now?: () => number;
} = {}): LocalCacheLeaseCoordinator {
  const maxLeases = Number.isInteger(options.maxLeases) && (options.maxLeases ?? 0) > 0
    ? options.maxLeases ?? MAX_LOCAL_LEASES
    : MAX_LOCAL_LEASES;
  const now = options.now ?? (() => Date.now());
  const leases = new Map<string, LocalLeaseEntry>();

  const clearEntry = (key: string, entry: LocalLeaseEntry): void => {
    clearTimeout(entry.timer);
    if (leases.get(key)?.token === entry.token) leases.delete(key);
  };

  const sweepExpired = (currentTime: number): void => {
    for (const [key, entry] of leases) {
      if (entry.expiresAt <= currentTime) clearEntry(key, entry);
    }
  };

  const scheduleExpiry = (key: string, token: symbol, ttlMs: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      const entry = leases.get(key);
      if (entry?.token === token) clearEntry(key, entry);
    }, ttlMs);
    unrefTimer(timer);
    return timer;
  };

  const makeHandle = (key: string, token: symbol): LeaseHandle => {
    let active = true;

    return {
      renewalSupported: true,
      async renew(ttlSec) {
        if (!active) return { kind: 'not-owner' };
        const currentTime = now();
        const current = leases.get(key);
        if (!current || current.token !== token || current.expiresAt <= currentTime) {
          if (current?.token === token) clearEntry(key, current);
          active = false;
          return { kind: 'not-owner' };
        }
        clearTimeout(current.timer);
        const ttlMs = leaseTtlMs(ttlSec);
        const next: LocalLeaseEntry = {
          token,
          expiresAt: currentTime + ttlMs,
          timer: scheduleExpiry(key, token, ttlMs),
        };
        leases.set(key, next);
        return { kind: 'renewed' };
      },
      async release() {
        if (!active) return { kind: 'not-owner' };
        const current = leases.get(key);
        if (!current || current.token !== token) {
          active = false;
          return { kind: 'not-owner' };
        }
        clearEntry(key, current);
        active = false;
        return { kind: 'released' };
      },
    };
  };

  const coordinator: LocalCacheLeaseCoordinator = {
    scope: 'local',
    async acquire(key, ttlSec): Promise<LeaseAcquireResult> {
      const currentTime = now();
      sweepExpired(currentTime);
      const existing = leases.get(key);
      if (existing) {
        if (existing.expiresAt > currentTime) return { kind: 'held' };
        clearEntry(key, existing);
      }
      if (leases.size >= maxLeases) return { kind: 'unavailable' };
      const token = Symbol(key);
      const ttlMs = leaseTtlMs(ttlSec);
      const entry: LocalLeaseEntry = {
        token,
        expiresAt: currentTime + ttlMs,
        timer: scheduleExpiry(key, token, ttlMs),
      };
      leases.set(key, entry);
      return { kind: 'acquired', handle: makeHandle(key, token) };
    },
    size: () => leases.size,
    dispose: () => {
      for (const entry of leases.values()) clearTimeout(entry.timer);
      leases.clear();
    },
  };
  return coordinator;
}

const processLocalCoordinator = createLocalCacheLeaseCoordinator();

export { processLocalCoordinator };
