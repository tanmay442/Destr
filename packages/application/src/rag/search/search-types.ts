import type { ChunkRepository, EmbeddingService, Reranker, RetrievedChunkRow } from '@app/domain';
import type {
  RetrievalScores,
  RetrievalSignal,
  SearchDegradation,
  SearchFailure,
} from './search-contract';

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
  chunkIndex: number;
  scores: RetrievalScores;
}

interface ScoredRow extends RetrievedChunkRow {
  denseScore?: number;
  lexicalScore?: number;
  fusedScore?: number;
  rerankerScore?: number;
}

export type { ScoredRow };

export function scoreOf(row: ScoredRow): number {
  return row.rerankerScore ?? row.fusedScore ?? row.denseScore ?? row.lexicalScore ?? 0;
}

function finiteNonnegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function denseScoredRows(rows: RetrievedChunkRow[]): ScoredRow[] {
  return rows.map((row) => ({ ...row, denseScore: finiteNonnegative(Number(row.similarity)) }));
}

export function lexicalScoredRows(rows: RetrievedChunkRow[]): ScoredRow[] {
  return rows.map((row) => ({ ...row, lexicalScore: finiteNonnegative(Number(row.similarity)) }));
}

function finalSignal(row: ScoredRow): RetrievalSignal {
  if (row.rerankerScore !== undefined) return 'reranker';
  if (row.fusedScore !== undefined) return 'fusion';
  if (row.denseScore !== undefined) return 'dense';
  return 'lexical';
}

function scoresOf(row: ScoredRow, finalRank: number): RetrievalScores {
  return {
    ...(row.denseScore !== undefined ? { dense: finiteNonnegative(row.denseScore) } : {}),
    ...(row.lexicalScore !== undefined ? { lexical: finiteNonnegative(row.lexicalScore) } : {}),
    ...(row.fusedScore !== undefined ? { fusion: finiteNonnegative(row.fusedScore) } : {}),
    ...(row.rerankerScore !== undefined ? { reranker: finiteNonnegative(row.rerankerScore) } : {}),
    finalRank: Math.max(1, Math.floor(finalRank)),
    finalSignal: finalSignal(row),
  };
}

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
  /** Override `PARENT_CHILD_MODE` for this call (`parent`|`window`|`segment`). */
  mode?: 'parent' | 'window' | 'segment' | undefined;
  /** Override `PARENT_CHILD_WINDOW` for this call. */
  parentChildWindow?: number | undefined;
  /** RSE penalty subtracted from normalized relevance in `segment` mode. */
  rsePenalty?: number | undefined;
  /** Maximum chunks in one reconstructed segment. */
  rseMaxSegmentChunks?: number | undefined;
  /** Maximum chunks across segments per contiguous run. */
  rseOverallMaxChunks?: number | undefined;
  /** Minimum segment value required for emission. */
  rseMinSegmentValue?: number | undefined;
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

export interface SearchExecutionResult {
  readonly chunks: RetrievedChunk[];
  readonly degradedBy: readonly SearchDegradation[];
}

export type SearchChunksResult = import('@app/domain').Result<SearchExecutionResult, SearchFailure>;

function toRetrievedChunk(r: ScoredRow, finalRank = 1): RetrievedChunk {
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
    chunkIndex: r.chunkIndex,
    scores: scoresOf(r, finalRank),
  };
}

export { toRetrievedChunk };
