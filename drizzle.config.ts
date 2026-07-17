import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// DATABASE_URL is only required for commands that open a live connection
// (`push`, `introspect`, `studio`). `generate` only reads the schema, so we
// tolerate its absence instead of failing the whole config load.
const databaseUrl = process.env.DATABASE_URL ?? '';

export default defineConfig({
  dialect: 'postgresql',
  schema: './packages/infrastructure/src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: databaseUrl,
  },
  verbose: true,
  strict: true,
});
