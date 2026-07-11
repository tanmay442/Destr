import 'dotenv/config';
import { Pool as NeonPool } from '@neondatabase/serverless';
import pg from 'pg';

const POOL_OPTS = {
  max: 20,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
} as const;

// Neon's serverless driver can't reach plain TCP Postgres; route Neon URLs to it, everything else via `pg`.
export function isNeonUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.endsWith('.neon.tech') || host.endsWith('.neon.app');
  } catch {
    return false;
  }
}

export function buildNeonPool(): NeonPool {
  return new NeonPool({
    connectionString: process.env.DATABASE_URL ?? '',
    ...POOL_OPTS,
  });
}

export function buildPgPool(): pg.Pool {
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? '',
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
