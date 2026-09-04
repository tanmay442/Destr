import { err, ok, type Result, ExternalServiceError, logger } from '@app/domain';
import type { RetrievedChunkRow } from '@app/domain';
import {
  SIMILARITY_THRESHOLD,
  PARENT_CHILD_MODE,
  PARENT_CHILD_WINDOW,
  CANDIDATE_POOL,
  RERANK_TOP_N,
  HYBRID_ENABLED,
  RRF_K,
  LEXICAL_WEIGHT,
  RSE_IRRELEVANT_PENALTY,
  RSE_MAX_SEGMENT_CHUNKS,
  RSE_OVERALL_MAX_CHUNKS,
  RSE_MIN_SEGMENT_VALUE,
} from '@app/domain';
import { sanitizePagination } from '../../service-result';
import { throwIfAborted, abortable } from './abort';
import {
  MAX_SEARCH_LIMIT,
  MAX_CANDIDATE_LIMIT,
  boundedPositiveInteger,
  boundedNonnegativeNumber,
  type RetrievedChunk,
  type ScoredRow,
  type SearchDeps,
  type SearchOpts,
} from './search-types';
import { resolveParents } from './resolve-parents';
import { resolveWindow } from './resolve-window';
import { resolveSegments } from './resolve-segments';
import { rerankRows, sortByRelevance, reciprocalRankFusion } from './rerank-fusion';

export type { RetrievedChunk, SearchDeps, SearchOpts };

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

  const mode = opts.mode ?? PARENT_CHILD_MODE;
  const resolved =
    mode === 'window'
      ? await resolveWindow(
          capped,
          deps,
          boundedPositiveInteger(opts.parentChildWindow, PARENT_CHILD_WINDOW, MAX_SEARCH_LIMIT),
          opts.signal,
        )
      : mode === 'segment'
        ? (
            await resolveSegments(
              capped,
              deps,
              {
                penalty: boundedNonnegativeNumber(opts.rsePenalty, RSE_IRRELEVANT_PENALTY),
                maxSegmentChunks: boundedPositiveInteger(
                  opts.rseMaxSegmentChunks,
                  RSE_MAX_SEGMENT_CHUNKS,
                  MAX_SEARCH_LIMIT,
                ),
                overallMaxChunks: boundedPositiveInteger(
                  opts.rseOverallMaxChunks,
                  RSE_OVERALL_MAX_CHUNKS,
                  MAX_SEARCH_LIMIT,
                ),
                minSegmentValue:
                  typeof opts.rseMinSegmentValue === 'number' && Number.isFinite(opts.rseMinSegmentValue)
                    ? opts.rseMinSegmentValue
                    : RSE_MIN_SEGMENT_VALUE,
              },
              opts.signal,
            )
          ).slice(0, topN)
        : await resolveParents(capped, deps, topN, opts.signal);
  return ok(resolved);
}
