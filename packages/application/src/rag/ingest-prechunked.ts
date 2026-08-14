import { randomUUID } from 'crypto';
import { err, ok, type Result, ValidationError, ExternalServiceError } from '@app/domain';
import type {
  DocumentRepository, ChunkRepository, EmbeddingService,
  Hasher, BlobStorage, TransactionRunner, ParsedChunk, MarkdownParser,
  DocSummarizer,
} from '@app/domain';
import { writeChunks, type IngestResult, type PreparedChunk } from './ingest';
import { CCH_ENABLED, CCH_CONTEXT_CHARS } from '@app/domain';

const MAX_PRECHUNKED_CHUNKS = 5000;
const MAX_PRECHUNKED_DELIMITER_LENGTH = 200;

function safeBlobName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

export interface PrechunkedIngestInput {
  /** Markdown file name; also used as the document `fileName` (dedup key). */
  fileName: string;
  /** Already-parsed chunks. */
  chunks: ParsedChunk[];
  uploadedBy: string;
  /** Optional companion PDF; stored as the document blob for preview/download. */
  pdfBuffer?: Buffer | undefined;
  /** Blob filename for the PDF when it differs from `fileName`. */
  pdfFileName?: string | undefined;
}

export interface PrechunkedIngestDeps {
  documents: DocumentRepository;
  chunks: ChunkRepository;
  embeddings: EmbeddingService;
  hasher: Hasher;
  /** Stores the companion PDF and links it to the document row. */
  blobStorage?: BlobStorage;
  /** Makes the upsert + chunk-replace sequence atomic. */
  runner?: TransactionRunner;
  /** Optional Contextual-Chunk-Header summarizer. */
  summarizer?: DocSummarizer;
  /** Override the CCH toggle. */
  cchEnabled?: boolean;
}

/** Ingest pre-chunked Markdown. An optional companion PDF is stored as
 *  the document blob for preview/download. */
export async function ingestPrechunked(
  input: PrechunkedIngestInput,
  deps: PrechunkedIngestDeps,
): Promise<Result<IngestResult>> {
  const { fileName, chunks, uploadedBy, pdfBuffer, pdfFileName } = input;
  if (chunks.length === 0) {
    return err(new ValidationError(`No chunks parsed from ${fileName}`));
  }
  if (chunks.length > MAX_PRECHUNKED_CHUNKS) {
    return err(new ValidationError(`${fileName} has ${chunks.length} segments; maximum is ${MAX_PRECHUNKED_CHUNKS}`));
  }

  // Dedup hash covers the markdown AND any companion PDF, so re-uploading one
  // with different content for the other is never treated as unchanged.
  const markdownSource = Buffer.from(chunks.map((c) => c.content).join('\n'));
  const fileHash = pdfBuffer
    ? deps.hasher.sha256(Buffer.concat([markdownSource, pdfBuffer]))
    : deps.hasher.sha256(markdownSource);

  const existing = await deps.documents.findByName(fileName);
  if (existing && existing.fileHash === fileHash) {
    return ok({ documentId: existing.id, chunks: 0, status: 'unchanged' });
  }

  let header = '';
  let title: string | null = null;
  let summary: string | null = null;
  if (deps.summarizer && (deps.cchEnabled ?? CCH_ENABLED)) {
    const ctx = await deps.summarizer.generateDocContext(
      chunks.map((c) => c.content).join('\n').slice(0, CCH_CONTEXT_CHARS),
    );
    title = ctx.title?.trim() || null;
    summary = ctx.summary?.trim() || null;
    if (title) header = `Document: ${title}\nSummary: ${summary ?? ''}\n\n`;
  }
  let embeddings: number[][];
  try {
    embeddings = await deps.embeddings.embedBatch(
      chunks.map((c) => (header ? header + c.content : c.content)),
    );
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
    title,
    parentChunkId: null,
    embeddingModel: null,
    contentHash: null,
  }));

  const blobKey = pdfBuffer && deps.blobStorage
    ? `docs/${randomUUID()}/${safeBlobName(pdfFileName ?? fileName)}`
    : undefined;
  if (pdfBuffer && deps.blobStorage && blobKey) {
    await deps.blobStorage.put(blobKey, pdfBuffer, 'application/pdf');
  }

  let outcome: { documentId: number };
  try {
    outcome = deps.runner
      ? await deps.runner.run((ctx) => writeChunks(ctx.documents, ctx.chunks, { fileName, fileHash, uploadedBy, storageKey: blobKey }, rows))
      : await writeChunks(deps.documents, deps.chunks, { fileName, fileHash, uploadedBy, storageKey: blobKey }, rows);
  } catch (cause) {
    if (blobKey) await deps.blobStorage?.delete(blobKey).catch(() => {});
    throw cause;
  }

  return ok({
    documentId: outcome.documentId,
    chunks: chunks.length,
    status: existing ? 'updated' : 'inserted',
  });
}

export interface UploadPrechunkedMarkdownInput {
  fileName: string;
  /** Raw markdown text to parse. */
  mdText: string;
  delimiter?: string | undefined;
  uploadedBy: string;
  pdfBuffer?: Buffer | undefined;
  pdfFileName?: string | undefined;
}

/**
 * Parse pre-chunked Markdown via the injected `MarkdownParser` port and ingest.
 */
export async function uploadPrechunkedMarkdown(
  input: UploadPrechunkedMarkdownInput,
  deps: PrechunkedIngestDeps & { markdownParser: MarkdownParser },
): Promise<Result<IngestResult>> {
  if (input.delimiter && input.delimiter.length > MAX_PRECHUNKED_DELIMITER_LENGTH) {
    return err(new ValidationError(`Delimiter exceeds ${MAX_PRECHUNKED_DELIMITER_LENGTH} characters`));
  }
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
