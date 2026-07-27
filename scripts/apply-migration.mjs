// Non-interactive SQL migrator. Applies Drizzle migrations from ./drizzle.
// Applied files are tracked in `_migrations` so re-runs are idempotent.
// Usage: node scripts/apply-migration.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const EXTENSION_SQL = 'CREATE EXTENSION IF NOT EXISTS vector;';

// Applied migrations tracked by file name + content hash for idempotent re-runs.
const MIGRATIONS_TABLE = 'public._migrations';

async function ensureTrackingTable(pool, logger) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id SERIAL PRIMARY KEY,
      file_name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      hash TEXT NOT NULL
    )
  `);
  logger.log('  tracking table ok');
}

async function getApplied(pool) {
  const result = await pool.query(
    `SELECT file_name, hash FROM ${MIGRATIONS_TABLE} ORDER BY id`,
  );
  return new Map(result.rows.map((r) => [r.file_name, r.hash]));
}

async function recordApplied(pool, file, hash) {
  await pool.query(
    `INSERT INTO ${MIGRATIONS_TABLE} (file_name, hash) VALUES ($1, $2)
     ON CONFLICT (file_name) DO UPDATE SET hash = EXCLUDED.hash, applied_at = now()`,
    [file, hash],
  );
}

// Postgres error codes meaning the DDL already exists; safe to skip.
// Matched by code (not message text) so real failures aren't swallowed.
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

    // Create tracking table and load already-applied set.
    logger.log('-- migration tracking...');
    await ensureTrackingTable(pool, logger);
    const applied = await getApplied(pool);
    logger.log(`  ${applied.size} previously applied`);

    for (const file of files) {
      // Skip if already applied with the same content hash.
      const content = readFileSync(join(dir, file), 'utf8');
      const hash = simpleHash(content);

      const prevHash = applied.get(file);
      if (prevHash === hash) {
        logger.log(`-- ${file}: already applied, skipping`);
        continue;
      }

      const statements = content
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

      await recordApplied(pool, file, hash);
      logger.log(`  recorded`);
    }
  } finally {
    await pool.end();
  }
  logger.log('done');
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export const __test = { isBenignError, simpleHash };

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
