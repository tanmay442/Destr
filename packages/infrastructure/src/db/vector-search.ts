import { sql } from 'drizzle-orm';
import { db } from './client';
import { resolveVectorDimForClient } from './schema-vector';
import { executeDatabaseCancelable } from './query-cancellation';
import type { VectorSearch } from '@app/domain';

type Client = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function searchChunksByVector(
  embedding: number[],
  opts: { threshold: number; limit: number; filter?: { documentId?: number }; signal?: AbortSignal },
  client: Client = db,
  vectorDim?: number,
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
  if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((v) => Number.isFinite(v))) {
    throw new Error('Invalid embedding: must be a non-empty array of finite numbers');
  }
  const expectedDimension = vectorDim ?? resolveVectorDimForClient(client);
  if (embedding.length !== expectedDimension) {
    throw new Error(`Invalid embedding: expected ${expectedDimension} dimensions, got ${embedding.length}`);
  }
  const vectorLiteral = `[${embedding.join(',')}]`;
  const candidatePool = Math.max(opts.limit * 10, 50);
  const result = await executeDatabaseCancelable({
    client,
    operation: async (queryClient) => {
      const runSearch = async (tx: Client) => {
        await tx.execute(sql`SELECT set_config('hnsw.ef_search', ${String(candidatePool * 2)}, true)`);
        return tx.execute(sql`
    WITH candidates AS (
      SELECT ch.id
      FROM chunks ch
      JOIN documents doc ON doc.id = ch.document_id
      WHERE doc.deleted_at IS NULL
        AND ch.kind <> 'parent'
      ORDER BY ch.embedding <=> ${vectorLiteral}::vector
      LIMIT ${candidatePool}
    )
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
      1 - (c.embedding <=> ${vectorLiteral}::vector) AS similarity
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    JOIN candidates cand ON cand.id = c.id
    WHERE d.deleted_at IS NULL
      AND c.kind <> 'parent'
      AND (1 - (c.embedding <=> ${vectorLiteral}::vector)) > ${opts.threshold}
      ${opts.filter?.documentId != null ? sql`AND c.document_id = ${opts.filter.documentId}` : sql``}
    ORDER BY similarity DESC
        LIMIT ${opts.limit}
        `);
      };
      // Real Drizzle clients keep the LOCAL HNSW setting and query on one
      // transaction/connection. Minimal contract-test clients may expose only
      // execute; retain that narrow compatibility without affecting runtime.
      return typeof queryClient.transaction === 'function'
        ? queryClient.transaction((tx) => runSearch(tx as Client))
        : runSearch(queryClient);
    },
    signal: opts.signal,
  });
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

export function createVectorSearch(client: Client, vectorDim?: number): VectorSearch {
  const expectedDimension = vectorDim ?? resolveVectorDimForClient(client);
  return {
    searchByVector: (embedding, opts) => searchChunksByVector(embedding, opts, client, expectedDimension),
  };
}
