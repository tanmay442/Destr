import { err, ok, type Result, ExternalServiceError, logger } from '@app/domain';
import type { ChunkRepository, EmbeddingService, Reranker, RetrievedChunkRow } from '@app/domain';
import {
  SIMILARITY_THRESHOLD,
  PARENT_CHILD_MODE,
  PARENT_CHILD_WINDOW,
  CANDIDATE_POOL,
  RERANK_TOP_N,
  HYBRID_ENABLED,
  RRF_K,
  LEXICAL_WEIGHT,
} from '@app/domain';
import { sanitizePagination } from '../service-result';

const MAX_SEARCH_LIMIT = 50;
const MAX_CANDIDATE_LIMIT = 500;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Search aborted');
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error('Search aborted'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  const candidate = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(candidate, 1), maximum);
}

function boundedNonnegativeNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(value, 0) : fallback;
}

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

async function resolveParents(
  hits: ScoredRow[],
  deps: SearchDeps,
  topN: number,
  signal?: AbortSignal,
): Promise<RetrievedChunk[]> {
  const childHits = hits.filter((h) => h.parentChunkId != null);
  const flatHits = hits.filter((h) => h.parentChunkId == null);
  if (childHits.length === 0) {
    return hits.map(toRetrievedChunk);
  }

  const parentIds = [...new Set(childHits.map((h) => h.parentChunkId as number))];
  const parents = await abortable(
    signal ? deps.chunks.getByIds(parentIds, { signal }) : deps.chunks.getByIds(parentIds),
    signal,
  );
  const parentById = new Map(parents.map((p) => [p.id, p]));

  const bestSimilarity = new Map<number, number>();
  const bestScore = new Map<number, number>();
  const bestChild = new Map<number, ScoredRow>();
  for (const h of childHits) {
    const pid = h.parentChunkId as number;
    bestSimilarity.set(pid, Math.max(bestSimilarity.get(pid) ?? -Infinity, h.similarity));
    const score = h.fusedScore ?? h.similarity;
    bestScore.set(pid, Math.max(bestScore.get(pid) ?? -Infinity, score));
    const prev = bestChild.get(pid);
    if (!prev || score > (prev.fusedScore ?? prev.similarity)) bestChild.set(pid, h);
  }

  const parentByIdHas = (id: number | null | undefined) => id != null && parentById.has(id);
  const entries: Array<{ chunk: RetrievedChunk; score: number }> = [];

  for (const p of parents) {
    if (!parentById.has(p.id)) continue;
    const child = bestChild.get(p.id);
    entries.push({
      chunk: {
        id: p.id,
        documentId: p.documentId,
        ...(p.documentUid ? { documentUid: p.documentUid } : {}),
        ...(p.chunkUid ? { chunkUid: p.chunkUid } : {}),
        fileName: p.fileName,
        page: child?.page ?? p.page,
        sectionTitle: child?.sectionTitle ?? p.sectionTitle,
        source: child?.source ?? p.source,
        title: p.title ?? child?.title ?? null,
        content: p.content,
        similarity: bestSimilarity.get(p.id) ?? child?.similarity ?? 0,
      },
      score: bestScore.get(p.id) ?? 0,
    });
  }

  // Orphaned children (parent missing) fall back to the child hit so recall is not silently lost.
  for (const h of childHits) {
    if (parentByIdHas(h.parentChunkId)) continue;
    entries.push({ chunk: toRetrievedChunk(h), score: h.fusedScore ?? h.similarity });
  }

  for (const h of flatHits) {
    entries.push({ chunk: toRetrievedChunk(h), score: h.fusedScore ?? h.similarity });
  }

  return entries
    .sort((a, b) => b.score - a.score || String(a.chunk.id).localeCompare(String(b.chunk.id)))
    .slice(0, topN)
    .map((entry) => entry.chunk);
}

async function resolveWindow(
  hits: ScoredRow[],
  deps: SearchDeps,
  radius: number,
  signal?: AbortSignal,
): Promise<RetrievedChunk[]> {
  const boundedRadius = Math.max(0, Math.floor(radius));
  const ranges = hits.map((h) => ({ documentId: h.documentId, start: h.chunkIndex - boundedRadius, end: h.chunkIndex + boundedRadius }));
  const ranged = await abortable(
    signal ? deps.chunks.getByDocAndRanges(ranges, { signal }) : deps.chunks.getByDocAndRanges(ranges),
    signal,
  );
  const seen = new Set<number>();
  const resolved: RetrievedChunk[] = [];
  for (const h of hits) {
    const key = `${h.documentId}:${h.chunkIndex - boundedRadius}:${h.chunkIndex + boundedRadius}`;
    const neighbours = ranged.get(key) ?? [];
    const ordered = [...new Map(neighbours.map((neighbour) => [neighbour.id, neighbour])).values()]
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
    const windowed = ordered.filter((n) => !seen.has(n.id));
    for (const n of ordered) seen.add(n.id);
    const content =
      windowed.length > 0
        ? windowed.map((n) => n.content).join('\n\n')
        : seen.has(h.id)
          ? ''
          : h.content;
    if (content === '') continue;
    resolved.push({
      ...toRetrievedChunk(h),
      content,
    });
  }
  return resolved;
}

function filterByThreshold(
  rows: RetrievedChunkRow[],
  threshold: number,
  vectorIds: Set<number>,
): RetrievedChunkRow[] {
  // The cosine threshold only applies to vector-retrieved rows; lexical-only
  // rows carry ts_rank scores, which are not comparable to cosine similarity.
  // When a reranker is present, lexical rows are gated by reranker relevance
  // via rerankRows; without a reranker there is no comparable lexical
  // threshold — TODO: add lexicalThreshold or ts_rank cutoff when needed.
  return rows.filter((r) => !vectorIds.has(r.id) || r.similarity >= threshold);
}

async function rerankRows(
  query: string,
  rows: ScoredRow[],
  topN: number,
  reranker: Reranker,
  threshold: number,
  vectorIds: Set<number>,
  signal?: AbortSignal,
): Promise<RetrievedChunkRow[]> {
  try {
    const ranked = await abortable(reranker.rank(query, rows.map((r) => r.content)), signal);
    const ordered = [...ranked]
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .map((r) => rows[r.index])
      .filter((r): r is RetrievedChunkRow => r != null);
    return filterByThreshold(ordered.length > 0 ? ordered : sortByRelevance(rows), threshold, vectorIds).slice(0, topN);
  } catch {
    return filterByThreshold(sortByRelevance(rows), threshold, vectorIds).slice(0, topN);
  }
}

function sortByRelevance(rows: ScoredRow[]): ScoredRow[] {
  return [...rows].sort((a, b) => (b.fusedScore ?? b.similarity) - (a.fusedScore ?? a.similarity));
}

/** Reciprocal Rank Fusion: `score = Σ boost / (K + rank)`. Merges vector and lexical rankings. */
function reciprocalRankFusion(
  vectorRows: RetrievedChunkRow[],
  lexicalRows: RetrievedChunkRow[],
  limit: number,
  rrfK: number,
  lexicalWeight: number,
): ScoredRow[] {
  const fused = new Map<string, { row: RetrievedChunkRow; score: number }>();
  const add = (rows: RetrievedChunkRow[], boost: number) => {
    rows.forEach((row, rank) => {
      const key = row.chunkUid ?? `id:${row.id}`;
      const prev = fused.get(key)?.score ?? 0;
      fused.set(key, { row, score: prev + boost / (rrfK + rank + 1) });
    });
  };
  add(vectorRows, 1);
  add(lexicalRows, lexicalWeight);
  return [...fused.values()]
    .sort((a, b) => b.score - a.score || String(a.row.id).localeCompare(String(b.row.id)))
    .slice(0, limit)
    .map((entry) => ({ ...entry.row, fusedScore: entry.score }));
}

export async function searchChunks(
  query: string,
  opts: SearchOpts,
  deps: SearchDeps,
): Promise<Result<RetrievedChunk[]>> {
  throwIfAborted(opts.signal);
  if (query.trim() === '') {
    return ok([]);
  }
  const { limit: topN } = sanitizePagination(opts.limit, undefined, MAX_SEARCH_LIMIT, opts.rerankTopN ?? RERANK_TOP_N);
  const rerankerEnabled = deps.reranker != null;
  const threshold = Math.min(Math.max(boundedNonnegativeNumber(opts.threshold, SIMILARITY_THRESHOLD), 0), 1);
  const preThreshold = rerankerEnabled ? 0 : threshold;
  const candidateLimit = rerankerEnabled
    ? boundedPositiveInteger(opts.candidateLimit, CANDIDATE_POOL, MAX_CANDIDATE_LIMIT)
    : topN;

  let embedding: number[];
  try {
    embedding = await abortable(
      opts.signal ? deps.embeddings.embed(query, { signal: opts.signal }) : deps.embeddings.embed(query),
      opts.signal,
    );
  } catch (cause) {
    throwIfAborted(opts.signal);
    return err(new ExternalServiceError('Embedding API failed', cause));
  }

  const hybridEnabled = opts.hybridEnabled ?? HYBRID_ENABLED;
  const searchByLexical = deps.chunks.searchByLexical;
  const runHybrid = hybridEnabled && searchByLexical != null;

  // Run vector + lexical concurrently; lexical failure falls back to vector-only.
  const vectorPromise = abortable(
    opts.signal
      ? deps.chunks.searchByVector(embedding, { threshold: preThreshold, limit: candidateLimit, signal: opts.signal })
      : deps.chunks.searchByVector(embedding, { threshold: preThreshold, limit: candidateLimit }),
    opts.signal,
  );
  const lexicalPromise = runHybrid
    ? abortable(
        opts.signal
          ? searchByLexical(query, { limit: candidateLimit, signal: opts.signal })
          : searchByLexical(query, { limit: candidateLimit }),
        opts.signal,
      ).then(
        (rows) => ({ ok: true as const, rows }),
        (cause: unknown) => ({ ok: false as const, cause }),
      )
    : Promise.resolve(null);

  let vectorRows: RetrievedChunkRow[] = [];
  let vectorError: unknown;
  try {
    vectorRows = await vectorPromise;
  } catch (cause) {
    throwIfAborted(opts.signal);
    vectorError = cause;
  }
  const vectorIds = new Set(vectorRows.map((r) => r.id));

  const lexicalResult = await lexicalPromise;
  throwIfAborted(opts.signal);
  if (vectorError !== undefined) {
    if (!runHybrid || lexicalResult === null || !lexicalResult.ok) {
      return err(new ExternalServiceError('Vector search failed', vectorError));
    }
    logger.warn('Vector search failed; falling back to lexical-only', { error: String(vectorError) });
    return capAndResolve(lexicalResult.rows, query, topN, opts, deps, vectorIds);
  }
  if (lexicalResult === null) {
    return capAndResolve(vectorRows, query, topN, opts, deps, vectorIds);
  }
  if (!lexicalResult.ok) {
    logger.warn('Lexical search failed; falling back to vector-only', { error: String(lexicalResult.cause) });
    return capAndResolve(vectorRows, query, topN, opts, deps, vectorIds);
  }
  const lexicalRows = lexicalResult.rows;

  if (vectorRows.length === 0 && lexicalRows.length === 0) {
    return ok([]);
  }
  if (vectorRows.length === 0) {
    return capAndResolve(lexicalRows, query, topN, opts, deps, vectorIds);
  }
  if (lexicalRows.length === 0) {
    return capAndResolve(vectorRows, query, topN, opts, deps, vectorIds);
  }

  const rrfK = boundedPositiveInteger(opts.rrfK, RRF_K, Number.MAX_SAFE_INTEGER);
  const lexicalWeight = boundedNonnegativeNumber(opts.lexicalWeight, LEXICAL_WEIGHT);
  const fused = reciprocalRankFusion(vectorRows, lexicalRows, candidateLimit, rrfK, lexicalWeight);
  return capAndResolve(fused, query, topN, { ...opts, threshold }, deps, vectorIds);
}

async function capAndResolve(
  rows: ScoredRow[],
  query: string,
  topN: number,
  opts: SearchOpts,
  deps: SearchDeps,
  vectorIds: Set<number>,
): Promise<Result<RetrievedChunk[]>> {
  throwIfAborted(opts.signal);
  const threshold = Math.min(Math.max(boundedNonnegativeNumber(opts.threshold, SIMILARITY_THRESHOLD), 0), 1);
  const capped = deps.reranker
    ? await rerankRows(query, rows, topN, deps.reranker, threshold, vectorIds, opts.signal)
    : sortByRelevance(rows).slice(0, topN);

  const resolved =
    (opts.mode ?? PARENT_CHILD_MODE) === 'window'
      ? await resolveWindow(
          capped,
          deps,
          boundedPositiveInteger(opts.parentChildWindow, PARENT_CHILD_WINDOW, MAX_SEARCH_LIMIT),
          opts.signal,
        )
      : await resolveParents(capped, deps, topN, opts.signal);
  return ok(resolved);
}
