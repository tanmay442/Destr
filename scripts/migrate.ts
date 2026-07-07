import 'dotenv/config';
import { execSync } from 'node:child_process';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Cannot run migrations.');
  process.exit(1);
}

// The Drizzle-generated migrations use the `vector` column type, so the
// pgvector extension must be enabled before `drizzle-kit migrate` runs.
// `pg` connects over TCP to both the local Docker Postgres and Neon's
// pooled endpoint (sslmode=require is honoured from the connection
// string), so this works in every environment.
async function ensurePgvector(): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    console.log('pgvector extension ensured.');
  } finally {
    await pool.end();
  }
}

ensurePgvector()
  .then(() => {
    try {
      console.log('Running migrations...');
      execSync('pnpm drizzle-kit migrate', { stdio: 'inherit' });
      console.log('Migrations complete.');
    } catch (err) {
      console.error('Migration failed:', err);
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
