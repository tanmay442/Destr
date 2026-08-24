import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { QualityReviewsRepository } from '../quality-reviews-repo';
import { qualityReviews } from '../schema';
import { db } from '../client';

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

suite('QualityReviewsRepository (real SQL)', () => {
  it('create persists a review row and listRecent returns newest first', async () => {
    try {
      await db.transaction(async (tx) => {
        const { chatEvents, users } = await import('../schema');
        await tx.insert(users).values({ clerkUserId: 'qr-admin', email: 'qr-admin@example.com', role: 'admin' });
        await tx.insert(chatEvents).values([
          { turnId: uuid(1), userId: 'qr-u', query: 'q1', mode: 'vector' },
          { turnId: uuid(2), userId: 'qr-u', query: 'q2', mode: 'agentic' },
        ]);
        const repo = new QualityReviewsRepository(tx);
        await repo.create({ turnId: uuid(1), reviewerId: 'qr-admin', verdict: 'bad', note: 'wrong doc' });
        await repo.create({ turnId: uuid(2), reviewerId: 'qr-admin', verdict: 'docs_missing' });
        await tx.execute(sql`update ${qualityReviews} set created_at = now() - interval '1 hour' where verdict = 'bad'`);

        const rows = await repo.listRecent(10);
        expect(rows).toHaveLength(2);
        expect(rows[0]!.verdict).toBe('docs_missing');
        expect(rows[0]!.note).toBeNull();
        expect(rows[1]!).toMatchObject({
          turnId: uuid(1),
          reviewerId: 'qr-admin',
          verdict: 'bad',
          note: 'wrong doc',
        });
        expect(rows[1]!.createdAt).toBeInstanceOf(Date);

        expect(await repo.listRecent(1)).toHaveLength(1);

        await expect(
          tx.insert(qualityReviews).values({
            turnId: uuid(1),
            reviewerId: 'qr-admin',
            verdict: 'meh',
          }),
        ).rejects.toThrow();
        throw ROLLBACK;
      });
    } catch (e) {
      expect(e).toBe(ROLLBACK);
    }
  });
});
