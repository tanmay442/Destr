import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import type { AnswerCache, LeaseHandle } from '@app/domain';
import { loadDotEnv } from '../packages/infrastructure/src/config/dotenv-bootstrap';
import { createInMemoryAnswerCache } from '../packages/infrastructure/src/auth/in-memory-answer-cache';
import { createUpstashAnswerCache } from '../packages/infrastructure/src/auth/upstash-answer-cache';
import { executeCancelable } from '../packages/infrastructure/src/db/query-cancellation';

loadDotEnv();

const DEFAULT_VECTOR_DIMENSION = 768;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_BATCH_SIZE = 2_000;
const DEFAULT_ITERATIONS = 3;
const DEFAULT_CACHE_WORKERS = 16;
const DEFAULT_LEASE_TTL_SEC = 30;
const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
const DEFAULT_SLEEP_SEC = 2;
const DEFAULT_ABORT_AFTER_MS = 100;
const DEFAULT_VECTOR_LIMIT = 10;
const DEFAULT_MESSAGE_LIMIT = 50;

const EMPTY_UUID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_USER_ID = 'baseline-user';

const VALUE_OPTIONS = new Set([
  '--database-url',
  '--retention-days',
  '--page-size',
  '--batch-size',
  '--iterations',
  '--cache-workers',
  '--lease-ttl-sec',
  '--query-timeout-ms',
  '--sleep-sec',
  '--abort-after-ms',
  '--vector-limit',
  '--message-limit',
  '--output',
]);

type QueryRow = Record<string, unknown>;

export interface QueryResultLike<T extends QueryRow = QueryRow> {
  rows: T[];
}

export interface PoolClientLike {
  query<T extends QueryRow = QueryRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResultLike<T>>;
  release(error?: Error): void;
}

export interface PoolLike {
  query<T extends QueryRow = QueryRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResultLike<T>>;
  connect(): Promise<PoolClientLike>;
  end(): Promise<void>;
}

export interface BaselineOptions {
  databaseUrl?: string;
  retentionDays: number;
  pageSize: number;
  batchSize: number;
  iterations: number;
  cacheWorkers: number;
  leaseTtlSec: number;
  queryTimeoutMs: number;
  sleepSec: number;
  abortAfterMs: number;
  vectorLimit: number;
  messageLimit: number;
  outputPath?: string;
}

export interface BaselineDependencies {
  poolFactory?: (databaseUrl: string, queryTimeoutMs: number) => PoolLike;
  cacheFactory?: () => CacheProbeTarget;
  now?: () => Date;
  keyFactory?: () => string;
}

export interface CacheProbeTarget {
  cache: AnswerCache;
  provider: 'upstash' | 'memory';
  distributed: boolean;
}

export interface ExplainResult {
  name: string;
  status: 'measured' | 'error';
  sql: string;
  clientElapsedMs: number;
  plan?: unknown;
  planningMs?: number | null;
  executionMs?: number | null;
  error?: string;
}

export interface ThroughputSample {
  rows: number;
  elapsedMs: number;
}

export interface ThroughputResult {
  status: 'measured' | 'error';
  table: 'chat_events' | 'chat_conversations';
  operation: 'retention-batch-selection';
  batchSize: number;
  iterations: number;
  deletePerformed: false;
  rowsSelected: number;
  elapsedMs: number;
  rowsPerSecond: number;
  samples: ThroughputSample[];
  error?: string;
}

export interface CacheLeaseRound {
  key: string;
  workers: number;
  acquired: number;
  contended: number;
  errors: number;
  elapsedMs: number;
  releaseErrors: number;
}

export interface CacheLeaseProbeResult {
  status: 'measured' | 'error';
  provider: 'upstash' | 'memory' | 'unavailable';
  distributed: boolean;
  crossProcess: false;
  workers: number;
  iterations: number;
  leaseTtlSec: number;
  exclusivePerRound: boolean;
  rounds: CacheLeaseRound[];
  error?: string;
}

export interface CancellationProbeResult {
  status: 'measured' | 'error';
  method: 'execute-cancelable-wrapper';
  sleepSec: number;
  abortAfterMs: number;
  wrapperOutcome?: 'aborted' | 'completed';
  abortObservedMs?: number;
  underlyingCompletedMs?: number;
  underlyingStillActiveAfterAbort?: boolean | null;
  serverCancellationRequested: boolean;
  notes: string[];
  error?: string;
}

export interface BaselineReport {
  schemaVersion: 1;
  generatedAt: string;
  database: {
    target: string;
    database: string;
    serverVersion: string;
    serverVersionNum: string;
    currentSchema: string;
  };
  options: Omit<BaselineOptions, 'databaseUrl' | 'outputPath'>;
  rowEstimates: unknown[];
  relationSizes: unknown[];
  indexDefinitions: unknown[];
  explains: ExplainResult[];
  purgeThroughput: ThroughputResult[];
  cancellation: CancellationProbeResult;
  cacheLease: CacheLeaseProbeResult;
  limitations: string[];
}

interface SampleValues {
  embedding: string;
  embeddingSource: 'database' | 'synthetic';
  userId: string;
  conversationId: string;
  auditAt: Date;
  auditId: number;
}

const ROW_ESTIMATES_SQL = `
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  c.relkind::text AS relation_kind,
  c.reltuples::double precision AS estimated_rows,
  c.relpages::bigint AS estimated_pages
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p', 'm')
  AND c.relname NOT LIKE '__drizzle_migrations%'
ORDER BY c.relname
`;

const RELATION_SIZES_SQL = `
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  c.relkind::text AS relation_kind,
  pg_relation_size(c.oid)::bigint AS table_bytes,
  pg_indexes_size(c.oid)::bigint AS index_bytes,
  pg_total_relation_size(c.oid)::bigint AS total_bytes
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p', 'm')
  AND c.relname NOT LIKE '__drizzle_migrations%'
ORDER BY pg_total_relation_size(c.oid) DESC, c.relname
`;

const INDEX_DEFINITIONS_SQL = `
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname
`;

const VECTOR_SEARCH_SQL = `
WITH candidates AS (
  SELECT ch.id
  FROM chunks ch
  JOIN documents doc ON doc.id = ch.document_id
  WHERE doc.deleted_at IS NULL
    AND ch.kind <> 'parent'
  ORDER BY ch.embedding <=> $1::vector
  LIMIT $2::integer
)
SELECT
  c.id,
  c.chunk_uid,
  c.document_id,
  d.document_uid,
  d.file_name,
  c.page,
  c.section_title,
  c.source,
  c.title,
  c.content,
  c.parent_chunk_id,
  c.chunk_index,
  1 - (c.embedding <=> $1::vector) AS similarity
FROM chunks c
JOIN documents d ON d.id = c.document_id
JOIN candidates cand ON cand.id = c.id
WHERE d.deleted_at IS NULL
  AND c.kind <> 'parent'
  AND (1 - (c.embedding <=> $1::vector)) > $3::real
ORDER BY similarity DESC
LIMIT $4::integer
`;

const LEXICAL_SEARCH_SQL = `
SELECT
  c.id,
  c.chunk_uid,
  c.document_id,
  d.document_uid,
  d.file_name,
  c.page,
  c.section_title,
  c.source,
  c.title,
  c.content,
  c.parent_chunk_id,
  c.chunk_index,
  ts_rank(c.tsv, plainto_tsquery('english', $1::text)) AS similarity
FROM chunks c
JOIN documents d ON d.id = c.document_id
WHERE d.deleted_at IS NULL
  AND c.kind <> 'parent'
  AND c.tsv @@ plainto_tsquery('english', $1::text)
ORDER BY similarity DESC
LIMIT $2::integer
`;

const CONVERSATION_LOOKUP_SQL = `
SELECT id, user_id, title, message_count, created_at, updated_at
FROM chat_conversations
WHERE id = $1::uuid
  AND user_id = $2::text
LIMIT 1
`;

const CONVERSATION_MESSAGES_SQL = `
SELECT id, conversation_id, turn_id, role, content, created_at
FROM chat_messages
WHERE conversation_id = $1::uuid
ORDER BY id DESC
LIMIT $2::integer
`;

const CHAT_EVENT_ANALYTICS_SQL = `
SELECT
  count(*)::bigint AS total,
  count(*) FILTER (WHERE ticket_created)::bigint AS tickets_created,
  count(*) FILTER (WHERE cache_hit)::bigint AS cache_hits,
  count(*) FILTER (WHERE out_of_domain)::bigint AS out_of_domain,
  count(*) FILTER (WHERE hallucination_blocked)::bigint AS hallucinations,
  count(*) FILTER (WHERE hit_count = 0 OR hit_count IS NULL)::bigint AS zero_results,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY retrieve_ms) AS retrieve_p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY retrieve_ms) AS retrieve_p95_ms,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY total_ms) AS total_p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms) AS total_p95_ms,
  count(DISTINCT user_id)::bigint AS unique_users
FROM chat_events
WHERE created_at >= $1::timestamptz
  AND created_at < $2::timestamptz
`;

const AUDIT_PAGINATION_SQL = `
SELECT
  a.id,
  a.kind,
  a.action,
  a.actor_id,
  u.name AS actor_name,
  a.target_type,
  a.target_id,
  a.details,
  a.at
FROM audit_events a
LEFT JOIN users u ON u.clerk_user_id = a.actor_id
WHERE a.at < $1::timestamptz
   OR (a.at = $1::timestamptz AND a.id < $2::bigint)
ORDER BY a.at DESC, a.id DESC
LIMIT $3::integer
`;

const CHAT_EVENT_RETENTION_SQL = `
SELECT id, turn_id
FROM chat_events
WHERE created_at <= $1::timestamptz
LIMIT $2::integer
`;

const CHAT_CONVERSATION_RETENTION_SQL = `
SELECT id
FROM chat_conversations
WHERE updated_at <= $1::timestamptz
ORDER BY id
LIMIT $2::integer
`;

const SAMPLE_EMBEDDING_SQL = `
SELECT embedding::text AS embedding
FROM chunks
WHERE kind <> 'parent'
LIMIT 1
`;

const SAMPLE_CONVERSATION_SQL = `
SELECT id::text AS id, user_id
FROM chat_conversations
ORDER BY updated_at DESC, id DESC
LIMIT 1
`;

const SAMPLE_AUDIT_SQL = `
SELECT id, at
FROM audit_events
ORDER BY at DESC, id DESC
LIMIT 1
`;

const DATABASE_METADATA_SQL = `
SELECT
  current_database() AS database,
  current_schema() AS current_schema,
  current_setting('server_version', true) AS server_version,
  current_setting('server_version_num', true) AS server_version_num
`;

const USAGE = `Usage: pnpm exec tsx scripts/scale-baseline.ts [options]

Read-only database scale diagnostics. DATABASE_URL is required unless
--database-url is supplied. Output is JSON suitable for attaching to a PR.

Options:
  --database-url URL       Database URL (otherwise DATABASE_URL)
  --retention-days N       Age window used by analytics/retention probes (default: ${DEFAULT_RETENTION_DAYS})
  --page-size N            Audit pagination page size (default: ${DEFAULT_PAGE_SIZE})
  --batch-size N           Retention batch size (default: ${DEFAULT_BATCH_SIZE})
  --iterations N           Throughput/cache repetitions (default: ${DEFAULT_ITERATIONS})
  --cache-workers N        Concurrent lease contenders (default: ${DEFAULT_CACHE_WORKERS})
  --lease-ttl-sec N        Lease TTL used by the cache probe (default: ${DEFAULT_LEASE_TTL_SEC})
  --query-timeout-ms N     PostgreSQL statement timeout (default: ${DEFAULT_QUERY_TIMEOUT_MS})
  --sleep-sec N             pg_sleep duration for cancellation probe (default: ${DEFAULT_SLEEP_SEC})
  --abort-after-ms N        Abort delay for cancellation probe (default: ${DEFAULT_ABORT_AFTER_MS})
  --vector-limit N          Vector result limit (default: ${DEFAULT_VECTOR_LIMIT})
  --message-limit N         Conversation message limit (default: ${DEFAULT_MESSAGE_LIMIT})
  --output PATH              Write JSON to PATH instead of stdout
  --help                    Show this help
`;

function defaultOptions(): BaselineOptions {
  return {
    retentionDays: DEFAULT_RETENTION_DAYS,
    pageSize: DEFAULT_PAGE_SIZE,
    batchSize: DEFAULT_BATCH_SIZE,
    iterations: DEFAULT_ITERATIONS,
    cacheWorkers: DEFAULT_CACHE_WORKERS,
    leaseTtlSec: DEFAULT_LEASE_TTL_SEC,
    queryTimeoutMs: DEFAULT_QUERY_TIMEOUT_MS,
    sleepSec: DEFAULT_SLEEP_SEC,
    abortAfterMs: DEFAULT_ABORT_AFTER_MS,
    vectorLimit: DEFAULT_VECTOR_LIMIT,
    messageLimit: DEFAULT_MESSAGE_LIMIT,
  };
}

function parsePositiveNumber(name: string, raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`Missing value for ${name}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name} value: ${raw}`);
  }
  return value;
}

function parsePositiveInteger(name: string, raw: string | undefined): number {
  const value = parsePositiveNumber(name, raw);
  if (!Number.isInteger(value)) throw new Error(`Invalid ${name} value: ${raw}; expected an integer`);
  return value;
}

function parseOptionValue(argv: string[], index: number, name: string): { value: string; nextIndex: number } {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return { value, nextIndex: index + 1 };
}

export function parseBaselineArgs(argv: string[]): BaselineOptions & { help?: boolean } {
  const options = defaultOptions();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--help' || argument === '-h') {
      return { ...options, help: true };
    }
    const equalIndex = argument.indexOf('=');
    const name = equalIndex >= 0 ? argument.slice(0, equalIndex) : argument;
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: ${argument}`);
    let value = equalIndex >= 0 ? argument.slice(equalIndex + 1) : undefined;
    if (value === undefined) {
      const parsed = parseOptionValue(argv, index, name);
      value = parsed.value;
      index = parsed.nextIndex;
    }
    switch (name) {
      case '--database-url':
        options.databaseUrl = value;
        break;
      case '--retention-days':
        options.retentionDays = parsePositiveNumber(name, value);
        break;
      case '--page-size':
        options.pageSize = parsePositiveInteger(name, value);
        break;
      case '--batch-size':
        options.batchSize = parsePositiveInteger(name, value);
        break;
      case '--iterations':
        options.iterations = parsePositiveInteger(name, value);
        break;
      case '--cache-workers':
        options.cacheWorkers = parsePositiveInteger(name, value);
        break;
      case '--lease-ttl-sec':
        options.leaseTtlSec = parsePositiveNumber(name, value);
        break;
      case '--query-timeout-ms':
        options.queryTimeoutMs = parsePositiveInteger(name, value);
        break;
      case '--sleep-sec':
        options.sleepSec = parsePositiveNumber(name, value);
        break;
      case '--abort-after-ms':
        options.abortAfterMs = parsePositiveInteger(name, value);
        break;
      case '--vector-limit':
        options.vectorLimit = parsePositiveInteger(name, value);
        break;
      case '--message-limit':
        options.messageLimit = parsePositiveInteger(name, value);
        break;
      case '--output':
        options.outputPath = value;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

export function redactDatabaseUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.password = '';
    for (const key of parsed.searchParams.keys()) {
      if (/(?:pass|secret|token|key)/i.test(key)) parsed.searchParams.set(key, '<redacted>');
    }
    return parsed.toString();
  } catch {
    return '<invalid DATABASE_URL>';
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/postgres(?:ql)?:\/\/[^\s)]+/gi, '<redacted DATABASE_URL>');
}

function normalise(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalise);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalise(item)]),
    );
  }
  return value;
}

export function makeSyntheticEmbedding(dimension: number): string {
  const safeDimension = Number.isInteger(dimension) && dimension > 0 ? dimension : DEFAULT_VECTOR_DIMENSION;
  return `[${Array.from({ length: safeDimension }, () => '0').join(',')}]`;
}

function resolveVectorDimension(): number {
  const value = Number(process.env.EMBEDDING_DIMENSION ?? DEFAULT_VECTOR_DIMENSION);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_VECTOR_DIMENSION;
}

function defaultPoolFactory(databaseUrl: string, queryTimeoutMs: number): PoolLike {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: queryTimeoutMs,
  }) as unknown as PoolLike;
}

async function queryRows<T extends QueryRow>(pool: PoolLike, text: string, values: readonly unknown[] = []): Promise<T[]> {
  const result = await pool.query<T>(text, values);
  return result.rows;
}

function explainTimings(plan: unknown): { planningMs: number | null; executionMs: number | null } {
  const root = Array.isArray(plan) ? plan[0] : plan;
  if (root === null || typeof root !== 'object') return { planningMs: null, executionMs: null };
  const record = root as Record<string, unknown>;
  return {
    planningMs: typeof record['Planning Time'] === 'number' ? record['Planning Time'] : null,
    executionMs: typeof record['Execution Time'] === 'number' ? record['Execution Time'] : null,
  };
}

async function runExplain(
  pool: PoolLike,
  name: string,
  sql: string,
  values: readonly unknown[],
): Promise<ExplainResult> {
  const started = performance.now();
  try {
    const rows = await queryRows<{ 'QUERY PLAN'?: unknown }>(
      pool,
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
      values,
    );
    const plan = rows[0]?.['QUERY PLAN'] ?? null;
    const timings = explainTimings(plan);
    return {
      name,
      status: 'measured',
      sql: sql.trim(),
      clientElapsedMs: Math.round((performance.now() - started) * 100) / 100,
      plan: normalise(plan),
      planningMs: timings.planningMs,
      executionMs: timings.executionMs,
    };
  } catch (error) {
    return {
      name,
      status: 'error',
      sql: sql.trim(),
      clientElapsedMs: Math.round((performance.now() - started) * 100) / 100,
      error: safeError(error),
    };
  }
}

async function sampleValues(pool: PoolLike): Promise<SampleValues> {
  const syntheticEmbedding = makeSyntheticEmbedding(resolveVectorDimension());
  let embedding = syntheticEmbedding;
  let embeddingSource: SampleValues['embeddingSource'] = 'synthetic';
  try {
    const rows = await queryRows<{ embedding?: unknown }>(pool, SAMPLE_EMBEDDING_SQL);
    const candidate = rows[0]?.embedding;
    if (typeof candidate === 'string' && candidate.startsWith('[')) {
      embedding = candidate;
      embeddingSource = 'database';
    }
  } catch {
    // The related explain probe reports a missing table/schema error. Keep the
    // rest of the report useful by retaining a valid synthetic vector literal.
  }

  let userId = DEFAULT_USER_ID;
  let conversationId = EMPTY_UUID;
  try {
    const rows = await queryRows<{ id?: unknown; user_id?: unknown }>(pool, SAMPLE_CONVERSATION_SQL);
    if (typeof rows[0]?.id === 'string') conversationId = rows[0].id;
    if (typeof rows[0]?.user_id === 'string') userId = rows[0].user_id;
  } catch {
    // The conversation explain probes remain valid with a non-matching UUID.
  }

  let auditAt = new Date();
  let auditId = 2_147_483_647;
  try {
    const rows = await queryRows<{ id?: unknown; at?: unknown }>(pool, SAMPLE_AUDIT_SQL);
    const candidateAt = rows[0]?.at;
    if (candidateAt instanceof Date) auditAt = candidateAt;
    else if (typeof candidateAt === 'string') auditAt = new Date(candidateAt);
    const candidateId = Number(rows[0]?.id);
    if (Number.isInteger(candidateId) && candidateId > 0) auditId = candidateId;
  } catch {
    // The audit explain probe reports a missing table/schema error if needed.
  }

  return { embedding, embeddingSource, userId, conversationId, auditAt, auditId };
}

function period(now: Date, retentionDays: number): { from: Date; to: Date; cutoff: Date } {
  const to = new Date(now);
  const from = new Date(to.getTime() - retentionDays * 86_400_000);
  return { from, to, cutoff: from };
}

async function runExplainSuite(
  pool: PoolLike,
  options: BaselineOptions,
  now: Date,
): Promise<ExplainResult[]> {
  const samples = await sampleValues(pool);
  const { from, to, cutoff } = period(now, options.retentionDays);
  const candidatePool = Math.max(options.vectorLimit * 10, 50);
  const results: ExplainResult[] = [];
  results.push(
    await runExplain(pool, 'vector-search', VECTOR_SEARCH_SQL, [
      samples.embedding,
      candidatePool,
      0,
      options.vectorLimit,
    ]),
  );
  results.push(await runExplain(pool, 'lexical-search', LEXICAL_SEARCH_SQL, ['password reset', options.vectorLimit]));
  results.push(
    await runExplain(pool, 'conversation-lookup', CONVERSATION_LOOKUP_SQL, [samples.conversationId, samples.userId]),
  );
  results.push(
    await runExplain(pool, 'conversation-messages', CONVERSATION_MESSAGES_SQL, [
      samples.conversationId,
      options.messageLimit,
    ]),
  );
  results.push(await runExplain(pool, 'recent-chat-event-analytics', CHAT_EVENT_ANALYTICS_SQL, [from, to]));
  results.push(
    await runExplain(pool, 'audit-pagination', AUDIT_PAGINATION_SQL, [
      samples.auditAt,
      samples.auditId,
      options.pageSize,
    ]),
  );
  results.push(
    await runExplain(pool, 'chat-event-retention-selection', CHAT_EVENT_RETENTION_SQL, [cutoff, options.batchSize]),
  );
  results.push(
    await runExplain(pool, 'chat-conversation-retention-selection', CHAT_CONVERSATION_RETENTION_SQL, [
      cutoff,
      options.batchSize,
    ]),
  );
  return results;
}

async function measureThroughput(
  pool: PoolLike,
  table: ThroughputResult['table'],
  sql: string,
  cutoff: Date,
  batchSize: number,
  iterations: number,
): Promise<ThroughputResult> {
  const samples: ThroughputSample[] = [];
  const startedAll = performance.now();
  try {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const started = performance.now();
      const rows = await queryRows(pool, sql, [cutoff, batchSize]);
      samples.push({
        rows: rows.length,
        elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      });
    }
    const elapsedMs = Math.round((performance.now() - startedAll) * 100) / 100;
    const rowsSelected = samples.reduce((sum, sample) => sum + sample.rows, 0);
    return {
      status: 'measured',
      table,
      operation: 'retention-batch-selection',
      batchSize,
      iterations,
      deletePerformed: false,
      rowsSelected,
      elapsedMs,
      rowsPerSecond: elapsedMs > 0 ? Math.round((rowsSelected / (elapsedMs / 1_000)) * 100) / 100 : 0,
      samples,
    };
  } catch (error) {
    return {
      status: 'error',
      table,
      operation: 'retention-batch-selection',
      batchSize,
      iterations,
      deletePerformed: false,
      rowsSelected: samples.reduce((sum, sample) => sum + sample.rows, 0),
      elapsedMs: Math.round((performance.now() - startedAll) * 100) / 100,
      rowsPerSecond: 0,
      samples,
      error: safeError(error),
    };
  }
}

export async function runPurgeThroughput(
  pool: PoolLike,
  options: Pick<BaselineOptions, 'retentionDays' | 'batchSize' | 'iterations'>,
  now = new Date(),
): Promise<ThroughputResult[]> {
  const cutoff = period(now, options.retentionDays).cutoff;
  return [
    await measureThroughput(
      pool,
      'chat_events',
      CHAT_EVENT_RETENTION_SQL,
      cutoff,
      options.batchSize,
      options.iterations,
    ),
    await measureThroughput(
      pool,
      'chat_conversations',
      CHAT_CONVERSATION_RETENTION_SQL,
      cutoff,
      options.batchSize,
      options.iterations,
    ),
  ];
}

export async function runCancellationProbe(
  pool: PoolLike,
  options: Pick<BaselineOptions, 'sleepSec' | 'abortAfterMs'>,
): Promise<CancellationProbeResult> {
  let client: PoolClientLike | undefined;
  const result: CancellationProbeResult = {
    status: 'error',
    method: 'execute-cancelable-wrapper',
    sleepSec: options.sleepSec,
    abortAfterMs: options.abortAfterMs,
    serverCancellationRequested: false,
    notes: [
      'The probe sends pg_cancel_backend from the pool when the request signal aborts.',
      'Application node-postgres searches use a dedicated connection and wait for query/cancel settlement before release; Neon uses the documented timeout fallback.',
      'pg_stat_activity observation is best effort and requires permission to inspect the probe backend.',
    ],
  };
  try {
    client = await pool.connect();
    const pidResult = await client.query<{ pid?: unknown }>('SELECT pg_backend_pid() AS pid');
    const backendPid = Number(pidResult.rows[0]?.pid);
    const started = performance.now();
    let underlying: Promise<QueryResultLike<{ slept?: unknown }>> | undefined;
    let underlyingCompletedMs: number | undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('baseline cancellation probe aborted')), options.abortAfterMs);
    const wrapper = executeCancelable({
      operation: () => {
        const query = client!.query<{ slept?: unknown }>(
          'SELECT pg_sleep($1::double precision) AS slept',
          [options.sleepSec],
        );
        underlying = query;
        return query;
      },
      signal: controller.signal,
      cancel: Number.isSafeInteger(backendPid) && backendPid > 0
        ? async () => {
            result.serverCancellationRequested = true;
            await pool.query('SELECT pg_cancel_backend($1::integer)', [backendPid]);
          }
        : undefined,
    });
    let wrapperOutcome: 'aborted' | 'completed';
    try {
      await wrapper;
      wrapperOutcome = 'completed';
    } catch {
      wrapperOutcome = 'aborted';
    }
    clearTimeout(timer);
    const abortObservedMs = Math.round((performance.now() - started) * 100) / 100;
    let underlyingStillActiveAfterAbort: boolean | null = null;
    if (wrapperOutcome === 'aborted' && Number.isInteger(backendPid)) {
      try {
        const activity = await queryRows<{ state?: unknown; query?: unknown }>(
          pool,
          `SELECT state, query
           FROM pg_stat_activity
           WHERE pid = $1::integer`,
          [backendPid],
        );
        underlyingStillActiveAfterAbort = activity.some(
          (row) => row.state === 'active' && typeof row.query === 'string' && row.query.includes('pg_sleep'),
        );
      } catch {
        result.notes.push('Could not inspect pg_stat_activity for the probe backend.');
      }
    }
    let underlyingError: unknown;
    if (underlying) {
      try {
        await underlying;
        underlyingCompletedMs = Math.round((performance.now() - started) * 100) / 100;
      } catch (error) {
        underlyingCompletedMs = Math.round((performance.now() - started) * 100) / 100;
        underlyingError = error;
      }
    }
    result.status = underlyingError === undefined ? 'measured' : 'error';
    result.wrapperOutcome = wrapperOutcome;
    result.abortObservedMs = abortObservedMs;
    if (underlyingCompletedMs !== undefined) result.underlyingCompletedMs = underlyingCompletedMs;
    result.underlyingStillActiveAfterAbort = underlyingStillActiveAfterAbort;
    if (underlyingError !== undefined) result.error = safeError(underlyingError);
    return result;
  } catch (error) {
    result.error = safeError(error);
    return result;
  } finally {
    client?.release();
  }
}

function defaultCacheFactory(): CacheProbeTarget {
  const urlConfigured = Boolean(process.env.UPSTASH_REDIS_REST_URL);
  const tokenConfigured = Boolean(process.env.UPSTASH_REDIS_REST_TOKEN);
  if (urlConfigured || tokenConfigured) {
    if (!urlConfigured || !tokenConfigured) {
      throw new Error(
        'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must both be set to probe the distributed cache; refusing to mask the configuration error with the memory fallback.',
      );
    }
    return { cache: createUpstashAnswerCache(), provider: 'upstash', distributed: true };
  }
  return { cache: createInMemoryAnswerCache(), provider: 'memory', distributed: false };
}

export async function runCacheLeaseProbe(
  target: CacheProbeTarget,
  options: Pick<BaselineOptions, 'cacheWorkers' | 'iterations' | 'leaseTtlSec'>,
  dependencies: Pick<BaselineDependencies, 'keyFactory'> = {},
): Promise<CacheLeaseProbeResult> {
  const rounds: CacheLeaseRound[] = [];
  const coordination = target.cache.coordination;
  const legacyLease = coordination ? undefined : target.cache.lease;
  if (!coordination && !legacyLease) {
    return {
      status: 'error',
      provider: target.provider,
      distributed: target.distributed,
      crossProcess: false,
      workers: options.cacheWorkers,
      iterations: options.iterations,
      leaseTtlSec: options.leaseTtlSec,
      exclusivePerRound: false,
      rounds,
      error: 'Configured answer cache does not expose the optional lease port.',
    };
  }

  const keyFactory = dependencies.keyFactory ?? randomUUID;
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const key = `scale-baseline:${keyFactory()}`;
    const started = performance.now();
    const attempts = await Promise.all(
      Array.from({ length: options.cacheWorkers }, async () => {
        try {
          if (coordination) {
            const acquired = await coordination.acquire(key, options.leaseTtlSec);
            if (acquired.kind === 'acquired') return { outcome: 'acquired' as const, handle: acquired.handle };
            return acquired.kind === 'held'
              ? { outcome: 'contended' as const }
              : { outcome: 'error' as const };
          }
          const token = await legacyLease!.tryAcquire(key, options.leaseTtlSec);
          return token === null
            ? { outcome: 'contended' as const }
            : { outcome: 'acquired' as const, token };
        } catch {
          return { outcome: 'error' as const };
        }
      }),
    );
    let releaseErrors = 0;
    await Promise.all(
      attempts.flatMap((attempt) => (attempt.outcome === 'acquired' ? [attempt] : [])).map(async (attempt) => {
        try {
          if ('handle' in attempt) {
            const released = await (attempt.handle as LeaseHandle).release();
            if (released.kind === 'unavailable') releaseErrors += 1;
          } else if ('token' in attempt) {
            await legacyLease!.release(key, attempt.token);
          }
        } catch {
          releaseErrors += 1;
        }
      }),
    );
    rounds.push({
      key,
      workers: options.cacheWorkers,
      acquired: attempts.filter((attempt) => attempt.outcome === 'acquired').length,
      contended: attempts.filter((attempt) => attempt.outcome === 'contended').length,
      errors: attempts.filter((attempt) => attempt.outcome === 'error').length,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      releaseErrors,
    });
  }
  const exclusivePerRound = rounds.every((round) => round.acquired <= 1 && round.errors === 0);
  return {
    status: 'measured',
    provider: target.provider,
    distributed: target.distributed,
    crossProcess: false,
    workers: options.cacheWorkers,
    iterations: options.iterations,
    leaseTtlSec: options.leaseTtlSec,
    exclusivePerRound,
    rounds,
  };
}

async function collectBaseline(
  options: BaselineOptions,
  dependencies: BaselineDependencies = {},
): Promise<BaselineReport> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required. Use a read-only/staging URL for this diagnostic.');
  }
  const pool = (dependencies.poolFactory ?? defaultPoolFactory)(databaseUrl, options.queryTimeoutMs);
  const now = dependencies.now?.() ?? new Date();
  try {
    const metadata = (await queryRows<{
      database?: unknown;
      current_schema?: unknown;
      server_version?: unknown;
      server_version_num?: unknown;
    }>(pool, DATABASE_METADATA_SQL))[0];
    if (!metadata) throw new Error('Database metadata query returned no row.');
    const relationSizes = await queryRows(pool, RELATION_SIZES_SQL);
    const rowEstimates = await queryRows(pool, ROW_ESTIMATES_SQL);
    const indexDefinitions = await queryRows(pool, INDEX_DEFINITIONS_SQL);
    const [explains, purgeThroughput, cancellation] = await Promise.all([
      runExplainSuite(pool, options, now),
      runPurgeThroughput(pool, options, now),
      runCancellationProbe(pool, options),
    ]);
    let cacheLease: CacheLeaseProbeResult;
    try {
      const target = dependencies.cacheFactory?.() ?? defaultCacheFactory();
      cacheLease = await runCacheLeaseProbe(target, options, dependencies);
    } catch (error) {
      cacheLease = {
        status: 'error',
        provider: 'unavailable',
        distributed: false,
        crossProcess: false,
        workers: options.cacheWorkers,
        iterations: options.iterations,
        leaseTtlSec: options.leaseTtlSec,
        exclusivePerRound: false,
        rounds: [],
        error: safeError(error),
      };
    }
    return {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      database: {
        target: redactDatabaseUrl(databaseUrl),
        database: String(metadata.database ?? ''),
        serverVersion: String(metadata.server_version ?? ''),
        serverVersionNum: String(metadata.server_version_num ?? ''),
        currentSchema: String(metadata.current_schema ?? ''),
      },
      options: {
        retentionDays: options.retentionDays,
        pageSize: options.pageSize,
        batchSize: options.batchSize,
        iterations: options.iterations,
        cacheWorkers: options.cacheWorkers,
        leaseTtlSec: options.leaseTtlSec,
        queryTimeoutMs: options.queryTimeoutMs,
        sleepSec: options.sleepSec,
        abortAfterMs: options.abortAfterMs,
        vectorLimit: options.vectorLimit,
        messageLimit: options.messageLimit,
      },
      rowEstimates: normalise(rowEstimates) as unknown[],
      relationSizes: normalise(relationSizes) as unknown[],
      indexDefinitions: normalise(indexDefinitions) as unknown[],
      explains,
      purgeThroughput,
      cancellation,
      cacheLease,
      limitations: [
        'This report runs read-only SELECT/EXPLAIN/pg_sleep probes; purge throughput is selection-only and never issues DELETE.',
        'EXPLAIN ANALYZE executes the read query and can consume CPU/IO on a large database; use a read replica or staging clone when possible.',
        'Cache contention is measured within this process. Set both Upstash variables to measure the distributed provider; cross-process exclusivity requires a multi-process test.',
        'No timing or plan thresholds are asserted here because runner and database performance vary. Compare this report with later runs.',
      ],
    };
  } finally {
    await pool.end();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseBaselineArgs(argv);
  if (parsed.help) {
    process.stdout.write(USAGE);
    return;
  }
  const report = await collectBaseline(parsed);
  const rendered = `${JSON.stringify(normalise(report), null, 2)}\n`;
  if (parsed.outputPath) {
    writeFileSync(parsed.outputPath, rendered, { encoding: 'utf8', mode: 0o600 });
    console.log(`[scale-baseline] Wrote ${parsed.outputPath}`);
  } else {
    process.stdout.write(rendered);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(`[scale-baseline] failed: ${safeError(error)}`);
    process.exitCode = 1;
  });
}
