import { err, ok, type Result, ValidationError, ExternalServiceError } from '@app/domain';
import type {
  DocumentRepository, ChunkRepository, EmbeddingService,
  Hasher, BlobStorage, TransactionRunner, ParsedChunk, MarkdownParser,
} from '@app/domain';
import { writeChunks, type IngestResult, type PreparedChunk } from './ingest';

/** Sanitize a filename for use inside a blob-storage key (mirrors seed.ts). */
function safeBlobName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

export interface PrechunkedIngestInput {
  /** Markdown file name; also used as the document `fileName` (dedup key). */
  fileName: string;
  /** Already-parsed chunks (parser runs in the caller / infra adapter). */
  chunks: ParsedChunk[];
  uploadedBy: string;
  /** Optional companion PDF; stored as the document blob for preview/download. */
  pdfBuffer?: Buffer;
  /** Blob filename for the PDF when it differs from `fileName`. */
  pdfFileName?: string;
}

export interface PrechunkedIngestDeps {
  documents: DocumentRepository;
  chunks: ChunkRepository;
  embeddings: EmbeddingService;
  hasher: Hasher;
  /** Optional: stores the companion PDF and links it to the document row. */
  blobStorage?: BlobStorage;
  /** Optional: makes the upsert + chunk-replace sequence atomic. */
  runner?: TransactionRunner;
}

/**
 * Ingest pre-chunked Markdown. The parser is a pass-through — we never run a
 * `ChunkingStrategy` on the content. Chunks are embedded and written with their
 * page/sectionTitle/source metadata into the same `chunks` columns the
 * strategy sessions use. An optional companion PDF is stored as the document
 * blob (for preview/download) only when supplied.
 */
export async function ingestPrechunked(
  input: PrechunkedIngestInput,
  deps: PrechunkedIngestDeps,
): Promise<Result<IngestResult>> {
  const { fileName, chunks, uploadedBy, pdfBuffer, pdfFileName } = input;
  if (chunks.length === 0) {
    return err(new ValidationError(`No chunks parsed from ${fileName}`));
  }

  // Hash the markdown content (or the PDF buffer when present) for dedup.
  const hashSource = pdfBuffer ?? Buffer.from(chunks.map((c) => c.content).join('\n'));
  const fileHash = deps.hasher.sha256(hashSource);

  const existing = await deps.documents.findByName(fileName);
  if (existing && existing.fileHash === fileHash) {
    return ok({ documentId: existing.id, chunks: 0, status: 'unchanged' });
  }

  let embeddings: number[][];
  try {
    embeddings = await deps.embeddings.embedBatch(chunks.map((c) => c.content));
  } catch (cause) {
    return err(new ExternalServiceError('Embedding API failed', cause));
  }
  if (embeddings.length !== chunks.length) {
    return err(new ExternalServiceError('Embedding count mismatch'));
  }

  const rows: PreparedChunk[] = chunks.map((c, i) => ({
    documentId: 0,
    content: c.content,
    embedding: embeddings[i]!,
    chunkIndex: i,
    page: c.page ?? null,
    sectionTitle: c.sectionTitle ?? null,
    source: c.source ?? null,
    title: null,
    summary: null,
    parentChunkId: null,
    embeddingModel: null,
    contentHash: null,
  }));

  const outcome = deps.runner
    ? await deps.runner.run((ctx) =>
        writeChunks(ctx.documents, ctx.chunks, { fileName, fileHash, uploadedBy }, rows),
      )
    : await writeChunks(deps.documents, deps.chunks, { fileName, fileHash, uploadedBy }, rows);

  // Persist the companion PDF only after the row commits, then link it.
  if (pdfBuffer && deps.blobStorage && outcome.documentId) {
    const key = `docs/${outcome.documentId}/${safeBlobName(pdfFileName ?? fileName)}`;
    await deps.blobStorage.put(key, pdfBuffer, 'application/pdf');
    await deps.documents.setStorageKey(outcome.documentId, key);
  }

  return ok({
    documentId: outcome.documentId,
    chunks: chunks.length,
    status: existing ? 'updated' : 'inserted',
  });
}

export interface UploadPrechunkedMarkdownInput {
  fileName: string;
  /** Raw markdown text to parse (caller supplies delimiter when non-default). */
  mdText: string;
  delimiter?: string;
  uploadedBy: string;
  pdfBuffer?: Buffer;
  pdfFileName?: string;
}

/**
 * Parse pre-chunked Markdown via the injected `MarkdownParser` port and ingest
 * the result. Keeps the parser (an infrastructure concern) out of the API
 * layer: callers here wire the adapter, so `src/app` never imports
 * infrastructure directly.
 */
export async function uploadPrechunkedMarkdown(
  input: UploadPrechunkedMarkdownInput,
  deps: PrechunkedIngestDeps & { markdownParser: MarkdownParser },
): Promise<Result<IngestResult>> {
  const parsed = deps.markdownParser.parseChunkedMarkdown(input.mdText, input.delimiter);
  return ingestPrechunked(
    {
      fileName: input.fileName,
      chunks: parsed,
      uploadedBy: input.uploadedBy,
      pdfBuffer: input.pdfBuffer,
      pdfFileName: input.pdfFileName,
    },
    deps,
  );
}
