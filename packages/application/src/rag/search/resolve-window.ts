import { abortable } from './abort';
import { toRetrievedChunk, type RetrievedChunk, type ScoredRow, type SearchDeps } from './search-types';

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

export { resolveWindow };
