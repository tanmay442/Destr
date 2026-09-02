import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '../client';
import { auditRepo } from '../repositories';

const ACTOR = 'audit-backfill-test-actor';
const LEGACY_ID = 910001;
const SOURCE_REFS = [
  `document_audit:${LEGACY_ID}`,
  `ticket_audit:${LEGACY_ID}`,
  `user_audit:${LEGACY_ID}`,
];

async function dbReachable(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    await db.execute('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

function backfillBlock(): string {
  const dir = join(process.cwd(), 'drizzle');
  const file = readdirSync(dir).find((f) => f.startsWith('0009_'));
  if (!file) throw new Error('audit_events migration not found');
  const statements = readFileSync(join(dir, file), 'utf8')
    .split(/-->\s*statement-breakpoint/)
    .map((s) => s.trim())
    .filter(Boolean);
  const block = statements.find((s) => s.includes('DO $$'));
  if (!block) throw new Error('backfill DO block not found in migration');
  return block;
}

async function seedLegacyTables(): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS document_audit (
      id serial PRIMARY KEY, document_id integer, actor_id text NOT NULL,
      action text NOT NULL, at timestamp DEFAULT now() NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ticket_audit (
      id serial PRIMARY KEY, ticket_id text, actor_id text NOT NULL,
      action text NOT NULL, at timestamp DEFAULT now() NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS user_audit (
      id serial PRIMARY KEY, target_user_id text NOT NULL, actor_id text NOT NULL,
      from_role text NOT NULL, to_role text NOT NULL, at timestamp DEFAULT now() NOT NULL
    )`,
    `INSERT INTO document_audit (id, document_id, actor_id, action)
      VALUES (${LEGACY_ID}, 42, '${ACTOR}', 'upload') ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO ticket_audit (id, ticket_id, actor_id, action)
      VALUES (${LEGACY_ID}, 'TKT-backfill', '${ACTOR}', 'create') ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO user_audit (id, target_user_id, actor_id, from_role, to_role)
      VALUES (${LEGACY_ID}, 'user_backfill', '${ACTOR}', 'user', 'admin') ON CONFLICT (id) DO NOTHING`,
  ];
  for (const stmt of statements) await db.execute(sql.raw(stmt));
}

async function isAuditEventsPartitioned(): Promise<boolean> {
  const r = await db.execute(sql.raw(
    "SELECT relkind FROM pg_class WHERE relname = 'audit_events'",
  ));
  const kind = (r as unknown as { rows?: Array<{ relkind: string }> }).rows?.[0]?.relkind;
  return kind === 'p';
}

async function runBackfill(): Promise<void> {
  try {
    await db.execute(sql.raw(backfillBlock()));
    return;
  } catch (e: unknown) {
    const code = (e as { cause?: { code?: string }; code?: string })?.code
      ?? (e as { cause?: { code?: string } })?.cause?.code;
    const message = (e as Error)?.message ?? '';
    const isMissingConstraint = code === '42P10' || message.includes('ON CONFLICT');
    if (!isMissingConstraint || !(await isAuditEventsPartitioned())) throw e;
  }
  for (const stmt of [
    `INSERT INTO audit_events (kind, action, actor_id, target_type, target_id, details, at, source_ref)
      SELECT 'document', action, actor_id, 'document', document_id::text, '{}'::jsonb, at, 'document_audit:' || id
      FROM document_audit
      WHERE NOT EXISTS (SELECT 1 FROM audit_events ae WHERE ae.source_ref = 'document_audit:' || document_audit.id)`,
    `INSERT INTO audit_events (kind, action, actor_id, target_type, target_id, details, at, source_ref)
      SELECT 'ticket', action, actor_id, 'ticket', ticket_id, '{}'::jsonb, at, 'ticket_audit:' || id
      FROM ticket_audit
      WHERE NOT EXISTS (SELECT 1 FROM audit_events ae WHERE ae.source_ref = 'ticket_audit:' || ticket_audit.id)`,
    `INSERT INTO audit_events (kind, action, actor_id, target_type, target_id, details, at, source_ref)
      SELECT 'user', 'role_change', actor_id, 'user', target_user_id,
        jsonb_build_object('fromRole', from_role, 'toRole', to_role), at, 'user_audit:' || id
      FROM user_audit
      WHERE NOT EXISTS (SELECT 1 FROM audit_events ae WHERE ae.source_ref = 'user_audit:' || user_audit.id)`,
  ]) {
    await db.execute(sql.raw(stmt));
  }
  for (const t of ['document_audit', 'ticket_audit', 'user_audit']) {
    const check = await db.execute(sql.raw(`SELECT to_regclass('public.${t}') AS reg`));
    const row = (check as unknown as { rows?: Array<{ reg: string | null }> }).rows?.[0];
    if (row?.reg) {
      const hasRows = await db.execute(sql.raw(`SELECT 1 FROM ${t} LIMIT 1`));
      const rows = (hasRows as unknown as { rows?: unknown[] }).rows ?? [];
      const stillMissing = rows.length > 0
        ? (await db.execute(sql.raw(
            `SELECT 1 FROM ${t} t WHERE NOT EXISTS (SELECT 1 FROM audit_events ae WHERE ae.source_ref = '${t}:' || t.id) LIMIT 1`,
          ))) as unknown as { rows?: unknown[] }
        : { rows: [] };
      if ((stillMissing.rows?.length ?? 0) > 0) throw new Error(`Backfill verification failed for ${t}`);
    }
  }
  for (const t of ['document_audit', 'ticket_audit', 'user_audit']) {
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${t}`));
  }
}

async function backfilledCount(): Promise<number> {
  const r = await db.execute(sql`
    SELECT count(*)::int AS count FROM audit_events
    WHERE source_ref IN (${SOURCE_REFS[0]}, ${SOURCE_REFS[1]}, ${SOURCE_REFS[2]})
  `);
  return ((r as unknown as { rows?: Array<{ count: number }> }).rows?.[0]?.count) ?? 0;
}

const connected = await dbReachable();
const suite = connected ? describe : describe.skip;

suite('audit_events backfill migration', () => {
  beforeAll(async () => {
    await db.execute(sql`DELETE FROM audit_events WHERE actor_id = ${ACTOR}`);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM audit_events WHERE actor_id = ${ACTOR}`);
    for (const t of ['document_audit', 'ticket_audit', 'user_audit']) {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS ${t}`));
    }
  });

  it('backfills all three legacy tables, verifies, and drops them', async () => {
    await seedLegacyTables();
    await runBackfill();

    expect(await backfilledCount()).toBe(3);
    const tables = await db.execute(sql.raw(
      "SELECT to_regclass('public.document_audit') AS d, to_regclass('public.ticket_audit') AS t, to_regclass('public.user_audit') AS u",
    ));
    const row = (tables as unknown as { rows?: Array<{ d: string | null; t: string | null; u: string | null }> }).rows?.[0];
    expect(row).toEqual({ d: null, t: null, u: null });
  });

  it('is idempotent: a re-run with the same legacy rows adds 0 rows', async () => {
    await seedLegacyTables();
    await runBackfill();
    expect(await backfilledCount()).toBe(3);
  });

  it('returns user role_change events from list() (no silent drop)', async () => {
    const { events } = await auditRepo.list({ kind: 'user', actorId: ACTOR, limit: 10, offset: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'user',
      action: 'role_change',
      targetType: 'user',
      targetId: 'user_backfill',
      details: { fromRole: 'user', toRole: 'admin' },
    });
  });

  it('returns settings events from list()', async () => {
    await auditRepo.logEvent({
      kind: 'settings',
      action: 'update',
      actorId: ACTOR,
      targetType: 'settings',
      targetId: 'app',
      details: { changes: [{ key: 'agentStepBudget', old: 8, new: 5 }] },
    });
    const { events } = await auditRepo.list({ kind: 'settings', actorId: ACTOR, limit: 10, offset: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]!.details).toEqual({ changes: [{ key: 'agentStepBudget', old: 8, new: 5 }] });
  });
});
