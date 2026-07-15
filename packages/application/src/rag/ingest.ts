import { err, ok, type Result, ValidationError, ExternalServiceError } from '@app/domain';
import type {
  DocumentRepository, ChunkRepository, EmbeddingService,
  Hasher, PdfParser, TextSplitter, TransactionRunner,
  ContentParser, ChunkingStrategy, DocumentChunk, DocSummarizer,
} from '@app/domain';
import { CCH_ENABLED, CCH_CONTEXT_CHARS } from '../../../../config/constants';

interface IngestFileInput {
  fileName: string;
  buffer: Buffer;
  uploadedBy: string;
}

export interface IngestResult {
  documentId: number;
  chunks: number;
  status: 'inserted' | 'updated' | 'unchanged' | 'queued';
}

export interface IngestDeps {
  documents: DocumentRepository;
  chunks: ChunkRepository;
  embeddings: EmbeddingService;
  hasher: Hasher;
  pdfParser: PdfParser;
  textSplitter: TextSplitter;
  /** Optional: when present (wired in Session 4), chunking uses the new
   *  strategy path instead of the legacy TextSplitter. Legacy stays required
   *  until then so the existing ingest path is never broken. */
  contentParser?: ContentParser;
  chunkingStrategy?: ChunkingStrategy;
  /** Optional Contextual-Chunk-Header summarizer (Session 3). */
  summarizer?: DocSummarizer;
  /** Optional transaction runner used to make the upsert+replace-chunks
   *  sequence atomic. When absent (e.g. unit tests), the legacy direct
   *  writes are used. */
  runner?: TransactionRunner;
}

export interface PreparedChunk {
  documentId: number;
  content: string;
  embedding: number[];
  chunkIndex: number;
  page?: number | null;
  sectionTitle?: string | null;
  source?: string | null;
  title?: string | null;
  summary?: string | null;
  parentChunkId?: number | null;
  kind?: 'child' | 'summary';
  embeddingModel?: string | null;
  contentHash?: string | null;
}

/** Deps needed to parse + split + embed. Shared by `parseAndEmbed`/`prepareIngest`. */
export interface ParseDeps {
  embeddings: EmbeddingService;
  pdfParser: PdfParser;
  textSplitter: TextSplitter;
  contentParser?: ContentParser;
  chunkingStrategy?: ChunkingStrategy;
  /** Optional Contextual-Chunk-Header summarizer (Session 3). When present
   *  (and `CCH_ENABLED`), one title+summary is generated per document and
   *  prepended to every chunk before embedding. */
  summarizer?: DocSummarizer;
}

/**
 * Generate the Contextual Chunk Header (CCH) for a document, once.
 * Returns the header string to prepend and the title/summary metadata.
 * Returns empty/falsy values when CCH is disabled or no summarizer is wired,
 * so callers can safely prepend (no-op) without branching.
 */
async function buildCchHeader(
  deps: ParseDeps,
  sourceText: string,
): Promise<{ header: string; title: string | null; summary: string | null }> {
  if (!deps.summarizer || !CCH_ENABLED) {
    return { header: '', title: null, summary: null };
  }
  const ctx = await deps.summarizer.generateDocContext(sourceText.slice(0, CCH_CONTEXT_CHARS));
  const title = ctx.title?.trim() || null;
  const summary = ctx.summary?.trim() || null;
  // Only prepend a header when we got a usable title; the metadata is still
  // recorded regardless so downstream retrieval can see provenance.
  const header = title ? `Document: ${title}\nSummary: ${summary ?? ''}\n\n` : '';
  return { header, title, summary };
}

/** Prepend a CCH header to every chunk (when present) and always stamp the
 *  title/summary metadata so retrieval/provenance can use it. */
function applyCchHeader(
  docChunks: DocumentChunk[],
  header: string,
  title: string | null,
  summary: string | null,
): DocumentChunk[] {
  return docChunks.map((c) => ({
    ...c,
    content: header ? header + c.content : c.content,
    title: c.title ?? title,
    summary: c.summary ?? summary,
  }));
}

/** Turn parsed/split chunks into fully-populated PreparedChunk rows (no DB writes). */
function toPreparedRows(
  docChunks: DocumentChunk[],
  embeddings: number[][],
  documentId: number,
): PreparedChunk[] {
  return docChunks.map((c, i) => ({
    documentId,
    content: c.content,
    embedding: embeddings[i],
    chunkIndex: c.chunkIndex,
    page: c.page ?? null,
    sectionTitle: c.sectionTitle ?? null,
    source: c.source ?? null,
    title: c.title ?? null,
    summary: c.summary ?? null,
    parentChunkId: c.parentChunkId ?? null,
    embeddingModel: c.embeddingModel ?? null,
    contentHash: c.contentHash ?? null,
  }));
}

/** Parse + split + embed as a single, reusable step (no DB writes). */
export async function parseAndEmbed(
  input: { fileName: string; buffer: Buffer },
  deps: ParseDeps,
): Promise<Result<{ chunks: number; rows: PreparedChunk[] }>> {
  let docChunks: DocumentChunk[];
  let sourceText = '';
  if (deps.contentParser && deps.chunkingStrategy) {
    // New strategy path (wired in Session 4). Yields per-page provenance.
    const pages = await deps.contentParser.extractPages(input.buffer);
    docChunks = await deps.chunkingStrategy.splitPages(pages);
    sourceText = pages.map((p) => p.text).join('\n\n');
  } else {
    // Legacy path: whole-document text → TextSplitter.
    let text: string;
    try {
      text = await deps.pdfParser.extractText(input.buffer);
    } catch (cause) {
      return err(new ExternalServiceError('PDF parsing failed', cause));
    }
    sourceText = text;
    const texts = await deps.textSplitter.splitText(text);
    docChunks = texts.map((t, i) => ({ content: t, chunkIndex: i }));
  }

  // Contextual Chunk Header (Session 3): one title+summary per document,
  // prepended to every chunk before embedding so retrieval scores match.
  const { header, title, summary } = await buildCchHeader(deps, sourceText);
  docChunks = applyCchHeader(docChunks, header, title, summary);

  if (docChunks.length === 0) {
    return err(new ValidationError(`No extractable text in ${input.fileName}`));
  }

  let embeddings: number[][];
  try {
    embeddings = await deps.embeddings.embedBatch(docChunks.map((c) => c.content));
  } catch (cause) {
    return err(new ExternalServiceError('Embedding API failed', cause));
  }
  if (embeddings.length !== docChunks.length) {
    return err(new ExternalServiceError('Embedding count mismatch'));
  }

  return ok({ chunks: docChunks.length, rows: toPreparedRows(docChunks, embeddings, 0) });
}

/** Write the upsert-then-replace-chunks sequence against the given repos/tx.
 *  Exported so other ingest paths (pre-chunked Markdown) can reuse the
 *  identical atomic insert + chunk-replace behaviour. */
export async function writeChunks(
  documents: DocumentRepository,
  chunks: ChunkRepository,
  input: { fileName: string; fileHash: string; uploadedBy: string },
  rows: PreparedChunk[],
): Promise<{ documentId: number }> {
  const row = await documents.insert({ fileName: input.fileName, fileHash: input.fileHash, uploadedBy: input.uploadedBy });
  await chunks.deleteByDocumentId(row.id);
  await chunks.insertMany(
    rows.map((r) => ({
      documentId: row.id,
      content: r.content,
      embedding: r.embedding,
      chunkIndex: r.chunkIndex,
      page: r.page,
      sectionTitle: r.sectionTitle,
      source: r.source,
      parentChunkId: r.parentChunkId,
      kind: r.kind ?? 'child',
      embeddingModel: r.embeddingModel,
      contentHash: r.contentHash,
    })),
  );
  return { documentId: row.id };
}

export async function ingestFile(
  input: IngestFileInput,
  deps: IngestDeps,
): Promise<Result<IngestResult>> {
  const { fileName, buffer, uploadedBy } = input;
  const fileHash = deps.hasher.sha256(buffer);

  const existing = await deps.documents.findByName(fileName);
  if (existing && existing.fileHash === fileHash) {
    return ok({ documentId: existing.id, chunks: 0, status: 'unchanged' });
  }

  const parsed = await parseAndEmbed({ fileName, buffer }, deps);
  if (!parsed.ok) return parsed;

  // Upsert by unique file_name: an existing (or soft-deleted) same-name row is
  // updated in place and un-deleted, keeping its id, so we never delete the row
  // we just wrote (which previously caused an FK violation on the audit insert)
  // and never lose the only copy. Its chunks are then replaced wholesale.
  // When a transaction runner is available the whole sequence runs atomically.
  const outcome = deps.runner
    ? await deps.runner.run((ctx) => writeChunks(ctx.documents, ctx.chunks, { fileName, fileHash, uploadedBy }, parsed.value.rows))
    : await writeChunks(deps.documents, deps.chunks, { fileName, fileHash, uploadedBy }, parsed.value.rows);

  return ok({
    documentId: outcome.documentId,
    chunks: parsed.value.chunks,
    status: existing ? 'updated' : 'inserted',
  });
}

/** Parse/split/embed for an existing `queued` row; caller inserts chunks + flips status atomically. */
export async function prepareIngest(
  input: { documentId: number; fileName: string; buffer: Buffer },
  deps: ParseDeps,
): Promise<Result<{ chunks: number; rows: PreparedChunk[] }>> {
  const parsed = await parseAndEmbed(input, deps);
  if (!parsed.ok) return parsed;
  return ok({
    chunks: parsed.value.chunks,
    rows: parsed.value.rows.map((r) => ({ ...r, documentId: input.documentId })),
  });
}
