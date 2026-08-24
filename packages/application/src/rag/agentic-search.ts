import { ok, err, type Result, ExternalServiceError } from '@app/domain';
import { logger } from '@app/domain';
import type { QueryRewriter, DocumentGrader, FallbackReason, AgenticResultState } from '@app/domain';
import { searchChunks, type SearchDeps, type RetrievedChunk } from './search';
import {
  GRADE_MAX_ROWS,
  AGENTIC_RETRIEVE_LIMIT,
  AGENTIC_MAX_RETRIES,
  AGENT_STEP_BUDGET,
  FALLBACK_CHUNK_COUNT,
} from '@app/domain';

function isLenientFallbackVerdicts(value: unknown): boolean {
  return Array.isArray(value) && (value as unknown as { lenientFallbackUsed?: boolean }).lenientFallbackUsed === true;
}

export interface AgenticDeps {
  search: SearchDeps;
  queryRewriter: QueryRewriter;
  documentGrader: DocumentGrader;
  retrieveLimit?: number;
  maxRetries?: number;
  stepBudget?: number;
  rewriteEnabled?: boolean;
  gradeEnabled?: boolean;
  similarityThreshold?: number;
  hybridEnabled?: boolean;
}

export interface AgenticResult {
  chunks: RetrievedChunk[];
  rewrittenQuery: string;
  outOfDomain: boolean;
  isEmpty: boolean;
  degraded: boolean;
  fallbackReason: FallbackReason | null;
  resultState: AgenticResultState;
  gradingUnavailable?: boolean;
}

type PassOutcome =
  | { kind: 'empty' }
  | { kind: 'kept'; chunks: RetrievedChunk[] }
  | { kind: 'fallback'; reason: Exclude<FallbackReason, 'grading_disabled'>; pool: RetrievedChunk[] }
  | { kind: 'grading_disabled'; pool: RetrievedChunk[] };

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

      const graded = rows.slice(0, GRADE_MAX_ROWS);
      if (rows.length > GRADE_MAX_ROWS) {
        logger.warn('agentic retrieval: ranked tail dropped due to GRADE_MAX_ROWS cap', {
          severity: 'warn',
          event: 'agentic.ranked_tail_dropped',
          total: rows.length,
          graded: graded.length,
          droppedCount: rows.length - GRADE_MAX_ROWS,
        });
      }
      let verdicts: Array<'yes' | 'no'> | null;
      try {
        verdicts = await deps.documentGrader.gradeAll(query, graded.map((r) => r.content));
      } catch {
        verdicts = null;
      }
      if (verdicts === null) return { kind: 'fallback', reason: 'grader_unavailable', pool: rows };
      if (isLenientFallbackVerdicts(verdicts)) {
        logger.warn('agentic retrieval degraded; lenient fallback used', {
          severity: 'warn',
          event: 'agentic.degraded_fallback',
          fallbackReason: 'lenient_fallback' as FallbackReason,
          chunks: Math.min(rows.length, FALLBACK_CHUNK_COUNT),
        });
        return { kind: 'fallback', reason: 'lenient_fallback', pool: rows };
      }
      const kept = graded.filter((_, i) => verdicts[i] === 'yes');
      if (kept.length === 0) return { kind: 'fallback', reason: 'all_filtered', pool: rows };
      return { kind: 'kept', chunks: kept };
    };

    let rewritten = await tryRewrite(originalQuery);
    let outcome = await runPass(rewritten);

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
