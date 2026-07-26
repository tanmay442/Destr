import type { RetrievedChunk } from '@app/application/rag/search';
import { CITATION_SNIPPET_MAX } from '../../config/constants';

export interface EmittedCitation {
  id: number;
  documentId: number;
  similarity: number;
  snippet: string;
  fileName: string | null;
  page: number | null;
  sectionTitle: string | null;
  source: string | null;
}

export function emitCitations(
  chunks: RetrievedChunk[],
  snippetMax = CITATION_SNIPPET_MAX,
): EmittedCitation[] {
  return chunks.map((m) => ({
    id: m.id,
    documentId: m.documentId,
    similarity: m.similarity,
    snippet:
      m.content.length > snippetMax
        ? m.content.slice(0, snippetMax) + '\u2026'
        : m.content,
    fileName: m.fileName,
    page: m.page,
    sectionTitle: m.sectionTitle,
    source: m.source,
  }));
}

export function citationDocumentIds(citations: Array<{ documentId?: number | null }>): number[] {
  return [...new Set(citations.map((c) => c.documentId).filter((id): id is number => typeof id === 'number' && id > 0))];
}
