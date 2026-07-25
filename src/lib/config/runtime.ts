import { getComposition } from '@/composition';
import { appConfig } from '@/lib/config';
import { appConfigSchema, type AppConfig } from '@app/domain/app-config';
import { logger } from '@/lib/logger';

interface CacheEntry {
  value: AppConfig;
  softExpiry: number;
  hardExpiry: number;
  version: number;
}

const SOFT_TTL_MS = 30_000;
const HARD_TTL_MS = 300_000;

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

type RemoteVersionSource = () => Promise<number | null>;

let remoteVersionSource: RemoteVersionSource | null = null;

export function setRemoteConfigVersionSource(source: RemoteVersionSource | null): void {
  remoteVersionSource = source;
}

async function readRemoteVersion(): Promise<number | null> {
  if (!remoteVersionSource) return null;
  try {
    return await remoteVersionSource();
  } catch {
    return null;
  }
}

let cache: CacheEntry | null = null;
let refreshInFlight: Promise<AppConfig> | null = null;

export async function getRuntimeConfig(): Promise<AppConfig> {
  const now = Date.now();

  const remote = await readRemoteVersion();
  const remoteNewer = remote != null && cache != null && remote > cache.version;

  if (cache && now < cache.softExpiry && !remoteNewer) {
    return applyEnvLock(cache.value);
  }
  if (cache && now < cache.hardExpiry) {
    if (!refreshInFlight) {
      refreshInFlight = refreshCache().finally(() => {
        refreshInFlight = null;
      });
    }
    return applyEnvLock(cache.value);
  }
  return applyEnvLock(await refreshCache());
}

async function refreshCache(): Promise<AppConfig> {
  try {
    const { overrides, version } = await getComposition().settingsRepo.getOverrides();
    const merged = deepMerge(appConfig, overrides);
    const validated = appConfigSchema.parse(merged);
    const now = Date.now();
    cache = {
      value: validated,
      softExpiry: now + SOFT_TTL_MS,
      hardExpiry: now + HARD_TTL_MS,
      version,
    };
    return validated;
  } catch (err) {
    logger.error('[runtime-config] DB read failed, falling back', { error: err });
    if (cache) {
      cache.softExpiry = Date.now() + SOFT_TTL_MS;
      return cache.value;
    }
    return appConfig;
  }
}

export function invalidateRuntimeConfig(): void {
  if (cache) cache.softExpiry = 0;
}
