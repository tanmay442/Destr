import { ok, err, isRequestCancellationError, type Result, logger } from '@app/domain';
import type { QueryRewriter, FallbackReason, AgenticResultState } from '@app/domain';
import {
  searchChunks,
  type RetrievalDiagnostics,
  type SearchDeps,
  type RetrievedChunk,
} from './search';
import { SearchFailure, type SearchDegradation } from './search/search-contract';
import { AGENTIC_RETRIEVE_LIMIT, AGENTIC_MAX_RETRIES, AGENT_STEP_BUDGET } from '@app/domain';

export interface AgenticDeps {
  search: SearchDeps;
  signal?: AbortSignal | undefined;
  queryRewriter: QueryRewriter;
  retrieveLimit?: number;
  maxRetries?: number;
  stepBudget?: number;
  rewriteEnabled?: boolean;
  similarityThreshold?: number;
  rerankerThreshold?: number;
  hybridEnabled?: boolean;
  lexicalSearchMode?: 'content_plain' | 'weighted_websearch';
  filter?: { documentId?: number };
  excludeChunkIdentities?: ReadonlySet<string>;
}

export interface AgenticResult {
  chunks: RetrievedChunk[];
  rewrittenQuery: string;
  attemptedQueries: string[];
  resultQuery: string | null;
  degradedBy: readonly SearchDegradation[];
  outOfDomain: boolean;
  isEmpty: boolean;
  fallbackReason: FallbackReason | null;
  resultState: AgenticResultState;
  retrievalDiagnostics: readonly RetrievalDiagnostics[];
}

type PassOutcome =
  | { kind: 'empty'; degradedBy: readonly SearchDegradation[] }
  | { kind: 'kept'; chunks: RetrievedChunk[]; query: string; degradedBy: readonly SearchDegradation[] };

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Agentic search aborted');
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error('Agentic search aborted'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * @deprecated WP-4: legacy deterministic rewrite/retry wrapper preserved for
 * rollback compatibility. New code should use the structured search
 * orchestrator (`packages/application/src/agent/search/search-orchestrator.ts`)
 * behind the `SEARCH_STRUCTURED_PLANNER_ENABLED` flag. This wrapper keeps the
 * corrected WP-1/WP-2 retrieval behavior (typed errors, score provenance,
 * stable identity, over-fetch/backfill) unchanged.
 */
export async function agenticSearch(
  originalQuery: string,
  deps: AgenticDeps,
): Promise<Result<AgenticResult, SearchFailure>> {
  if (deps.signal?.aborted) {
    return err(unexpectedFailure(deps.signal.reason, deps.signal));
  }
  if (originalQuery.trim() === '') {
    return ok({
      chunks: [],
      rewrittenQuery: originalQuery,
      attemptedQueries: [originalQuery],
      resultQuery: null,
      degradedBy: [],
      outOfDomain: true,
      isEmpty: true,
      fallbackReason: null,
      resultState: 'no_match',
      retrievalDiagnostics: [],
    });
  }

  const attemptedQueries: string[] = [];
  const retrievalDiagnostics: RetrievalDiagnostics[] = [];
  try {
    const rewriteOn = deps.rewriteEnabled !== false;

    const tryRewrite = async (query: string): Promise<string> => {
      if (!rewriteOn) return query;
      try {
        const candidate = (await abortable(deps.queryRewriter.rewrite(query), deps.signal)).trim();
        return (candidate || query.trim()).slice(0, 2_000);
      } catch {
        logger.debug('agentic rewrite failed');
        return query;
      }
    };

    const stepBudget = Math.max(1, deps.stepBudget ?? AGENT_STEP_BUDGET);
    const maxRetries = Math.max(0, Math.min(deps.maxRetries ?? AGENTIC_MAX_RETRIES, stepBudget - 1));

    const runPass = async (query: string): Promise<PassOutcome> => {
      attemptedQueries.push(query);
      const found = await searchChunks(
        query,
        {
          limit: deps.retrieveLimit ?? AGENTIC_RETRIEVE_LIMIT,
          threshold: deps.similarityThreshold,
          rerankerThreshold: deps.rerankerThreshold,
          hybridEnabled: deps.hybridEnabled,
          lexicalSearchMode: deps.lexicalSearchMode,
          filter: deps.filter,
          excludeChunkIdentities: deps.excludeChunkIdentities,
          signal: deps.signal,
        },
        deps.search,
      );
      if (!found.ok) {
        throw found.error;
      }
      retrievalDiagnostics.push(found.value.diagnostics);
      const rows = found.value.chunks;
      if (rows.length === 0) return { kind: 'empty', degradedBy: found.value.degradedBy };
      return { kind: 'kept', chunks: rows, query, degradedBy: found.value.degradedBy };
    };

    let rewritten = await tryRewrite(originalQuery);
    let outcome = await runPass(rewritten);

    for (let attempt = 0; attempt < maxRetries && outcome.kind === 'empty'; attempt++) {
      rewritten = await tryRewrite(originalQuery);
      outcome = await runPass(rewritten);
    }

    if (outcome.kind === 'empty') {
      return ok({
        chunks: [],
        rewrittenQuery: rewritten,
        attemptedQueries,
        resultQuery: null,
        degradedBy: outcome.degradedBy,
        outOfDomain: true,
        isEmpty: true,
        fallbackReason: null,
        resultState: 'no_match',
        retrievalDiagnostics,
      });
    }

    return ok({
      chunks: outcome.chunks,
      rewrittenQuery: rewritten,
      attemptedQueries,
      resultQuery: outcome.query,
      degradedBy: outcome.degradedBy,
      outOfDomain: false,
      isEmpty: false,
      fallbackReason: null,
      resultState: outcome.degradedBy.length > 0 ? 'degraded' : 'results',
      retrievalDiagnostics,
    });
  } catch (e) {
    if (e instanceof SearchFailure) {
      return err(new SearchFailure(
        e.code,
        e.retryable,
        e.userSafeMessage,
        e,
        attemptedQueries.length > 0 ? attemptedQueries : e.attemptedQueries,
      ));
    }
    return err(unexpectedFailure(e, deps.signal, attemptedQueries));
  }
}

function unexpectedFailure(
  cause: unknown,
  signal: AbortSignal | undefined,
  attemptedQueries?: readonly string[],
): SearchFailure {
  const candidate = cause instanceof Error ? cause : undefined;
  const interruption = signal?.aborted ? signal.reason : cause;
  const interruptionError = interruption instanceof Error ? interruption : candidate;
  const timedOut = interruptionError?.name === 'TimeoutError';
  const cancelled = signal?.aborted || isRequestCancellationError(cause);
  const code = timedOut ? 'timeout' : cancelled ? 'cancelled' : 'retrieval_unavailable';
  return new SearchFailure(
    code,
    code !== 'cancelled',
    code === 'timeout'
      ? 'The documentation search timed out. Please try again.'
      : code === 'cancelled'
        ? 'The documentation search was cancelled.'
        : 'The documentation search is temporarily unavailable. Please try again.',
    cause,
    attemptedQueries,
  );
}
