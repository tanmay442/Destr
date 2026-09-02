import type {
  AnswerCache,
  CacheLeaseCoordinator,
  LeaseAcquireResult,
  LeaseHandle,
  LeasePublishResult,
  LeaseReleaseResult,
  LeaseRenewResult,
} from '@app/domain';

/**
 * Strict mode never turns a failed distributed coordinator into a process-local
 * lease. Degraded mode is intended for local development and explicitly
 * accepts the weaker, process-local single-flight guarantee.
 */
export type CacheLeasePolicy = 'strict' | 'degraded';

export interface CacheLeaseTelemetry {
  key: string;
  operation: 'acquire' | 'renew' | 'release';
  result: 'unavailable' | 'not-owner';
  policy: CacheLeasePolicy;
}

export interface CacheLeaseOptions {
  policy?: CacheLeasePolicy;
  /** Called for degraded-mode fallback and ownership failures. */
  onTelemetry?: (event: CacheLeaseTelemetry) => void;
  /** Override the bounded renewal interval; useful for deterministic tests. */
  renewalIntervalMs?: number;
}

export interface CacheLease {
  /** True while the current acquisition is backed by a distributed provider. */
  distributed: boolean;
  /** Backward-compatible boolean acquisition helper. */
  acquire(): Promise<boolean>;
  /** Explicit acquisition result used by chat-turn single-flight logic. */
  acquireResult(): Promise<LeaseAcquireResult>;
  /** Backward-compatible release helper. */
  release(): Promise<void>;
  /** Explicit release result for ownership/availability handling. */
  releaseResult(): Promise<LeaseReleaseResult>;
  /** Explicit renewal result; failed renewal makes this lease non-publishable. */
  renew(): Promise<LeaseRenewResult>;
  /** Publish only while this handle remains the current lease owner. */
  publish(value: string, valueTtlSec: number): Promise<LeasePublishResult>;
  /** Whether this handle still owns a lease and may publish a cached value. */
  isOwned(): boolean;
}

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
const TELEMETRY_WINDOW_MS = 60_000;

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

interface CoordinatorSource {
  coordinator: CacheLeaseCoordinator;
  distributed: boolean;
}

function legacyCoordinator(cache: AnswerCache, key: string): CoordinatorSource | null {
  const lease = cache.lease;
  if (!lease) return null;
  const coordinator: CacheLeaseCoordinator = {
    scope: 'distributed',
    async acquire(keyForAcquire, ttlSec): Promise<LeaseAcquireResult> {
      try {
        const token = await lease.tryAcquire(keyForAcquire, ttlSec);
        if (token === null) return { kind: 'held' };
        let active = true;
        const handle: LeaseHandle = {
          renewalSupported: false,
          async renew() {
            return { kind: 'unsupported' };
          },
          async release() {
            if (!active) return { kind: 'released' };
            try {
              await lease.release(key, token);
              active = false;
              return { kind: 'released' };
            } catch {
              return { kind: 'unavailable' };
            }
          },
        };
        return { kind: 'acquired', handle };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
  return { coordinator, distributed: true };
}

function getCoordinator(cache: AnswerCache, key: string): CoordinatorSource | null {
  if (cache.coordination) {
    return {
      coordinator: cache.coordination,
      distributed: cache.coordination.scope === 'distributed',
    };
  }
  return legacyCoordinator(cache, key);
}

const telemetryAt = new Map<string, number>();

function emitTelemetry(
  options: CacheLeaseOptions,
  event: CacheLeaseTelemetry,
): void {
  if (!options.onTelemetry) return;
  const eventKey = `${event.operation}:${event.result}`;
  const currentTime = Date.now();
  const previous = telemetryAt.get(eventKey);
  if (previous !== undefined && currentTime - previous < TELEMETRY_WINDOW_MS) return;
  telemetryAt.set(eventKey, currentTime);
  while (telemetryAt.size > 16) {
    const oldest = telemetryAt.keys().next().value;
    if (oldest === undefined) break;
    telemetryAt.delete(oldest);
  }
  options.onTelemetry(event);
}

/**
 * Adapts an AnswerCache's explicit coordinator to the small lifecycle object
 * used by chat-turn. The boolean methods remain for older consumers; new code
 * should branch on `acquireResult`/`releaseResult`.
 */
export function createCacheLease(
  cache: AnswerCache,
  key: string,
  ttlSec: number,
  options: CacheLeaseOptions = {},
): CacheLease {
  const policy = options.policy ?? 'degraded';
  const source = getCoordinator(cache, key);
  const coordinator = source?.coordinator;
  const distributedSource = source?.distributed ?? false;
  let handle: LeaseHandle | null = null;
  let usingLocalFallback = false;
  let owned = false;
  let renewalTimer: ReturnType<typeof setTimeout> | null = null;
  let released = false;

  const clearRenewalTimer = (): void => {
    if (renewalTimer === null) return;
    clearTimeout(renewalTimer);
    renewalTimer = null;
  };

  const telemetry = (operation: CacheLeaseTelemetry['operation'], result: CacheLeaseTelemetry['result']): void => {
    emitTelemetry(options, { key, operation, result, policy });
  };

  const renew = async (): Promise<LeaseRenewResult> => {
    if (!handle || !owned) return { kind: 'not-owner' };
    let result: LeaseRenewResult;
    try {
      result = await handle.renew(positiveTtlSec(ttlSec));
    } catch {
      result = { kind: 'unavailable' };
    }
    if (result.kind !== 'renewed') {
      owned = false;
      clearRenewalTimer();
      if (result.kind === 'unavailable' || result.kind === 'not-owner') telemetry('renew', result.kind);
    }
    return result;
  };

  const scheduleRenewal = (): void => {
    clearRenewalTimer();
    if (!handle || !owned || handle.renewalSupported === false) return;
    const ttlMs = leaseTtlMs(ttlSec);
    const configuredInterval = options.renewalIntervalMs;
    const delay = Number.isFinite(configuredInterval) && (configuredInterval ?? 0) > 0
      ? Math.min(ttlMs - 1, Math.max(1, Math.floor(configuredInterval ?? ttlMs / DEFAULT_RENEWAL_INTERVAL_FRACTION)))
      : Math.max(250, Math.floor(ttlMs / DEFAULT_RENEWAL_INTERVAL_FRACTION));
    renewalTimer = setTimeout(() => {
      renewalTimer = null;
      void renew().then((result) => {
        if (result.kind === 'renewed') scheduleRenewal();
      });
    }, Math.max(1, delay));
    unrefTimer(renewalTimer);
  };

  const acquireResult = async (): Promise<LeaseAcquireResult> => {
    if (owned && handle) return { kind: 'acquired', handle };
    released = false;
    const sourceResult = coordinator && (policy === 'degraded' || distributedSource)
      ? await coordinator.acquire(key, positiveTtlSec(ttlSec)).catch(() => ({ kind: 'unavailable' } as const))
      : { kind: 'unavailable' as const };
    if (sourceResult.kind === 'acquired') {
      handle = sourceResult.handle;
      owned = true;
      usingLocalFallback = false;
      scheduleRenewal();
      return sourceResult;
    }
    if (sourceResult.kind === 'held') return sourceResult;
    if (policy !== 'degraded') {
      telemetry('acquire', 'unavailable');
      return sourceResult;
    }

    if (coordinator && !distributedSource) {
      telemetry('acquire', 'unavailable');
      return sourceResult;
    }

    const localResult = await processLocalCoordinator.acquire(key, positiveTtlSec(ttlSec));
    if (localResult.kind === 'acquired') {
      handle = localResult.handle;
      owned = true;
      usingLocalFallback = true;
      scheduleRenewal();
      telemetry('acquire', 'unavailable');
      return localResult;
    }
    if (localResult.kind === 'held') return localResult;
    telemetry('acquire', 'unavailable');
    return localResult;
  };

  const releaseResult = async (): Promise<LeaseReleaseResult> => {
    clearRenewalTimer();
    if (!handle) {
      released = true;
      owned = false;
      usingLocalFallback = false;
      return { kind: 'released' };
    }
    const currentHandle = handle;
    let result: LeaseReleaseResult;
    try {
      result = await currentHandle.release();
    } catch {
      result = { kind: 'unavailable' };
    }
    if (result.kind === 'released' || result.kind === 'not-owner') {
      handle = null;
      owned = false;
      usingLocalFallback = false;
      released = true;
    } else {
      telemetry('release', 'unavailable');
    }
    return result;
  };

  const publish = async (value: string, valueTtlSec: number): Promise<LeasePublishResult> => {
    if (!handle || !owned || released) return { kind: 'not-owner' };
    try {
      if (handle.publish) {
        const result = await handle.publish(value, positiveTtlSec(valueTtlSec));
        if (result.kind !== 'published') {
          owned = false;
          clearRenewalTimer();
        }
        return result;
      }
      if (handle.renewalSupported !== false) {
        const renewed = await renew();
        if (renewed.kind !== 'renewed') return renewed;
      }
      await cache.set(key, value, positiveTtlSec(valueTtlSec));
      return { kind: 'published' };
    } catch {
      owned = false;
      clearRenewalTimer();
      return { kind: 'unavailable' };
    }
  };

  return {
    get distributed() {
      return distributedSource && !usingLocalFallback;
    },
    acquire: async () => (await acquireResult()).kind === 'acquired',
    acquireResult,
    release: async () => {
      await releaseResult();
    },
    releaseResult,
    renew,
    publish,
    isOwned: () => owned && !released,
  };
}

export interface CacheWaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  if (!signal) return new Promise((resolve) => setTimeout(resolve, delayMs));
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new Error('Aborted'));
    };
    const timer = setTimeout(() => {
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function waitForCachedAnswer(
  cache: AnswerCache,
  key: string,
  options: CacheWaitOptions = {},
): Promise<string | null> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 45_000);
  const deadline = Date.now() + timeoutMs;
  let delayMs = 25;
  while (Date.now() < deadline) {
    await wait(Math.min(delayMs, Math.max(1, deadline - Date.now())), options.signal);
    const value = await cache.get(key).catch(() => null);
    if (value) return value;
    delayMs = Math.min(delayMs * 2, 250);
  }
  return null;
}
