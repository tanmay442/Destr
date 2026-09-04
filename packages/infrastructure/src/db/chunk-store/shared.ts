import { sql } from 'drizzle-orm';
import { db } from '../client';

export type Client = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ChunkValues = {
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

export type NormalizedChunk = {
  values: ChunkValues;
  parentChunkIndex: number | null;
};

export const DELETE_BATCH_SIZE = 2_000;
export const INSERT_BATCH_SIZE = 100;

export const chunkConflictUpdate = {
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
