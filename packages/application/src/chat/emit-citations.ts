import type { RetrievedChunk } from '../rag/search';
import { CITATION_SNIPPET_MAX } from '@app/domain';

export interface EmittedCitation {
  id: number;
  documentId: number;
  chunkIndex: number;
  documentUid?: string;
  chunkUid?: string;
  scores: RetrievedChunk['scores'];
  snippet: string;
  fileName: string | null;
  page: number | null;
  sectionTitle: string | null;
  source: string | null;
  callId?: string | undefined;
  subquestionId?: string | undefined;
  queryIds?: readonly string[] | undefined;
}

function truncateSnippet(content: string, max: number): string {
  if (content.length <= max) return content;
  let end = max;
  const code = content.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return content.slice(0, end) + '\u2026';
}

/** Optional retrieval provenance a chunk may carry into citation emission. */
export interface CitationProvenance {
  readonly callId?: string | undefined;
  readonly subquestionId?: string | undefined;
  readonly queryIds?: readonly string[] | undefined;
}

export type CitableChunk = RetrievedChunk & CitationProvenance;

export function emitCitations(
  chunks: CitableChunk[],
  snippetMax = CITATION_SNIPPET_MAX,
): EmittedCitation[] {
  return chunks.map((m) => ({
    id: m.id,
    documentId: m.documentId,
    chunkIndex: m.chunkIndex,
    ...(m.documentUid ? { documentUid: m.documentUid } : {}),
    ...(m.chunkUid ? { chunkUid: m.chunkUid } : {}),
    scores: m.scores,
    snippet: truncateSnippet(m.content, snippetMax),
    fileName: m.fileName,
    page: m.page,
    sectionTitle: m.sectionTitle,
    source: m.source,
    ...(m.callId !== undefined ? { callId: m.callId } : {}),
    ...(m.subquestionId !== undefined ? { subquestionId: m.subquestionId } : {}),
    ...(m.queryIds !== undefined ? { queryIds: [...m.queryIds] } : {}),
  }));
}

export function citationDocumentIds(citations: Array<{ documentId?: number | null | undefined }>): number[] {
  return [...new Set(citations.map((c) => c.documentId).filter((id): id is number => typeof id === 'number' && id > 0))];
}
