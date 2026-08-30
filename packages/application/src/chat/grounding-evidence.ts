import { TOOL_CONTENT_CAP } from '@app/domain';
import type { RetrievedChunk } from '../rag/search';
import { emitCitations, type EmittedCitation } from './emit-citations';

const MAX_UNIQUE_GROUNDING_CHUNKS = 30;

export interface GroundingEvidence {
  citations: EmittedCitation[];
  documents: string[];
  seenChunkKeys: Set<string>;
}

export function createGroundingEvidence(): GroundingEvidence {
  return {
    citations: [],
    documents: [],
    seenChunkKeys: new Set<string>(),
  };
}

function chunkKey(chunk: RetrievedChunk): string {
  if (Number.isInteger(chunk.id)) return `id:${chunk.id}`;
  return `fallback:${chunk.documentId ?? ''}:${chunk.source ?? ''}:${chunk.page ?? ''}:${chunk.content}`;
}

function capContent(content: string): string {
  if (content.length <= TOOL_CONTENT_CAP) return content;
  let end = TOOL_CONTENT_CAP;
  const code = content.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return content.slice(0, end) + '\u2026';
}

export function formatGroundingReference(chunk: RetrievedChunk): string {
  return `<reference source="${chunk.source}">\n${capContent(chunk.content)}\n</reference>`;
}

export function addGroundingEvidence(
  evidence: GroundingEvidence,
  chunks: RetrievedChunk[],
): RetrievedChunk[] {
  const uniqueChunks: RetrievedChunk[] = [];
  for (const chunk of chunks) {
    const key = chunkKey(chunk);
    if (evidence.seenChunkKeys.has(key)) continue;
    if (evidence.citations.length >= MAX_UNIQUE_GROUNDING_CHUNKS) break;
    evidence.seenChunkKeys.add(key);
    uniqueChunks.push(chunk);
    evidence.documents.push(formatGroundingReference(chunk));
    const citation = emitCitations([chunk])[0];
    if (citation) evidence.citations.push(citation);
  }
  return uniqueChunks;
}
