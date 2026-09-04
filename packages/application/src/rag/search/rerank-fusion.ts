import type { RetrievedChunkRow, Reranker } from '@app/domain';
import { abortable } from './abort';
import type { ScoredRow } from './search-types';

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

export { filterByThreshold, rerankRows, sortByRelevance, reciprocalRankFusion };
