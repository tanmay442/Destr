import { appConfig } from '@/lib/config';
import { appConfigSchema, type AppConfig } from '@app/domain/app-config';
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

function enforceAgenticKillSwitch(cfg: AppConfig): AppConfig {
  if (process.env.AGENTIC_ENABLED === 'false' && cfg.retrievalMode === 'agentic') {
    return { ...cfg, retrievalMode: 'normal' };
  }
  return cfg;
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
    return enforceAgenticKillSwitch(applyEnvLock(cache.value));
  }
  if (cache && now < cache.hardExpiry) {
    if (!refreshInFlight) {
      refreshInFlight = refreshCache().finally(() => {
        refreshInFlight = null;
      });
    }
    return enforceAgenticKillSwitch(applyEnvLock(cache.value));
  }
  return enforceAgenticKillSwitch(applyEnvLock(await refreshCache()));
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
  const enforced = enforceAgenticKillSwitch(fallback);
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
    let validated = appConfigSchema.parse(merged);
    validated = enforceAgenticKillSwitch(validated);
    if (process.env.AGENTIC_ENABLED === 'false' && (merged as Record<string, unknown>).retrievalMode === 'agentic') {
      logger.warn('[runtime-config] AGENTIC_ENABLED=false forces retrievalMode=normal despite DB override — agentic retrieval disabled');
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
