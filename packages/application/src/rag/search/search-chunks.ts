import { err, ok, isRequestCancellationError, logger } from '@app/domain';
import type { RetrievedChunkRow } from '@app/domain';
import {
  SIMILARITY_THRESHOLD,
  PARENT_CHILD_MODE,
  PARENT_CHILD_WINDOW,
  CANDIDATE_POOL,
  RERANK_TOP_N,
  RERANKER_THRESHOLD,
  HYBRID_ENABLED,
  RRF_K,
  LEXICAL_WEIGHT,
  LEXICAL_SEARCH_MODE,
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
  finiteNonnegative,
  lexicalScoredRows,
  toRetrievedChunk,
  type RetrievedChunk,
  type ScoredRow,
  type SearchChunksResult,
  type SearchDeps,
  type SearchExecutionResult,
  type SearchOpts,
  type RetrievalDiagnostics,
} from './search-types';
import { SearchFailure, type SearchDegradation, type SearchFailureCode } from './search-contract';
import {
  buildCandidateCacheContext,
  candidatesFromSearchResult,
  fetchCandidateRows,
  rehydrateCandidates,
  type CandidateCacheKeyInput,
  type CandidateCacheModality,
} from '../../agent/search/candidate-cache-port';
import { resolveParents } from './resolve-parents';
import { resolveWindow } from './resolve-window';
import { resolveSegments } from './resolve-segments';
import { rerankRows, sortByRelevance, reciprocalRankFusion } from './rerank-fusion';
import { stableChunkIdentities } from './stable-chunk-identity';

interface RetrievalStages {
  readonly dense: RetrievalDiagnostics['dense'];
  readonly lexical: RetrievalDiagnostics['lexical'];
  readonly fusion: RetrievalDiagnostics['fusion'];
}

export type { RetrievedChunk, SearchDeps, SearchOpts };

/**
 * Pool-scope synthetic provenance for cached candidate entries.
 *
 * Pool entries are keyed by query + modality + filter + versions, not by
 * subquestion: the same pool can serve any subquestion whose query matches.
 * Provenance stored here never surfaces — the orchestrator and the tool
 * recompute executedQueryIds/subquestionIds from the live plan on every
 * call — so these constants only satisfy the entry schema.
 */
const POOL_CACHE_PROVENANCE = { queryId: 'q-pool', subquestionId: 'sq-pool' } as const;

interface PoolCacheScope {
  readonly versions: {
    readonly tenantId: string;
    readonly corpusVersion: string;
    readonly indexVersion: string;
    readonly retrievalConfigVersion: string;
  };
}

/**
 * Resolve the candidate-cache scope for this call, or null when caching is
 * disabled, versions are absent, or the call was already cancelled.
 *
 * The retrievalConfigVersion carries a per-call pool signature
 * (candidateLimit, vector threshold, lexical mode): pools are fetched with
 * those parameters, so different shapes must never share a key. Fusion,
 * rerank, resolve, limits, and turn-local exclusion re-run per call and stay
 * out of the key.
 */
function poolCacheScope(deps: SearchDeps, opts: SearchOpts, candidateLimit: number): PoolCacheScope | null {
  const port = deps.candidateCache;
  const versions = deps.candidateCacheVersions;
  if (!port || !versions) return null;
  if (opts.signal?.aborted) return null;
  const threshold = Math.min(Math.max(boundedNonnegativeNumber(opts.threshold, SIMILARITY_THRESHOLD), 0), 1);
  const poolSignature = `c${candidateLimit}t${threshold}l${opts.lexicalSearchMode ?? LEXICAL_SEARCH_MODE}`;
  return {
    versions: {
      tenantId: versions.tenantId,
      corpusVersion: versions.corpusVersion,
      indexVersion: versions.indexVersion,
      retrievalConfigVersion: `${versions.retrievalConfigVersion}|pool:${poolSignature}`,
    },
  };
}

function poolKeyInput(
  scope: PoolCacheScope,
  query: string,
  modality: CandidateCacheModality,
  opts: SearchOpts,
): CandidateCacheKeyInput | null {
  try {
    return buildCandidateCacheContext({
      tenantId: scope.versions.tenantId,
      corpusVersion: scope.versions.corpusVersion,
      indexVersion: scope.versions.indexVersion,
      query,
      modality,
      filter: opts.filter,
      retrievalConfigVersion: scope.versions.retrievalConfigVersion,
    });
  } catch {
    return null;
  }
}

function rowIdentityKey(documentId: number, chunkIndex: number, chunkUid: string | undefined): string {
  return `${documentId}:${chunkIndex}:${chunkUid ?? ''}`;
}

/**
 * Load one modality pool from the candidate cache. Returns null on any miss,
 * version skew, rehydration gap, or failure — the caller runs uncached
 * retrieval. Content always comes fresh from the chunk store; only the
 * candidate identity set is cached.
 */
async function loadCachedPool(
  deps: SearchDeps,
  scope: PoolCacheScope,
  query: string,
  modality: CandidateCacheModality,
  opts: SearchOpts,
): Promise<ScoredRow[] | null> {
  const port = deps.candidateCache;
  if (!port) return null;
  if (opts.signal?.aborted) return null;
  const keyInput = poolKeyInput(scope, query, modality, opts);
  if (!keyInput) return null;
  let lookup;
  try {
    lookup = await port.get(port.buildKey(keyInput), keyInput);
  } catch {
    return null;
  }
  if (opts.signal?.aborted) return null;
  if (lookup.outcome !== 'hit') return null;
  let rows: RetrievedChunkRow[];
  try {
    rows = await fetchCandidateRows(
      lookup.candidates,
      deps.chunks,
      ...(opts.signal ? [{ signal: opts.signal }] : []),
    );
  } catch {
    return null;
  }
  const hydrated = rehydrateCandidates(lookup.candidates, rows);
  if (!hydrated) return null;
  const rowByIdentity = new Map<string, RetrievedChunkRow>();
  for (const row of rows) {
    const key = rowIdentityKey(row.documentId, row.chunkIndex, row.chunkUid);
    if (!rowByIdentity.has(key)) rowByIdentity.set(key, row);
  }
  const pool: ScoredRow[] = [];
  for (const chunk of hydrated) {
    const row = rowByIdentity.get(rowIdentityKey(chunk.documentId, chunk.chunkIndex, chunk.chunkUid));
    if (!row) return null;
    pool.push(modality === 'vector'
      ? { ...row, denseScore: chunk.scores.dense ?? finiteNonnegative(Number(row.similarity)) }
      : { ...row, lexicalScore: chunk.scores.lexical ?? finiteNonnegative(Number(row.similarity)) });
  }
  return pool;
}

/**
 * Store one modality pool. Best-effort and fail-open: any error is swallowed
 * so caching can never break retrieval.
 */
async function storePool(
  deps: SearchDeps,
  scope: PoolCacheScope,
  query: string,
  modality: CandidateCacheModality,
  opts: SearchOpts,
  scored: ScoredRow[],
): Promise<void> {
  const port = deps.candidateCache;
  if (!port) return;
  try {
    const chunks = scored.map((row, index) => toRetrievedChunk(row, index + 1));
    const entries = candidatesFromSearchResult(chunks, POOL_CACHE_PROVENANCE);
    const keyInput = poolKeyInput(scope, query, modality, opts);
    if (!keyInput) return;
    await port.set(port.buildKey(keyInput), keyInput, entries);
  } catch {
    // Fail-open: a lost pool write only costs a future cache miss.
  }
}

export async function searchChunks(
  query: string,
  opts: SearchOpts,
  deps: SearchDeps,
): Promise<SearchChunksResult> {
  if (opts.signal?.aborted) {
    return err(toSearchFailure('retrieval_unavailable', opts.signal.reason, opts.signal));
  }
  if (query.trim() === '') {
    return ok({
      chunks: [],
      degradedBy: [],
      diagnostics: emptyDiagnostics(opts),
    });
  }
  const { limit: topN } = sanitizePagination(opts.limit, undefined, MAX_SEARCH_LIMIT, opts.rerankTopN ?? RERANK_TOP_N);
  const rerankerEnabled = deps.reranker != null;
  const exclusionsPresent = (opts.excludeChunkIdentities?.size ?? 0) > 0;
  const threshold = Math.min(Math.max(boundedNonnegativeNumber(opts.threshold, SIMILARITY_THRESHOLD), 0), 1);
  const preThreshold = rerankerEnabled ? 0 : threshold;
  const configuredCandidateLimit = boundedPositiveInteger(
    opts.candidateLimit,
    CANDIDATE_POOL,
    MAX_CANDIDATE_LIMIT,
  );
  const candidateLimit = rerankerEnabled || exclusionsPresent
    ? Math.max(topN, configuredCandidateLimit)
    : topN;

  let embedding: number[];
  const precomputed = opts.precomputedEmbedding;
  if (
    precomputed !== undefined &&
    precomputed.length > 0 &&
    precomputed.every((value) => Number.isFinite(value))
  ) {
    embedding = [...precomputed];
  } else {
    try {
      embedding = await abortable(
        opts.signal ? deps.embeddings.embed(query, { signal: opts.signal }) : deps.embeddings.embed(query),
        opts.signal,
      );
    } catch (cause) {
      return err(toSearchFailure('embedding_unavailable', cause, opts.signal));
    }
  }

  const hybridEnabled = opts.hybridEnabled ?? HYBRID_ENABLED;
  const searchByLexical = deps.chunks.searchByLexical;
  const runHybrid = hybridEnabled && searchByLexical != null;

  // Run vector + lexical concurrently; lexical failure falls back to vector-only.
  // Each modality pool is served from the candidate cache when the scope is
  // configured and the pool is a hit; otherwise it is fetched from the chunk
  // store and the fresh pool is stored best-effort.
  const poolScope = poolCacheScope(deps, opts, configuredCandidateLimit);
  const vectorPromise = abortable(
    (async (): Promise<ScoredRow[]> => {
      if (poolScope) {
        const cached = await loadCachedPool(deps, poolScope, query, 'vector', opts);
        if (cached) return cached;
      }
      const rows = await (opts.signal
        ? deps.chunks.searchByVector(embedding, {
            threshold: preThreshold,
            limit: candidateLimit,
            ...(opts.filter ? { filter: opts.filter } : {}),
            signal: opts.signal,
          })
        : deps.chunks.searchByVector(embedding, {
            threshold: preThreshold,
            limit: candidateLimit,
            ...(opts.filter ? { filter: opts.filter } : {}),
          }));
      const scored = denseScoredRows(rows);
      if (poolScope) await storePool(deps, poolScope, query, 'vector', opts, scored);
      return scored;
    })(),
    opts.signal,
  );
  const lexicalPromise = runHybrid
    ? abortable(
        (async () => {
          if (poolScope) {
            const cached = await loadCachedPool(deps, poolScope, query, 'lexical', opts);
            if (cached) return { ok: true as const, rows: cached };
          }
          const rows = await (opts.signal
            ? searchByLexical(query, {
                limit: candidateLimit,
                ...(opts.filter ? { filter: opts.filter } : {}),
                mode: opts.lexicalSearchMode ?? LEXICAL_SEARCH_MODE,
                signal: opts.signal,
              })
            : searchByLexical(query, {
                limit: candidateLimit,
                ...(opts.filter ? { filter: opts.filter } : {}),
                mode: opts.lexicalSearchMode ?? LEXICAL_SEARCH_MODE,
              }));
          const scored = lexicalScoredRows(rows);
          if (poolScope) await storePool(deps, poolScope, query, 'lexical', opts, scored);
          return { ok: true as const, rows: scored };
        })(),
        opts.signal,
      ).then(
        (result) => result,
        (cause: unknown) => ({ ok: false as const, cause }),
      )
    : Promise.resolve(null);

  let vectorRows: ScoredRow[] = [];
  let vectorError: unknown;
  try {
    vectorRows = await vectorPromise;
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
    logger.warn('Vector search failed; falling back to lexical-only');
    return capAndResolve(
      lexicalScoredRows(lexicalResult.rows),
      query,
      topN,
      opts,
      deps,
      ['vector_unavailable'],
      {
        dense: { status: 'error', candidateCount: 0 },
        lexical: {
          status: 'ok',
          candidateCount: lexicalResult.rows.length,
          mode: opts.lexicalSearchMode ?? LEXICAL_SEARCH_MODE,
        },
        fusion: { applied: false, inputCount: lexicalResult.rows.length, outputCount: lexicalResult.rows.length },
      },
    );
  }
  if (lexicalResult === null) {
    return capAndResolve(vectorRows, query, topN, opts, deps, [], {
      dense: { status: 'ok', candidateCount: vectorRows.length },
      lexical: { status: 'not_run', candidateCount: 0, mode: opts.lexicalSearchMode ?? LEXICAL_SEARCH_MODE },
      fusion: { applied: false, inputCount: vectorRows.length, outputCount: vectorRows.length },
    });
  }
  if (!lexicalResult.ok) {
    if (isRequestCancellationError(lexicalResult.cause)) {
      return err(toSearchFailure('retrieval_unavailable', lexicalResult.cause, opts.signal));
    }
    logger.warn('Lexical search failed; falling back to vector-only');
    return capAndResolve(vectorRows, query, topN, opts, deps, ['lexical_unavailable'], {
      dense: { status: 'ok', candidateCount: vectorRows.length },
      lexical: { status: 'error', candidateCount: 0, mode: opts.lexicalSearchMode ?? LEXICAL_SEARCH_MODE },
      fusion: { applied: false, inputCount: vectorRows.length, outputCount: vectorRows.length },
    });
  }
  const lexicalRows = lexicalResult.rows;
  if (vectorRows.length === 0) {
    return capAndResolve(lexicalRows, query, topN, opts, deps, [], {
      dense: { status: 'ok', candidateCount: 0 },
      lexical: { status: 'ok', candidateCount: lexicalRows.length, mode: opts.lexicalSearchMode ?? LEXICAL_SEARCH_MODE },
      fusion: { applied: false, inputCount: lexicalRows.length, outputCount: lexicalRows.length },
    });
  }
  if (lexicalRows.length === 0) {
    return capAndResolve(vectorRows, query, topN, opts, deps, [], {
      dense: { status: 'ok', candidateCount: vectorRows.length },
      lexical: { status: 'ok', candidateCount: 0, mode: opts.lexicalSearchMode ?? LEXICAL_SEARCH_MODE },
      fusion: { applied: false, inputCount: vectorRows.length, outputCount: vectorRows.length },
    });
  }

  const rrfK = boundedPositiveInteger(opts.rrfK, RRF_K, Number.MAX_SAFE_INTEGER);
  const lexicalWeight = boundedNonnegativeNumber(opts.lexicalWeight, LEXICAL_WEIGHT);
  const fused = reciprocalRankFusion(vectorRows, lexicalRows, candidateLimit, rrfK, lexicalWeight);
  return capAndResolve(fused, query, topN, { ...opts, threshold }, deps, [], {
    dense: { status: 'ok', candidateCount: vectorRows.length },
    lexical: { status: 'ok', candidateCount: lexicalRows.length, mode: opts.lexicalSearchMode ?? LEXICAL_SEARCH_MODE },
    fusion: {
      applied: true,
      inputCount: vectorRows.length + lexicalRows.length,
      outputCount: fused.length,
    },
  });
}

function emptyDiagnostics(opts: SearchOpts): RetrievalDiagnostics {
  const mode = opts.mode ?? PARENT_CHILD_MODE;
  return {
    requestedLimit: 0,
    candidateLimit: 0,
    documentFilterApplied: opts.filter?.documentId != null,
    dense: { status: 'not_run', candidateCount: 0 },
    lexical: { status: 'not_run', candidateCount: 0, mode: opts.lexicalSearchMode ?? LEXICAL_SEARCH_MODE },
    fusion: { applied: false, inputCount: 0, outputCount: 0 },
    reranker: {
      status: 'not_configured',
      inputCount: 0,
      validCount: 0,
      acceptedCount: 0,
      threshold: null,
      thresholdFilteredCount: 0,
    },
    resolutionMode: mode,
    resolvedCount: 0,
    stableDuplicatesSkipped: 0,
    backfillCount: 0,
    hasMore: false,
    finalCount: 0,
    finalRanks: [],
  };
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
  stages: RetrievalStages,
): Promise<SearchChunksResult> {
  if (opts.signal?.aborted) {
    return err(toSearchFailure('retrieval_unavailable', opts.signal.reason, opts.signal));
  }
  const threshold = Math.min(Math.max(boundedNonnegativeNumber(opts.threshold, SIMILARITY_THRESHOLD), 0), 1);
  const rerankerThreshold = Math.min(
    Math.max(boundedNonnegativeNumber(opts.rerankerThreshold, RERANKER_THRESHOLD), 0),
    1,
  );
  const exclusions = opts.excludeChunkIdentities ?? new Set<string>();
  const configuredCandidateLimit = boundedPositiveInteger(
    opts.candidateLimit,
    CANDIDATE_POOL,
    MAX_CANDIDATE_LIMIT,
  );
  const effectiveCandidateLimit = deps.reranker || exclusions.size > 0
    ? Math.max(topN, configuredCandidateLimit)
    : topN;
  const resolutionLimit = effectiveCandidateLimit;
  let capped: ScoredRow[];
  let combinedDegradations = [...degradedBy];
  let rerankerDiagnostics: RetrievalDiagnostics['reranker'] = {
    status: 'not_configured',
    inputCount: 0,
    validCount: 0,
    acceptedCount: 0,
    threshold: null,
    thresholdFilteredCount: 0,
  };
  try {
    if (deps.reranker) {
      const reranked = await rerankRows(
        query,
        rows,
        resolutionLimit,
        deps.reranker,
        threshold,
        rerankerThreshold,
        opts.signal,
      );
      capped = reranked.rows;
      combinedDegradations = [...combinedDegradations, ...reranked.degradedBy];
      rerankerDiagnostics = {
        ...reranked.diagnostics,
        threshold: rerankerThreshold,
      };
    } else {
      capped = sortByRelevance(rows).slice(0, resolutionLimit);
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
            ).slice(0, resolutionLimit)
          : await resolveParents(capped, deps, resolutionLimit, opts.signal);
    const selected: RetrievedChunk[] = [];
    const selectedIdentities = new Set<string>();
    let stableDuplicatesSkipped = 0;
    let backfillCount = 0;
    let hasMore = false;
    for (const [index, chunk] of resolved.entries()) {
      const identities = stableChunkIdentities(chunk);
      if (identities.some((identity) => exclusions.has(identity) || selectedIdentities.has(identity))) {
        stableDuplicatesSkipped += 1;
        continue;
      }
      if (selected.length >= topN) {
        hasMore = true;
        break;
      }
      if (index >= topN) backfillCount += 1;
      for (const identity of identities) selectedIdentities.add(identity);
      selected.push(chunk);
    }
    const chunks: RetrievedChunk[] = selected.map((chunk, index) => ({
      ...chunk,
      scores: { ...chunk.scores, finalRank: index + 1 },
    }));
    const value: SearchExecutionResult = {
      chunks,
      degradedBy: [...new Set(combinedDegradations)],
      diagnostics: {
        requestedLimit: topN,
        candidateLimit: effectiveCandidateLimit,
        documentFilterApplied: opts.filter?.documentId != null,
        ...stages,
        reranker: rerankerDiagnostics,
        resolutionMode: mode,
        resolvedCount: resolved.length,
        stableDuplicatesSkipped,
        backfillCount,
        hasMore,
        finalCount: chunks.length,
        finalRanks: chunks.map((chunk) => chunk.scores.finalRank),
      },
    };
    return ok(value);
  } catch (cause) {
    return err(toSearchFailure('retrieval_unavailable', cause, opts.signal));
  }
}
