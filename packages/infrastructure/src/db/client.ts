import { drizzle } from 'drizzle-orm/neon-serverless';
import { buildPool } from './pool';
import * as schema from './schema';

export { schema };
export const db = drizzle(buildPool(), { schema });
