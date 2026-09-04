import type { RetrievedChunkRow } from '@app/domain';
import { abortable } from './abort';
import {
  scoreOf,
  toRetrievedChunk,
  type RetrievedChunk,
  type ScoredRow,
  type SearchDeps,
} from './search-types';

export function getBestSegments(
  values: number[],
  opts: { maxLength: number; overallMaxLength: number; minimumValue: number },
): Array<{ start: number; end: number; value: number }> {
  const maxLength = Math.max(1, Math.floor(opts.maxLength));
  const overallMaxLength = Math.max(1, Math.floor(opts.overallMaxLength));
  const best: Array<{ start: number; end: number; value: number }> = [];
  let totalLength = 0;
  while (totalLength < overallMaxLength) {
    const remainingLength = overallMaxLength - totalLength;
    let bestStart = -1;
    let bestEnd = -1;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let start = 0; start < values.length; start++) {
      if (values[start]! < 0) continue;
      let running = 0;
      for (
        let end = start + 1;
        end <= Math.min(start + maxLength, start + remainingLength, values.length);
        end++
      ) {
        running += values[end - 1]!;
        if (values[end - 1]! < 0) continue;
        if (best.some((segment) => start < segment.end && end > segment.start)) continue;
        if (running > bestValue) {
          bestValue = running;
          bestStart = start;
          bestEnd = end;
        }
      }
    }
    if (bestStart === -1 || bestValue < opts.minimumValue) break;
    best.push({ start: bestStart, end: bestEnd, value: bestValue });
    totalLength += bestEnd - bestStart;
  }
  return best.sort((a, b) => a.start - b.start);
}

function concatDeduped(contents: string[]): string {
  const parts: string[] = [];
  for (const content of contents) {
    if (content.trim().length === 0) continue;
    const existing = parts.findIndex((part) => part.includes(content) || content.includes(part));
    if (existing === -1) parts.push(content);
    else if (content.length > parts[existing]!.length) parts[existing] = content;
  }
  return parts.join('\n\n');
}

export async function resolveSegments(
  hits: ScoredRow[],
  deps: SearchDeps,
  rse: { penalty: number; maxSegmentChunks: number; overallMaxChunks: number; minSegmentValue: number },
  signal?: AbortSignal,
): Promise<RetrievedChunk[]> {
  if (hits.length === 0) return [];
  const penalty = Math.max(0, rse.penalty);
  const maxSegmentChunks = Math.max(1, Math.floor(rse.maxSegmentChunks));
  const overallMaxChunks = Math.max(1, Math.floor(rse.overallMaxChunks));
  const radius = maxSegmentChunks;
  const ranges = hits.map((hit) => ({
    documentId: hit.documentId,
    start: hit.chunkIndex - radius,
    end: hit.chunkIndex + radius,
  }));
  const ranged = await abortable(
    signal ? deps.chunks.getByDocAndRanges(ranges, { signal }) : deps.chunks.getByDocAndRanges(ranges),
    signal,
  );

  const keyOf = (row: RetrievedChunkRow): string => row.chunkUid ?? `id:${row.id}`;
  const hitByKey = new Map<string, ScoredRow>();
  for (const hit of hits) {
    const previous = hitByKey.get(keyOf(hit));
    if (!previous || scoreOf(hit) > scoreOf(previous)) hitByKey.set(keyOf(hit), hit);
  }

  const docChunks = new Map<number, RetrievedChunkRow[]>();
  const addCandidate = (documentId: number, row: RetrievedChunkRow): void => {
    const candidates = docChunks.get(documentId);
    if (candidates) {
      if (!candidates.some((candidate) => candidate.id === row.id)) candidates.push(row);
    } else {
      docChunks.set(documentId, [row]);
    }
  };
  for (const hit of hits) {
    const key = `${hit.documentId}:${hit.chunkIndex - radius}:${hit.chunkIndex + radius}`;
    for (const neighbour of ranged.get(key) ?? []) addCandidate(neighbour.documentId, neighbour);
  }
  for (const hit of hits) addCandidate(hit.documentId, hit);

  const seen = new Set<number>();
  const segments: Array<{ chunk: RetrievedChunk; score: number }> = [];
  for (const candidates of docChunks.values()) {
    const ordered = [...candidates].sort((a, b) => a.chunkIndex - b.chunkIndex);
    const runs: RetrievedChunkRow[][] = [];
    for (const candidate of ordered) {
      const run = runs[runs.length - 1];
      if (run && candidate.chunkIndex === run[run.length - 1]!.chunkIndex + 1) run.push(candidate);
      else runs.push([candidate]);
    }
    for (const run of runs) {
      const maxScore = Math.max(
        0,
        ...run.map((candidate) => {
          const hit = hitByKey.get(keyOf(candidate));
          return hit ? scoreOf(hit) : 0;
        }),
      );
      const values = run.map((candidate) => {
        const hit = hitByKey.get(keyOf(candidate));
        const relevance = hit && maxScore > 0 ? scoreOf(hit) / maxScore : 0;
        return relevance - penalty;
      });
      const spans = getBestSegments(values, {
        maxLength: maxSegmentChunks,
        overallMaxLength: overallMaxChunks,
        minimumValue: rse.minSegmentValue,
      });
      for (const span of spans) {
        const inSpan = run.slice(span.start, span.end);
        const fresh = inSpan.filter((candidate) => !seen.has(candidate.id));
        for (const candidate of inSpan) seen.add(candidate.id);
        if (fresh.length === 0) continue;
        const content = concatDeduped(inSpan.map((candidate) => candidate.content));
        if (content === '') continue;
        let anchor: RetrievedChunkRow = inSpan[0]!;
        let anchorScore = Number.NEGATIVE_INFINITY;
        for (const candidate of inSpan) {
          const hit = hitByKey.get(keyOf(candidate));
          const candidateScore = hit ? scoreOf(hit) : Number.NEGATIVE_INFINITY;
          if (candidateScore > anchorScore) {
            anchorScore = candidateScore;
            anchor = hit ?? candidate;
          }
        }
        segments.push({
          chunk: {
            ...toRetrievedChunk(anchor),
            content,
            similarity: anchor.similarity,
          },
          score: Number.isFinite(anchorScore) ? anchorScore : 0,
        });
      }
    }
  }
  return segments
    .sort((a, b) => b.score - a.score || String(a.chunk.id).localeCompare(String(b.chunk.id)))
    .map((entry) => entry.chunk);
}
