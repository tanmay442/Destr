import { eq, and, or, sql, inArray } from 'drizzle-orm';
import { db } from './client';
import { resolveVectorDimForClient } from './schema-vector';
import { chunks } from './schema';
import { ValidationError } from '@app/domain';
import type { ChunkStore } from '@app/domain';

type Client = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

function toChunkValues(r: {
  documentId: number;
  content: string;
  embedding: number[];
  chunkIndex?: number | undefined;
  page?: number | null | undefined;
  sectionTitle?: string | null | undefined;
  source?: string | null | undefined;
  title?: string | null | undefined;
  parentChunkId?: number | null | undefined;
  kind?: 'parent' | 'child' | 'summary' | undefined;
  embeddingModel?: string | null | undefined;
  contentHash?: string | null | undefined;
}) {
  return {
    documentId: r.documentId,
    content: r.content,
    embedding: r.embedding,
    chunkIndex: r.chunkIndex ?? 0,
    page: r.page ?? null,
    sectionTitle: r.sectionTitle ?? null,
    source: r.source ?? null,
    title: r.title ?? null,
    parentChunkId: r.parentChunkId ?? null,
    kind: r.kind ?? 'child',
    embeddingModel: r.embeddingModel ?? null,
    contentHash: r.contentHash ?? null,
  };
}

export async function insertChunks(
  rows: Array<{
    documentId: number;
    content: string;
    embedding: number[];
    chunkIndex?: number | undefined;
    page?: number | null | undefined;
    sectionTitle?: string | null | undefined;
    source?: string | null | undefined;
    title?: string | null | undefined;
    parentChunkId?: number | null | undefined;
    kind?: 'parent' | 'child' | 'summary' | undefined;
    embeddingModel?: string | null | undefined;
    contentHash?: string | null | undefined;
  }>,
  client: Client = db,
  vectorDim?: number,
): Promise<void> {
  if (rows.length === 0) return;
  const expectedDimension = vectorDim ?? resolveVectorDimForClient(client);
  for (const r of rows) {
    if (!Array.isArray(r.embedding) || r.embedding.length !== expectedDimension) {
      throw new ValidationError(`Invalid embedding: expected ${expectedDimension} dimensions, got ${r.embedding.length}`);
    }
    if (!r.embedding.every((v) => Number.isFinite(v))) {
      throw new ValidationError(`Invalid embedding: chunk ${r.chunkIndex} contains non-finite values`);
    }
  }
  const BATCH_SIZE = 100;

  async function runInserts(tx: Client): Promise<void> {
    const parents = rows.filter((r) => r.kind === 'parent');
    if (parents.length === 0) {
      for (const r of rows) {
        if (r.parentChunkId != null) {
          throw new ValidationError(
            `Parent chunk ${r.parentChunkId} not found in batch for chunk ${r.chunkIndex}`,
          );
        }
      }
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        await tx.insert(chunks).values(rows.slice(i, i + BATCH_SIZE).map(toChunkValues));
      }
      return;
    }
    const parentIndices = parents.map((r) => r.chunkIndex ?? 0);
    const uniqueIndices = new Set(parentIndices);
    if (uniqueIndices.size !== parentIndices.length) {
      throw new Error(
        'insertChunks: parent chunkIndex values must be unique within a batch for self-FK resolution',
      );
    }
    const indexToId = new Map<number, number>();
    for (let i = 0; i < parents.length; i += BATCH_SIZE) {
      const batch = parents.slice(i, i + BATCH_SIZE);
      const inserted = await tx
        .insert(chunks)
        .values(batch.map(toChunkValues))
        .returning({ id: chunks.id, chunkIndex: chunks.chunkIndex });
      for (const row of inserted) {
        indexToId.set(Number(row.chunkIndex), Number(row.id));
      }
    }
    const children = rows.filter((r) => r.kind !== 'parent');
    for (let i = 0; i < children.length; i += BATCH_SIZE) {
      const batch = children.slice(i, i + BATCH_SIZE);
      await tx.insert(chunks).values(
        batch.map((r) => {
          const realParentId =
            r.parentChunkId != null ? indexToId.get(r.parentChunkId) ?? null : null;
          if (r.parentChunkId != null && realParentId == null) {
            throw new ValidationError(
              `Parent chunk ${r.parentChunkId} not found in batch for chunk ${r.chunkIndex}`,
            );
          }
          return { ...toChunkValues(r), parentChunkId: realParentId };
        }),
      );
    }
  }
  if (client === db) {
    await db.transaction(async (tx) => {
      await runInserts(tx as unknown as Client);
    });
  } else {
    const maybeTx = client as unknown as { transaction?: (fn: (tx: Client) => Promise<void>) => Promise<void> };
    if (maybeTx.transaction) {
      await maybeTx.transaction(async (tx) => runInserts(tx));
    } else {
      await runInserts(client);
    }
  }
}

export async function getChunksByIds(
  ids: number[],
  client: Client = db,
): Promise<
  Array<{
    id: number;
    documentId: number;
    fileName: string | null;
    page: number | null;
    sectionTitle: string | null;
    source: string | null;
    title: string | null;
    content: string;
    similarity: number;
    parentChunkId: number | null;
    chunkIndex: number;
  }>
> {
  if (ids.length === 0) return [];
  const result = await client.execute(sql`
    SELECT
      c.id AS id,
      c.document_id AS "documentId",
      d.file_name AS "fileName",
      c.page AS page,
      c.section_title AS "sectionTitle",
      c.source AS source,
      c.title AS title,
      c.content AS content,
      c.parent_chunk_id AS "parentChunkId",
      c.chunk_index AS "chunkIndex",
      0 AS similarity
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE d.deleted_at IS NULL
      AND c.id IN ${ids}
    ORDER BY c.id
  `);
  type RawRow = {
    id: number;
    documentId: number;
    fileName: string | null;
    page: number | null;
    sectionTitle: string | null;
    source: string | null;
    title: string | null;
    content: string;
    parentChunkId: number | null;
    chunkIndex: number;
    similarity: number;
  };
  const rows = (result as unknown as { rows?: RawRow[] }).rows ?? [];
  return rows.map((r) => ({
    id: Number(r.id),
    documentId: Number(r.documentId),
    fileName: r.fileName ?? null,
    page: r.page != null ? Number(r.page) : null,
    sectionTitle: r.sectionTitle ?? null,
    source: r.source ?? null,
    title: r.title ?? null,
    content: r.content,
    parentChunkId: r.parentChunkId != null ? Number(r.parentChunkId) : null,
    chunkIndex: Number(r.chunkIndex),
    similarity: Number(r.similarity),
  }));
}

export async function getChunksByDocAndRange(
  documentId: number,
  start: number,
  end: number,
  client: Client = db,
): Promise<
  Array<{
    id: number;
    documentId: number;
    fileName: string | null;
    page: number | null;
    sectionTitle: string | null;
    source: string | null;
    title: string | null;
    content: string;
    similarity: number;
    parentChunkId: number | null;
    chunkIndex: number;
  }>
> {
  const result = await client.execute(sql`
    SELECT
      c.id AS id,
      c.document_id AS "documentId",
      d.file_name AS "fileName",
      c.page AS page,
      c.section_title AS "sectionTitle",
      c.source AS source,
      c.title AS title,
      c.content AS content,
      c.parent_chunk_id AS "parentChunkId",
      c.chunk_index AS "chunkIndex",
      0 AS similarity
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE d.deleted_at IS NULL
      AND c.document_id = ${documentId}
      AND c.chunk_index >= ${start}
      AND c.chunk_index <= ${end}
    ORDER BY c.chunk_index
  `);
  type RawRow = {
    id: number;
    documentId: number;
    fileName: string | null;
    page: number | null;
    sectionTitle: string | null;
    source: string | null;
    title: string | null;
    content: string;
    parentChunkId: number | null;
    chunkIndex: number;
    similarity: number;
  };
  const rows = (result as unknown as { rows?: RawRow[] }).rows ?? [];
  return rows.map((r) => ({
    id: Number(r.id),
    documentId: Number(r.documentId),
    fileName: r.fileName ?? null,
    page: r.page != null ? Number(r.page) : null,
    sectionTitle: r.sectionTitle ?? null,
    source: r.source ?? null,
    title: r.title ?? null,
    content: r.content,
    parentChunkId: r.parentChunkId != null ? Number(r.parentChunkId) : null,
    chunkIndex: Number(r.chunkIndex),
    similarity: Number(r.similarity),
  }));
}

export async function getChunksByDocAndRanges(
  ranges: Array<{ documentId: number; start: number; end: number }>,
  client: Client = db,
): Promise<Map<string, Array<{
  id: number;
  documentId: number;
  fileName: string | null;
  page: number | null;
  sectionTitle: string | null;
  source: string | null;
  title: string | null;
  content: string;
  similarity: number;
  parentChunkId: number | null;
  chunkIndex: number;
}>>> {
  const map = new Map<string, Array<{
    id: number;
    documentId: number;
    fileName: string | null;
    page: number | null;
    sectionTitle: string | null;
    source: string | null;
    title: string | null;
    content: string;
    similarity: number;
    parentChunkId: number | null;
    chunkIndex: number;
  }>>();
  if (ranges.length === 0) return map;
  const conditions = ranges.map((r) =>
    and(sql`c.document_id = ${r.documentId}`, sql`c.chunk_index >= ${r.start}`, sql`c.chunk_index <= ${r.end}`),
  );
  const result = await client.execute(sql`
    SELECT
      c.id AS id,
      c.document_id AS "documentId",
      d.file_name AS "fileName",
      c.page AS page,
      c.section_title AS "sectionTitle",
      c.source AS source,
      c.title AS title,
      c.content AS content,
      c.parent_chunk_id AS "parentChunkId",
      c.chunk_index AS "chunkIndex",
      0 AS similarity
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE d.deleted_at IS NULL
      AND (${or(...conditions)})
    ORDER BY c.document_id, c.chunk_index
  `);
  type RawRow = {
    id: number;
    documentId: number;
    fileName: string | null;
    page: number | null;
    sectionTitle: string | null;
    source: string | null;
    title: string | null;
    content: string;
    parentChunkId: number | null;
    chunkIndex: number;
    similarity: number;
  };
  const rows = (result as unknown as { rows?: RawRow[] }).rows ?? [];
  const parsed = rows.map((r) => ({
    id: Number(r.id),
    documentId: Number(r.documentId),
    fileName: r.fileName ?? null,
    page: r.page != null ? Number(r.page) : null,
    sectionTitle: r.sectionTitle ?? null,
    source: r.source ?? null,
    title: r.title ?? null,
    content: r.content,
    parentChunkId: r.parentChunkId != null ? Number(r.parentChunkId) : null,
    chunkIndex: Number(r.chunkIndex),
    similarity: Number(r.similarity),
  }));
  for (const r of parsed) {
    for (const range of ranges) {
      if (r.documentId === range.documentId && r.chunkIndex >= range.start && r.chunkIndex <= range.end) {
        const key = `${range.documentId}:${range.start}:${range.end}`;
        const arr = map.get(key);
        if (arr) arr.push(r);
        else map.set(key, [r]);
      }
    }
  }
  return map;
}

export async function deleteChunksByDocumentId(documentId: number, client: Client = db): Promise<void> {
  await client.delete(chunks).where(eq(chunks.documentId, documentId));
}

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

export function createChunkStore(client: Client, vectorDim?: number): ChunkStore {
  const expectedDimension = vectorDim ?? resolveVectorDimForClient(client);
  return {
    getByIds: (ids) => getChunksByIds(ids, client),
    getByDocAndRange: (documentId, start, end) => getChunksByDocAndRange(documentId, start, end, client),
    getByDocAndRanges: (ranges) => getChunksByDocAndRanges(ranges, client),
    insertMany: (rows) => insertChunks(rows, client, expectedDimension),
    deleteByDocumentId: (documentId) => deleteChunksByDocumentId(documentId, client),
    countForDocuments: (ids) => countChunksForDocuments(ids, client),
    countForAll: () => countChunksForAll(client),
    countForDocument: (id) => countChunksForDocument(id, client),
    recountAll: () => recountChunksForAll(client),
  };
}
