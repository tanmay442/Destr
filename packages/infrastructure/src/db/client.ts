import { drizzle as drizzleNeon, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { buildNeonPool, buildPgPool, buildMissingPool, isNeonUrl } from './pool';
import * as schema from './schema';

export { schema };

const url = process.env.DATABASE_URL ?? '';

export const db: NeonDatabase<typeof schema> = !url
  ? drizzleNeon(buildMissingPool(), { schema })
  : isNeonUrl(url)
    ? drizzleNeon(buildNeonPool(), { schema })
    : (drizzlePg(buildPgPool(), { schema }) as unknown as NeonDatabase<typeof schema>);
