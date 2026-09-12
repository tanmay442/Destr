import { stableChunkIdentities, type RetrievedChunk } from '../rag/search';
import { serializeUntrustedChunk } from '../agent/prompt/serialize-untrusted-result';
import { evidenceStableKey, type StructuredEvidenceItem } from '../agent/grounding/grounding-decision';
import { emitCitations, type EmittedCitation } from './emit-citations';

const MAX_UNIQUE_GROUNDING_CHUNKS = 30;

export interface GroundingEvidence {
  citations: EmittedCitation[];
  documents: string[];
  seenChunkKeys: Set<string>;
  structured: StructuredEvidenceItem[];
}

export function createGroundingEvidence(): GroundingEvidence {
  return {
    citations: [],
    documents: [],
    seenChunkKeys: new Set<string>(),
    structured: [],
  };
}

export interface SearchProvenanceAttachment {
  readonly callId: string;
  readonly subquestionId: string;
  readonly queryIds: readonly string[];
  readonly items: readonly {
    readonly chunkUid?: string | undefined;
    readonly documentId: number;
    readonly chunkIndex: number;
  }[];
}

function mergeUnique(existing: readonly string[], additions: readonly string[]): string[] {
  const merged = [...existing];
  for (const value of additions) {
    if (!merged.includes(value)) merged.push(value);
  }
  return merged;
}

export function attachSearchProvenance(
  evidence: GroundingEvidence,
  attachment: SearchProvenanceAttachment,
): void {
  if (attachment.callId.trim() === '' || attachment.subquestionId.trim() === '') return;
  for (const item of attachment.items) {
    const key = evidenceStableKey(item);
    const structuredIndex = evidence.structured.findIndex((entry) => evidenceStableKey(entry) === key);
    if (structuredIndex >= 0) {
      const entry = evidence.structured[structuredIndex];
      if (entry === undefined) continue;
      evidence.structured[structuredIndex] = {
        ...entry,
        subquestionIds: mergeUnique(entry.subquestionIds, [attachment.subquestionId]),
        callIds: mergeUnique(entry.callIds, [attachment.callId]),
        queryIds: mergeUnique(entry.queryIds, attachment.queryIds),
      };
    }
    for (let index = 0; index < evidence.citations.length; index += 1) {
      const citation = evidence.citations[index];
      if (citation === undefined) continue;
      if (evidenceStableKey(citation) !== key) continue;
      evidence.citations[index] = {
        ...citation,
        ...(citation.callId !== undefined ? {} : { callId: attachment.callId }),
        ...(citation.subquestionId !== undefined ? {} : { subquestionId: attachment.subquestionId }),
        queryIds: mergeUnique(citation.queryIds ?? [], attachment.queryIds),
      };
    }
  }
}
export function addGroundingEvidence(
  evidence: GroundingEvidence,
  chunks: RetrievedChunk[],
): RetrievedChunk[] {
  const uniqueChunks: RetrievedChunk[] = [];
  for (const chunk of chunks) {
    const keys = stableChunkIdentities(chunk);
    if (keys.some((key) => evidence.seenChunkKeys.has(key))) continue;
    const citationSources = chunk.constituentChunks?.length ? chunk.constituentChunks : [chunk];
    if (evidence.citations.length + citationSources.length > MAX_UNIQUE_GROUNDING_CHUNKS) break;
    for (const key of keys) evidence.seenChunkKeys.add(key);
    uniqueChunks.push(chunk);
    // All model-visible document formatting goes through the centralized
    // untrusted-result seam; this module must not build its own wrapper.
    evidence.documents.push(serializeUntrustedChunk({ content: chunk.content, source: chunk.source }));
    evidence.citations.push(...emitCitations([...citationSources]));
    // Tool-call provenance (callId/subquestionId/queryIds) is attached
    // after execution via attachSearchProvenance: RetrievedChunk carries no
    // provenance fields, so new entries start empty here.
    // One entry per unique chunk; already-seen chunks skip entirely.
    evidence.structured.push({
      ...(chunk.chunkUid ? { chunkUid: chunk.chunkUid } : {}),
      documentId: chunk.documentId,
      chunkIndex: chunk.chunkIndex,
      subquestionIds: [],
      callIds: [],
      queryIds: [],
      content: chunk.content,
      source: chunk.source,
    });
  }
  return uniqueChunks;
}
