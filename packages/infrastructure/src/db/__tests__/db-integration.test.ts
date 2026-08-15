import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { db } from '../client';
import { VECTOR_DIM } from '../schema-vector';
import { tickets, auditEvents, documents } from '../schema';
import {
  insertChunks,
  insertDocument,
  getChunksByIds,
  getChunksByDocAndRange,
  getChunksByDocAndRanges,
  ticketRepo,
  createDocumentRepo,
} from '../repositories';

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

const emb = () => Array.from({ length: VECTOR_DIM }, () => 0.1);

const ROLLBACK = new Error('ROLLBACK');

suite('db-integration (real SQL)', () => {
  it('round-trips chunks through insert and the getChunks* reads, then rolls back', async () => {
    const fileName = `wp1-${randomUUID()}.pdf`;
    try {
      await db.transaction(async (tx) => {
        const doc = await insertDocument({ fileName, fileHash: randomUUID(), uploadedBy: 'wp1-test' }, tx);
        const docId = doc.id;
        await insertChunks(
          [
            { documentId: docId, content: 'alpha head', embedding: emb(), chunkIndex: 0, kind: 'child' },
            { documentId: docId, content: 'beta tail', embedding: emb(), chunkIndex: 1, kind: 'child' },
          ],
          tx,
        );

        const byRange = await getChunksByDocAndRange(docId, 0, 0, tx);
        expect(byRange.map((c) => c.content)).toEqual(['alpha head']);

        const byRanges = await getChunksByDocAndRanges([{ documentId: docId, start: 1, end: 1 }], tx);
        expect(byRanges.get(`${docId}:1:1`)!.map((c) => c.content)).toEqual(['beta tail']);

        const idResult = (await tx.execute(
          sql`SELECT id FROM chunks WHERE document_id = ${docId} ORDER BY id`,
        )) as unknown as { rows: Array<{ id: number }> };
        const chunkIds = idResult.rows.map((r) => Number(r.id));
        expect(chunkIds).toHaveLength(2);

        const byIds = await getChunksByIds(chunkIds, tx);
        expect(byIds.map((c) => c.content)).toEqual(['alpha head', 'beta tail']);

        throw ROLLBACK;
      });
    } catch (e) {
      expect(e).toBe(ROLLBACK);
    }

    const leftover = (await db.execute(
      sql`SELECT count(*)::int AS n FROM documents WHERE file_name = ${fileName}`,
    )) as unknown as { rows: Array<{ n: number }> };
    expect(leftover.rows[0]!.n).toBe(0);
  });

  it('aggregates ticket response times and honors a from/to range, then rolls back', async () => {
    const now = Date.now();
    const newTicket = `TKT-${randomUUID()}`;
    const oldTicket = `TKT-old-${randomUUID()}`;

    const beforeNoRange = await ticketRepo.getTicketResponseTimes(undefined, db);
    const beforeRange = await ticketRepo.getTicketResponseTimes({ from: new Date(now) }, db);

    try {
      await db.transaction(async (tx) => {
        const insertTicket = async (ticketId: string, created: Date, status: 'created' | 'closed') => {
          await tx.insert(tickets).values({
            ticketId,
            userId: 'wp1-user',
            name: 'Integration',
            email: 'wp1@example.com',
            issue: 'integration fixture',
            status,
            createdAt: created,
          });
          await tx.insert(auditEvents).values([
            {
              kind: 'ticket',
              action: 'status_change',
              actorId: 'wp1-actor',
              targetType: 'ticket',
              targetId: ticketId,
              at: new Date(created.getTime() + 5_000),
              details: {},
            },
            {
              kind: 'ticket',
              action: 'status_change',
              actorId: 'wp1-actor',
              targetType: 'ticket',
              targetId: ticketId,
              at: new Date(created.getTime() + 60_000),
              details: {},
            },
          ]);
        };
        await insertTicket(newTicket, new Date(now), 'closed');
        await insertTicket(oldTicket, new Date(now - 3 * 86_400_000), 'created');

        const afterNoRange = await ticketRepo.getTicketResponseTimes(undefined, tx);
        expect(afterNoRange.respondedCount).toBe(beforeNoRange.respondedCount + 2);
        expect(afterNoRange.resolvedCount).toBe(beforeNoRange.resolvedCount + 1);

        const afterFromNow = await ticketRepo.getTicketResponseTimes({ from: new Date(now) }, tx);
        expect(afterFromNow.respondedCount).toBe(beforeRange.respondedCount + 1);

        const futureOnly = await ticketRepo.getTicketResponseTimes({ from: new Date(now + 86_400_000) }, tx);
        expect(futureOnly.respondedCount).toBe(beforeRange.respondedCount);

        throw ROLLBACK;
      });
    } catch (e) {
      expect(e).toBe(ROLLBACK);
    }

    const leftover = (await db.execute(
      sql`SELECT count(*)::int AS n FROM tickets WHERE ticket_id IN (${newTicket}, ${oldTicket})`,
    )) as unknown as { rows: Array<{ n: number }> };
    expect(leftover.rows[0]!.n).toBe(0);
  });

  it('counts only queued/ingesting documents, then rolls back', async () => {
    const before = await createDocumentRepo(db).countPendingIngest();
    try {
      await db.transaction(async (tx) => {
        const docA = await insertDocument(
          { fileName: `pi-${randomUUID()}.pdf`, fileHash: randomUUID(), uploadedBy: 'pi-test' },
          tx,
        );
        const docB = await insertDocument(
          { fileName: `pi-${randomUUID()}.pdf`, fileHash: randomUUID(), uploadedBy: 'pi-test' },
          tx,
        );
        const docC = await insertDocument(
          { fileName: `pi-${randomUUID()}.pdf`, fileHash: randomUUID(), uploadedBy: 'pi-test' },
          tx,
        );
        await tx.update(documents).set({ ingestStatus: 'queued' }).where(eq(documents.id, docA.id));
        await tx.update(documents).set({ ingestStatus: 'ingesting' }).where(eq(documents.id, docB.id));
        await tx.update(documents).set({ ingestStatus: 'failed' }).where(eq(documents.id, docC.id));

        const repo = createDocumentRepo(tx);
        expect(await repo.countPendingIngest()).toBe(before + 2);

        await tx.update(documents).set({ ingestStatus: 'done' }).where(eq(documents.id, docA.id));
        expect(await repo.countPendingIngest()).toBe(before + 1);

        throw ROLLBACK;
      });
    } catch (e) {
      expect(e).toBe(ROLLBACK);
    }
  });
});