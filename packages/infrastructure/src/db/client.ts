import { drizzle as drizzleNeon, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { buildNeonPool, buildPgPool, buildMissingPool, isNeonUrl } from './pool';
import * as schema from './schema';

export { schema };

const url = process.env.DATABASE_URL ?? '';

// `db` is typed as NeonDatabase<typeof schema> so the derived `Client`
// type in repositories.ts stays a single, non-union type. The local
// (non-Neon) branch builds a node-postgres drizzle and casts it: both
// drivers extend the same PgDatabase base and expose the identical
// query/select/insert/update/delete/transaction API the repositories
// use, so the cast is sound at runtime.
export const db: NeonDatabase<typeof schema> = !url
  ? drizzleNeon(buildMissingPool(), { schema })
  : isNeonUrl(url)
    ? drizzleNeon(buildNeonPool(), { schema })
    : (drizzlePg(buildPgPool(), { schema }) as unknown as NeonDatabase<typeof schema>);
