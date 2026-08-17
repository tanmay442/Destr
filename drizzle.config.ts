import { loadDotEnv } from './packages/infrastructure/src/config/dotenv-bootstrap';
import { defineConfig } from 'drizzle-kit';

loadDotEnv();

// DATABASE_URL is only required for commands that open a live connection
// (`push`, `introspect`, `studio`). `generate` only reads the schema, so we
// tolerate its absence instead of failing the whole config load.
// DDL commands (`push`, `introspect`, `studio`) need owner rights; the app's
// DATABASE_URL is the least-privilege rag_app role. Prefer MIGRATION_DATABASE_URL.
const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

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
