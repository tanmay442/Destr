import { err, ok, type Result, ExternalServiceError } from '@app/domain';
import type { ChunkRepository, EmbeddingService, RetrievedChunkRow } from '@app/domain';
import { SIMILARITY_THRESHOLD, DEFAULT_SEARCH_LIMIT, PARENT_CHILD_MODE, PARENT_CHILD_WINDOW } from '../../../../config/constants';
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
}

export interface SearchOpts {
  threshold?: number;
  limit?: number;
  /** Override the `PARENT_CHILD_MODE` config for this call (`parent`|`window`). */
  mode?: 'parent' | 'window';
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

export async function searchChunks(
  query: string,
  opts: SearchOpts,
  deps: SearchDeps,
): Promise<Result<RetrievedChunk[]>> {
  if (query.trim() === '') {
    return ok([]);
  }
  const threshold = opts.threshold ?? SIMILARITY_THRESHOLD;
  const { limit } = sanitizePagination(opts.limit, undefined, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);
  let embedding: number[];
  try {
    embedding = await deps.embeddings.embed(query);
  } catch (cause) {
    return err(new ExternalServiceError('Embedding API failed', cause));
  }
  let rows: RetrievedChunkRow[];
  try {
    rows = await deps.chunks.searchByVector(embedding, { threshold, limit });
  } catch (cause) {
    return err(new ExternalServiceError('Vector search failed', cause));
  }
  if (rows.length === 0) {
    return ok([]);
  }

  const resolved =
    (opts.mode ?? PARENT_CHILD_MODE) === 'window'
      ? await resolveWindow(rows, deps)
      : await resolveParents(rows, deps);
  return ok(resolved);
}
