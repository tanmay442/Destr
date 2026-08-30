import { Pool as NeonPool } from '@neondatabase/serverless';
import pg from 'pg';

const POOL_OPTS = {
  max: 20,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
} as const;

export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url.replace(/:[^@]*@/, ':****@');
  }
}

// Neon's serverless driver can't reach plain TCP Postgres; route Neon URLs to it, everything else via `pg`.
export function isNeonUrl(url: string): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid DATABASE_URL: "${redactDatabaseUrl(url)}". Expected a valid postgres connection string.`);
  }
  const host = parsed.hostname;
  return host.endsWith('.neon.tech') || host.endsWith('.neon.app');
}

function buildNeonPool(url: string): NeonPool {
  return new NeonPool({
    connectionString: url,
    ...POOL_OPTS,
  });
}

function buildPgPool(url: string): pg.Pool {
  return new pg.Pool({
    connectionString: url,
    ...POOL_OPTS,
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

export function getPool(url: string): NeonPool | pg.Pool {
  const existing = pools.get(url);
  if (existing) return existing;
  const pool = isNeonUrl(url)
    ? (buildNeonPool(url) as unknown as NeonPool | pg.Pool)
    : (buildPgPool(url) as unknown as NeonPool | pg.Pool);
  pools.set(url, pool);
  return pool;
}

export async function closePool(): Promise<void> {
  const openPools = [...pools.values()];
  pools.clear();
  await Promise.allSettled(
    openPools.map((pool) => (pool as unknown as { end: () => Promise<void> }).end()),
  );
}

