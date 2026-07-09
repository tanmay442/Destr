import 'dotenv/config';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.warn('DATABASE_URL is not set. Skipping migrations.');
  process.exit(0);
}

// Delegates to the idempotent apply-migration.mjs (pgvector + additive ALTERs,
// skips "already exists"); safe to run on every build via push or migrate.
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
