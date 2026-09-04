import type { ChunkRepository, EmbeddingService, Reranker, RetrievedChunkRow } from '@app/domain';

const MAX_SEARCH_LIMIT = 50;
const MAX_CANDIDATE_LIMIT = 500;

export { MAX_SEARCH_LIMIT, MAX_CANDIDATE_LIMIT };

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  const candidate = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(candidate, 1), maximum);
}

function boundedNonnegativeNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(value, 0) : fallback;
}

export { boundedPositiveInteger, boundedNonnegativeNumber };

export interface RetrievedChunk {
  id: number;
  documentId: number;
  documentUid?: string;
  chunkUid?: string;
  fileName: string | null;
  page: number | null;
  sectionTitle: string | null;
  source: string | null;
  title: string | null;
  content: string;
  similarity: number;
}

interface ScoredRow extends RetrievedChunkRow {
  fusedScore?: number;
}

export type { ScoredRow };

export interface SearchDeps {
  chunks: ChunkRepository;
  embeddings: EmbeddingService;
  /** Optional second-stage reranker. Retrieves a broad pool then reorders by
   *  relevance. Falls back to cosine ordering when absent. */
  reranker?: Reranker | undefined;
}

export interface SearchOpts {
  signal?: AbortSignal | undefined;
  threshold?: number | undefined;
  limit?: number | undefined;
  /** Override `PARENT_CHILD_MODE` for this call (`parent`|`window`). */
  mode?: 'parent' | 'window' | undefined;
  /** Override `PARENT_CHILD_WINDOW` for this call. */
  parentChildWindow?: number | undefined;
  /** Broad candidate-pool size before reranking. Ignored when no reranker. */
  candidateLimit?: number | undefined;
  /** Override `HYBRID_ENABLED`. Defaults to the frozen constant. */
  hybridEnabled?: boolean | undefined;
  /** Override RRF_K (Reciprocal Rank Fusion constant). */
  rrfK?: number | undefined;
  /** Override LEXICAL_WEIGHT (lexical modality boost). */
  lexicalWeight?: number | undefined;
  /** Override RERANK_TOP_N (default search limit). */
  rerankTopN?: number | undefined;
}

function toRetrievedChunk(r: RetrievedChunkRow): RetrievedChunk {
  return {
    id: r.id,
    documentId: r.documentId,
    ...(r.documentUid ? { documentUid: r.documentUid } : {}),
    ...(r.chunkUid ? { chunkUid: r.chunkUid } : {}),
    fileName: r.fileName,
    page: r.page,
    sectionTitle: r.sectionTitle,
    source: r.source,
    title: r.title,
    content: r.content,
    similarity: Number(r.similarity),
  };
}

export { toRetrievedChunk };
