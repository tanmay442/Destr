import 'dotenv/config';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.warn('DATABASE_URL is not set. Skipping migrations.');
  process.exit(0);
}

// Uses the idempotent migrator in apply-migration.mjs, which enables the
// pgvector extension, runs additive ALTERs, and plays every Drizzle SQL
// file in ./drizzle — skipping benign "already exists" errors. This works
// whether the target DB was set up via `drizzle-kit push` (no journal) or
// `drizzle-kit migrate` (journaled), so it is safe to run on every build.
(async () => {
  try {
    console.log('Running migrations...');
    const { applyMigrations } = await import('./apply-migration.mjs');
    await applyMigrations();
    console.log('Migrations complete.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
})();
