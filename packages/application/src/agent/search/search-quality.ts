import type { RetrievedChunk } from '../../rag/search/search-types';

export type EvidenceQuality =
  | 'sufficient'
  | 'partial'
  | 'weak'
  | 'empty';

export type QualityReasonCode =
  | 'sufficient_evidence'
  | 'weak_relevance'
  | 'coverage_gap'
  | 'duplicate_only'
  | 'no_results'
  | 'relevance_floor'
  | 'candidate_exhausted';

export interface QualityAssessment {
  readonly quality: EvidenceQuality;
  readonly reasonCode: QualityReasonCode;
  readonly resultCount: number;
  readonly hasMore: boolean;
  readonly degraded: boolean;
}

export interface PriorResultSummary {
  readonly documentId: number;
  readonly chunkUid?: string | undefined;
  readonly chunkIndex: number;
  readonly title?: string | undefined;
  readonly section?: string | undefined;
  readonly rank: number;
  readonly qualityReason: QualityReasonCode;
}

export interface PriorAttemptFeedback {
  readonly normalizedQueries: readonly string[];
  readonly resultSummaries: readonly PriorResultSummary[];
  readonly remainingPlans: number;
  readonly remainingMs: number | null;
}

function bestSignal(chunk: RetrievedChunk): number {
  const scores = chunk.scores;
  if (scores.finalSignal === 'reranker' && scores.reranker !== undefined) return scores.reranker;
  if (scores.finalSignal === 'fusion' && scores.fusion !== undefined) return scores.fusion;
  if (scores.finalSignal === 'dense' && scores.dense !== undefined) return scores.dense;
  if (scores.finalSignal === 'lexical' && scores.lexical !== undefined) return scores.lexical;
  return scores.dense ?? scores.lexical ?? scores.fusion ?? scores.reranker ?? 0;
}

export function assessSubquestionQuality(input: {
  chunks: readonly RetrievedChunk[];
  requestedCount: number;
  hasMore: boolean;
  degraded: boolean;
  duplicatesSkipped: number;
  rerankerThreshold?: number | undefined;
}): QualityAssessment {
  const { chunks, requestedCount, hasMore, degraded, duplicatesSkipped } = input;
  if (chunks.length === 0) {
    if (duplicatesSkipped > 0) {
      return {
        quality: 'partial',
        reasonCode: 'duplicate_only',
        resultCount: 0,
        hasMore,
        degraded,
      };
    }
    return {
      quality: 'empty',
      reasonCode: 'no_results',
      resultCount: 0,
      hasMore,
      degraded,
    };
  }
  if (chunks.length < requestedCount && !hasMore) {
    return {
      quality: 'partial',
      reasonCode: 'candidate_exhausted',
      resultCount: chunks.length,
      hasMore,
      degraded,
    };
  }
  const threshold = input.rerankerThreshold ?? 0.5;
  const weak = chunks.every((chunk) => {
    if (chunk.scores.finalSignal !== 'reranker') return false;
    const value = chunk.scores.reranker ?? 1;
    return value < threshold + 0.1 && value >= threshold;
  });
  if (weak) {
    return {
      quality: 'weak',
      reasonCode: 'weak_relevance',
      resultCount: chunks.length,
      hasMore,
      degraded,
    };
  }
  if (chunks.length < requestedCount || degraded) {
    return {
      quality: 'partial',
      reasonCode: 'coverage_gap',
      resultCount: chunks.length,
      hasMore,
      degraded,
    };
  }
  void bestSignal;
  return {
    quality: 'sufficient',
    reasonCode: 'sufficient_evidence',
    resultCount: chunks.length,
    hasMore,
    degraded,
  };
}

export function summarizeForFollowup(input: {
  normalizedQueries: readonly string[];
  chunks: readonly RetrievedChunk[];
  reasonCode: QualityReasonCode;
  maxSummaries?: number | undefined;
}): PriorAttemptFeedback {
  const max = Math.max(1, Math.min(input.maxSummaries ?? 10, 20));
  const summaries: PriorResultSummary[] = input.chunks.slice(0, max).map((chunk, index) => ({
    documentId: chunk.documentId,
    ...(chunk.chunkUid ? { chunkUid: chunk.chunkUid } : {}),
    chunkIndex: chunk.chunkIndex,
    ...(chunk.title ? { title: chunk.title.slice(0, 120) } : {}),
    ...(chunk.sectionTitle ? { section: chunk.sectionTitle.slice(0, 120) } : {}),
    rank: index + 1,
    qualityReason: input.reasonCode,
  }));
  return {
    normalizedQueries: input.normalizedQueries.slice(0, 20),
    resultSummaries: summaries,
    remainingPlans: 1,
    remainingMs: null,
  };
}
