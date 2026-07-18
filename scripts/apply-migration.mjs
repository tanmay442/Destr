// Non-interactive SQL migrator. Plays every Drizzle-generated
// migration in ./drizzle against the configured database. Idempotent:
// known duplicate-object errors are logged and skipped; anything else
// throws.
//
// Usage:
//   node scripts/apply-migration.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const EXTENSION_SQL = 'CREATE EXTENSION IF NOT EXISTS vector;';

// Postgres error codes that mean "this DDL is already applied" and should
// be skipped rather than fail the run. Message-substring matching is
// intentionally avoided: a real failure whose text happens to contain a
// duplicate keyword (e.g. a constraint violation during a backfill UPDATE)
// must not be silently swallowed.
const BENIGN_CODES = new Set([
  '42710', // duplicate object
  '42P07', // duplicate table
  '42701', // duplicate column
  '42P06', // duplicate schema
  '42P10', // conflicting/invalid object definition
]);

function isBenignError(err) {
  if (!err) return false;
  return BENIGN_CODES.has(err.code);
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

export const __test = { isBenignError };

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
