import type { Reranker } from '@app/domain';
import { abortable } from './abort';
import { scoreOf, type ScoredRow } from './search-types';
import type { SearchDegradation } from './search-contract';

function filterByThreshold(
  rows: ScoredRow[],
  threshold: number,
): ScoredRow[] {
  // The cosine threshold only applies to vector-retrieved rows; lexical-only
  // rows carry ts_rank scores, which are not comparable to cosine similarity.
  // When a reranker is present, lexical rows are gated by reranker relevance
  // via rerankRows; without a reranker there is no comparable lexical
  // threshold — TODO: add lexicalThreshold or ts_rank cutoff when needed.
  return rows.filter((row) => row.denseScore === undefined || row.denseScore >= threshold);
}

interface RerankOutcome {
  readonly rows: ScoredRow[];
  readonly degradedBy: readonly SearchDegradation[];
}

async function rerankRows(
  query: string,
  rows: ScoredRow[],
  topN: number,
  reranker: Reranker,
  threshold: number,
  signal?: AbortSignal,
): Promise<RerankOutcome> {
  try {
    const ranked = await abortable(reranker.rank(query, rows.map((r) => r.content)), signal);
    const ordered: ScoredRow[] = [...ranked]
      .filter((rankedRow) => Number.isFinite(rankedRow.relevanceScore) && rankedRow.relevanceScore >= 0)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .flatMap((rankedRow) => {
        const row = rows[rankedRow.index];
        return row ? [{ ...row, rerankerScore: rankedRow.relevanceScore }] : [];
      });
    if (ordered.length === 0 && rows.length > 0) {
      return {
        rows: filterByThreshold(sortByRelevance(rows), threshold).slice(0, topN),
        degradedBy: ['reranker_unavailable'],
      };
    }
    return {
      rows: filterByThreshold(ordered, threshold).slice(0, topN),
      degradedBy: [],
    };
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return {
      rows: filterByThreshold(sortByRelevance(rows), threshold).slice(0, topN),
      degradedBy: ['reranker_unavailable'],
    };
  }
}

function sortByRelevance(rows: ScoredRow[]): ScoredRow[] {
  return [...rows].sort((a, b) => scoreOf(b) - scoreOf(a));
}

/** Reciprocal Rank Fusion: `score = Σ boost / (K + rank)`. Merges vector and lexical rankings. */
function reciprocalRankFusion(
  vectorRows: ScoredRow[],
  lexicalRows: ScoredRow[],
  limit: number,
  rrfK: number,
  lexicalWeight: number,
): ScoredRow[] {
  const fused = new Map<string, { row: ScoredRow; score: number }>();
  const add = (rows: ScoredRow[], boost: number) => {
    rows.forEach((row, rank) => {
      const key = row.chunkUid ?? `id:${row.id}`;
      const previous = fused.get(key);
      const score = (previous?.score ?? 0) + boost / (rrfK + rank + 1);
      fused.set(key, {
        row: {
          ...(previous?.row ?? row),
          ...(row.denseScore !== undefined ? { denseScore: row.denseScore } : {}),
          ...(row.lexicalScore !== undefined ? { lexicalScore: row.lexicalScore } : {}),
        },
        score,
      });
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
