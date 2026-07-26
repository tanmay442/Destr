import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { ChatFeedbackRepository } from '../chat-feedback-repo';

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

const TURN = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('ChatFeedbackRepository.upsertFeedback', () => {
  it('reports not_found when the referenced turn does not exist', async () => {
    const { client } = makeExecuteClient([{ found: 0, upserted: 0 }]);
    const result = await new ChatFeedbackRepository(client).upsertFeedback({
      turnId: TURN, userId: 'u1', feedback: 1, documentIds: [1], chunkIds: [2],
    });
    expect(result).toBe('not_found');
  });

  it('reports forbidden when the turn exists but belongs to another user', async () => {
    const { client } = makeExecuteClient([{ found: 1, upserted: 0 }]);
    const result = await new ChatFeedbackRepository(client).upsertFeedback({
      turnId: TURN, userId: 'u1', feedback: 1, documentIds: [], chunkIds: [],
    });
    expect(result).toBe('forbidden');
  });

  it('reports ok and upserts on conflict (vote change allowed)', async () => {
    const { client, executed } = makeExecuteClient([{ found: 1, upserted: 1 }]);
    const result = await new ChatFeedbackRepository(client).upsertFeedback({
      turnId: TURN, userId: 'u1', feedback: -1, documentIds: [1, 2], chunkIds: [3],
    });
    expect(result).toBe('ok');
    const sql = compiled(executed);
    expect(sql).toContain('insert into');
    expect(sql).toContain('on conflict');
    expect(sql).toContain('do update set');
    expect(sql).toContain('user_id is null or');
  });
});

describe('ChatFeedbackRepository read queries', () => {
  it('getFeedbackSummary aggregates votes and total events', async () => {
    const { client, executed } = makeExecuteClient([{ up: 8, down: 2, total: 10, total_events: 40 }]);
    const result = await new ChatFeedbackRepository(client).getFeedbackSummary();
    expect(result).toEqual({ up: 8, down: 2, total: 10, totalEvents: 40 });
    expect(compiled(executed, 0)).toContain('filter (where feedback = 1)');
    expect(compiled(executed, 1)).toContain('from "chat_events"');
  });

  it('getDocumentSentiment unnests document ids and joins documents', async () => {
    const { client, executed } = makeExecuteClient([{ document_id: 5, file_name: 'a.pdf', up: 3, down: 1 }]);
    const result = await new ChatFeedbackRepository(client).getDocumentSentiment(10);
    expect(result).toEqual([{ documentId: 5, fileName: 'a.pdf', up: 3, down: 1 }]);
    const sql = compiled(executed);
    expect(sql).toContain('unnest(f.document_ids)');
    expect(sql).toContain('join documents');
    expect(sql).toContain('deleted_at is null');
    expect(sql).toContain('limit');
  });

  it('getThumbsDownDocs filters negative feedback and orders by down count', async () => {
    const { client, executed } = makeExecuteClient([{ document_id: 9, file_name: 'b.pdf', down: 6 }]);
    const result = await new ChatFeedbackRepository(client).getThumbsDownDocs(5);
    expect(result).toEqual([{ documentId: 9, fileName: 'b.pdf', down: 6 }]);
    const sql = compiled(executed);
    expect(sql).toContain('where f.feedback = -1');
    expect(sql).toContain('deleted_at is null');
    expect(sql).toContain('order by down desc');
  });
});
