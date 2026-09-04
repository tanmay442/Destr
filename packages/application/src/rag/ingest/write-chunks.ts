import type {
  DocumentRepository, ChunkRepository, InsertChunkInput,
} from '@app/domain';
import type { PreparedChunk } from './parse-embed';

export async function replaceDocumentChunks(
  chunks: Pick<ChunkRepository, 'deleteByDocumentId' | 'insertMany'> & {
    replaceMany?: ((documentId: number, rows: InsertChunkInput[]) => Promise<void>) | undefined;
  },
  documentId: number,
  rows: InsertChunkInput[],
): Promise<void> {
  if (chunks.replaceMany) {
    await chunks.replaceMany(documentId, rows);
    return;
  }
  await chunks.deleteByDocumentId(documentId);
  await chunks.insertMany(rows);
}

/** Write the upsert-then-replace-chunks sequence. Exported so other ingest
 *  paths (pre-chunked Markdown) can reuse the atomic insert + chunk-replace. */
export async function writeChunks(
  documents: DocumentRepository,
  chunks: ChunkRepository,
  input: {
    fileName: string;
    fileHash: string;
    uploadedBy: string;
    storageKey?: string | null | undefined;
    resurrectDeleted?: boolean | undefined;
  },
  rows: PreparedChunk[],
): Promise<{ documentId: number }> {
  const row = await documents.insert(
    { fileName: input.fileName, fileHash: input.fileHash, uploadedBy: input.uploadedBy },
    { resurrectDeleted: input.resurrectDeleted },
  );
  if (input.storageKey !== undefined) await documents.setStorageKey(row.id, input.storageKey);
  await replaceDocumentChunks(
    chunks,
    row.id,
    rows.map((r) => ({
      documentId: row.id,
      content: r.content,
      embedding: r.embedding,
      chunkIndex: r.chunkIndex,
      page: r.page,
      sectionTitle: r.sectionTitle,
      source: r.source,
      title: r.title,
      parentChunkId: r.parentChunkId,
      kind: r.kind ?? 'child',
      embeddingModel: r.embeddingModel,
      contentHash: r.contentHash,
    })),
  );
  return { documentId: row.id };
}
