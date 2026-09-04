import type {
  AnswerCache,
  CacheLeaseCoordinator,
  LeaseAcquireResult,
  LeaseHandle,
  LeasePublishResult,
  LeaseReleaseResult,
  LeaseRenewResult,
} from '@app/domain';
import {
  createLocalCacheLeaseCoordinator,
  processLocalCoordinator,
  leaseTtlMs,
  positiveTtlSec,
  unrefTimer,
  DEFAULT_RENEWAL_INTERVAL_FRACTION,
  type LocalCacheLeaseCoordinator,
} from './local-coordinator';

export type { LocalCacheLeaseCoordinator };
export { createLocalCacheLeaseCoordinator };

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

const TELEMETRY_WINDOW_MS = 60_000;

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
