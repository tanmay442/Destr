import pg from 'pg';
import { loadDotEnv } from '../packages/infrastructure/src/config/dotenv-bootstrap';

loadDotEnv();

const ADVISORY_LOCK_KEY = 2_654_840_719;
const DEFAULT_MONTHS_AHEAD = 6;
const MIN_MONTHS_AHEAD = 6;
const MAX_MONTHS_AHEAD = 24;
const DEFAULT_LOCK_TIMEOUT = '5s';
const DEFAULT_STATEMENT_TIMEOUT = '30s';

const EVENT_INDEXES = [
  ['chat_events', 'chat_events_created_at_idx', 'created_at DESC'],
  ['chat_events', 'chat_events_mode_idx', 'mode'],
  ['chat_events', 'chat_events_user_id_idx', 'user_id'],
  ['chat_events', 'idx_chat_events_meta_document_ids', "(meta -> 'documentIds') USING gin"],
] as const;

const AUDIT_INDEXES = [
  ['audit_events', 'audit_events_kind_idx', 'kind'],
  ['audit_events', 'audit_events_at_id_idx', 'at DESC, id DESC'],
  ['audit_events', 'audit_events_actor_id_idx', 'actor_id'],
  ['audit_events', 'audit_events_kind_target_id_idx', 'kind, target_id'],
] as const;

const MESSAGE_INDEXES = [
  ['chat_messages', 'idx_chat_messages_conversation_id', 'conversation_id, id'],
  ['chat_messages', 'chat_messages_turn_unique', 'conversation_id, turn_id, role UNIQUE'],
] as const;

type ParentKind = 'chat_events' | 'audit_events';

export interface QueryResultLike<T extends Record<string, unknown> = Record<string, unknown>> {
  rows: T[];
}

export interface PoolLike {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResultLike<T>>;
  end(): Promise<void>;
}

export interface PartitionCommandOptions {
  apply: boolean;
  dryRun: boolean;
  allowDefaultRows: boolean;
  confirmDatabase?: string;
  monthsAhead: number;
  databaseUrl?: string;
  now?: Date;
}

export interface PartitionStatus {
  database: string;
  user: string;
  ownsParents: boolean;
  missingFuture: string[];
  defaultRows: { chatEvents: number; auditEvents: number };
  indexes: { name: string; table: string }[];
}

export interface PartitionMaintenanceResult {
  applied: boolean;
  status: PartitionStatus;
  created: string[];
  createdIndexes: string[];
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function monthStart(value: Date): Date {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error('Invalid --now date');
  result.setUTCDate(1);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

function monthLabel(value: Date): string {
  return `${value.getUTCFullYear().toString().padStart(4, '0')}_${(value.getUTCMonth() + 1)
    .toString()
    .padStart(2, '0')}`;
}

function nextMonth(value: Date): Date {
  const result = new Date(value);
  result.setUTCMonth(result.getUTCMonth() + 1);
  return result;
}

export function futurePartitionNames(
  kind: ParentKind,
  now: Date,
  monthsAhead = DEFAULT_MONTHS_AHEAD,
): string[] {
  const count = normalizeMonthsAhead(monthsAhead);
  const first = monthStart(now);
  const names: string[] = [];
  for (let i = 0; i <= count; i += 1) {
    names.push(`${kind}_${monthLabel(first)}`);
    first.setUTCMonth(first.getUTCMonth() + 1);
  }
  return names;
}

export function normalizeMonthsAhead(value: number): number {
  if (!Number.isInteger(value) || value < MIN_MONTHS_AHEAD) return DEFAULT_MONTHS_AHEAD;
  return Math.min(value, MAX_MONTHS_AHEAD);
}

function parseValue(argument: string, flag: string): string {
  const value = argument.slice(flag.length).trim();
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  return value;
}

export function parsePartitionArgs(argv: string[]): Omit<PartitionCommandOptions, 'databaseUrl' | 'now'> {
  let apply = false;
  let dryRun = true;
  let allowDefaultRows = false;
  let confirmDatabase: string | undefined;
  let monthsAhead = DEFAULT_MONTHS_AHEAD;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--apply' || argument === '--yes') {
      apply = true;
      dryRun = false;
    } else if (argument === '--dry-run') {
      apply = false;
      dryRun = true;
    } else if (argument === '--allow-default-rows') {
      allowDefaultRows = true;
    } else if (argument.startsWith('--confirm-database=')) {
      confirmDatabase = parseValue(argument, '--confirm-database=');
    } else if (argument === '--confirm-database') {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) throw new Error('Missing value for --confirm-database');
      confirmDatabase = value;
    } else if (argument.startsWith('--months-ahead=')) {
      const value = parseValue(argument, '--months-ahead=');
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < MIN_MONTHS_AHEAD || parsed > MAX_MONTHS_AHEAD) {
        throw new Error(`--months-ahead must be an integer from ${MIN_MONTHS_AHEAD} to ${MAX_MONTHS_AHEAD}`);
      }
      monthsAhead = parsed;
    } else if (argument === '--months-ahead') {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) throw new Error('Missing value for --months-ahead');
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < MIN_MONTHS_AHEAD || parsed > MAX_MONTHS_AHEAD) {
        throw new Error(`--months-ahead must be an integer from ${MIN_MONTHS_AHEAD} to ${MAX_MONTHS_AHEAD}`);
      }
      monthsAhead = parsed;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  return { apply, dryRun, allowDefaultRows, ...(confirmDatabase ? { confirmDatabase } : {}), monthsAhead };
}

function parsePartitionRows(result: QueryResultLike): string[] {
  return result.rows
    .map((row) => (typeof row.relname === 'string' ? row.relname : null))
    .filter((name): name is string => name !== null);
}

async function readStatus(
  pool: PoolLike,
  now: Date,
  monthsAhead: number,
): Promise<PartitionStatus> {
  const identity = await pool.query<{
    database: string;
    user: string;
    owns_parents: boolean;
    parent_count: number;
  }>(`
    SELECT current_database() AS database,
           current_user AS user,
           bool_and(pg_get_userbyid(c.relowner) = current_user OR r.rolsuper) AS owns_parents,
           count(*)::int AS parent_count
    FROM pg_class c
    JOIN pg_roles r ON r.rolname = current_user
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relname IN ('chat_events', 'audit_events', 'chat_messages')
  `);
  const identityRow = identity.rows[0];
  if (!identityRow || Number(identityRow.parent_count) !== 3) {
    throw new Error('Partition parents are missing; apply migration 0029 first.');
  }

  const partitions = await pool.query<{ relname: string }>(`
    SELECT child.relname
    FROM pg_inherits inheritance
    JOIN pg_class child ON child.oid = inheritance.inhrelid
    JOIN pg_class parent ON parent.oid = inheritance.inhparent
    WHERE parent.relnamespace = 'public'::regnamespace
      AND parent.relname IN ('chat_events', 'audit_events')
  `);
  const present = new Set(parsePartitionRows(partitions));
  const expected = [
    ...futurePartitionNames('chat_events', now, monthsAhead),
    ...futurePartitionNames('audit_events', now, monthsAhead),
  ];
  const missingFuture = expected.filter((name) => !present.has(name));

  const defaults = await pool.query<{ chat_events: number; audit_events: number }>(`
    SELECT
      (SELECT count(*)::int FROM chat_events_default) AS chat_events,
      (SELECT count(*)::int FROM audit_events_default) AS audit_events
  `);
  const defaultRow = defaults.rows[0] ?? { chat_events: 0, audit_events: 0 };

  const indexes = await pool.query<{ tablename: string; indexname: string }>(`
    SELECT tablename, indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN ('chat_events', 'audit_events', 'chat_messages')
  `);

  return {
    database: identityRow.database,
    user: identityRow.user,
    ownsParents: Boolean(identityRow.owns_parents),
    missingFuture,
    defaultRows: {
      chatEvents: Number(defaultRow.chat_events ?? 0),
      auditEvents: Number(defaultRow.audit_events ?? 0),
    },
    indexes: indexes.rows.map((row) => ({ table: row.tablename, name: row.indexname })),
  };
}

async function ensurePartitions(
  pool: PoolLike,
  now: Date,
  monthsAhead: number,
): Promise<string[]> {
  const created: string[] = [];
  const ensureRange = async (kind: ParentKind): Promise<void> => {
    const first = monthStart(now);
    for (let index = 0; index <= monthsAhead; index += 1) {
      const start = new Date(first);
      start.setUTCMonth(start.getUTCMonth() + index);
      const end = nextMonth(start);
      const name = `${kind}_${monthLabel(start)}`;
      const exists = await pool.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = $1`,
        [name],
      );
      if (exists.rows.length > 0) continue;
      const startLiteral = start.toISOString();
      const endLiteral = end.toISOString();
      await pool.query(
        `CREATE TABLE ${quoteIdentifier(name)} PARTITION OF ${quoteIdentifier(kind)} FOR VALUES FROM ('${startLiteral}') TO ('${endLiteral}')`,
      );
      created.push(name);
    }
  };
  await ensureRange('chat_events');
  await ensureRange('audit_events');
  return created;
}

async function ensureIndexes(pool: PoolLike): Promise<string[]> {
  const created: string[] = [];
  for (const [table, name, definition] of [...EVENT_INDEXES, ...AUDIT_INDEXES, ...MESSAGE_INDEXES]) {
    const exists = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
      [name],
    );
    if (exists.rows.length > 0) continue;
    const unique = definition.endsWith(' UNIQUE') ? ' UNIQUE' : '';
    const columns = unique ? definition.slice(0, -' UNIQUE'.length) : definition;
    const using = columns.includes(' USING gin') ? ' USING gin' : '';
    const expression = columns.replace(' USING gin', '');
    await pool.query(
      `CREATE${unique} INDEX ${quoteIdentifier(name)} ON ${quoteIdentifier(table)}${using} (${expression})`,
    );
    created.push(name);
  }
  return created;
}

function assertOwner(status: PartitionStatus): void {
  if (!status.ownsParents || status.user === 'rag_app') {
    throw new Error('Partition maintenance requires the migration/owner role; refusing application-role DDL.');
  }
}

function assertDefaultSafety(status: PartitionStatus, allowDefaultRows: boolean): void {
  const total = status.defaultRows.chatEvents + status.defaultRows.auditEvents;
  if (total > 0 && !allowDefaultRows) {
    throw new Error(
      `Default partition contains ${total} row(s) (chat_events=${status.defaultRows.chatEvents}, audit_events=${status.defaultRows.auditEvents}); drain or explicitly allow before applying DDL.`,
    );
  }
}

export async function runPartitionMaintenance(
  options: PartitionCommandOptions,
  poolFactory: (databaseUrl: string) => PoolLike = (databaseUrl) =>
    new pg.Pool({ connectionString: databaseUrl, max: 2 }) as unknown as PoolLike,
): Promise<PartitionMaintenanceResult> {
  const databaseUrl = options.databaseUrl ?? process.env.MIGRATION_DATABASE_URL;
  if (!databaseUrl) throw new Error('MIGRATION_DATABASE_URL is required; application DATABASE_URL is not accepted for DDL.');
  const now = options.now ?? new Date();
  const monthsAhead = normalizeMonthsAhead(options.monthsAhead);
  const pool = poolFactory(databaseUrl);
  try {
    const before = await readStatus(pool, now, monthsAhead);
    assertOwner(before);
    if (options.apply && before.database !== options.confirmDatabase) {
      throw new Error(
        `Refusing unexpected database "${before.database}". Pass --confirm-database=${before.database} explicitly.`,
      );
    }
    if (options.apply) assertDefaultSafety(before, options.allowDefaultRows);

    if (!options.apply || options.dryRun) {
      return { applied: false, status: before, created: [], createdIndexes: [] };
    }

    await pool.query('BEGIN');
    try {
      await pool.query(`SET LOCAL lock_timeout = '${DEFAULT_LOCK_TIMEOUT}'`);
      await pool.query(`SET LOCAL statement_timeout = '${DEFAULT_STATEMENT_TIMEOUT}'`);
      await pool.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEY]);
      const created = await ensurePartitions(pool, now, monthsAhead);
      const createdIndexes = await ensureIndexes(pool);
      const after = await readStatus(pool, now, monthsAhead);
      assertOwner(after);
      assertDefaultSafety(after, options.allowDefaultRows);
      if (after.missingFuture.length > 0) {
        throw new Error(`Partition coverage is still missing: ${after.missingFuture.join(', ')}`);
      }
      await pool.query('COMMIT');
      return { applied: true, status: after, created, createdIndexes };
    } catch (error) {
      await pool.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    await pool.end();
  }
}

function printResult(result: PartitionMaintenanceResult): void {
  const { status } = result;
  console.log(`partition maintenance ${result.applied ? 'applied' : 'dry-run'} for ${status.database}`);
  console.log(`  owner: ${status.user}; future gaps: ${status.missingFuture.length}`);
  console.log(
    `  default rows: chat_events=${status.defaultRows.chatEvents}, audit_events=${status.defaultRows.auditEvents}`,
  );
  if (result.created.length > 0) console.log(`  created: ${result.created.join(', ')}`);
  if (result.createdIndexes.length > 0) console.log(`  indexes: ${result.createdIndexes.join(', ')}`);
}

async function main(): Promise<void> {
  const options = parsePartitionArgs(process.argv.slice(2));
  if (options.apply && !options.confirmDatabase) {
    throw new Error('Applying partition DDL requires --confirm-database=<current database name>.');
  }
  const result = await runPartitionMaintenance(options);
  printResult(result);
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error('manage-partitions failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
