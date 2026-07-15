import { err, ok, type Result, ExternalServiceError } from '@app/domain';
import type { ChunkRepository, EmbeddingService, Reranker, RetrievedChunkRow } from '@app/domain';
import {
  SIMILARITY_THRESHOLD,
  PARENT_CHILD_MODE,
  PARENT_CHILD_WINDOW,
  CANDIDATE_POOL,
  RERANK_TOP_N,
} from '../../../../config/constants';
import { sanitizePagination } from '../service-result';

const MAX_SEARCH_LIMIT = 50;

export interface RetrievedChunk {
  id: number;
  documentId: number;
  fileName: string | null;
  page: number | null;
  sectionTitle: string | null;
  source: string | null;
  content: string;
  similarity: number;
}

export interface SearchDeps {
  chunks: ChunkRepository;
  embeddings: EmbeddingService;
  /** Optional second-stage reranker (Session 6). When present, `searchChunks`
   *  retrieves a broad candidate pool then reorders it by true query–document
   *  relevance before capping to `limit`. When absent, results fall back to
   *  cosine (pgvector) ordering — the pre-Session-6 behaviour. */
  reranker?: Reranker;
}

export interface SearchOpts {
  threshold?: number;
  limit?: number;
  /** Override the `PARENT_CHILD_MODE` config for this call (`parent`|`window`). */
  mode?: 'parent' | 'window';
  /** Override the broad candidate-pool size retrieved before reranking
   *  (Session 6). Ignored when no reranker is configured. */
  candidateLimit?: number;
}

/** Map a raw query row to the public `RetrievedChunk` (drops `parentChunkId`). */
function toRetrievedChunk(r: RetrievedChunkRow): RetrievedChunk {
  return {
    id: r.id,
    documentId: r.documentId,
    fileName: r.fileName,
    page: r.page,
    sectionTitle: r.sectionTitle,
    source: r.source,
    content: r.content,
    similarity: Number(r.similarity),
  };
}

/**
 * Resolve child vector hits to their parent blocks (Session 5, `parent` mode).
 * Returns one entry per parent, using the parent's content but keeping the
 * most-relevant child's `page`/`sectionTitle`/`source` for precise citations
 * (gotcha #4). Flat chunks (no `parentChunkId`) pass through unchanged.
 */
async function resolveParents(hits: RetrievedChunkRow[], deps: SearchDeps): Promise<RetrievedChunk[]> {
  const childHits = hits.filter((h) => h.parentChunkId != null);
  const flatHits = hits.filter((h) => h.parentChunkId == null);
  if (childHits.length === 0) {
    return hits.map(toRetrievedChunk);
  }

  const parentIds = [...new Set(childHits.map((h) => h.parentChunkId as number))];
  const parents = await deps.chunks.getByIds(parentIds);
  const parentById = new Map(parents.map((p) => [p.id, p]));

  // Best child similarity (for ranking) and best child citation (for precision)
  // per parent.
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
        content: p.content,
        similarity: bestSim.get(p.id) ?? child?.similarity ?? 0,
      };
    })
    .sort((a, b) => b.similarity - a.similarity);

  return [...resolved, ...flatHits.map(toRetrievedChunk)];
}

/**
 * Pad each hit with its `±N` neighbouring chunks (Session 5, `window` mode).
 * Keeps the hit's id/citation but concatenates neighbour content for context.
 */
async function resolveWindow(hits: RetrievedChunkRow[], deps: SearchDeps): Promise<RetrievedChunk[]> {
  const radius = PARENT_CHILD_WINDOW;
  const out: RetrievedChunk[] = [];
  for (const h of hits) {
    const neighbours = await deps.chunks.getByDocAndRange(h.documentId, h.chunkIndex - radius, h.chunkIndex + radius);
    const ordered = [...neighbours].sort((a, b) => a.chunkIndex - b.chunkIndex);
    out.push({
      id: h.id,
      documentId: h.documentId,
      fileName: h.fileName,
      page: h.page,
      sectionTitle: h.sectionTitle,
      source: h.source,
      content: ordered.map((n) => n.content).join('\n\n'),
      similarity: h.similarity,
    });
  }
  return out;
}

/**
 * Reorder candidate rows by the reranker's relevance score and cap to `topN`.
 * Defensive against out-of-range indices from the adapter. If the reranker
 * throws, falls back to cosine (similarity) ordering so a reranker outage never
 * breaks search (the default provider is on-device and could fail to load).
 */
async function rerankRows(
  query: string,
  rows: RetrievedChunkRow[],
  topN: number,
  reranker: Reranker,
): Promise<RetrievedChunkRow[]> {
  try {
    const ranked = await reranker.rank(query, rows.map((r) => r.content));
    const ordered = [...ranked]
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .map((r) => rows[r.index])
      .filter((r): r is RetrievedChunkRow => r != null);
    // If the adapter returned nothing usable, fall back to cosine ordering.
    return (ordered.length > 0 ? ordered : sortBySimilarity(rows)).slice(0, topN);
  } catch {
    return sortBySimilarity(rows).slice(0, topN);
  }
}

function sortBySimilarity(rows: RetrievedChunkRow[]): RetrievedChunkRow[] {
  return [...rows].sort((a, b) => b.similarity - a.similarity);
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
  // With a reranker we cast a wide net (broad pool, no cosine cutoff) and let
  // the cross-encoder decide; otherwise we keep the pre-Session-6 behaviour.
  const threshold = rerankerEnabled ? 0 : (opts.threshold ?? SIMILARITY_THRESHOLD);
  const candidateLimit = rerankerEnabled ? (opts.candidateLimit ?? CANDIDATE_POOL) : topN;

  let embedding: number[];
  try {
    embedding = await deps.embeddings.embed(query);
  } catch (cause) {
    return err(new ExternalServiceError('Embedding API failed', cause));
  }
  let rows: RetrievedChunkRow[];
  try {
    rows = await deps.chunks.searchByVector(embedding, { threshold, limit: candidateLimit });
  } catch (cause) {
    return err(new ExternalServiceError('Vector search failed', cause));
  }
  if (rows.length === 0) {
    return ok([]);
  }

  const capped = deps.reranker
    ? await rerankRows(query, rows, topN, deps.reranker)
    : sortBySimilarity(rows).slice(0, topN);

  const resolved =
    (opts.mode ?? PARENT_CHILD_MODE) === 'window'
      ? await resolveWindow(capped, deps)
      : await resolveParents(capped, deps);
  return ok(resolved);
}
