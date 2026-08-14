import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { eq, isNull, sql, SQL } from 'drizzle-orm';
import { ChatEventBatcher } from '../chat-events-repo';
import { chatEvents, chatFeedback, auditEvents, tickets, users, auditDeadLetter } from '../schema';
import { db } from '../client';
import type { ChatEventInput } from '@app/domain';

const dialect = new PgDialect();

function makeExecuteClient(rows: unknown[]) {
  const executed: SQL[] = [];
  const client = {
    execute(query: SQL) {
      executed.push(query);
      return Promise.resolve({ rows });
    },
  };
  return { client: client as never, executed };
}

function compiled(executed: SQL[], index = executed.length - 1): string {
  return dialect.sqlToQuery(executed[index]!).sql.toLowerCase();
}

function makeSelectClient(selectRows: unknown[], byModeRows: unknown[] = []) {
  let calls = 0;
  const client = {
    select() {
      return {
        from() {
          return {
            where() {
              calls += 1;
              const promise = Promise.resolve(calls === 1 ? selectRows : byModeRows) as Promise<unknown[]> & {
                groupBy: () => Promise<unknown[]>;
              };
              promise.groupBy = () => Promise.resolve(byModeRows);
              return promise;
            },
          };
        },
      };
    },
  };
  return { client: client as never };
}

type Insert = { table: unknown; values: unknown };

function makeFakeClient(opts: { failChatInsert?: boolean } = {}) {
  const inserts: Insert[] = [];
  const client = {
    insert(table: unknown) {
      return {
        async values(values: unknown) {
          if (table === chatEvents && opts.failChatInsert) throw new Error('insert boom');
          inserts.push({ table, values });
        },
      };
    },
  };
  return { client: client as never, inserts };
}

const sample: ChatEventInput = { userId: 'u1', query: 'q', mode: 'vector' };

describe('ChatEventBatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('buffers records and flushes them as one insert', async () => {
    const { client, inserts } = makeFakeClient();
    const batcher = new ChatEventBatcher(client);
    batcher.record(sample);
    batcher.record({ ...sample, mode: 'agentic' });
    expect(inserts).toHaveLength(0);
    await batcher.flush();
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.table).toBe(chatEvents);
    expect(inserts[0]!.values as unknown[]).toHaveLength(2);
  });

  it('auto-flushes when the buffer reaches the max size', async () => {
    const { client, inserts } = makeFakeClient();
    const batcher = new ChatEventBatcher(client);
    for (let i = 0; i < 100; i++) batcher.record(sample);
    await vi.runOnlyPendingTimersAsync();
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.values as unknown[]).toHaveLength(100);
  });

  it('auto-flushes on the interval timer', async () => {
    const { client, inserts } = makeFakeClient();
    const batcher = new ChatEventBatcher(client);
    batcher.record(sample);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(inserts).toHaveLength(1);
  });

  it('uses the injected flush scheduler instead of the interval timer', async () => {
    const { client, inserts } = makeFakeClient();
    const scheduled: Array<() => void> = [];
    const batcher = new ChatEventBatcher(client, { flushScheduler: (fn) => scheduled.push(fn) });
    batcher.record(sample);
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    await vi.runOnlyPendingTimersAsync();
    expect(inserts).toHaveLength(1);
  });

  it('falls back to the interval timer when the flush scheduler throws', async () => {
    const { client, inserts } = makeFakeClient();
    const batcher = new ChatEventBatcher(client, {
      flushScheduler: () => {
        throw new Error('outside request scope');
      },
    });
    batcher.record(sample);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(inserts).toHaveLength(1);
  });

  it('serializes a size-triggered flush behind an in-flight flush', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
let insertCalls = 0;
    const client = {
      insert() {
        return {
          async values() {
            insertCalls += 1;
            if (insertCalls === 1) await gate;
          },
        };
      },
    };
    const batcher = new ChatEventBatcher(client as never);
    batcher.record(sample);
    const first = batcher.flush();
    batcher.record(sample);
    const second = batcher.flush();
    expect(insertCalls).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(insertCalls).toBe(2);
  });

  it('counts dropped batches when the dead-letter insert also fails', async () => {
    let calls = 0;
    const client = {
      insert() {
        return {
          async values() {
            calls += 1;
            throw new Error('outage');
          },
        };
      },
    };
    const batcher = new ChatEventBatcher(client as never);
    batcher.record(sample);
    await batcher.flush();
    expect(calls).toBe(2);
    expect(batcher.droppedBatchCount).toBe(1);
  });

  it('dead-letters the batch when the primary insert fails', async () => {
    const { client, inserts } = makeFakeClient({ failChatInsert: true });
    const batcher = new ChatEventBatcher(client);
    batcher.record(sample);
    await batcher.flush();
    const dl = inserts.find((i) => i.table === auditDeadLetter);
    expect(dl).toBeDefined();
    expect((dl!.values as { kind: string }).kind).toBe('chat_event');
    expect((dl!.values as { payload: unknown[] }).payload).toHaveLength(1);
    expect(batcher.droppedBatchCount).toBe(0);
  });

  it('flush is a no-op on an empty buffer', async () => {
    const { client, inserts } = makeFakeClient();
    await new ChatEventBatcher(client).flush();
    expect(inserts).toHaveLength(0);
  });

  it('purgeUserData removes feedback for the affected turns before the events', async () => {
    const { client, executed } = makeExecuteClient([{ id: 1 }, { id: 2 }]);
    const result = await new ChatEventBatcher(client).purgeUserData('u1');
    expect(result).toEqual({ deletedCount: 2 });
    const query = compiled(executed);
    expect(query).toContain('delete from "chat_feedback"');
    expect(query).toContain('delete from "chat_events"');
  });

  it('purgeUserData also removes the tickets, audit trail and users row', async () => {
    const { client, executed } = makeExecuteClient([{ id: 1 }]);
    await new ChatEventBatcher(client).purgeUserData('u1');
    const query = compiled(executed);
    expect(query).toContain('delete from "tickets"');
    expect(query).toContain('delete from "audit_events"');
    expect(query).toContain('"audit_events"."kind" = \'ticket\'');
    expect(query).toContain('delete from "users"');
    expect(query).toContain('select id from removed_events');
  });

  it('purgeOlderThan removes feedback for the affected turns before the events', async () => {
    const { client, executed } = makeExecuteClient([{ id: 1 }]);
    const result = await new ChatEventBatcher(client).purgeOlderThan(new Date());
    expect(result).toEqual({ deletedCount: 1 });
    const query = compiled(executed);
    expect(query).toContain('delete from "chat_feedback"');
    expect(query).toContain('delete from "chat_events"');
  });

  it('anonymizeUserData redacts the user, query and meta references', async () => {
    const { client, executed } = makeExecuteClient([{ id: 7 }]);
    const result = await new ChatEventBatcher(client).anonymizeUserData('u1');
    expect(result).toEqual({ updatedCount: 1 });
    const query = compiled(executed);
    expect(query).toContain('user_id = null');
    expect(query).not.toContain("user_id = 'redacted'");
    expect(query).toContain(`- 'documentids'`);
    expect(query).toContain(`- 'ticketid'`);
  });

  it('anonymizeUserData redacts tickets, the users row and scrubs audit details', async () => {
    const { client, executed } = makeExecuteClient([{ id: 7 }]);
    await new ChatEventBatcher(client).anonymizeUserData('u1');
    const query = compiled(executed);
    expect(query).toContain('update "tickets"');
    expect(query).toContain("name = 'redacted'");
    expect(query).toContain("email = 'redacted'");
    expect(query).toContain("issue = 'redacted'");
    expect(query).toContain('update "users"');
    expect(query).toContain('image_url = null');
    expect(query).toContain('last_seen_at = null');
    expect(query).toContain("email = 'redacted-' ||");
    expect(query).toContain("'@redacted.invalid'");
    expect(query).toContain('update "audit_events"');
    expect(query).toContain('set details = \'{}\'');
    expect(query).toContain('select id from redacted_events');
  });

  it('getModeComparison treats empty and whitespace-only queries as wordless', async () => {
    const queries: SQL[] = [];
    const row = {
      mode: 'vector', total: 0, avgTokens: 0, avgMaxSimilarity: 0, tickets: 0,
      hallucinations: 0, totalP50: 0, totalP95: 0, short: 0, medium: 0, long: 0,
    };
    const client = {
      select(fields: Record<string, SQL>) {
        queries.push(...Object.values(fields).filter((f): f is SQL => f instanceof SQL));
        return {
          from() {
            return {
              where() {
                return {
                  groupBy: () => Promise.resolve([row]),
                };
              },
            };
          },
        };
      },
    };
    const result = await new ChatEventBatcher(client as never).getModeComparison();
    expect(result).toEqual([{
      mode: 'vector',
      total: 0,
      avgTokensPerQuery: 0,
      avgMaxSimilarity: 0,
      ticketRate: 0,
      hallucinationRate: 0,
      totalP50Ms: 0,
      totalP95Ms: 0,
      queryLengthBuckets: { short: 0, medium: 0, long: 0 },
    }]);
    const compiledQueries = queries.map((q) => dialect.sqlToQuery(q).sql.toLowerCase());
    expect(compiledQueries.some((q) => q.includes('nullif(btrim'))).toBe(true);
  });

  it('getMetrics maps the aggregate row and derives the corrected rates', async () => {
    const { client } = makeSelectClient([
      {
        total: 10,
        ticketsCreated: 2,
        selfServe: 3,
        outOfDomain: 1,
        zeroResult: 4,
        cacheHits: 1,
        hallucinations: 0,
        agenticTotal: 4,
        agenticRetries: 1,
        retrieveP50: 12.5,
        retrieveP95: 30,
        generateP50: 8,
        generateP95: 20,
        totalP50: 20,
        totalP95: 60,
        tokensIn: 100,
        tokensOut: 300,
        uniqueUsers: 3,
      },
    ]);
    const result = await new ChatEventBatcher(client).getMetrics();
    expect(result.ticketCreationRate).toBe(0.2);
    expect(result.selfServeSuccessRate).toBe(0.3);
    expect(result.zeroResultRate).toBe(0.4);
    expect(result.agenticRetryRate).toBe(0.25);
    expect(result.outOfDomainRate).toBe(0.1);
    expect(result.cacheHitRate).toBe(0.1);
    expect(result.uniqueUsers).toBe(3);
  });

  it('getCacheBusterQueries maps repeated-miss queries', async () => {
    const { client } = makeExecuteClient([{ query: 'reset key', misses: 4 }]);
    const result = await new ChatEventBatcher(client).getCacheBusterQueries(5);
    expect(result).toEqual([{ query: 'reset key', misses: 4 }]);
  });

  it('getDocumentUtility joins meta.documentIds to documents with p95 similarity', async () => {
    const { client } = makeExecuteClient([
      { document_id: 3, file_name: 'guide.pdf', retrieval_count: 12, p95_similarity: 0.88, ticket_conversion_rate: 0.25 },
    ]);
    const result = await new ChatEventBatcher(client).getDocumentUtility(20);
    expect(result).toEqual([
      { documentId: 3, fileName: 'guide.pdf', retrievalCount: 12, p95Similarity: 0.88, ticketConversionRate: 0.25 },
    ]);
  });

  it('getZeroHitDocuments returns documents never referenced via meta containment', async () => {
    const { client } = makeExecuteClient([
      { document_id: 7, file_name: 'stale.pdf', created_at: '2026-01-01T00:00:00Z' },
    ]);
    const result = await new ChatEventBatcher(client).getZeroHitDocuments(20);
    expect(result).toEqual([{ documentId: 7, fileName: 'stale.pdf', createdAt: '2026-01-01T00:00:00Z' }]);
  });

  it('getTurnsToTicket sessionizes with lag and buckets first ticket turns', async () => {
    const { client, executed } = makeExecuteClient([
      {
        total_sessions: 3,
        avg_turns: '2.33',
        first_turns: [
          { turns: 1 },
          { turns: 2 },
          { turns: 5 },
        ],
      },
    ]);
    const result = await new ChatEventBatcher(client).getTurnsToTicket();
    expect(result.ticketSessions).toBe(3);
    expect(result.avgTurns).toBe(2.33);
    expect(result.buckets).toEqual([
      { label: '1', turns: 1, count: 1 },
      { label: '2', turns: 2, count: 1 },
      { label: '3', turns: 3, count: 0 },
      { label: '4', turns: 4, count: 0 },
      { label: '5+', turns: 5, count: 1 },
    ]);
    const query = compiled(executed);
    expect(query).not.toContain('limit 10000');
    expect(query).not.toContain('order by "chat_events"."created_at" desc');
  });

  it('getTurnsToTicket returns empty buckets when there are no ticket sessions', async () => {
    const { client } = makeExecuteClient([]);
    const result = await new ChatEventBatcher(client).getTurnsToTicket();
    expect(result.ticketSessions).toBe(0);
    expect(result.avgTurns).toBe(0);
    expect(result.buckets.every((b) => b.count === 0)).toBe(true);
  });
});

async function dbReachable(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

const connected = await dbReachable();
const suite = connected ? describe : describe.skip;

const ROLLBACK = new Error('ROLLBACK');

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

suite('ChatEventBatcher purge, anonymize & metrics (real SQL)', () => {
  it('purgeUserData removes the user events and their feedback rows', async () => {
    try {
      await db.transaction(async (tx) => {
        const batcher = new ChatEventBatcher(tx);
        await tx.insert(chatEvents).values([
          { turnId: uuid(1), userId: 'purge-u1', query: 'q1', mode: 'vector' },
          { turnId: uuid(2), userId: 'purge-u1', query: 'q2', mode: 'agentic' },
          { turnId: uuid(3), userId: 'purge-other', query: 'q3', mode: 'vector' },
        ]);
        await tx.insert(chatFeedback).values([
          { turnId: uuid(1), feedback: 1, documentIds: [1], chunkIds: [2] },
          { turnId: uuid(3), feedback: -1, documentIds: [3], chunkIds: [4] },
        ]);
        const result = await batcher.purgeUserData('purge-u1');
        expect(result.deletedCount).toBe(2);
        const remaining = await tx
          .select({ id: chatEvents.id })
          .from(chatEvents)
          .where(eq(chatEvents.userId, 'purge-u1'));
        expect(remaining).toHaveLength(0);
        const remainingFeedback = await tx.select({ turnId: chatFeedback.turnId }).from(chatFeedback);
        expect(remainingFeedback.map((r) => r.turnId)).toEqual([uuid(3)]);
        throw ROLLBACK;
      });
    } catch (e) {
      expect(e).toBe(ROLLBACK);
    }
  });

  it('purgeUserData removes the tickets, audit trail and users row', async () => {
    try {
      await db.transaction(async (tx) => {
        const batcher = new ChatEventBatcher(tx);
        await tx.insert(chatEvents).values([
          { turnId: uuid(1), userId: 'purge-u2', query: 'q', mode: 'vector' },
        ]);
        await tx.insert(users).values({ clerkUserId: 'purge-u2', email: 'purge@example.com', role: 'user' });
        await tx.insert(tickets).values({
          ticketId: 'TKT-purge',
          userId: 'purge-u2',
          name: 'Purge',
          email: 'purge@example.com',
          issue: 'purge me',
          status: 'created',
        });
        await tx.insert(auditEvents).values([
          { kind: 'ticket', action: 'create', actorId: 'admin-1', targetType: 'ticket', targetId: 'TKT-purge', details: {} },
          { kind: 'ticket', action: 'status_change', actorId: 'purge-u2', targetType: 'ticket', targetId: 'TKT-purge', details: {} },
          { kind: 'document', action: 'upload', actorId: 'purge-u2', targetType: 'document', targetId: '1', details: {} },
        ]);
        const result = await batcher.purgeUserData('purge-u2');
        expect(result.deletedCount).toBe(1);
        expect(await tx.select().from(tickets).where(eq(tickets.userId, 'purge-u2'))).toHaveLength(0);
        expect(await tx.select().from(users).where(eq(users.clerkUserId, 'purge-u2'))).toHaveLength(0);
        const auditLeft = await tx.select({ id: auditEvents.id }).from(auditEvents);
        expect(auditLeft).toHaveLength(0);
        throw ROLLBACK;
      });
    } catch (e) {
      expect(e).toBe(ROLLBACK);
    }
  });

  it('purgeOlderThan removes old events and their feedback, keeping newer ones', async () => {
    const old = new Date(Date.now() - 86_400_000);
    const recent = new Date();
    try {
      await db.transaction(async (tx) => {
        const batcher = new ChatEventBatcher(tx);
        await tx.insert(chatEvents).values([
          { turnId: uuid(1), userId: 'purge-u', query: 'old', mode: 'vector', createdAt: old },
          { turnId: uuid(2), userId: 'purge-u', query: 'new', mode: 'vector', createdAt: recent },
        ]);
        await tx.insert(chatFeedback).values([
          { turnId: uuid(1), feedback: 1, documentIds: [1], chunkIds: [] },
        ]);
        const result = await batcher.purgeOlderThan(old);
        expect(result.deletedCount).toBe(1);
        const remaining = await tx
          .select({ id: chatEvents.id })
          .from(chatEvents)
          .where(eq(chatEvents.userId, 'purge-u'));
        expect(remaining).toHaveLength(1);
        const feedback = await tx.select({ turnId: chatFeedback.turnId }).from(chatFeedback);
        expect(feedback).toHaveLength(0);
        throw ROLLBACK;
      });
    } catch (e) {
      expect(e).toBe(ROLLBACK);
    }
  });

  it('anonymizeUserData redacts user, query and meta references', async () => {
    try {
      await db.transaction(async (tx) => {
        const batcher = new ChatEventBatcher(tx);
        await tx.insert(chatEvents).values([
          {
            turnId: uuid(1),
            userId: 'anon-u',
            query: 'secret question',
            mode: 'vector',
            meta: { documentIds: [1, 2], ticketId: 'TKT-1', rewritten: false },
          },
          { turnId: uuid(2), userId: 'anon-u', query: 'kept', mode: 'vector', meta: {} },
        ]);
        const result = await batcher.anonymizeUserData('anon-u');
        expect(result.updatedCount).toBe(2);
        const rows = await tx.select().from(chatEvents).where(isNull(chatEvents.userId));
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.turnId === uuid(1))?.meta).toEqual({ rewritten: false });
        expect(rows.find((r) => r.turnId === uuid(2))?.meta).toEqual({});
        throw ROLLBACK;
      });
    } catch (e) {
      expect(e).toBe(ROLLBACK);
    }
  });

  it('getMetrics applies selfServe/zeroResult semantics on real rows', async () => {
    try {
      await db.transaction(async (tx) => {
        const batcher = new ChatEventBatcher(tx);
        await tx.insert(chatEvents).values([
          { turnId: uuid(1), userId: 'm-u', query: 'q', mode: 'vector', hitCount: 3 },
          { turnId: uuid(2), userId: 'm-u', query: 'q', mode: 'vector', hitCount: null },
          { turnId: uuid(3), userId: 'm-u', query: 'q', mode: 'vector', hitCount: 0 },
          { turnId: uuid(4), userId: 'm-u', query: 'q', mode: 'vector', hitCount: 5, ticketCreated: true },
        ]);
        const metrics = await batcher.getMetrics();
        expect(metrics.total).toBe(4);
        expect(metrics.ticketCreationRate).toBe(0.25);
        expect(metrics.selfServeSuccessRate).toBe(0.25);
        expect(metrics.zeroResultRate).toBe(0.5);
        throw ROLLBACK;
      });
    } catch (e) {
      expect(e).toBe(ROLLBACK);
    }
  });

  it('getCacheBusterQueries finds only queries with repeated misses and zero hits', async () => {
    try {
      await db.transaction(async (tx) => {
        const batcher = new ChatEventBatcher(tx);
        await tx.insert(chatEvents).values([
          { userId: 'u', query: 'banana', mode: 'vector', cacheHit: false },
          { userId: 'u', query: 'banana', mode: 'vector', cacheHit: false },
          { userId: 'u', query: 'banana', mode: 'vector', cacheHit: true },
          { userId: 'u', query: 'apple', mode: 'vector', cacheHit: false },
          { userId: 'v', query: 'cherry', mode: 'vector', cacheHit: false },
          { userId: 'v', query: 'cherry', mode: 'vector', cacheHit: false },
        ]);
        const rows = await batcher.getCacheBusterQueries(10);
        expect(rows).toEqual([{ query: 'cherry', misses: 2 }]);
        throw ROLLBACK;
      });
    } catch (e) {
      expect(e).toBe(ROLLBACK);
    }
  });
});
