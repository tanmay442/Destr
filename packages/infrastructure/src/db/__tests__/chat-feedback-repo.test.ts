import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { ChatFeedbackRepository } from '../chat-feedback-repo';
import { chatEvents, chatFeedback } from '../schema';
import { db } from '../client';

function makeExecuteClient(rows: unknown[]) {
  const client = {
    execute() {
      return Promise.resolve({ rows });
    },
  };
  return { client: client as never };
}

const TURN = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('ChatFeedbackRepository.upsertFeedback', () => {
  it('maps not_found, forbidden and ok results', async () => {
    const notFound = await new ChatFeedbackRepository(makeExecuteClient([{ found: 0, upserted: 0 }]).client).upsertFeedback({
      turnId: TURN, userId: 'u1', feedback: 1, documentIds: [1], chunkIds: [2],
    });
    expect(notFound).toBe('not_found');

    const forbidden = await new ChatFeedbackRepository(makeExecuteClient([{ found: 1, upserted: 0 }]).client).upsertFeedback({
      turnId: TURN, userId: 'u1', feedback: 1, documentIds: [], chunkIds: [],
    });
    expect(forbidden).toBe('forbidden');

    const ok = await new ChatFeedbackRepository(makeExecuteClient([{ found: 1, upserted: 1 }]).client).upsertFeedback({
      turnId: TURN, userId: 'u1', feedback: -1, documentIds: [1, 2], chunkIds: [3],
    });
    expect(ok).toBe('ok');
  });
});

describe('ChatFeedbackRepository read queries', () => {
  it('getFeedbackSummary aggregates votes and total events', async () => {
    const { client } = makeExecuteClient([{ up: 8, down: 2, total: 10, total_events: 40 }]);
    const result = await new ChatFeedbackRepository(client).getFeedbackSummary();
    expect(result).toEqual({ up: 8, down: 2, total: 10, totalEvents: 40 });
  });

  it('getDocumentSentiment unnests document ids and joins documents', async () => {
    const { client } = makeExecuteClient([{ document_id: 5, file_name: 'a.pdf', up: 3, down: 1 }]);
    const result = await new ChatFeedbackRepository(client).getDocumentSentiment(10);
    expect(result).toEqual([{ documentId: 5, fileName: 'a.pdf', up: 3, down: 1 }]);
  });

  it('getThumbsDownDocs filters negative feedback and orders by down count', async () => {
    const { client } = makeExecuteClient([{ document_id: 9, file_name: 'b.pdf', down: 6 }]);
    const result = await new ChatFeedbackRepository(client).getThumbsDownDocs(5);
    expect(result).toEqual([{ documentId: 9, fileName: 'b.pdf', down: 6 }]);
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

suite('ChatFeedbackRepository upsertFeedback (real SQL)', () => {
  it('persists feedback, enforces ownership, allows vote changes and rejects unknown turns', async () => {
    try {
      await db.transaction(async (tx) => {
        const repo = new ChatFeedbackRepository(tx);
        await tx.insert(chatEvents).values([{ turnId: TURN, userId: 'owner', query: 'q', mode: 'vector' }]);

        const ok = await repo.upsertFeedback({ turnId: TURN, userId: 'owner', feedback: 1, documentIds: [1], chunkIds: [2] });
        expect(ok).toBe('ok');

        const forbidden = await repo.upsertFeedback({ turnId: TURN, userId: 'other', feedback: -1, documentIds: [3], chunkIds: [] });
        expect(forbidden).toBe('forbidden');

        const changed = await repo.upsertFeedback({ turnId: TURN, userId: 'owner', feedback: -1, documentIds: [1, 9], chunkIds: [2] });
        expect(changed).toBe('ok');

        const notFound = await repo.upsertFeedback({
          turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3302', userId: 'other', feedback: -1, documentIds: [], chunkIds: [],
        });
        expect(notFound).toBe('not_found');

        const rows = await tx.select().from(chatFeedback);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.turnId).toBe(TURN);
        expect(rows[0]?.feedback).toBe(-1);
        expect(rows[0]?.documentIds).toEqual([1, 9]);
        throw ROLLBACK;
      });
    } catch (e) {
      expect(e).toBe(ROLLBACK);
    }
  });
});