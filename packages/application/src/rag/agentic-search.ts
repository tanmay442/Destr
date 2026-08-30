import { ok, err, type Result, ExternalServiceError, logger } from '@app/domain';
import type { QueryRewriter, FallbackReason, AgenticResultState } from '@app/domain';
import { searchChunks, type SearchDeps, type RetrievedChunk } from './search';
import { AGENTIC_RETRIEVE_LIMIT, AGENTIC_MAX_RETRIES, AGENT_STEP_BUDGET } from '@app/domain';

export interface AgenticDeps {
  search: SearchDeps;
  queryRewriter: QueryRewriter;
  retrieveLimit?: number;
  maxRetries?: number;
  stepBudget?: number;
  rewriteEnabled?: boolean;
  similarityThreshold?: number;
  hybridEnabled?: boolean;
}

export interface AgenticResult {
  chunks: RetrievedChunk[];
  rewrittenQuery: string;
  outOfDomain: boolean;
  isEmpty: boolean;
  fallbackReason: FallbackReason | null;
  resultState: AgenticResultState;
}

type PassOutcome =
  | { kind: 'empty' }
  | { kind: 'kept'; chunks: RetrievedChunk[] };

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
      fallbackReason: null,
      resultState: 'empty',
    });
  }

  try {
    const rewriteOn = deps.rewriteEnabled !== false;

    const tryRewrite = async (query: string): Promise<string> => {
      if (!rewriteOn) return query;
      try {
        return await deps.queryRewriter.rewrite(query);
      } catch (cause) {
        logger.debug('agentic rewrite failed', { error: String(cause), query });
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
      return { kind: 'kept', chunks: rows };
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
        outOfDomain: true,
        isEmpty: true,
        fallbackReason: null,
        resultState: 'empty',
      });
    }

    return ok({
      chunks: outcome.chunks,
      rewrittenQuery: rewritten,
      outOfDomain: false,
      isEmpty: false,
      fallbackReason: null,
      resultState: 'ok',
    });
  } catch (e) {
    return err(new ExternalServiceError('Agentic search failed', e));
  }
}
