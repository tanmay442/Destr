import { err, ok, type Result, ExternalServiceError } from '@app/domain';
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

export interface RetrievedChunk {
  id: number;
  documentId: number;
  fileName: string | null;
  page: number | null;
  sectionTitle: string | null;
  source: string | null;
  title: string | null;
  content: string;
  similarity: number;
}

export interface SearchDeps {
  chunks: ChunkRepository;
  embeddings: EmbeddingService;
  /** Optional second-stage reranker. Retrieves a broad pool then reorders by
   *  relevance. Falls back to cosine ordering when absent. */
  reranker?: Reranker;
}

export interface SearchOpts {
  threshold?: number;
  limit?: number;
  /** Override `PARENT_CHILD_MODE` for this call (`parent`|`window`). */
  mode?: 'parent' | 'window';
  /** Override `PARENT_CHILD_WINDOW` for this call. */
  parentChildWindow?: number;
  /** Broad candidate-pool size before reranking. Ignored when no reranker. */
  candidateLimit?: number;
  /** Override `HYBRID_ENABLED`. Defaults to the frozen constant. */
  hybridEnabled?: boolean;
}

function toRetrievedChunk(r: RetrievedChunkRow): RetrievedChunk {
  return {
    id: r.id,
    documentId: r.documentId,
    fileName: r.fileName,
    page: r.page,
    sectionTitle: r.sectionTitle,
    source: r.source,
    title: r.title,
    content: r.content,
    similarity: Number(r.similarity),
  };
}

/** Resolve child vector hits to their parent blocks (`parent` mode).
 *  Returns one entry per parent, using parent content with the most-relevant
 *  child's citation. Flat chunks pass through unchanged. */
async function resolveParents(hits: RetrievedChunkRow[], deps: SearchDeps): Promise<RetrievedChunk[]> {
  const childHits = hits.filter((h) => h.parentChunkId != null);
  const flatHits = hits.filter((h) => h.parentChunkId == null);
  if (childHits.length === 0) {
    return hits.map(toRetrievedChunk);
  }

  const parentIds = [...new Set(childHits.map((h) => h.parentChunkId as number))];
  const parents = await deps.chunks.getByIds(parentIds);
  const parentById = new Map(parents.map((p) => [p.id, p]));

  const bestSim = new Map<number, number>();
  const bestChild = new Map<number, RetrievedChunkRow>();
  for (const h of childHits) {
    const pid = h.parentChunkId as number;
    bestSim.set(pid, Math.max(bestSim.get(pid) ?? -Infinity, h.similarity));
    const prev = bestChild.get(pid);
    if (!prev || h.similarity > prev.similarity) bestChild.set(pid, h);
  }

  const resolved: RetrievedChunk[] = parents
    .filter((p) => parentById.has(p.id))
    .map((p) => {
      const child = bestChild.get(p.id);
      return {
        id: p.id,
        documentId: p.documentId,
        fileName: p.fileName,
        page: child?.page ?? p.page,
        sectionTitle: child?.sectionTitle ?? p.sectionTitle,
        source: child?.source ?? p.source,
        title: p.title ?? child?.title ?? null,
        content: p.content,
        similarity: bestSim.get(p.id) ?? child?.similarity ?? 0,
      };
    })
    .sort((a, b) => b.similarity - a.similarity);

  // Children whose parent is missing fall back to the child hit itself so
  // they are not silently dropped (recall loss).
  const parentByIdHas = (id: number | null | undefined) => id != null && parentById.has(id);
  const orphanedChildren = childHits
    .filter((h) => !parentByIdHas(h.parentChunkId))
    .map(toRetrievedChunk);

  return [...resolved, ...orphanedChildren, ...flatHits.map(toRetrievedChunk)].sort((a, b) => b.similarity - a.similarity);
}

/** Pad each hit with its `±N` neighbouring chunks (`window` mode).
 *  Concatenates neighbour content for context in a single batched round-trip.
 *  Hits with no neighbours are skipped; overlapping windows are deduped by chunk id. */
async function resolveWindow(
  hits: RetrievedChunkRow[],
  deps: SearchDeps,
  radius: number,
): Promise<RetrievedChunk[]> {
  const ranges = hits.map((h) => ({ documentId: h.documentId, start: h.chunkIndex - radius, end: h.chunkIndex + radius }));
  const ranged = await deps.chunks.getByDocAndRanges(ranges);
  const seen = new Set<number>();
  const resolved: RetrievedChunk[] = [];
  for (const h of hits) {
    const key = `${h.documentId}:${h.chunkIndex - radius}:${h.chunkIndex + radius}`;
    const neighbours = ranged.get(key) ?? [];
    const ordered = [...neighbours].sort((a, b) => a.chunkIndex - b.chunkIndex);
    const windowed = ordered.filter((n) => !seen.has(n.id));
    if (windowed.length === 0) continue;
    for (const n of ordered) seen.add(n.id);
    resolved.push({
      id: h.id,
      documentId: h.documentId,
      fileName: h.fileName,
      page: h.page,
      sectionTitle: h.sectionTitle,
      source: h.source,
      title: h.title,
      content: windowed.map((n) => n.content).join('\n\n'),
      similarity: h.similarity,
    });
  }
  return resolved;
}

/** Drop candidates below the similarity threshold (post-rerank cutoff). */
function filterByThreshold(rows: RetrievedChunkRow[], threshold: number): RetrievedChunkRow[] {
  return rows.filter((r) => r.similarity >= threshold);
}

/** Reorder by reranker relevance score, drop below-threshold candidates, cap to `topN`. Falls back to cosine on failure. */
async function rerankRows(
  query: string,
  rows: RetrievedChunkRow[],
  topN: number,
  reranker: Reranker,
  threshold: number,
): Promise<RetrievedChunkRow[]> {
  try {
    const ranked = await reranker.rank(query, rows.map((r) => r.content));
    const ordered = [...ranked]
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .map((r) => rows[r.index])
      .filter((r): r is RetrievedChunkRow => r != null);
    return filterByThreshold(ordered.length > 0 ? ordered : sortBySimilarity(rows), threshold).slice(0, topN);
  } catch {
    return filterByThreshold(sortBySimilarity(rows), threshold).slice(0, topN);
  }
}

function sortBySimilarity(rows: RetrievedChunkRow[]): RetrievedChunkRow[] {
  return [...rows].sort((a, b) => b.similarity - a.similarity);
}

/** Reciprocal Rank Fusion: `score = Σ boost / (K + rank)`. Merges vector and
 *  lexical rankings, rewarding chunks that rank well in either modality. */
function reciprocalRankFusion(
  vectorRows: RetrievedChunkRow[],
  lexicalRows: RetrievedChunkRow[],
  limit: number,
): RetrievedChunkRow[] {
  const fused = new Map<number, { row: RetrievedChunkRow; score: number }>();
  const add = (rows: RetrievedChunkRow[], boost: number) => {
    rows.forEach((row, rank) => {
      const prev = fused.get(row.id)?.score ?? 0;
      fused.set(row.id, { row, score: prev + boost / (RRF_K + rank + 1) });
    });
  };
  add(vectorRows, 1);
  add(lexicalRows, LEXICAL_WEIGHT);
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.row);
}

export async function searchChunks(
  query: string,
  opts: SearchOpts,
  deps: SearchDeps,
): Promise<Result<RetrievedChunk[]>> {
  if (query.trim() === '') {
    return ok([]);
  }
  const { limit: topN } = sanitizePagination(opts.limit, undefined, MAX_SEARCH_LIMIT, RERANK_TOP_N);
  const rerankerEnabled = deps.reranker != null;
  const preThreshold = rerankerEnabled ? 0 : (opts.threshold ?? SIMILARITY_THRESHOLD);
  const candidateLimit = rerankerEnabled ? (opts.candidateLimit ?? CANDIDATE_POOL) : topN;

  let embedding: number[];
  try {
    embedding = await deps.embeddings.embed(query);
  } catch (cause) {
    return err(new ExternalServiceError('Embedding API failed', cause));
  }

  const hybridEnabled = opts.hybridEnabled ?? HYBRID_ENABLED;
  const searchByLexical = deps.chunks.searchByLexical;
  const runHybrid = hybridEnabled && searchByLexical != null;

  // Run vector + lexical concurrently; lexical failure falls back to vector-only.
  const vectorPromise = deps.chunks.searchByVector(embedding, { threshold: preThreshold, limit: candidateLimit });
  const lexicalPromise = runHybrid
    ? searchByLexical(query, { limit: candidateLimit }).then(
        (rows) => ({ ok: true as const, rows }),
        (cause: unknown) => ({ ok: false as const, cause }),
      )
    : Promise.resolve(null);

  let vectorRows: RetrievedChunkRow[];
  try {
    vectorRows = await vectorPromise;
  } catch (cause) {
    return err(new ExternalServiceError('Vector search failed', cause));
  }

  const lexicalResult = await lexicalPromise;
  if (lexicalResult === null) {
    return capAndResolve(vectorRows, query, topN, opts, deps);
  }
  if (!lexicalResult.ok) {
    console.warn('Lexical search failed; falling back to vector-only', { error: String(lexicalResult.cause) });
    return capAndResolve(vectorRows, query, topN, opts, deps);
  }
  const lexicalRows = lexicalResult.rows;

  if (vectorRows.length === 0 && lexicalRows.length === 0) {
    return ok([]);
  }

  const fused = reciprocalRankFusion(vectorRows, lexicalRows, candidateLimit);
  return capAndResolve(fused, query, topN, opts, deps);
}

/** Apply optional reranker + parent/window resolution, then cap to `topN`. */
async function capAndResolve(
  rows: RetrievedChunkRow[],
  query: string,
  topN: number,
  opts: SearchOpts,
  deps: SearchDeps,
): Promise<Result<RetrievedChunk[]>> {
  const threshold = opts.threshold ?? SIMILARITY_THRESHOLD;
  const capped = deps.reranker
    ? await rerankRows(query, rows, topN, deps.reranker, threshold)
    : sortBySimilarity(rows).slice(0, topN);

  const resolved =
    (opts.mode ?? PARENT_CHILD_MODE) === 'window'
      ? await resolveWindow(capped, deps, opts.parentChildWindow ?? PARENT_CHILD_WINDOW)
      : await resolveParents(capped, deps);
  return ok(resolved);
}
