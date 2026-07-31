import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { ChatEventBatcher } from '../chat-events-repo';
import { chatEvents, auditDeadLetter } from '../schema';
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

function compiled(executed: SQL[]): string {
  return dialect.sqlToQuery(executed[executed.length - 1]!).sql.toLowerCase();
}

type Insert = { table: unknown; values: unknown };

function makeFakeClient(opts: { failChatInsert?: boolean } = {}) {
  const inserts: Insert[] = [];
  const deleted: { userId?: string } = {};
  const client = {
    insert(table: unknown) {
      return {
        async values(values: unknown) {
          if (table === chatEvents && opts.failChatInsert) throw new Error('insert boom');
          inserts.push({ table, values });
        },
      };
    },
    delete() {
      return {
        where() {
          return {
            async returning() {
              return [{ id: 1 }, { id: 2 }];
            },
          };
        },
      };
    },
    update() {
      return {
        set(patch: { userId?: string }) {
          deleted.userId = patch.userId;
          return {
            where() {
              return {
                async returning() {
                  return [{ id: 7 }];
                },
              };
            },
          };
        },
      };
    },
  };
  return { client: client as never, inserts, deleted };
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

  it('dead-letters the batch when the primary insert fails', async () => {
    const { client, inserts } = makeFakeClient({ failChatInsert: true });
    const batcher = new ChatEventBatcher(client);
    batcher.record(sample);
    await batcher.flush();
    const dl = inserts.find((i) => i.table === auditDeadLetter);
    expect(dl).toBeDefined();
    expect((dl!.values as { kind: string }).kind).toBe('chat_event');
    expect((dl!.values as { payload: unknown[] }).payload).toHaveLength(1);
  });

  it('flush is a no-op on an empty buffer', async () => {
    const { client, inserts } = makeFakeClient();
    await new ChatEventBatcher(client).flush();
    expect(inserts).toHaveLength(0);
  });

  it('purgeUserData deletes and reports the count', async () => {
    const { client } = makeFakeClient();
    const result = await new ChatEventBatcher(client).purgeUserData('u1');
    expect(result).toEqual({ deletedCount: 2 });
  });

  it('purgeOlderThan deletes and reports the count', async () => {
    const { client } = makeFakeClient();
    const result = await new ChatEventBatcher(client).purgeOlderThan(new Date());
    expect(result).toEqual({ deletedCount: 2 });
  });

  it('anonymizeUserData redacts the user and reports the count', async () => {
    const { client, deleted } = makeFakeClient();
    const result = await new ChatEventBatcher(client).anonymizeUserData('u1');
    expect(result).toEqual({ updatedCount: 1 });
    expect(deleted.userId).toBe('REDACTED');
  });

  it('getCacheBusterQueries filters repeated misses with zero hits and maps rows', async () => {
    const { client, executed } = makeExecuteClient([{ query: 'reset key', misses: 4 }]);
    const result = await new ChatEventBatcher(client).getCacheBusterQueries(5);
    expect(result).toEqual([{ query: 'reset key', misses: 4 }]);
    const sql = compiled(executed);
    expect(sql).toContain('group by');
    expect(sql).toContain('having');
    expect(sql).toContain('cache_hit');
    expect(sql).toContain('order by misses desc');
    expect(sql).toContain('limit');
  });

  it('getDocumentUtility joins meta.documentIds to documents with p95 similarity', async () => {
    const { client, executed } = makeExecuteClient([
      { document_id: 3, file_name: 'guide.pdf', retrieval_count: 12, p95_similarity: 0.88, ticket_conversion_rate: 0.25 },
    ]);
    const result = await new ChatEventBatcher(client).getDocumentUtility(20);
    expect(result).toEqual([
      { documentId: 3, fileName: 'guide.pdf', retrievalCount: 12, p95Similarity: 0.88, ticketConversionRate: 0.25 },
    ]);
    const sql = compiled(executed);
    expect(sql).toContain('jsonb_array_elements_text');
    expect(sql).toContain("-> 'documentids'");
    expect(sql).toContain('join documents');
    expect(sql).toContain('deleted_at is null');
    expect(sql).toContain('percentile_cont(0.95)');
    expect(sql).toContain('order by retrieval_count desc');
  });

  it('getZeroHitDocuments returns documents never referenced via meta containment', async () => {
    const { client, executed } = makeExecuteClient([
      { document_id: 7, file_name: 'stale.pdf', created_at: '2026-01-01T00:00:00Z' },
    ]);
    const result = await new ChatEventBatcher(client).getZeroHitDocuments(20);
    expect(result).toEqual([{ documentId: 7, fileName: 'stale.pdf', createdAt: '2026-01-01T00:00:00Z' }]);
    const sql = compiled(executed);
    expect(sql).toContain('not exists');
    expect(sql).toContain('@> to_jsonb(d.id)');
    expect(sql).toContain('deleted_at is null');
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
    const sql = compiled(executed);
    expect(sql).toContain('lag(');
    expect(sql).toContain('partition by');
    expect(sql).toContain("interval '30 minutes'");
    expect(sql).toContain('having bool_or(ticket_created)');
    expect(sql).toContain('first_ticket_turn');
    expect(sql).toContain('row_number() over (partition by user_id, session_no order by created_at)');
    expect(sql).toContain('limit 10000');
  });

  it('getTurnsToTicket returns empty buckets when there are no ticket sessions', async () => {
    const { client } = makeExecuteClient([]);
    const result = await new ChatEventBatcher(client).getTurnsToTicket();
    expect(result.ticketSessions).toBe(0);
    expect(result.avgTurns).toBe(0);
    expect(result.buckets.every((b) => b.count === 0)).toBe(true);
  });
});
