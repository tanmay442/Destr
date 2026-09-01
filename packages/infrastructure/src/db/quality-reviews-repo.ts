import { desc } from 'drizzle-orm';
import { db } from './client';
import { qualityReviews } from './schema';
import type { QualityReviewsRepo, QualityReviewInput, QualityReviewRow } from '@app/domain';
import { toSafeDatabaseId } from './safe-id';

type Client = typeof db;

function toQualityReviewRow(row: typeof qualityReviews.$inferSelect): QualityReviewRow {
  return {
    ...row,
    id: toSafeDatabaseId(row.id, 'quality_reviews.id'),
    verdict: row.verdict as QualityReviewRow['verdict'],
  };
}

export class QualityReviewsRepository implements QualityReviewsRepo {
  constructor(private readonly client: Client = db) {}

  async create(input: QualityReviewInput): Promise<QualityReviewRow> {
    const [row] = await this.client
      .insert(qualityReviews)
      .values({
        turnId: input.turnId,
        reviewerId: input.reviewerId,
        verdict: input.verdict,
        note: input.note ?? null,
      })
      .onConflictDoUpdate({
        target: [qualityReviews.turnId, qualityReviews.reviewerId],
        set: {
          verdict: input.verdict,
          note: input.note ?? null,
        },
      })
      .returning();
    if (!row) throw new Error('Failed to insert quality review');
    return toQualityReviewRow(row);
  }

  async listRecent(limit: number): Promise<QualityReviewRow[]> {
    const capped = Math.min(Math.max(limit, 1), 100);
    const rows = await this.client
      .select()
      .from(qualityReviews)
      .orderBy(desc(qualityReviews.createdAt))
      .limit(capped);
    return rows.map(toQualityReviewRow);
  }
}

export function createQualityReviewsRepo(client: Client = db): QualityReviewsRepo {
  return new QualityReviewsRepository(client);
}
