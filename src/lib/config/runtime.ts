import { appConfig } from '@/lib/config';
import {
  appConfigSchema,
  type AppConfig,
  type Wp8FingerprintCompatibility,
} from '@app/domain/app-config';
import type { SettingsRepo } from '@app/domain';
import { logger } from '@/lib/logger';

interface CacheEntry {
  value: AppConfig;
  softExpiry: number;
  hardExpiry: number;
  version: number;
}

const SOFT_TTL_MS = 30_000;
const HARD_TTL_MS = 300_000;
const SETTINGS_READ_RETRY_DELAY_MS = 200;

const ENV_LOCK = (process.env.APP_SETTINGS_LOCK ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function envLockedPaths(): readonly string[] {
  return ENV_LOCK;
}

function deepGet(obj: unknown, parts: string[]): unknown {
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function applyEnvLock(cfg: AppConfig): AppConfig {
  if (ENV_LOCK.length === 0) return cfg;
  const locked = clone(cfg) as Record<string, unknown>;
  for (const path of ENV_LOCK) {
    const parts = path.split('.');
    const defaultValue = deepGet(appConfig, parts);
    let cursor = locked as Record<string, unknown>;
    let reachable = true;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (key === undefined) {
        reachable = false;
        break;
      }
      const next = cursor[key];
      if (next && typeof next === 'object') {
        cursor = next as Record<string, unknown>;
      } else {
        reachable = false;
        break;
      }
    }
    if (reachable) {
      const leaf = parts[parts.length - 1];
      if (leaf !== undefined && leaf in cursor) cursor[leaf] = defaultValue;
      else logger.warn(`[runtime-config] APP_SETTINGS_LOCK path not found: ${path}`);
    } else {
      logger.warn(`[runtime-config] APP_SETTINGS_LOCK path not found: ${path}`);
    }
  }
  return locked as unknown as AppConfig;
}

function deepMerge(base: AppConfig, override: Partial<AppConfig>): AppConfig {
  const result: Record<string, unknown> = clone(base) as Record<string, unknown>;
  const src = override as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    const o = src[key];
    const b = result[key];
    if (
      o &&
      typeof o === 'object' &&
      !Array.isArray(o) &&
      b &&
      typeof b === 'object' &&
      !Array.isArray(b)
    ) {
      result[key] = deepMerge(b as AppConfig, o as Partial<AppConfig>);
    } else if (o !== undefined) {
      result[key] = o;
    }
  }
  return result as unknown as AppConfig;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonnegativeInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Capture removed WP-8 settings before appConfigSchema strips unknown keys.
 * This metadata is read only by the turn-result fingerprint bridge; it is not
 * exposed through the admin schema and cannot change WP-9 runtime behavior.
 */
function wp8FingerprintCompatibility(raw: unknown): Wp8FingerprintCompatibility | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const retrievalMode = record.retrievalMode === 'agentic' || record.retrievalMode === 'normal'
    ? record.retrievalMode
    : null;
  const retrieveLimit = positiveInteger(record.agenticRetrieveLimit);
  const maxRetries = nonnegativeInteger(record.agenticMaxRetries);
  const queryRewriteEnabled = typeof record.agenticQueryRewriteEnabled === 'boolean'
    ? record.agenticQueryRewriteEnabled
    : null;
  if (
    retrievalMode === null &&
    retrieveLimit === null &&
    maxRetries === null &&
    queryRewriteEnabled === null
  ) return undefined;
  return {
    ...(retrievalMode !== null ? { retrievalMode } : {}),
    ...(retrieveLimit !== null ? { retrieveLimit } : {}),
    ...(maxRetries !== null ? { maxRetries } : {}),
    ...(queryRewriteEnabled !== null ? { queryRewriteEnabled } : {}),
  };
}

function enforceEnvironmentKillSwitches(cfg: AppConfig): AppConfig {
  let enforced = cfg;
  if (process.env.AGENTIC_ENABLED === 'false' && cfg.retrievalMode === 'agentic') {
    enforced = { ...enforced, retrievalMode: 'normal' };
  }
  // An explicit rollback value is authoritative even when a stale DB override
  // still selects weighted lexical search. Enabling the candidate remains
  // runtime-editable; this one-way kill switch makes incident rollback atomic.
  if (process.env.LEXICAL_SEARCH_MODE === 'content_plain' && enforced.lexicalSearchMode !== 'content_plain') {
    enforced = { ...enforced, lexicalSearchMode: 'content_plain' };
  }
  return enforced;
}

let cache: CacheEntry | null = null;
let refreshInFlight: Promise<AppConfig> | null = null;
let degraded = false;

let settingsRepoProvider: (() => SettingsRepo) | null = null;

export function registerSettingsRepoProvider(provider: () => SettingsRepo): void {
  settingsRepoProvider = provider;
}

export function isRuntimeConfigDegraded(): boolean {
  return degraded;
}

export async function getRuntimeConfig(): Promise<AppConfig> {
  const now = Date.now();

  if (cache && now < cache.softExpiry) {
    return enforceEnvironmentKillSwitches(applyEnvLock(cache.value));
  }
  if (cache && now < cache.hardExpiry) {
    if (!refreshInFlight) {
      refreshInFlight = refreshCache().finally(() => {
        refreshInFlight = null;
      });
    }
    return enforceEnvironmentKillSwitches(applyEnvLock(cache.value));
  }
  return enforceEnvironmentKillSwitches(applyEnvLock(await refreshCache()));
}

async function enterDegradedMode(err?: unknown): Promise<AppConfig> {
  if (err === undefined) {
    logger.warn('[runtime-config] settings provider unavailable; using static defaults');
  } else {
    logger.error('[runtime-config] DB read failed, entering degraded mode', { error: err });
  }
  degraded = true;
  const now = Date.now();
  const fallback = cache ? cache.value : appConfig;
  const enforced = enforceEnvironmentKillSwitches(fallback);
  cache = {
    value: enforced,
    softExpiry: now + SOFT_TTL_MS,
    hardExpiry: now + HARD_TTL_MS,
    version: cache ? cache.version : 0,
  };
  return cache.value;
}

async function readOverridesWithRetry(): Promise<{
  overrides: Partial<AppConfig>;
  version: number;
}> {
  try {
    return await settingsRepoProvider!().getOverrides();
  } catch (err) {
    logger.warn('[runtime-config] settings override read failed; retrying once', { error: err });
    await new Promise((resolve) => setTimeout(resolve, SETTINGS_READ_RETRY_DELAY_MS));
    return await settingsRepoProvider!().getOverrides();
  }
}

async function refreshCache(): Promise<AppConfig> {
  if (!settingsRepoProvider) return enterDegradedMode();
  try {
    const { overrides, version } = await readOverridesWithRetry();
    const merged = deepMerge(appConfig, overrides);
    let validated: AppConfig = appConfigSchema.parse(merged);
    const fingerprintCompatibility = wp8FingerprintCompatibility(overrides);
    if (fingerprintCompatibility !== undefined) {
      validated = { ...validated, wp8FingerprintCompatibility: fingerprintCompatibility };
    }
    validated = enforceEnvironmentKillSwitches(validated);
    if (process.env.AGENTIC_ENABLED === 'false' && (merged as Record<string, unknown>).retrievalMode === 'agentic') {
      logger.warn('[runtime-config] AGENTIC_ENABLED=false forces retrievalMode=normal despite DB override — agentic retrieval disabled');
    }
    if (process.env.LEXICAL_SEARCH_MODE === 'content_plain' && merged.lexicalSearchMode !== 'content_plain') {
      logger.warn('[runtime-config] LEXICAL_SEARCH_MODE=content_plain overrides the DB setting — weighted lexical retrieval disabled');
    }
    const now = Date.now();
    cache = {
      value: validated,
      softExpiry: now + SOFT_TTL_MS,
      hardExpiry: now + HARD_TTL_MS,
      version,
    };
    degraded = false;
    return validated;
  } catch (err) {
    return enterDegradedMode(err);
  }
}

export function invalidateRuntimeConfig(): void {
  // Drop both TTLs so the next read takes the blocking cold path and
  // observably serves the saved overrides (no one-request stale window).
  if (!cache) return;
  cache.softExpiry = 0;
  cache.hardExpiry = 0;
}
