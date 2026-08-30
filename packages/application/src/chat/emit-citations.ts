import type { RetrievedChunk } from '../rag/search';
import { CITATION_SNIPPET_MAX } from '@app/domain';

export interface EmittedCitation {
  id: number;
  documentId: number;
  documentUid?: string;
  chunkUid?: string;
  similarity: number;
  snippet: string;
  fileName: string | null;
  page: number | null;
  sectionTitle: string | null;
  source: string | null;
}

function truncateSnippet(content: string, max: number): string {
  if (content.length <= max) return content;
  let end = max;
  const code = content.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return content.slice(0, end) + '\u2026';
}

export function emitCitations(
  chunks: RetrievedChunk[],
  snippetMax = CITATION_SNIPPET_MAX,
): EmittedCitation[] {
  return chunks.map((m) => ({
    id: m.id,
    documentId: m.documentId,
    ...(m.documentUid ? { documentUid: m.documentUid } : {}),
    ...(m.chunkUid ? { chunkUid: m.chunkUid } : {}),
    similarity: m.similarity,
    snippet: truncateSnippet(m.content, snippetMax),
    fileName: m.fileName,
    page: m.page,
    sectionTitle: m.sectionTitle,
    source: m.source,
  }));
}

export function citationDocumentIds(citations: Array<{ documentId?: number | null | undefined }>): number[] {
  return [...new Set(citations.map((c) => c.documentId).filter((id): id is number => typeof id === 'number' && id > 0))];
}
