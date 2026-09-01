import { drizzle as drizzleNeon, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import type { EnvSource } from '@app/domain';
import { defaultProcessEnv } from '../config/env';
import { parseDatabaseConfig, type DatabaseConfig } from '../config/database';
import { buildMissingPool, getPool } from './pool';
import { registerVectorDim, resolveVectorDim } from './schema-vector';
import * as schema from './schema';

export { schema };

const clientDatabaseConfigs = new WeakMap<object, DatabaseConfig>();

export function databaseConfigForClient(client: object): DatabaseConfig | undefined {
  return clientDatabaseConfigs.get(client);
}

/**
 * Call once per process (composition/CLI). Singleton semantics are enforced in Phase 05.
 * Fails fast on an invalid EMBEDDING_DIMENSION (E2) at client-creation time.
 */
export function createDbClient(cfg: { databaseUrl?: string; vectorDim?: number; env?: EnvSource } = {}): NeonDatabase<typeof schema> {
  const vectorDim = cfg.vectorDim ?? resolveVectorDim(cfg.env);
  if (!Number.isInteger(vectorDim) || vectorDim <= 0) {
    throw new Error(`Invalid vectorDim: "${vectorDim}". Expected a positive integer.`);
  }
  const env = cfg.env ?? defaultProcessEnv;
  const databaseConfig = parseDatabaseConfig(
    env,
    cfg.databaseUrl !== undefined ? { databaseUrl: cfg.databaseUrl } : {},
  );
  const client = !databaseConfig.databaseUrl
    ? drizzleNeon(buildMissingPool(), { schema })
    : (() => {
        const pool = getPool(databaseConfig);
        return databaseConfig.isNeon
          ? drizzleNeon(pool as ReturnType<typeof getPool> & import('@neondatabase/serverless').Pool, { schema })
          : (drizzlePg(pool as import('pg').Pool, { schema }) as unknown as NeonDatabase<typeof schema>);
      })();
  registerVectorDim(client, vectorDim);
  clientDatabaseConfigs.set(client, databaseConfig);
  return client;
}

export { closePool } from './pool';

export const db: NeonDatabase<typeof schema> = createDbClient();

export type Client = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
