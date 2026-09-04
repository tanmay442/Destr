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
): Promise<{ baseHeader: string; title: string | null; summary: string | null }> {
  if (!deps.summarizer || !(deps.cchEnabled ?? CCH_ENABLED)) {
    return { baseHeader: '', title: null, summary: null };
  }
  const ctx = await deps.summarizer.generateDocContext(sourceText.slice(0, CCH_CONTEXT_CHARS));
  const title = ctx.title?.trim() || null;
  const summary = ctx.summary?.trim() || null;
  const baseHeader = title ? `Document: ${title}\nSummary: ${summary ?? ''}\n` : '';
  return { baseHeader, title, summary };
}

function chunkHeader(baseHeader: string, sectionTitle: string | null | undefined): string {
  if (!baseHeader) return '';
  const section = sectionTitle?.trim() ? `Section: ${sectionTitle.trim()}\n` : '';
  return `${baseHeader}${section}\n`;
}

/** Attach the CCH header as an embedding-only prefix; `content` stays clean so citations are unpolluted. */
function applyCchHeader(
  docChunks: DocumentChunk[],
  baseHeader: string,
  title: string | null,
  summary: string | null,
): DocumentChunk[] {
  return docChunks.map((c) => ({
    ...c,
    embeddingPrefix: chunkHeader(baseHeader, c.sectionTitle) || undefined,
    title: c.title ?? title,
    summary: c.summary ?? summary,
  }));
}

/** Text sent to the embedding model: CCH prefix + clean content when present. */
function embeddingInput(c: DocumentChunk): string {
  return c.embeddingPrefix ? c.embeddingPrefix + c.content : c.content;
}

const PARENT_EMBED_MAX_CHARS = 2000;

function parentEmbeddingInput(c: DocumentChunk): string {
  const body = c.content.length > PARENT_EMBED_MAX_CHARS
    ? c.content.slice(0, PARENT_EMBED_MAX_CHARS).replace(/\s+\S*$/, '')
    : c.content;
  return c.embeddingPrefix ? c.embeddingPrefix + body : body;
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
  const { baseHeader, title, summary } = await buildCchHeader(deps, sourceText);
  docChunks = applyCchHeader(docChunks, baseHeader, title, summary);

  if (docChunks.length === 0) {
    return err(new ValidationError(`No extractable text in ${input.fileName}`));
  }

  const values = docChunks.map((c) =>
    c.kind === 'parent' ? parentEmbeddingInput(c) : embeddingInput(c),
  );
  let embeddings: number[][];
  try {
    embeddings = await embedBatch(deps.embeddings, values, input.signal);
  } catch (cause) {
    return err(new ExternalServiceError('Embedding API failed', cause));
  }
  if (embeddings.length !== docChunks.length) {
    return err(new ExternalServiceError('Embedding count mismatch'));
  }

  return ok({ chunks: docChunks.length, rows: toPreparedRows(docChunks, embeddings, 0) });
}
