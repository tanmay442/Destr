// Non-interactive SQL migrator. Plays every Drizzle-generated
// migration in ./drizzle against the configured database, plus a
// small set of `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements
// for columns that were added to pre-existing tables after the
// initial schema was shipped. Idempotent: known duplicate-object
// errors are logged and skipped; anything else throws.
//
// Usage:
//   node scripts/apply-migration.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const EXTENSION_SQL = 'CREATE EXTENSION IF NOT EXISTS vector;';

// SQL the migrator plays in addition to the Drizzle files. These
// are additive ALTERs that bring pre-existing tables up to the
// current schema. All use `IF NOT EXISTS` so re-runs are safe.
const ADD_COLUMNS = [
  'ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "blob" "bytea";',
  'ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;',
  'ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "assigned_to" text;',
  'ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "notes" text;',
];

// Postgres error codes / messages that mean "this DDL is already
// applied" and should be skipped rather than fail the run.
function isBenignError(err) {
  if (!err) return false;
  const code = err.code;
  if (
    code === '42710' || // duplicate object
    code === '42P07' || // duplicate table
    code === '42701' || // duplicate column
    code === '42P06' || // duplicate schema
    code === '42P10'    // duplicate object
  ) {
    return true;
  }
  const msg = err.message ?? '';
  return msg.includes('already exists') || msg.includes('does not exist');
}

async function safeQuery(pool, sql, logger) {
  try {
    await pool.query(sql);
    logger.log('  ok');
  } catch (err) {
    if (isBenignError(err)) {
      logger.log('  skip:', err.message.split('\n')[0]);
    } else {
      throw err;
    }
  }
}

/**
 * Structural shape of the pool the migrator needs. The real
 *  satisfies it; tests can pass a minimal fake.
 *
 * @typedef {{ query: (sql: string) => Promise<unknown>; end: () => Promise<unknown> }} PoolLike
 */

/**
 * @param {object} opts
 * @param {string} [opts.dir]
 * @param {() => PoolLike} [opts.poolFactory]
 * @param {Pick<Console, 'log' | 'error'>} [opts.logger]
 */
export async function applyMigrations({
  dir = './drizzle',
  poolFactory = () => {
    const connectionString = process.env.DATABASE_URL ?? '';
    return new pg.Pool({ connectionString });
  },
  logger = console,
} = {}) {
  const pool = poolFactory();
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  logger.log(`applying ${files.length} migration(s)...`);

  try {
    // Enable pgvector extension before any schema operations.
    logger.log('-- enabling pgvector extension...');
    await safeQuery(pool, EXTENSION_SQL, logger);

    for (const sql of ADD_COLUMNS) {
      logger.log('-- add column:', sql);
      await safeQuery(pool, sql, logger);
    }

    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const statements = sql
        .split(/-->\s*statement-breakpoint/)
        .map((s) => s.trim())
        .filter(Boolean);
      logger.log(`-- ${file}: ${statements.length} statements`);
      for (const stmt of statements) {
        try {
          await pool.query(stmt);
        } catch (err) {
          if (isBenignError(err)) {
            logger.log('  skip:', err.message.split('\n')[0]);
          } else {
            logger.log('  ERROR:', err.message.split('\n')[0]);
            throw err;
          }
        }
      }
    }
  } finally {
    await pool.end();
  }
  logger.log('done');
}

export const __test = { isBenignError, ADD_COLUMNS };

// CLI entry — only run when this module is the program root.
const invokedDirectly = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  applyMigrations().catch((err) => {
    console.error('apply-migration failed:', err);
    process.exit(1);
  });
}
