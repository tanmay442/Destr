import { err, ok, isRequestCancellationError, logger } from '@app/domain';
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
import { abortable } from './abort';
import {
  MAX_SEARCH_LIMIT,
  MAX_CANDIDATE_LIMIT,
  boundedPositiveInteger,
  boundedNonnegativeNumber,
  denseScoredRows,
  lexicalScoredRows,
  type RetrievedChunk,
  type ScoredRow,
  type SearchChunksResult,
  type SearchExecutionResult,
  type SearchDeps,
  type SearchOpts,
} from './search-types';
import { SearchFailure, type SearchDegradation, type SearchFailureCode } from './search-contract';
import { resolveParents } from './resolve-parents';
import { resolveWindow } from './resolve-window';
import { resolveSegments } from './resolve-segments';
import { rerankRows, sortByRelevance, reciprocalRankFusion } from './rerank-fusion';

export type { RetrievedChunk, SearchDeps, SearchOpts };

export async function searchChunks(
  query: string,
  opts: SearchOpts,
  deps: SearchDeps,
): Promise<SearchChunksResult> {
  if (opts.signal?.aborted) {
    return err(toSearchFailure('retrieval_unavailable', opts.signal.reason, opts.signal));
  }
  if (query.trim() === '') {
    return ok({ chunks: [], degradedBy: [] });
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
    return err(toSearchFailure('embedding_unavailable', cause, opts.signal));
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

  let vectorRows: ScoredRow[] = [];
  let vectorError: unknown;
  try {
    vectorRows = denseScoredRows(await vectorPromise);
  } catch (cause) {
    if (opts.signal?.aborted || isRequestCancellationError(cause)) {
      return err(toSearchFailure('retrieval_unavailable', cause, opts.signal));
    }
    vectorError = cause;
  }

  const lexicalResult = await lexicalPromise;
  if (opts.signal?.aborted) {
    return err(toSearchFailure('retrieval_unavailable', opts.signal.reason, opts.signal));
  }
  if (vectorError !== undefined) {
    if (!runHybrid || lexicalResult === null || !lexicalResult.ok) {
      return err(toSearchFailure('retrieval_unavailable', vectorError, opts.signal));
    }
    logger.warn('Vector search failed; falling back to lexical-only', { error: String(vectorError) });
    return capAndResolve(
      lexicalScoredRows(lexicalResult.rows),
      query,
      topN,
      opts,
      deps,
      ['vector_unavailable'],
    );
  }
  if (lexicalResult === null) {
    return capAndResolve(vectorRows, query, topN, opts, deps, []);
  }
  if (!lexicalResult.ok) {
    if (isRequestCancellationError(lexicalResult.cause)) {
      return err(toSearchFailure('retrieval_unavailable', lexicalResult.cause, opts.signal));
    }
    logger.warn('Lexical search failed; falling back to vector-only', { error: String(lexicalResult.cause) });
    return capAndResolve(vectorRows, query, topN, opts, deps, ['lexical_unavailable']);
  }
  const lexicalRows = lexicalScoredRows(lexicalResult.rows);

  if (vectorRows.length === 0 && lexicalRows.length === 0) {
    return ok({ chunks: [], degradedBy: [] });
  }
  if (vectorRows.length === 0) {
    return capAndResolve(lexicalRows, query, topN, opts, deps, []);
  }
  if (lexicalRows.length === 0) {
    return capAndResolve(vectorRows, query, topN, opts, deps, []);
  }

  const rrfK = boundedPositiveInteger(opts.rrfK, RRF_K, Number.MAX_SAFE_INTEGER);
  const lexicalWeight = boundedNonnegativeNumber(opts.lexicalWeight, LEXICAL_WEIGHT);
  const fused = reciprocalRankFusion(vectorRows, lexicalRows, candidateLimit, rrfK, lexicalWeight);
  return capAndResolve(fused, query, topN, { ...opts, threshold }, deps, []);
}

function errorName(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string'
    ? value.name
    : undefined;
}

function toSearchFailure(
  fallbackCode: SearchFailureCode,
  cause: unknown,
  signal: AbortSignal | undefined,
): SearchFailure {
  const interruption = signal?.aborted ? signal.reason : cause;
  const code = errorName(interruption) === 'TimeoutError'
    ? 'timeout'
    : signal?.aborted || isRequestCancellationError(cause)
      ? 'cancelled'
      : fallbackCode;
  const userSafeMessage = code === 'cancelled'
    ? 'The documentation search was cancelled.'
    : code === 'timeout'
      ? 'The documentation search timed out. Please try again.'
      : 'The documentation search is temporarily unavailable. Please try again.';
  return new SearchFailure(code, code !== 'cancelled', userSafeMessage, cause);
}

async function capAndResolve(
  rows: ScoredRow[],
  query: string,
  topN: number,
  opts: SearchOpts,
  deps: SearchDeps,
  degradedBy: readonly SearchDegradation[],
): Promise<SearchChunksResult> {
  if (opts.signal?.aborted) {
    return err(toSearchFailure('retrieval_unavailable', opts.signal.reason, opts.signal));
  }
  const threshold = Math.min(Math.max(boundedNonnegativeNumber(opts.threshold, SIMILARITY_THRESHOLD), 0), 1);
  let capped: ScoredRow[];
  let combinedDegradations = [...degradedBy];
  try {
    if (deps.reranker) {
      const reranked = await rerankRows(query, rows, topN, deps.reranker, threshold, opts.signal);
      capped = reranked.rows;
      combinedDegradations = [...combinedDegradations, ...reranked.degradedBy];
    } else {
      capped = sortByRelevance(rows).slice(0, topN);
    }
  } catch (cause) {
    return err(toSearchFailure('reranker_unavailable', cause, opts.signal));
  }

  const mode = opts.mode ?? PARENT_CHILD_MODE;
  try {
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
    const chunks: RetrievedChunk[] = resolved.map((chunk, index) => ({
      ...chunk,
      scores: { ...chunk.scores, finalRank: index + 1 },
    }));
    const value: SearchExecutionResult = {
      chunks,
      degradedBy: [...new Set(combinedDegradations)],
    };
    return ok(value);
  } catch (cause) {
    return err(toSearchFailure('retrieval_unavailable', cause, opts.signal));
  }
}
