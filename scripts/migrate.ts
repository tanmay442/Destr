import 'dotenv/config';

if (process.env.NEXT_SKIP_MIGRATIONS === '1') {
  console.log('NEXT_SKIP_MIGRATIONS=1 set; skipping migrations.');
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.warn('DATABASE_URL is not set. Skipping migrations.');
  process.exit(0);
}

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
