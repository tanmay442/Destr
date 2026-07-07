import 'dotenv/config';
import { Pool as NeonPool } from '@neondatabase/serverless';

export function buildPool(): NeonPool {
  const connectionString = process.env.DATABASE_URL ?? '';
  if (!connectionString) {
    return makeMissingDatabasePool();
  }
  return new NeonPool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 20,
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
