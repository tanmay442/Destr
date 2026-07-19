import { randomUUID } from 'crypto';
import { err, ok, type Result, ValidationError, ExternalServiceError } from '@app/domain';
import type {
  DocumentRepository, ChunkRepository, EmbeddingService,
  Hasher, BlobStorage, TransactionRunner, ParsedChunk, MarkdownParser,
  DocSummarizer,
} from '@app/domain';
import { writeChunks, type IngestResult, type PreparedChunk } from './ingest';
import { stripThinkTraces } from '@app/domain/sanitize-think';
import { CCH_ENABLED, CCH_CONTEXT_CHARS } from '../../../../config/constants';

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
  /** Optional Contextual-Chunk-Header summarizer (Session 3). */
  summarizer?: DocSummarizer;
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

  // Contextual Chunk Header (Session 3): one title+summary per document,
  // prepended to every chunk before embedding so retrieval matches.
  let header = '';
  let title: string | null = null;
  let summary: string | null = null;
  const cleanChunks = chunks.map((c) => ({ ...c, content: stripThinkTraces(c.content) }));
  if (deps.summarizer && CCH_ENABLED) {
    const ctx = await deps.summarizer.generateDocContext(
      cleanChunks.map((c) => c.content).join('\n').slice(0, CCH_CONTEXT_CHARS),
    );
    title = ctx.title?.trim() || null;
    summary = ctx.summary?.trim() || null;
    if (title) header = `Document: ${title}\nSummary: ${summary ?? ''}\n\n`;
  }
  const headerChunks = header
    ? cleanChunks.map((c) => ({ ...c, content: header + c.content }))
    : cleanChunks;

  let embeddings: number[][];
  try {
    embeddings = await deps.embeddings.embedBatch(headerChunks.map((c) => c.content));
  } catch (cause) {
    return err(new ExternalServiceError('Embedding API failed', cause));
  }
  if (embeddings.length !== headerChunks.length) {
    return err(new ExternalServiceError('Embedding count mismatch'));
  }

  const rows: PreparedChunk[] = headerChunks.map((c, i) => ({
    documentId: 0,
    content: c.content,
    embedding: embeddings[i]!,
    chunkIndex: i,
    page: c.page ?? null,
    sectionTitle: c.sectionTitle ?? null,
    source: c.source ?? null,
    title,
    summary,
    parentChunkId: null,
    embeddingModel: null,
    contentHash: null,
  }));

  // Upload blob before the tx (matching documents.ts) so a rolled-back tx never
  // orphans a blob a committed row points at; link key inside the tx atomically.
  const blobKey = pdfBuffer && deps.blobStorage
    ? `docs/${randomUUID()}/${safeBlobName(pdfFileName ?? fileName)}`
    : undefined;
  if (pdfBuffer && deps.blobStorage && blobKey) {
    await deps.blobStorage.put(blobKey, pdfBuffer, 'application/pdf');
  }

  const outcome = deps.runner
    ? await deps.runner.run((ctx) => writeChunks(ctx.documents, ctx.chunks, { fileName, fileHash, uploadedBy, storageKey: blobKey }, rows))
    : await writeChunks(deps.documents, deps.chunks, { fileName, fileHash, uploadedBy, storageKey: blobKey }, rows);

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
