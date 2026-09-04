import { err, ok, type Result, ValidationError, ExternalServiceError, ParseError } from '@app/domain';
import type {
  EmbeddingService,
  PdfParser, TextSplitter,
  ContentParser, ChunkingStrategy, DocumentChunk, DocSummarizer,
} from '@app/domain';
import { CCH_ENABLED, CCH_CONTEXT_CHARS } from '@app/domain';

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

function embedBatch(
  embeddings: EmbeddingService,
  values: string[],
  signal: AbortSignal | undefined,
): Promise<number[][]> {
  return signal === undefined
    ? embeddings.embedBatch(values)
    : embeddings.embedBatch(values, { signal });
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
  input: { fileName: string; buffer: Uint8Array; signal?: AbortSignal | undefined },
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
      embedEmbeddings = await embedBatch(deps.embeddings, embeddable.map(embeddingInput), input.signal);
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
    embeddings = await embedBatch(deps.embeddings, docChunks.map(embeddingInput), input.signal);
  } catch (cause) {
    return err(new ExternalServiceError('Embedding API failed', cause));
  }
  if (embeddings.length !== docChunks.length) {
    return err(new ExternalServiceError('Embedding count mismatch'));
  }

  return ok({ chunks: docChunks.length, rows: toPreparedRows(docChunks, embeddings, 0) });
}
