import { sql } from 'drizzle-orm';
import { db } from './client';
import type { LexicalSearch } from '@app/domain';

type Client = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function searchChunksByLexical(
  query: string,
  opts: { limit: number; filter?: { documentId?: number } },
  client: Client = db,
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
  if (!query.trim()) return [];
  const lexQuery = sql`plainto_tsquery('english', ${query})`;
  const result = await client.execute(sql`
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
      ts_rank(c.tsv, ${lexQuery}) AS similarity
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE d.deleted_at IS NULL
      AND c.kind <> 'parent'
      AND c.tsv @@ ${lexQuery}
      ${opts.filter?.documentId != null ? sql`AND c.document_id = ${opts.filter.documentId}` : sql``}
    ORDER BY similarity DESC
    LIMIT ${opts.limit}
  `);
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

export function createLexicalSearch(client: Client): LexicalSearch {
  return {
    searchByLexical: (query, opts) => searchChunksByLexical(query, opts, client),
  };
}
