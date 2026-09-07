import type { Reranker } from '@app/domain';
import { abortable } from './abort';
import { scoreOf, type ScoredRow } from './search-types';
import type { SearchDegradation } from './search-contract';
import { stableChunkIdentity } from './stable-chunk-identity';

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
  readonly diagnostics: {
    readonly status: 'applied' | 'degraded';
    readonly inputCount: number;
    readonly validCount: number;
    readonly acceptedCount: number;
    readonly thresholdFilteredCount: number;
  };
}

function isCompleteRanking(
  ranked: readonly { index: number; relevanceScore: number }[],
  rowCount: number,
): boolean {
  if (ranked.length !== rowCount) return false;
  const indices = new Set<number>();
  for (const item of ranked) {
    if (
      !Number.isInteger(item.index) ||
      item.index < 0 ||
      item.index >= rowCount ||
      !Number.isFinite(item.relevanceScore) ||
      item.relevanceScore < 0 ||
      item.relevanceScore > 1
    ) return false;
    indices.add(item.index);
  }
  return indices.size === rowCount;
}

function degradedRerank(
  rows: ScoredRow[],
  topN: number,
  denseThreshold: number,
  validCount: number,
): RerankOutcome {
  const fallback = filterByThreshold(sortByRelevance(rows), denseThreshold).slice(0, topN);
  return {
    rows: fallback,
    degradedBy: ['reranker_unavailable'],
    diagnostics: {
      status: 'degraded',
      inputCount: rows.length,
      validCount,
      acceptedCount: fallback.length,
      thresholdFilteredCount: 0,
    },
  };
}

async function rerankRows(
  query: string,
  rows: ScoredRow[],
  topN: number,
  reranker: Reranker,
  denseThreshold: number,
  rerankerThreshold: number,
  signal?: AbortSignal,
): Promise<RerankOutcome> {
  try {
    const documents = rows.map((row) => row.content);
    const ranked = await abortable(
      signal ? reranker.rank(query, documents, { signal }) : reranker.rank(query, documents),
      signal,
    );
    if (!isCompleteRanking(ranked, rows.length)) {
      return degradedRerank(rows, topN, denseThreshold, 0);
    }
    const ordered: ScoredRow[] = [...ranked]
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .flatMap((rankedRow) => {
        const row = rows[rankedRow.index];
        return row ? [{ ...row, rerankerScore: rankedRow.relevanceScore }] : [];
      });
    const accepted = ordered
      .filter((row) => row.rerankerScore !== undefined && row.rerankerScore >= rerankerThreshold)
      .slice(0, topN);
    return {
      rows: accepted,
      degradedBy: [],
      diagnostics: {
        status: 'applied',
        inputCount: rows.length,
        validCount: ordered.length,
        acceptedCount: accepted.length,
        thresholdFilteredCount: ordered.filter(
          (row) => row.rerankerScore !== undefined && row.rerankerScore < rerankerThreshold,
        ).length,
      },
    };
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return degradedRerank(rows, topN, denseThreshold, 0);
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
      const key = stableChunkIdentity(row);
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
    .sort((a, b) => b.score - a.score || stableChunkIdentity(a.row).localeCompare(stableChunkIdentity(b.row)))
    .slice(0, limit)
    .map((entry) => ({ ...entry.row, fusedScore: entry.score }));
}

export { filterByThreshold, rerankRows, sortByRelevance, reciprocalRankFusion };
