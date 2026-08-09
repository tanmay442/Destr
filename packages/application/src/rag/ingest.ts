import { err, ok, type Result, ValidationError, ExternalServiceError, ParseError } from '@app/domain';
import type {
  DocumentRepository, ChunkRepository, EmbeddingService,
  Hasher, PdfParser, TextSplitter, TransactionRunner,
  ContentParser, ChunkingStrategy, DocumentChunk, DocSummarizer,
} from '@app/domain';
import { CCH_ENABLED, CCH_CONTEXT_CHARS } from '@app/domain';

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
  /** Optional: when present, chunking uses the new strategy path instead of the legacy TextSplitter. */
  contentParser?: ContentParser | undefined;
  chunkingStrategy?: ChunkingStrategy | undefined;
  /** Optional Contextual-Chunk-Header summarizer. */
  summarizer?: DocSummarizer | undefined;
  /** Optional transaction runner used to make the upsert+replace-chunks sequence atomic. */
  runner?: TransactionRunner | undefined;
  /** Override the CCH toggle. */
  cchEnabled?: boolean | undefined;
}

export interface PreparedChunk {
  documentId: number;
  content: string;
  embedding: number[];
  chunkIndex: number;
  page?: number | null | undefined;
  sectionTitle?: string | null | undefined;
  source?: string | null | undefined;
  title?: string | null | undefined;
  parentChunkId?: number | null | undefined;
  kind?: 'parent' | 'child' | 'summary' | undefined;
  embeddingModel?: string | null | undefined;
  contentHash?: string | null | undefined;
}

export interface ParseDeps {
  embeddings: EmbeddingService;
  pdfParser: PdfParser;
  textSplitter: TextSplitter;
  contentParser?: ContentParser | undefined;
  chunkingStrategy?: ChunkingStrategy | undefined;
  /** CCH summarizer. When present (and `CCH_ENABLED`), one title+summary per document. */
  summarizer?: DocSummarizer | undefined;
  /** Override the CCH toggle. */
  cchEnabled?: boolean | undefined;
}

async function buildCchHeader(
  deps: ParseDeps,
  sourceText: string,
): Promise<{ header: string; title: string | null; summary: string | null }> {
  if (!deps.summarizer || !(deps.cchEnabled ?? CCH_ENABLED)) {
    return { header: '', title: null, summary: null };
  }
  const ctx = await deps.summarizer.generateDocContext(sourceText.slice(0, CCH_CONTEXT_CHARS));
  const title = ctx.title?.trim() || null;
  const summary = ctx.summary?.trim() || null;
  const header = title ? `Document: ${title}\nSummary: ${summary ?? ''}\n\n` : '';
  return { header, title, summary };
}

/** Attach the CCH header as an embedding-only prefix; `content` stays clean so citations are unpolluted. */
function applyCchHeader(
  docChunks: DocumentChunk[],
  header: string,
  title: string | null,
  summary: string | null,
): DocumentChunk[] {
  return docChunks.map((c) => ({
    ...c,
    embeddingPrefix: header || undefined,
    title: c.title ?? title,
    summary: c.summary ?? summary,
  }));
}

/** Text sent to the embedding model: CCH prefix + clean content when present. */
function embeddingInput(c: DocumentChunk): string {
  return c.embeddingPrefix ? c.embeddingPrefix + c.content : c.content;
}

function toPreparedRows(
  docChunks: DocumentChunk[],
  embeddings: number[][],
  documentId: number,
): PreparedChunk[] {
  return docChunks.map((c, i) => ({
    documentId,
    content: c.content,
    embedding: embeddings[i] ?? [],
    chunkIndex: c.chunkIndex,
    page: c.page ?? null,
    sectionTitle: c.sectionTitle ?? null,
    source: c.source ?? null,
    title: c.title ?? null,
    parentChunkId: c.parentChunkId ?? null,
    kind: c.kind ?? 'child',
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
    const pages = await deps.contentParser.extractPages(input.buffer);
    docChunks = await deps.chunkingStrategy.splitPages(pages);
    sourceText = pages.map((p) => p.text).join('\n\n');
  } else {
    let text: string;
    try {
      text = await deps.pdfParser.extractText(input.buffer);
    } catch (cause) {
      return err(new ParseError('PDF parsing failed', cause));
    }
    sourceText = text;
    const texts = await deps.textSplitter.splitText(text);
    docChunks = texts.map((t, i) => ({ content: t, chunkIndex: i }));
  }
  const { header, title, summary } = await buildCchHeader(deps, sourceText);
  docChunks = applyCchHeader(docChunks, header, title, summary);

  if (docChunks.length === 0) {
    return err(new ValidationError(`No extractable text in ${input.fileName}`));
  }

  // Parent blocks are excluded from vector queries; skip embedding them.
  const hasParents = docChunks.some((c) => c.kind === 'parent');
  const embeddable = docChunks.filter((c) => c.kind !== 'parent');
  if (hasParents && embeddable.length > 0) {
    let embedEmbeddings: number[][];
    try {
      embedEmbeddings = await deps.embeddings.embedBatch(embeddable.map(embeddingInput));
    } catch (cause) {
      return err(new ExternalServiceError('Embedding API failed', cause));
    }
    if (embedEmbeddings.length !== embeddable.length) {
      return err(new ExternalServiceError('Embedding count mismatch'));
    }
    const dim = embedEmbeddings[0]?.length ?? 0;
    const placeholder = dim > 0 ? new Array<number>(dim).fill(0) : [];
    const embByIndex = new Map<number, number[]>();
    embeddable.forEach((c, i) => embByIndex.set(c.chunkIndex, embedEmbeddings[i]!));
    const embeddings = docChunks.map((c) =>
      c.kind === 'parent' ? placeholder : embByIndex.get(c.chunkIndex)!,
    );
    return ok({ chunks: docChunks.length, rows: toPreparedRows(docChunks, embeddings, 0) });
  }

  let embeddings: number[][];
  try {
    embeddings = await deps.embeddings.embedBatch(docChunks.map(embeddingInput));
  } catch (cause) {
    return err(new ExternalServiceError('Embedding API failed', cause));
  }
  if (embeddings.length !== docChunks.length) {
    return err(new ExternalServiceError('Embedding count mismatch'));
  }

  return ok({ chunks: docChunks.length, rows: toPreparedRows(docChunks, embeddings, 0) });
}

/** Write the upsert-then-replace-chunks sequence. Exported so other ingest
 *  paths (pre-chunked Markdown) can reuse the atomic insert + chunk-replace. */
export async function writeChunks(
  documents: DocumentRepository,
  chunks: ChunkRepository,
  input: { fileName: string; fileHash: string; uploadedBy: string; storageKey?: string | null | undefined },
  rows: PreparedChunk[],
): Promise<{ documentId: number }> {
  const row = await documents.insert({ fileName: input.fileName, fileHash: input.fileHash, uploadedBy: input.uploadedBy });
  if (input.storageKey) await documents.setStorageKey(row.id, input.storageKey);
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
      title: r.title,
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

  // Upsert by file_name: reuse existing id to avoid FK violations on audit inserts.
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
