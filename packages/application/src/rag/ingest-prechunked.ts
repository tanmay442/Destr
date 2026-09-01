import { randomUUID } from 'crypto';
import {
  err,
  ok,
  type Result,
  ValidationError,
  ExternalServiceError,
  ConflictError,
  UPLOAD_CHUNKED_MAX_PDF_BYTES,
} from '@app/domain';
import type {
  DocumentRepository, ChunkRepository, EmbeddingService,
  Hasher, BlobStorage, TransactionRunner, ParsedChunk, MarkdownParser,
  DocSummarizer, PdfValidator,
} from '@app/domain';
import {
  writeChunks,
  claimDocumentByName,
  nameStillClaimed,
  UPLOAD_CONFLICT_MESSAGE,
  type IngestResult,
  type PreparedChunk,
} from './ingest';
import { CCH_ENABLED, CCH_CONTEXT_CHARS } from '@app/domain';

const MAX_PRECHUNKED_CHUNKS = 5000;
const MAX_PRECHUNKED_DELIMITER_LENGTH = 200;
const PDF_VALIDATION_TIMEOUT_MS = 15_000;

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
  /** Validates a companion PDF structurally before hashing, embedding, or storage. */
  pdfValidator?: PdfValidator;
  /** Makes the upsert + chunk-replace sequence atomic. */
  runner?: TransactionRunner;
  /** Optional Contextual-Chunk-Header summarizer. */
  summarizer?: DocSummarizer;
  /** Override the CCH toggle. */
  cchEnabled?: boolean;
}

/** Ingest pre-chunked Markdown. An optional companion PDF is stored as
 *  the document blob for preview/download. */
function isDocumentNameConflict(error: unknown): boolean {
  const wrapped = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const pgError = wrapped.code ? wrapped : wrapped.cause;
  return pgError?.code === '23505' && (pgError.constraint === 'documents_name_key' || pgError.constraint === 'documents_file_name_unique');
}

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
  if (pdfBuffer) {
    if (pdfBuffer.byteLength > UPLOAD_CHUNKED_MAX_PDF_BYTES) {
      return err(new ValidationError(
        `Companion PDF exceeds ${UPLOAD_CHUNKED_MAX_PDF_BYTES} bytes`,
      ));
    }
    if (!deps.pdfValidator) {
      return err(new ValidationError('Companion PDF validation is unavailable'));
    }
    try {
      await deps.pdfValidator.validate(pdfBuffer, {
        signal: AbortSignal.timeout(PDF_VALIDATION_TIMEOUT_MS),
      });
    } catch (cause: unknown) {
      return err(new ValidationError('Companion PDF is invalid or unsupported', {
        reason: cause instanceof Error ? cause.message : 'validation failed',
      }));
    }
  }

  // Dedup hash covers the markdown AND any companion PDF, so re-uploading one
  // with different content for the other is never treated as unchanged.
  const markdownSource = Buffer.from(chunks.map((chunk) => chunk.content).join('\n'));
  const fileHash = pdfBuffer
    ? deps.hasher.sha256(Buffer.concat([markdownSource, pdfBuffer]))
    : deps.hasher.sha256(markdownSource);

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
    try {
      await deps.blobStorage.put(blobKey, pdfBuffer, 'application/pdf');
    } catch (cause) {
      await deps.blobStorage.delete(blobKey).catch(() => {});
      throw cause;
    }
  }

  let oldStorageKey: string | null = null;
  const write = async (
    documents: DocumentRepository,
    repoChunks: ChunkRepository,
  ): Promise<Result<IngestResult>> => {
    const claim = await claimDocumentByName(fileName, fileHash, documents);
    if (claim.kind === 'unchanged') {
      if (claim.restore) await documents.restore(claim.documentId);
      return ok({ documentId: claim.documentId, chunks: 0, status: 'unchanged' });
    }
    oldStorageKey = claim.kind === 'replace' || claim.kind === 'resurrect'
      ? claim.previous.storageKey
      : claim.oldStorageKey;
    const outcome = await writeChunks(
      documents,
      repoChunks,
      {
        fileName,
        fileHash,
        uploadedBy,
        storageKey: blobKey ?? null,
        resurrectDeleted: claim.kind === 'resurrect',
      },
      rows,
    );
    if (!(await nameStillClaimed(fileName, fileHash, documents))) {
      throw new ConflictError(UPLOAD_CONFLICT_MESSAGE);
    }
    return ok({
      documentId: outcome.documentId,
      chunks: chunks.length,
      status: claim.kind === 'replace' ? 'updated' : 'inserted',
    });
  };

  let result: Result<IngestResult>;
  try {
    result = deps.runner
      ? await deps.runner.run((ctx) => write(ctx.documents, ctx.chunks))
      : await write(deps.documents, deps.chunks);
  } catch (cause) {
    if (blobKey) await deps.blobStorage?.delete(blobKey).catch(() => {});
    if (isDocumentNameConflict(cause)) return err(new ConflictError(UPLOAD_CONFLICT_MESSAGE));
    if (cause instanceof ConflictError) return err(cause);
    throw cause;
  }
  if (!result.ok || result.value.status === 'unchanged') {
    if (blobKey) await deps.blobStorage?.delete(blobKey).catch(() => {});
  } else if (oldStorageKey && oldStorageKey !== blobKey) {
    await deps.blobStorage?.delete(oldStorageKey).catch(() => {});
  }
  return result;
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
