import { drizzle as drizzleNeon, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import type { EnvSource } from '@app/domain';
import { defaultProcessEnv } from '../config/env';
import { buildNeonPool, buildPgPool, buildMissingPool, isNeonUrl } from './pool';
import { resolveVectorDim } from './schema-vector';
import * as schema from './schema';

export { schema };

/**
 * Call once per process (composition/CLI). Singleton semantics are enforced in Phase 05.
 * Fails fast on an invalid EMBEDDING_DIMENSION (E2) at client-creation time.
 */
export function createDbClient(cfg: { databaseUrl?: string; vectorDim?: number; env?: EnvSource } = {}): NeonDatabase<typeof schema> {
  if (cfg.vectorDim === undefined) {
    resolveVectorDim(cfg.env);
  } else if (!Number.isFinite(cfg.vectorDim) || cfg.vectorDim <= 0) {
    throw new Error(`Invalid vectorDim: "${cfg.vectorDim}". Expected a positive integer.`);
  }
  const url = cfg.databaseUrl ?? cfg.env?.get('DATABASE_URL') ?? defaultProcessEnv.get('DATABASE_URL') ?? '';
  if (!url) return drizzleNeon(buildMissingPool(), { schema });
  return isNeonUrl(url)
    ? drizzleNeon(buildNeonPool(url), { schema })
    : (drizzlePg(buildPgPool(url), { schema }) as unknown as NeonDatabase<typeof schema>);
}

export const db: NeonDatabase<typeof schema> = createDbClient();
