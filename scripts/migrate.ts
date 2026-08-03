import 'dotenv/config';

const isLocal =
  process.env.NODE_ENV === 'development' &&
  !process.env.VERCEL &&
  !process.env.CI &&
  !process.env.DOCKER_BUILD;

if (process.env.NEXT_SKIP_MIGRATIONS === '1') {
  if (!isLocal) {
    // Gate the dev-only escape hatch: skipping migrations in a real build can
    // ship an app against an unbumped schema.
    console.error(
      'NEXT_SKIP_MIGRATIONS=1 is only allowed in local development. ' +
        'Unset it (or run in a dev env) before building.',
    );
    process.exit(1);
  }
  console.log('NEXT_SKIP_MIGRATIONS=1 set; skipping migrations.');
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  if (!isLocal) {
    console.error(
      'DATABASE_URL is not set. Migrations are required in this environment; ' +
        'refusing to continue.',
    );
    process.exit(1);
  }
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
