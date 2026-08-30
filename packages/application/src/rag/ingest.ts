import { err, ok, type Result, ValidationError, ExternalServiceError, ParseError, ConflictError } from '@app/domain';
import type {
  DocumentRepository, ChunkRepository, EmbeddingService,
  Hasher, PdfParser, TextSplitter, TransactionRunner,
  ContentParser, ChunkingStrategy, DocumentChunk, DocSummarizer,
  IngestStatus, InsertChunkInput,
} from '@app/domain';
import { CCH_ENABLED, CCH_CONTEXT_CHARS, RESTORE_WINDOW_MS } from '@app/domain';

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

export const UPLOAD_CONFLICT_MESSAGE =
  'A document with this file name was uploaded by another request; retry the upload';

function isDocumentNameConflict(error: unknown): boolean {
  const wrapped = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const pgError = wrapped.code ? wrapped : wrapped.cause;
  return pgError?.code === '23505' && pgError.constraint === 'documents_file_name_unique';
}

export interface RowPrevious {
  fileHash: string | null;
  status: IngestStatus | null;
  storageKey: string | null;
}

export type DocumentNameClaim =
  | { kind: 'unchanged'; documentId: number; restore: boolean }
  | { kind: 'replace'; documentId: number; previous: RowPrevious }
  | { kind: 'resurrect'; documentId: number; previous: RowPrevious }
  | { kind: 'insert'; oldStorageKey: string | null };

export async function claimDocumentByName(
  fileName: string,
  fileHash: string,
  documents: DocumentRepository,
): Promise<DocumentNameClaim> {
  const row = await (documents.findByNameForUpdate?.(fileName, { includeDeleted: true }) ?? documents.findByName(fileName, { includeDeleted: true }));
  if (!row) return { kind: 'insert', oldStorageKey: null };
  if (!row.deletedAt) {
    if (row.fileHash === fileHash) return { kind: 'unchanged', documentId: row.id, restore: false };
    return {
      kind: 'replace',
      documentId: row.id,
      previous: { fileHash: row.fileHash, status: row.ingestStatus, storageKey: row.storageKey },
    };
  }
  if (Date.now() - row.deletedAt.getTime() <= RESTORE_WINDOW_MS) {
    if (row.fileHash === fileHash) return { kind: 'unchanged', documentId: row.id, restore: true };
    return {
      kind: 'resurrect',
      documentId: row.id,
      previous: { fileHash: row.fileHash, status: row.ingestStatus, storageKey: row.storageKey },
    };
  }
  return { kind: 'insert', oldStorageKey: row.storageKey };
}

export async function nameStillClaimed(
  fileName: string,
  fileHash: string,
  documents: DocumentRepository,
): Promise<boolean> {
  const row = await documents.findByName(fileName);
  return row !== null && row.fileHash === fileHash;
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

export async function ingestFile(
  input: IngestFileInput,
  deps: IngestDeps,
): Promise<Result<IngestResult>> {
  const { fileName, buffer, uploadedBy } = input;
  const fileHash = deps.hasher.sha256(buffer);

  const parsed = await parseAndEmbed({ fileName, buffer }, deps);
  if (!parsed.ok) return parsed;

  const write = async (
    documents: DocumentRepository,
    chunks: ChunkRepository,
  ): Promise<Result<IngestResult>> => {
    const claim = await claimDocumentByName(fileName, fileHash, documents);
    if (claim.kind === 'unchanged') {
      if (claim.restore) await documents.restore(claim.documentId);
      return ok({ documentId: claim.documentId, chunks: 0, status: 'unchanged' });
    }
    const outcome = await writeChunks(
      documents,
      chunks,
      { fileName, fileHash, uploadedBy, resurrectDeleted: claim.kind === 'resurrect' },
      parsed.value.rows,
    );
    if (!(await nameStillClaimed(fileName, fileHash, documents))) {
      throw new ConflictError(UPLOAD_CONFLICT_MESSAGE);
    }
    return ok({
      documentId: outcome.documentId,
      chunks: parsed.value.chunks,
      status: claim.kind === 'replace' ? 'updated' : 'inserted',
    });
  };

  try {
    return deps.runner
      ? await deps.runner.run((ctx) => write(ctx.documents, ctx.chunks))
      : await write(deps.documents, deps.chunks);
  } catch (error) {
    if (isDocumentNameConflict(error)) return err(new ConflictError(UPLOAD_CONFLICT_MESSAGE));
    if (error instanceof ConflictError) return err(error);
    throw error;
  }
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
