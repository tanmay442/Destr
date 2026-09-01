import { randomUUID } from 'node:crypto';
import type {
  AnswerCache,
  AnswerCacheLease,
  CacheLeaseCoordinator,
  LeaseAcquireResult,
  LeaseHandle,
  LeaseReleaseResult,
  LeaseRenewResult,
} from '@app/domain';
import { answerCacheRegistry, registerAnswerCacheProvider } from './answer-cache-registry';

const MAX_KEYS = 5_000;
const MAX_LEASES = 256;

interface ValueEntry {
  value: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface LeaseEntry {
  token: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

function ttlMs(ttlSec: number): number {
  return Number.isFinite(ttlSec) ? Math.max(1_000, Math.ceil(ttlSec * 1_000)) : 60_000;
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

export interface InMemoryCacheOptions {
  maxKeys?: number;
  maxLeases?: number;
  now?: () => number;
}

export interface InMemoryCacheLeaseCoordinator extends CacheLeaseCoordinator {
  readonly scope: 'local';
  size(): number;
  dispose(): void;
}

function createLeaseCoordinator(options: {
  maxLeases: number;
  now: () => number;
}): InMemoryCacheLeaseCoordinator {
  const leases = new Map<string, LeaseEntry>();

  const clearEntry = (key: string, entry: LeaseEntry): void => {
    clearTimeout(entry.timer);
    if (leases.get(key)?.token === entry.token) leases.delete(key);
  };

  const sweepExpired = (currentTime: number): void => {
    for (const [key, entry] of leases) {
      if (entry.expiresAt <= currentTime) clearEntry(key, entry);
    }
  };

  const scheduleExpiry = (key: string, token: string, durationMs: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      const entry = leases.get(key);
      if (entry?.token === token) clearEntry(key, entry);
    }, durationMs);
    unrefTimer(timer);
    return timer;
  };

  const createHandle = (key: string, token: string): LeaseHandle => {
    let active = true;
    return {
      renewalSupported: true,
      async renew(durationSec): Promise<LeaseRenewResult> {
        if (!active) return { kind: 'not-owner' };
        const currentTime = options.now();
        const current = leases.get(key);
        if (!current || current.token !== token || current.expiresAt <= currentTime) {
          if (current?.token === token) clearEntry(key, current);
          active = false;
          return { kind: 'not-owner' };
        }
        clearTimeout(current.timer);
        const durationMs = ttlMs(durationSec);
        leases.set(key, {
          token,
          expiresAt: currentTime + durationMs,
          timer: scheduleExpiry(key, token, durationMs),
        });
        return { kind: 'renewed' };
      },
      async release(): Promise<LeaseReleaseResult> {
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

  return {
    scope: 'local',
    async acquire(key, durationSec): Promise<LeaseAcquireResult> {
      const currentTime = options.now();
      sweepExpired(currentTime);
      const existing = leases.get(key);
      if (existing) {
        if (existing.expiresAt > currentTime) return { kind: 'held' };
        clearEntry(key, existing);
      }
      if (leases.size >= options.maxLeases) return { kind: 'unavailable' };
      const token = randomUUID();
      const durationMs = ttlMs(durationSec);
      leases.set(key, {
        token,
        expiresAt: currentTime + durationMs,
        timer: scheduleExpiry(key, token, durationMs),
      });
      return { kind: 'acquired', handle: createHandle(key, token) };
    },
    size: () => leases.size,
    dispose: () => {
      for (const entry of leases.values()) clearTimeout(entry.timer);
      leases.clear();
    },
  };
}

function createLegacyLease(coordinator: InMemoryCacheLeaseCoordinator): AnswerCacheLease {
  const handles = new Map<string, { handle: LeaseHandle; timer: ReturnType<typeof setTimeout> }>();
  const remove = (identity: string): void => {
    const entry = handles.get(identity);
    if (!entry) return;
    clearTimeout(entry.timer);
    handles.delete(identity);
  };
  return {
    async tryAcquire(key, durationSec) {
      const result = await coordinator.acquire(key, durationSec);
      if (result.kind !== 'acquired') return null;
      const token = randomUUID();
      const identity = `${key}\u0000${token}`;
      const timer = setTimeout(() => remove(identity), ttlMs(durationSec));
      unrefTimer(timer);
      handles.set(identity, { handle: result.handle, timer });
      return token;
    },
    async release(key, token) {
      const identity = `${key}\u0000${token}`;
      const entry = handles.get(identity);
      if (!entry) return;
      const result = await entry.handle.release();
      if (result.kind !== 'unavailable') remove(identity);
    },
  };
}

export function createInMemoryAnswerCache(options: InMemoryCacheOptions = {}): AnswerCache {
  const maxKeys = Number.isInteger(options.maxKeys) && (options.maxKeys ?? 0) > 0
    ? options.maxKeys ?? MAX_KEYS
    : MAX_KEYS;
  const now = options.now ?? (() => Date.now());
  const maxLeases = Number.isInteger(options.maxLeases) && (options.maxLeases ?? 0) > 0
    ? options.maxLeases ?? MAX_LEASES
    : MAX_LEASES;
  const store = new Map<string, ValueEntry>();
  const coordination = createLeaseCoordinator({ maxLeases, now });

  const removeValue = (key: string, entry: ValueEntry): void => {
    if (entry.timer !== null) clearTimeout(entry.timer);
    if (store.get(key) === entry) store.delete(key);
  };
  const scheduleValueExpiry = (key: string, entry: ValueEntry, durationMs: number): void => {
    entry.timer = setTimeout(() => {
      if (store.get(key) === entry) removeValue(key, entry);
    }, durationMs);
    unrefTimer(entry.timer);
  };
  const sweepValues = (currentTime: number): void => {
    for (const [key, entry] of store) {
      if (entry.expiresAt <= currentTime) removeValue(key, entry);
    }
  };

  const cache: AnswerCache = {
    coordination,
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        removeValue(key, entry);
        return null;
      }
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },
  async set(key, answer, durationSec) {
      const old = store.get(key);
      if (old && old.timer !== null) clearTimeout(old.timer);
      const durationMs = ttlMs(durationSec);
      const entry: ValueEntry = {
        value: answer,
        expiresAt: now() + durationMs,
        timer: null,
      };
      store.delete(key);
      store.set(key, entry);
      scheduleValueExpiry(key, entry, durationMs);
      sweepValues(now());
      while (store.size > maxKeys) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        const oldestEntry = store.get(oldest);
        if (oldestEntry) removeValue(oldest, oldestEntry);
      }
    },
    // Kept as a compatibility view for pre-coordination consumers. New code
    // uses `coordination` and never receives provider ownership tokens.
    lease: createLegacyLease(coordination),
  };
  return cache;
}

registerAnswerCacheProvider('memory', createInMemoryAnswerCache);

function unavailableCoordinator(): CacheLeaseCoordinator {
  return {
    scope: 'distributed',
    async acquire(): Promise<LeaseAcquireResult> {
      return { kind: 'unavailable' };
    },
  };
}

/** Memory-backed reads/writes with an explicit unavailable distributed lease. */
function createUnavailableAnswerCache(): AnswerCache {
  const memory = createInMemoryAnswerCache();
  return {
    get: memory.get,
    set: memory.set,
    coordination: unavailableCoordinator(),
  };
}

export function createAnswerCache(onInitError?: (error: unknown) => void): AnswerCache {
  const provider = process.env.UPSTASH_REDIS_REST_URL ? 'upstash' : 'memory';
  const factory = answerCacheRegistry.get(provider);
  if (!factory) throw new Error(`Unknown answer cache provider: ${provider}`);
  try {
    return factory();
  } catch (error) {
    onInitError?.(error);
    return provider === 'upstash' ? createUnavailableAnswerCache() : createInMemoryAnswerCache();
  }
}
