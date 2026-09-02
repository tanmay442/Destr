import { Pool as NeonPool } from '@neondatabase/serverless';
import pg from 'pg';

import {
  defaultDatabaseEnv,
  parseDatabaseConfig,
  parseDatabaseConnection,
  type DatabaseConfig,
} from '../config/database';

/**
 * Upper bound for one runtime statement. Request abort is not propagated by
 * Drizzle's `execute` API, so this server-side backstop prevents a detached
 * query from occupying a backend indefinitely. Long-running maintenance jobs
 * should use their own owner/migration connection rather than this pool.
 */
export const DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS = 30_000;

// Neon's serverless driver can't reach plain TCP Postgres; route Neon URLs to it, everything else via `pg`.
export function isPooledNeonUrl(url: string): boolean {
  if (!url) return false;
  return parseDatabaseConnection(url)?.isPooledNeon ?? false;
}

export function isNeonUrl(url: string): boolean {
  if (!url) return false;
  return parseDatabaseConnection(url)?.isNeon ?? false;
}

export function enforceNeonTlsVerification(url: string): string {
  if (!url) return url;
  return parseDatabaseConnection(url)?.connectionString ?? url;
}

function buildNeonPool(config: DatabaseConfig & { databaseUrl: string }): NeonPool {
  return new NeonPool({
    connectionString: config.databaseUrl,
    max: config.poolMax,
    statement_timeout: DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
}

function buildPgPool(config: DatabaseConfig & { databaseUrl: string }): pg.Pool {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.poolMax,
    statement_timeout: DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
}

function makeMissingDatabasePool(): NeonPool {
  const message = 'DATABASE_URL is not set.';
  const stub = {
    query: <T extends Record<string, unknown> = Record<string, unknown>>(): Promise<{ rows: T[] }> =>
      Promise.reject(new Error(message)),
    connect: (): Promise<{ query: () => Promise<unknown>; release: () => void }> =>
      Promise.reject(new Error(message)),
    end: (): Promise<void> => Promise.reject(new Error(message)),
    on: () => stub, once: () => stub, emit: () => false,
    removeListener: () => stub, removeAllListeners: () => stub,
    setMaxListeners: () => stub, getMaxListeners: () => 0,
    listeners: () => [], rawListeners: () => [], eventNames: () => [],
    listenerCount: () => 0, addListener: () => stub, off: () => stub,
    prependListener: () => stub, prependOnceListener: () => stub,
  };
  return stub as unknown as NeonPool;
}

export function buildMissingPool(): NeonPool {
  return makeMissingDatabasePool();
}

const pools = new Map<string, NeonPool | pg.Pool>();

function hasDatabaseUrl(config: DatabaseConfig): config is DatabaseConfig & { databaseUrl: string } {
  return typeof config.databaseUrl === 'string' && config.databaseUrl !== '';
}

/**
 * Pool construction depends on more than the connection string. Keep each
 * effective pool configuration isolated so a later caller cannot inherit a
 * previously constructed pool with a different capacity or driver policy.
 */
function poolCacheKey(config: DatabaseConfig & { databaseUrl: string }): string {
  return JSON.stringify({
    databaseUrl: config.databaseUrl,
    poolMax: config.poolMax,
    driver: config.isNeon ? 'neon' : 'pg',
    isPooledNeon: config.isPooledNeon,
    sslMode: config.sslMode ?? null,
  });
}

export function getPool(input: string | DatabaseConfig): NeonPool | pg.Pool {
  const config = typeof input === 'string'
    ? parseDatabaseConfig(defaultDatabaseEnv, { databaseUrl: input })
    : input;
  if (!hasDatabaseUrl(config)) return buildMissingPool();
  const cacheKey = poolCacheKey(config);
  const existing = pools.get(cacheKey);
  if (existing) return existing;
  const pool = config.isNeon ? buildNeonPool(config) : buildPgPool(config);
  pools.set(cacheKey, pool);
  return pool;
}

export { redactDatabaseUrl } from '../config/database';

export async function closePool(): Promise<void> {
  const openPools = [...pools.values()];
  pools.clear();
  await Promise.allSettled(
    openPools.map((pool) => (pool as unknown as { end: () => Promise<void> }).end()),
  );
}
