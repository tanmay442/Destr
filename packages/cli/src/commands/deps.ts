import { createHash } from 'node:crypto';
import type { IngestDeps } from '@app/application/rag/ingest';
import type { PrechunkedIngestDeps } from '@app/application/rag/ingest-prechunked';
import type { ChunkingStrategyName } from '@app/infrastructure/chunking';
import type { MarkdownParser } from '@app/domain';
import { markdownParser } from '@app/infrastructure/markdown';

type UploadIngestDeps = PrechunkedIngestDeps & { markdownParser: MarkdownParser };

async function buildDbDeps() {
  const Db = await import('@app/infrastructure/db');
  const Llm = await import('@app/infrastructure/llm');
  const documents = {
    findByName: (n: string) => Db.findDocumentByName(n),
    findById: (id: number) => Db.findDocumentById(id),
    setStorageKey: (id: number, key: string) => Db.setDocumentStorageKey(id, key),
    updateIngestStatus: (id: number, status: 'queued' | 'ingesting' | 'done' | 'failed') =>
      Db.updateDocumentIngestStatus(id, status),
    claimIngest: (id: number) => Db.claimDocumentIngest(id),
    insert: (i: { fileName: string; fileHash: string; uploadedBy: string }) => Db.insertDocument(i),
    update: (id: number, patch: { fileName?: string; fileHash?: string; uploadedBy?: string; ingestStatus?: 'queued' | 'ingesting' | 'done' | 'failed' }) => Db.updateDocument(id, patch),
    deleteById: (id: number) => Db.deleteDocumentById(id),
    softDelete: (id: number, at: Date) => Db.softDeleteDocument(id, at),
    restore: (id: number) => Db.restoreDocument(id),
    list: Db.listDocuments,
    countChunksForDocuments: Db.countChunksForDocuments,
    countChunksForAll: Db.countChunksForAll,
  };
  const chunks = {
    insertMany: (rows: Array<{
      documentId: number; content: string; embedding: number[];
      chunkIndex?: number; page?: number | null; sectionTitle?: string | null;
      source?: string | null; parentChunkId?: number | null;
      kind?: 'parent' | 'child' | 'summary'; embeddingModel?: string | null; contentHash?: string | null;
    }>) => Db.insertChunks(rows),
    deleteByDocumentId: (documentId: number) => Db.deleteChunksByDocumentId(documentId),
    getByIds: (ids: number[]) => Db.getChunksByIds(ids),
    getByDocAndRange: (documentId: number, start: number, end: number) =>
      Db.getChunksByDocAndRange(documentId, start, end),
    getByDocAndRanges: (ranges: Array<{ documentId: number; start: number; end: number }>) => Db.getChunksByDocAndRanges(ranges),
    countForDocuments: (ids: number[]) => Db.countChunksForDocuments(ids),
    countForAll: () => Db.countChunksForAll(),
    countForDocument: (id: number) => Db.countChunksForDocument(id),
    recountAll: () => Db.recountChunksForAll(),
    searchByVector: (embedding: number[], opts: { threshold: number; limit: number; filter?: { documentId?: number } }) =>
      Db.searchChunksByVector(embedding, opts),
    searchByLexical: (query: string, opts: { limit: number; filter?: { documentId?: number } }) =>
      Db.searchChunksByLexical(query, opts),
  };
  const embeddings = Llm.getEmbeddingService();
  const hasher = { sha256: (b: Buffer) => createHash('sha256').update(b).digest('hex') };
  return { documents, chunks, embeddings, hasher };
}

export async function buildIngestDeps(): Promise<IngestDeps> {
  const base = await buildDbDeps();
  const Pdf = await import('@app/infrastructure/pdf');
  const Chunking = await import('@app/infrastructure/chunking');
  const strategyName = (process.env.CHUNKING_STRATEGY ?? 'document-aware') as ChunkingStrategyName;
  const useStrategy = !process.env.SEED_LEGACY_SPLITTER;
  return {
    ...base,
    pdfParser: Pdf.unpdfParser,
    textSplitter: Pdf.langchainSplitter,
    contentParser: useStrategy ? Pdf.unpdfParser : undefined,
    chunkingStrategy: useStrategy
      ? Chunking.getChunkingStrategy(strategyName, { embeddings: base.embeddings })
      : undefined,
  };
}

export async function buildUploadDeps(): Promise<UploadIngestDeps> {
  const base = await buildDbDeps();
  const { createBlobStorage } = await import(
    '../../../infrastructure/src/storage/blob-storage-factory'
  );
  return {
    ...base,
    blobStorage: createBlobStorage(),
    markdownParser,
  };
}
