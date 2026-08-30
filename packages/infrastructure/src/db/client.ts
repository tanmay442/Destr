import { drizzle as drizzleNeon, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import type { EnvSource } from '@app/domain';
import { defaultProcessEnv } from '../config/env';
import { buildMissingPool, getPool, isNeonUrl } from './pool';
import { registerVectorDim, resolveVectorDim } from './schema-vector';
import * as schema from './schema';

export { schema };

/**
 * Call once per process (composition/CLI). Singleton semantics are enforced in Phase 05.
 * Fails fast on an invalid EMBEDDING_DIMENSION (E2) at client-creation time.
 */
export function createDbClient(cfg: { databaseUrl?: string; vectorDim?: number; env?: EnvSource } = {}): NeonDatabase<typeof schema> {
  const vectorDim = cfg.vectorDim ?? resolveVectorDim(cfg.env);
  if (!Number.isInteger(vectorDim) || vectorDim <= 0) {
    throw new Error(`Invalid vectorDim: "${vectorDim}". Expected a positive integer.`);
  }
  const url = cfg.databaseUrl ?? cfg.env?.get('DATABASE_URL') ?? defaultProcessEnv.get('DATABASE_URL') ?? '';
  const client = !url
    ? drizzleNeon(buildMissingPool(), { schema })
    : (() => {
        const pool = getPool(url);
        return isNeonUrl(url)
          ? drizzleNeon(pool as ReturnType<typeof getPool> & import('@neondatabase/serverless').Pool, { schema })
          : (drizzlePg(pool as import('pg').Pool, { schema }) as unknown as NeonDatabase<typeof schema>);
      })();
  registerVectorDim(client, vectorDim);
  return client;
}

export { closePool } from './pool';

export const db: NeonDatabase<typeof schema> = createDbClient();

export type Client = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
