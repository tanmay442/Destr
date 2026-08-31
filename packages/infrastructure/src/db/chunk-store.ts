import { eq, and, or, sql, inArray } from 'drizzle-orm';
import { db } from './client';
import { resolveVectorDimForClient } from './schema-vector';
import { chunks } from './schema';
import { ValidationError } from '@app/domain';
import { abortableQuery } from './query-cancellation';
import type { ChunkStore, InsertChunkInput, Hasher } from '@app/domain';
import {
  createChunkUid,
  defaultHasher,
  normalizeChunkContentHash,
} from './stable-identities';

type Client = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

type ChunkValues = {
  documentId: number;
  chunkUid: string;
  content: string;
  embedding: number[];
  chunkIndex: number;
  page: number | null;
  sectionTitle: string | null;
  source: string | null;
  title: string | null;
  parentChunkId: number | null;
  kind: 'parent' | 'child' | 'summary';
  embeddingModel: string | null;
  contentHash: string;
};

type NormalizedChunk = {
  values: ChunkValues;
  parentChunkIndex: number | null;
};

const DELETE_BATCH_SIZE = 2_000;
const INSERT_BATCH_SIZE = 100;

const chunkConflictUpdate = {
  documentId: sql`excluded.document_id`,
  content: sql`excluded.content`,
  embedding: sql`excluded.embedding`,
  chunkIndex: sql`excluded.chunk_index`,
  page: sql`excluded.page`,
  sectionTitle: sql`excluded.section_title`,
  source: sql`excluded.source`,
  title: sql`excluded.title`,
  parentChunkId: sql`excluded.parent_chunk_id`,
  kind: sql`excluded.kind`,
  embeddingModel: sql`excluded.embedding_model`,
  contentHash: sql`excluded.content_hash`,
};

function toChunkValues(
  row: InsertChunkInput,
  documentUid: string,
  hasher: Hasher,
  parentChunkId: number | null = row.parentChunkId ?? null,
): ChunkValues {
  const kind = row.kind ?? 'child';
  const chunkIndex = row.chunkIndex ?? 0;
  const parentChunkIndex = row.parentChunkIndex ?? row.parentChunkId ?? null;
  const contentHash = normalizeChunkContentHash(row.contentHash, row.content, hasher);
  return {
    documentId: row.documentId,
    chunkUid: createChunkUid({
      documentUid,
      kind,
      chunkIndex,
      parentChunkIndex,
      contentHash,
    }, hasher),
    content: row.content,
    embedding: row.embedding,
    chunkIndex,
    page: row.page ?? null,
    sectionTitle: row.sectionTitle ?? null,
    source: row.source ?? null,
    title: row.title ?? null,
    parentChunkId,
    kind,
    embeddingModel: row.embeddingModel ?? null,
    contentHash,
  };
}

async function resolveDocumentUid(documentId: number, client: Client): Promise<string> {
  if (typeof client.execute !== 'function') return `legacy-document-${documentId}`;
  const result = await client.execute(sql`
    SELECT document_uid AS "documentUid"
    FROM documents
    WHERE id = ${documentId}
  `);
  const rows = (result as unknown as { rows?: Array<{ documentUid?: unknown }> }).rows ?? [];
  const documentUid = rows[0]?.documentUid;
  if (typeof documentUid !== 'string' || documentUid.trim().length === 0) {
    throw new ValidationError(`Document ${documentId} has no stable identity`);
  }
  return documentUid.trim().toLowerCase();
}

async function normalizeRows(
  rows: InsertChunkInput[],
  client: Client,
  documentIdOverride?: number,
  hasher: Hasher = defaultHasher,
): Promise<NormalizedChunk[]> {
  const documentUids = new Map<number, string>();
  for (const row of rows) {
    const documentId = documentIdOverride ?? row.documentId;
    if (!documentUids.has(documentId)) {
      documentUids.set(documentId, await resolveDocumentUid(documentId, client));
    }
  }
  const normalized = rows.map((row) => {
    const documentId = documentIdOverride ?? row.documentId;
    const parentChunkIndex = row.parentChunkIndex ?? row.parentChunkId ?? null;
    const values = toChunkValues(
      { ...row, documentId },
      documentUids.get(documentId)!,
      hasher,
    );
    return { values, parentChunkIndex };
  });
  const seenUids = new Set<string>();
  for (const row of normalized) {
    if (seenUids.has(row.values.chunkUid)) {
      throw new ValidationError(`Duplicate stable chunk identity for chunk ${row.values.chunkIndex}`);
    }
    seenUids.add(row.values.chunkUid);
  }
  return normalized;
}

function insertBatch(tx: Client, values: ChunkValues[]) {
  const query = tx.insert(chunks).values(values);
  if (typeof query.onConflictDoUpdate !== 'function') return query;
  return query.onConflictDoUpdate({
    target: chunks.chunkUid,
    set: chunkConflictUpdate,
  });
}

async function runInserts(rows: NormalizedChunk[], tx: Client): Promise<void> {
  const parents = rows.filter((row) => row.values.kind === 'parent');
  if (parents.length === 0) {
    for (const row of rows) {
      if (row.parentChunkIndex != null) {
        throw new ValidationError(
          `Parent chunk ${row.parentChunkIndex} not found in batch for chunk ${row.values.chunkIndex}`,
        );
      }
    }
    for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
      await insertBatch(tx, rows.slice(i, i + INSERT_BATCH_SIZE).map((row) => row.values));
    }
    return;
  }

  const parentIndices = parents.map((row) => row.values.chunkIndex);
  const uniqueIndices = new Set(parentIndices);
  if (uniqueIndices.size !== parentIndices.length) {
    throw new Error(
      'insertChunks: parent chunkIndex values must be unique within a batch for self-FK resolution',
    );
  }
  const indexToId = new Map<number, number>();
  for (let i = 0; i < parents.length; i += INSERT_BATCH_SIZE) {
    const batch = parents.slice(i, i + INSERT_BATCH_SIZE);
    const inserted = await insertBatch(tx, batch.map((row) => row.values))
      .returning({ id: chunks.id, chunkIndex: chunks.chunkIndex });
    for (const row of inserted) {
      indexToId.set(Number(row.chunkIndex), Number(row.id));
    }
  }

  const children = rows.filter((row) => row.values.kind !== 'parent');
  for (let i = 0; i < children.length; i += INSERT_BATCH_SIZE) {
    const batch = children.slice(i, i + INSERT_BATCH_SIZE);
    await insertBatch(tx, batch.map((row) => {
      const realParentId = row.parentChunkIndex == null
        ? null
        : indexToId.get(row.parentChunkIndex) ?? null;
      if (row.parentChunkIndex != null && realParentId == null) {
        throw new ValidationError(
          `Parent chunk ${row.parentChunkIndex} not found in batch for chunk ${row.values.chunkIndex}`,
        );
      }
      return { ...row.values, parentChunkId: realParentId };
    }));
  }
}

async function runWithClient(
  client: Client,
  operation: (tx: Client) => Promise<void>,
): Promise<void> {
  if (client === db) {
    await db.transaction(async (tx) => operation(tx as unknown as Client));
    return;
  }
  const maybeTx = client as unknown as {
    transaction?: (fn: (tx: Client) => Promise<void>) => Promise<void>;
  };
  if (maybeTx.transaction) {
    await maybeTx.transaction(operation);
    return;
  }
  await operation(client);
}

function validateEmbeddings(rows: InsertChunkInput[], expectedDimension: number): void {
  for (const row of rows) {
    if (!Array.isArray(row.embedding) || row.embedding.length !== expectedDimension) {
      throw new ValidationError(`Invalid embedding: expected ${expectedDimension} dimensions, got ${row.embedding.length}`);
    }
    if (!row.embedding.every((value) => Number.isFinite(value))) {
      throw new ValidationError(`Invalid embedding: chunk ${row.chunkIndex} contains non-finite values`);
    }
  }
}

export async function insertChunks(
  rows: InsertChunkInput[],
  client: Client = db,
  vectorDim?: number,
  hasher: Hasher = defaultHasher,
): Promise<void> {
  if (rows.length === 0) return;
  const expectedDimension = vectorDim ?? resolveVectorDimForClient(client);
  validateEmbeddings(rows, expectedDimension);
  const normalized = await normalizeRows(rows, client, undefined, hasher);
  await runWithClient(client, (tx) => runInserts(normalized, tx));
}

async function deleteStaleChunks(
  documentId: number,
  retainedUids: string[],
  client: Client,
): Promise<void> {
  const retained = sql.join(retainedUids.map((uid) => sql`${uid}`), sql`, `);
  while (true) {
    const result = await client.execute(sql`
      WITH candidates AS MATERIALIZED (
        SELECT candidate.id
        FROM chunks AS candidate
        WHERE candidate.document_id = ${documentId}
          AND candidate.chunk_uid NOT IN (${retained})
          AND NOT EXISTS (
            SELECT 1
            FROM chunks AS child
            WHERE child.parent_chunk_id = candidate.id
          )
        ORDER BY candidate.id
        LIMIT ${DELETE_BATCH_SIZE}
      )
      DELETE FROM chunks AS target
      USING candidates
      WHERE target.id = candidates.id
      RETURNING target.id
    `);
    const rows = (result as unknown as { rows?: unknown[] }).rows ?? [];
    if (rows.length === 0) return;
  }
}

export async function replaceChunks(
  documentId: number,
  rows: InsertChunkInput[],
  client: Client = db,
  vectorDim?: number,
  hasher: Hasher = defaultHasher,
): Promise<void> {
  if (rows.length === 0) {
    await runWithClient(client, (tx) => deleteChunksByDocumentId(documentId, tx));
    return;
  }
  const expectedDimension = vectorDim ?? resolveVectorDimForClient(client);
  validateEmbeddings(rows, expectedDimension);
  const normalized = await normalizeRows(rows, client, documentId, hasher);
  await runWithClient(client, async (tx) => {
    await runInserts(normalized, tx);
    await deleteStaleChunks(
      documentId,
      normalized.map((row) => row.values.chunkUid),
      tx,
    );
  });
}

export async function getChunksByIds(
  ids: number[],
  client: Client = db,
  opts: { signal?: AbortSignal } = {},
): Promise<
  Array<{
    id: number;
    chunkUid?: string;
    documentId: number;
    documentUid?: string;
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
  const result = await abortableQuery(client.execute(sql`
    SELECT
      c.id AS id,
      c.chunk_uid AS "chunkUid",
      c.document_id AS "documentId",
      d.document_uid AS "documentUid",
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
  `), opts.signal);
  type RawRow = {
    id: number;
    chunkUid?: string | null;
    documentId: number;
    documentUid?: string | null;
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
    ...(r.chunkUid ? { chunkUid: r.chunkUid } : {}),
    documentId: Number(r.documentId),
    ...(r.documentUid ? { documentUid: r.documentUid } : {}),
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
  opts: { signal?: AbortSignal } = {},
): Promise<
  Array<{
    id: number;
    chunkUid?: string;
    documentId: number;
    documentUid?: string;
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
  const result = await abortableQuery(client.execute(sql`
    SELECT
      c.id AS id,
      c.chunk_uid AS "chunkUid",
      c.document_id AS "documentId",
      d.document_uid AS "documentUid",
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
  `), opts.signal);
  type RawRow = {
    id: number;
    chunkUid?: string | null;
    documentId: number;
    documentUid?: string | null;
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
    ...(r.chunkUid ? { chunkUid: r.chunkUid } : {}),
    documentId: Number(r.documentId),
    ...(r.documentUid ? { documentUid: r.documentUid } : {}),
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
  opts: { signal?: AbortSignal } = {},
): Promise<Map<string, Array<{
  id: number;
  chunkUid?: string;
  documentId: number;
  documentUid?: string;
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
    chunkUid?: string;
    documentId: number;
    documentUid?: string;
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
  const result = await abortableQuery(client.execute(sql`
    SELECT
      c.id AS id,
      c.chunk_uid AS "chunkUid",
      c.document_id AS "documentId",
      d.document_uid AS "documentUid",
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
  `), opts.signal);
  type RawRow = {
    id: number;
    chunkUid?: string | null;
    documentId: number;
    documentUid?: string | null;
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
    ...(r.chunkUid ? { chunkUid: r.chunkUid } : {}),
    documentId: Number(r.documentId),
    ...(r.documentUid ? { documentUid: r.documentUid } : {}),
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
  const deleteBatch = async (): Promise<number> => {
    const result = await client.execute(sql`
      WITH candidates AS MATERIALIZED (
        SELECT candidate.id
        FROM ${chunks} AS candidate
        WHERE candidate.document_id = ${documentId}
          AND NOT EXISTS (
            SELECT 1
            FROM ${chunks} AS child
            WHERE child.parent_chunk_id = candidate.id
          )
        ORDER BY candidate.id
        LIMIT ${DELETE_BATCH_SIZE}
      )
      DELETE FROM ${chunks} AS target
      USING candidates
      WHERE target.id = candidates.id
      RETURNING target.id
    `);
    const rows = (result as unknown as { rows?: Array<{ id: number }> }).rows ?? [];
    return rows.length;
  };

  if (typeof client.delete !== 'function') {
    await deleteBatch();
    return;
  }

  while (true) {
    const deleted = await deleteBatch();
    if (deleted === 0) break;
  }
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

export function createChunkStore(
  client: Client,
  vectorDim?: number,
  hasher: Hasher = defaultHasher,
): ChunkStore {
  const expectedDimension = vectorDim ?? resolveVectorDimForClient(client);
  return {
    getByIds: (ids, opts) => getChunksByIds(ids, client, opts),
    getByDocAndRange: (documentId, start, end, opts) => getChunksByDocAndRange(documentId, start, end, client, opts),
    getByDocAndRanges: (ranges, opts) => getChunksByDocAndRanges(ranges, client, opts),
    insertMany: (rows) => insertChunks(rows, client, expectedDimension, hasher),
    replaceMany: (documentId, rows) => replaceChunks(documentId, rows, client, expectedDimension, hasher),
    deleteByDocumentId: (documentId) => deleteChunksByDocumentId(documentId, client),
    countForDocuments: (ids) => countChunksForDocuments(ids, client),
    countForAll: () => countChunksForAll(client),
    countForDocument: (id) => countChunksForDocument(id, client),
    recountAll: () => recountChunksForAll(client),
  };
}
