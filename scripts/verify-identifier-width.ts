import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadDotEnv } from '../packages/infrastructure/src/config/dotenv-bootstrap';

loadDotEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'drizzle');
const INT4_MAX = 2_147_483_647;
const TARGET_TABLES = ['chat_events', 'audit_events', 'quality_reviews', 'tickets'] as const;

type TargetTable = (typeof TARGET_TABLES)[number];

const SEQUENCES: Record<TargetTable, string> = {
  chat_events: 'chat_events_id_seq',
  audit_events: 'audit_events_id_seq',
  quality_reviews: 'quality_reviews_id_seq',
  tickets: 'tickets_id_seq',
};

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function databaseUrlFor(baseUrl: string, databaseName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function tempDatabaseName(label: string): string {
  const suffix = `${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  return `destr_identifier_${label}_${suffix}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

async function applyMigrations(databaseUrl: string, directory = MIGRATIONS_DIR): Promise<void> {
  const { applyMigrations: run } = await import('./apply-migration.mjs');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  // apply-migration owns the supplied pool's lifecycle in its finally block.
  await run({
    dir: directory,
    poolFactory: () => pool,
    logger: console,
  });
}

async function withTemporaryDatabase<T>(
  baseUrl: string,
  label: string,
  callback: (databaseUrl: string) => Promise<T>,
): Promise<T> {
  const databaseName = tempDatabaseName(label);
  const ownerPool = new pg.Pool({ connectionString: baseUrl, max: 1 });
  const targetUrl = databaseUrlFor(baseUrl, databaseName);
  try {
    await ownerPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    return await callback(targetUrl);
  } finally {
    await ownerPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`).catch(() => {});
    await ownerPool.end();
  }
}

function copyMigrationsThrough0027(): string {
  const directory = mkdtempSync(join(ROOT, '.tmp-identifier-width-'));
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^00(?:0\d|1\d|2[0-7])_.*\.sql$/u.test(file))
    .sort();
  if (files.length !== 28 || !files.at(-1)?.startsWith('0027_')) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`Expected migrations 0000 through 0027, found ${files.length}`);
  }
  for (const file of files) copyFileSync(join(MIGRATIONS_DIR, file), join(directory, basename(file)));
  return directory;
}

async function seedSchema0027(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const turnId = '00000000-0000-4000-8000-000000000027';
  try {
    await pool.query(
      `INSERT INTO users (clerk_user_id, email, name, role)
       VALUES ($1, $2, 'Identifier Width', 'admin')`,
      ['identifier-width-reviewer', 'identifier-width@example.invalid'],
    );
    await pool.query(
      `INSERT INTO chat_events (id, turn_id, mode, meta)
       VALUES (42, $1, 'vector', '{}'::jsonb)`,
      [turnId],
    );
    await pool.query(
      `INSERT INTO quality_reviews (id, turn_id, reviewer_id, verdict)
       VALUES (42, $1, 'identifier-width-reviewer', 'good')`,
      [turnId],
    );
    await pool.query(
      `INSERT INTO tickets (id, ticket_id, user_id, name, email, issue)
       VALUES (42, 'TKT-identifier-width-0027', 'identifier-width-reviewer',
               'Identifier Width', 'identifier-width@example.invalid', 'seeded upgrade')`,
    );
    await pool.query(
      `INSERT INTO audit_events (id, kind, action, actor_id, target_type, target_id, details)
       VALUES (42, 'ticket', 'create', 'identifier-width-reviewer', 'ticket',
               'TKT-identifier-width-0027', '{}'::jsonb)`,
    );
  } finally {
    await pool.end();
  }
}

async function querySchema(databaseUrl: string): Promise<{
  columns: Array<{ table_name: string; data_type: string }>;
  sequences: Array<{ sequence_name: string; data_type: string }>;
  defaults: Array<{ table_name: string; column_default: string | null }>;
  foreignKeys: string[];
}> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const [columns, sequences, defaults, foreignKeys] = await Promise.all([
      pool.query<{ table_name: string; data_type: string }>(
        `SELECT table_name, data_type
         FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'id'
           AND table_name = ANY($1::text[])
         ORDER BY table_name`,
        [TARGET_TABLES],
      ),
      pool.query<{ sequence_name: string; data_type: string }>(
        `SELECT sequencename AS sequence_name, data_type::text
         FROM pg_sequences
         WHERE schemaname = 'public' AND sequencename = ANY($1::text[])
         ORDER BY sequencename`,
        [Object.values(SEQUENCES)],
      ),
      pool.query<{ table_name: string; column_default: string | null }>(
        `SELECT table_name, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'id'
           AND table_name = ANY($1::text[])
         ORDER BY table_name`,
        [TARGET_TABLES],
      ),
      pool.query<{ conname: string }>(
        `SELECT conname
         FROM pg_constraint c
         JOIN pg_class r ON r.oid = c.conrelid
         WHERE r.relnamespace = 'public'::regnamespace
           AND c.contype = 'f'
           AND (
             c.conname IN (
               'chat_events_turn_id_chat_turns_turn_id_fk',
               'chat_feedback_turn_id_chat_turns_turn_id_fk',
               'quality_reviews_turn_id_chat_turns_turn_id_fk',
               'quality_reviews_reviewer_id_users_clerk_user_id_fk'
             )
             OR r.relname IN ('chat_feedback', 'quality_reviews')
           )
         ORDER BY conname`,
      ),
    ]);
    return {
      columns: columns.rows,
      sequences: sequences.rows,
      defaults: defaults.rows,
      foreignKeys: foreignKeys.rows.map((row) => row.conname),
    };
  } finally {
    await pool.end();
  }
}

function assertWidenedSchema(schema: Awaited<ReturnType<typeof querySchema>>): void {
  if (schema.columns.length !== TARGET_TABLES.length || schema.columns.some((row) => row.data_type !== 'bigint')) {
    throw new Error(`Expected bigint IDs for ${TARGET_TABLES.join(', ')}, got ${JSON.stringify(schema.columns)}`);
  }
  if (schema.sequences.length !== TARGET_TABLES.length || schema.sequences.some((row) => row.data_type !== 'bigint')) {
    throw new Error(`Expected bigint owned sequences, got ${JSON.stringify(schema.sequences)}`);
  }
  if (schema.defaults.length !== TARGET_TABLES.length || schema.defaults.some((row) => !row.column_default?.includes('nextval'))) {
    throw new Error(`Expected nextval defaults for all widened IDs, got ${JSON.stringify(schema.defaults)}`);
  }
  const requiredForeignKeys = [
    'chat_events_turn_id_chat_turns_turn_id_fk',
    'chat_feedback_turn_id_chat_turns_turn_id_fk',
    'quality_reviews_turn_id_chat_turns_turn_id_fk',
    'quality_reviews_reviewer_id_users_clerk_user_id_fk',
  ];
  for (const constraint of requiredForeignKeys) {
    if (!schema.foreignKeys.includes(constraint)) throw new Error(`Missing foreign key ${constraint}`);
  }
}

async function assertSeededRowsAndSequences(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const seeded = await pool.query<{ table_name: string; id: string }>(
      `SELECT 'chat_events' AS table_name, id::text FROM chat_events WHERE id = 42
       UNION ALL SELECT 'audit_events', id::text FROM audit_events WHERE id = 42
       UNION ALL SELECT 'quality_reviews', id::text FROM quality_reviews WHERE id = 42
       UNION ALL SELECT 'tickets', id::text FROM tickets WHERE id = 42`,
    );
    if (seeded.rows.length !== TARGET_TABLES.length || seeded.rows.some((row) => row.id !== '42')) {
      throw new Error(`Seeded IDs changed during upgrade: ${JSON.stringify(seeded.rows)}`);
    }

    for (const table of TARGET_TABLES) {
      const sequence = SEQUENCES[table];
      await pool.query(`SELECT setval($1::regclass, $2::bigint, true)`, [sequence, INT4_MAX]);
      const result = await pool.query<{ id: string }>(`SELECT nextval($1::regclass)::text AS id`, [sequence]);
      const next = Number(result.rows[0]?.id);
      if (!Number.isSafeInteger(next) || next <= INT4_MAX) {
        throw new Error(`${sequence} did not advance beyond int4: ${String(result.rows[0]?.id)}`);
      }
    }
  } finally {
    await pool.end();
  }
}

async function verifyFresh(baseUrl: string): Promise<void> {
  await withTemporaryDatabase(baseUrl, 'fresh', async (databaseUrl) => {
    await applyMigrations(databaseUrl);
    assertWidenedSchema(await querySchema(databaseUrl));
  });
  console.log('[identifier-width] fresh migration verified');
}

async function verifyUpgrade(baseUrl: string): Promise<void> {
  const through0027 = copyMigrationsThrough0027();
  try {
    await withTemporaryDatabase(baseUrl, 'upgrade', async (databaseUrl) => {
      await applyMigrations(databaseUrl, through0027);
      await seedSchema0027(databaseUrl);
      await applyMigrations(databaseUrl);
      assertWidenedSchema(await querySchema(databaseUrl));
      await assertSeededRowsAndSequences(databaseUrl);
    });
  } finally {
    rmSync(through0027, { recursive: true, force: true });
  }
  console.log('[identifier-width] seeded 0027 upgrade verified');
}

function parseModes(argv: string[]): Array<'fresh' | 'upgrade'> {
  const modes = new Set<'fresh' | 'upgrade'>();
  for (const arg of argv) {
    if (arg === '--fresh') modes.add('fresh');
    else if (arg === '--upgrade') modes.add('upgrade');
    else throw new Error(`Unknown option ${arg}; use --fresh and/or --upgrade`);
  }
  return modes.size === 0 ? ['fresh', 'upgrade'] : [...modes];
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required');
  const modes = parseModes(process.argv.slice(2));
  for (const mode of modes) {
    if (mode === 'fresh') await verifyFresh(databaseUrl);
    else await verifyUpgrade(databaseUrl);
  }
}

if (isMain) {
  main().catch((error: unknown) => {
    console.error(`[identifier-width] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export const __test = {
  assertWidenedSchema,
  databaseUrlFor,
  parseModes,
  tempDatabaseName,
};
