import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../client';
import { chunks } from '../schema';
import type { Client } from './shared';

export async function countChunksForDocuments(
  documentIds: number[],
  client: Client = db,
): Promise<Map<number, number>> {
  if (documentIds.length === 0) return new Map();
  const rows = await client
    .select({ documentId: chunks.documentId, count: sql<number>`count(*)::int` })
    .from(chunks)
    .where(inArray(chunks.documentId, documentIds))
    .groupBy(chunks.documentId);
  return new Map(rows.map((r) => [r.documentId, r.count]));
}

export async function countChunksForAll(client: Client = db): Promise<number> {
  const [row] = await client.select({ count: sql<number>`count(*)::int` }).from(chunks);
  return row?.count ?? 0;
}

export async function countChunksForDocument(id: number, client: Client = db): Promise<number> {
  const [row] = await client
    .select({ count: sql<number>`count(*)::int` })
    .from(chunks)
    .where(eq(chunks.documentId, id));
  return row?.count ?? 0;
}

export async function recountChunksForAll(client: Client = db): Promise<Array<{ documentId: number; count: number }>> {
  const rows = await client
    .select({ documentId: chunks.documentId, count: sql<number>`count(*)::int` })
    .from(chunks)
    .groupBy(chunks.documentId);
  return rows;
}
