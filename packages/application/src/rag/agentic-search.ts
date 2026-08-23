import { ok, err, type Result, ExternalServiceError } from '@app/domain';
import { logger } from '@app/domain';
import type { QueryRewriter, DocumentGrader, FallbackReason, AgenticResultState } from '@app/domain';
import { searchChunks, type SearchDeps, type RetrievedChunk } from './search';
import {
  GRADE_MAX_ROWS,
  AGENTIC_RETRIEVE_LIMIT,
  AGENTIC_MAX_RETRIES,
  AGENT_STEP_BUDGET,
} from '@app/domain';

/** §A3 degraded fallback size: top 4 of the reranker-sorted fused rows. */
const FALLBACK_CHUNK_COUNT = 4;

export interface AgenticDeps {
  search: SearchDeps;
  queryRewriter: QueryRewriter;
  documentGrader: DocumentGrader;
  /** Runtime knobs. Each falls back to its frozen constant. */
  retrieveLimit?: number;
  maxRetries?: number;
  /** Caps retry passes only (grading is bounded by GRADE_MAX_ROWS). */
  stepBudget?: number;
  /** §B3 toggles. Off ⇒ skip rewrite / grading entirely. */
  rewriteEnabled?: boolean;
  gradeEnabled?: boolean;
  similarityThreshold?: number;
  hybridEnabled?: boolean;
}

/** Outcome of one agentic retrieval turn (§A3). */
export interface AgenticResult {
  chunks: RetrievedChunk[];
  /** Rewritten query used for the final retrieval. */
  rewrittenQuery: string;
  /** DB alias of `isEmpty`, kept for history compat. Only true when search found 0 rows. */
  outOfDomain: boolean;
  isEmpty: boolean;
  degraded: boolean;
  fallbackReason: FallbackReason | null;
  resultState: AgenticResultState;
  /** Kept for compat; mirrors `fallbackReason === 'grader_unavailable'`. */
  gradingUnavailable?: boolean;
}

type PassOutcome =
  | { kind: 'empty' }
  | { kind: 'kept'; chunks: RetrievedChunk[] }
  | { kind: 'fallback'; reason: Exclude<FallbackReason, 'grading_disabled'>; pool: RetrievedChunk[] }
  | { kind: 'grading_disabled'; pool: RetrievedChunk[] };

/**
 * Agentic retrieval loop (§A3): 1. rewrite the query (toggleable), 2. retrieve
 * fused reranker-sorted rows honoring admin similarity/hybrid knobs, 3. grade
 * up to GRADE_MAX_ROWS in ONE batched call — grader outage or all-`no` yields a
 * top-4 degraded fallback instead of an empty wall; only a 0-row search result
 * produces the empty wall, 4. retry passes run solely while a pass found zero
 * chunks with grading enabled and retries remain.
 * Generation + hallucination check happen in the route after `streamText`.
 */
export async function agenticSearch(
  originalQuery: string,
  deps: AgenticDeps,
): Promise<Result<AgenticResult>> {
  if (originalQuery.trim() === '') {
    return ok({
      chunks: [],
      rewrittenQuery: originalQuery,
      outOfDomain: true,
      isEmpty: true,
      degraded: false,
      fallbackReason: null,
      resultState: 'empty',
      gradingUnavailable: false,
    });
  }

  try {
    const rewriteOn = deps.rewriteEnabled !== false;
    const gradeOn = deps.gradeEnabled !== false;

    const tryRewrite = async (query: string): Promise<string> => {
      if (!rewriteOn) return query;
      try {
        return await deps.queryRewriter.rewrite(query);
      } catch {
        return query;
      }
    };

    // stepBudget now only caps retry passes through the maxRetries clamp.
    const stepBudget = Math.max(1, deps.stepBudget ?? AGENT_STEP_BUDGET);
    const maxRetries = Math.max(0, Math.min(deps.maxRetries ?? AGENTIC_MAX_RETRIES, stepBudget - 1));

    const runPass = async (query: string): Promise<PassOutcome> => {
      const found = await searchChunks(
        query,
        {
          limit: deps.retrieveLimit ?? AGENTIC_RETRIEVE_LIMIT,
          threshold: deps.similarityThreshold,
          hybridEnabled: deps.hybridEnabled,
        },
        deps.search,
      );
      if (!found.ok) {
        throw new ExternalServiceError('Agentic retrieval failed', found.error);
      }
      const rows = found.value;
      if (rows.length === 0) return { kind: 'empty' };
      if (!gradeOn) return { kind: 'grading_disabled', pool: rows };

      // Explicit visible cap on graded rows; the ranked tail is dropped audibly.
      const graded = rows.slice(0, GRADE_MAX_ROWS);
      let verdicts: Array<'yes' | 'no'> | null;
      try {
        verdicts = await deps.documentGrader.gradeAll(query, graded.map((r) => r.content));
      } catch {
        verdicts = null;
      }
      if (verdicts === null) return { kind: 'fallback', reason: 'grader_unavailable', pool: rows };
      const kept = graded.filter((_, i) => verdicts[i] === 'yes');
      if (kept.length === 0) return { kind: 'fallback', reason: 'all_filtered', pool: rows };
      return { kind: 'kept', chunks: kept };
    };

    let rewritten = await tryRewrite(originalQuery);
    let outcome = await runPass(rewritten);

    // Degraded outcomes return immediately; retries are only useful when the
    // search itself came back empty (a fresh rewrite may find rows).
    for (
      let attempt = 0;
      attempt < maxRetries && gradeOn && outcome.kind === 'empty';
      attempt++
    ) {
      rewritten = await tryRewrite(rewritten);
      outcome = await runPass(rewritten);
    }

    switch (outcome.kind) {
      case 'kept':
        return ok({
          chunks: outcome.chunks,
          rewrittenQuery: rewritten,
          outOfDomain: false,
          isEmpty: false,
          degraded: false,
          fallbackReason: null,
          resultState: 'ok',
          gradingUnavailable: false,
        });
      case 'fallback':
      case 'grading_disabled': {
        const fallbackChunks = outcome.pool.slice(0, FALLBACK_CHUNK_COUNT);
        const fallbackReason: FallbackReason =
          outcome.kind === 'grading_disabled' ? 'grading_disabled' : outcome.reason;
        logger.warn('agentic retrieval degraded; serving ungraded fallback chunks', {
          severity: 'warn',
          event: 'agentic.degraded_fallback',
          fallbackReason,
          chunks: fallbackChunks.length,
        });
        return ok({
          chunks: fallbackChunks,
          rewrittenQuery: rewritten,
          outOfDomain: false,
          isEmpty: false,
          degraded: true,
          fallbackReason,
          resultState: 'degraded',
          gradingUnavailable: fallbackReason === 'grader_unavailable',
        });
      }
      case 'empty':
        return ok({
          chunks: [],
          rewrittenQuery: rewritten,
          outOfDomain: true,
          isEmpty: true,
          degraded: false,
          fallbackReason: null,
          resultState: 'empty',
          gradingUnavailable: false,
        });
    }
  } catch (e) {
    return err(new ExternalServiceError('Agentic search failed', e));
  }
}
