import { and, or, sql } from 'drizzle-orm';
import { db } from '../client';
import { executeDatabaseCancelable } from '../query-cancellation';
import type { Client } from './shared';

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
  const result = await executeDatabaseCancelable({ client, operation: (queryClient) => queryClient.execute(sql`
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
  `), signal: opts.signal });
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
  const result = await executeDatabaseCancelable({ client, operation: (queryClient) => queryClient.execute(sql`
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
  `), signal: opts.signal });
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
  const result = await executeDatabaseCancelable({ client, operation: (queryClient) => queryClient.execute(sql`
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
  `), signal: opts.signal });
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
