import { abortable } from './abort';
import { scoreOf, toRetrievedChunk, type RetrievedChunk, type ScoredRow, type SearchDeps } from './search-types';
import { stableChunkIdentity } from './stable-chunk-identity';

async function resolveParents(
  hits: ScoredRow[],
  deps: SearchDeps,
  topN: number,
  signal?: AbortSignal,
): Promise<RetrievedChunk[]> {
  const childHits = hits.filter((h) => h.parentChunkId != null);
  const flatHits = hits.filter((h) => h.parentChunkId == null);
  if (childHits.length === 0) {
    return [...hits]
      .sort((a, b) => scoreOf(b) - scoreOf(a) || stableChunkIdentity(a).localeCompare(stableChunkIdentity(b)))
      .map(toRetrievedChunk);
  }

  const parentIds = [...new Set(childHits.map((h) => h.parentChunkId as number))];
  const parents = await abortable(
    signal ? deps.chunks.getByIds(parentIds, { signal }) : deps.chunks.getByIds(parentIds),
    signal,
  );
  const parentById = new Map(parents.map((p) => [p.id, p]));

  const bestScore = new Map<number, number>();
  const bestChild = new Map<number, ScoredRow>();
  for (const h of childHits) {
    const pid = h.parentChunkId as number;
    const score = scoreOf(h);
    bestScore.set(pid, Math.max(bestScore.get(pid) ?? -Infinity, score));
    const prev = bestChild.get(pid);
    if (!prev || score > scoreOf(prev)) bestChild.set(pid, h);
  }

  const parentByIdHas = (id: number | null | undefined) => id != null && parentById.has(id);
  const entries: Array<{ chunk: RetrievedChunk; score: number }> = [];

  for (const p of parents) {
    if (!parentById.has(p.id)) continue;
    const child = bestChild.get(p.id);
    const rankedSource = child ? toRetrievedChunk(child) : toRetrievedChunk({ ...p, denseScore: 0 });
    entries.push({
      chunk: {
        ...rankedSource,
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
        chunkIndex: p.chunkIndex,
      },
      score: bestScore.get(p.id) ?? 0,
    });
  }

  // Orphaned children (parent missing) fall back to the child hit so recall is not silently lost.
  for (const h of childHits) {
    if (parentByIdHas(h.parentChunkId)) continue;
    entries.push({ chunk: toRetrievedChunk(h), score: scoreOf(h) });
  }

  for (const h of flatHits) {
    entries.push({ chunk: toRetrievedChunk(h), score: scoreOf(h) });
  }

  return entries
    .sort((a, b) => b.score - a.score || stableChunkIdentity(a.chunk).localeCompare(stableChunkIdentity(b.chunk)))
    .slice(0, topN)
    .map((entry) => entry.chunk);
}

export { resolveParents };
