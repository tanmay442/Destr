import { ok, err, type Result, ExternalServiceError } from '@app/domain';
import type {
  QueryRewriter,
  DocumentGrader,
  HallucinationGrader,
} from '@app/domain';
import { searchChunks, type SearchDeps, type RetrievedChunk } from './search';
import {
  OUT_OF_DOMAIN_THRESHOLD,
  AGENTIC_RETRIEVE_LIMIT,
  AGENTIC_MAX_RETRIES,
  AGENT_STEP_BUDGET,
} from '@app/domain';

export interface AgenticDeps {
  search: SearchDeps;
  queryRewriter: QueryRewriter;
  documentGrader: DocumentGrader;
  hallucinationGrader: HallucinationGrader;
  /** Runtime knobs. Each falls back to its frozen constant. */
  retrieveLimit?: number;
  maxRetries?: number;
  /** Absolute cap on total grader LLM calls this turn. */
  stepBudget?: number;
  outOfDomainThreshold?: number;
}

/** Outcome of one agentic retrieval pass. */
export interface AgenticResult {
  chunks: RetrievedChunk[];
  /** Rewritten query used for the final retrieval. */
  rewrittenQuery: string;
  /** True when no chunk cleared the relevance grade and similarity was below threshold. */
  outOfDomain: boolean;
}

const GRADER_CONCURRENCY = 3;

async function gradeBounded(
  query: string,
  rows: RetrievedChunk[],
  deps: AgenticDeps,
): Promise<Array<'yes' | 'no'>> {
  const grades: Array<'yes' | 'no'> = new Array(rows.length);
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const i = next++;
      try {
        grades[i] = await deps.documentGrader.grade(query, rows[i]!.content);
      } catch {
        grades[i] = 'yes';
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(GRADER_CONCURRENCY, rows.length) }, worker));
  return grades;
}

/**
 * Agentic retrieval loop: 1. rewrite query, 2. retrieve + grade/drop irrelevant
 * chunks, 3. retry with a fresh rewrite of the previous rewrite if nothing kept
 * (bounded by retries, a hard total grader-call budget, and a grading
 * concurrency cap), 4. report out-of-domain when the final pool is empty and
 * below threshold. Generation + hallucination check happen in the route after
 * `streamText` returns.
 */
export async function agenticSearch(
  originalQuery: string,
  deps: AgenticDeps,
): Promise<Result<AgenticResult>> {
  if (originalQuery.trim() === '') {
    return ok({ chunks: [], rewrittenQuery: originalQuery, outOfDomain: true });
  }

  try {
    const tryRewrite = async (query: string): Promise<string> => {
      try {
        return await deps.queryRewriter.rewrite(query);
      } catch {
        return query;
      }
    };

    const stepBudget = Math.max(1, deps.stepBudget ?? AGENT_STEP_BUDGET);
    const maxRetries = Math.max(0, Math.min(deps.maxRetries ?? AGENTIC_MAX_RETRIES, stepBudget - 1));
    // Share the budget across all passes so a dense first retrieval cannot starve the retry loop.
    const perPassBudget = Math.max(1, Math.floor(stepBudget / (maxRetries + 1)));
    let budget = stepBudget;

    const runPass = async (query: string): Promise<{ chunks: RetrievedChunk[]; maxSimilarity: number }> => {
      const found = await searchChunks(query, { limit: deps.retrieveLimit ?? AGENTIC_RETRIEVE_LIMIT }, deps.search);
      if (!found.ok) {
        throw new ExternalServiceError('Agentic retrieval failed', found.error);
      }
      const rows = found.value;
      const graded = rows.slice(0, Math.min(perPassBudget, budget));
      budget -= graded.length;
      const grades = await gradeBounded(query, graded, deps);
      const kept = graded.filter((_, i) => grades[i] === 'yes');
      const maxSimilarity = graded.reduce((m, r) => Math.max(m, r.similarity), 0);
      return { chunks: kept, maxSimilarity };
    };

    let rewritten = await tryRewrite(originalQuery);
    let pass = await runPass(rewritten);

    for (let attempt = 0; attempt < maxRetries && pass.chunks.length === 0 && budget > 0; attempt++) {
      rewritten = await tryRewrite(rewritten);
      pass = await runPass(rewritten);
    }

    const outOfDomain =
      pass.chunks.length === 0 &&
      pass.maxSimilarity < (deps.outOfDomainThreshold ?? OUT_OF_DOMAIN_THRESHOLD);

    return ok({
      chunks: pass.chunks,
      rewrittenQuery: rewritten,
      outOfDomain,
    });
  } catch (e) {
    return err(new ExternalServiceError('Agentic search failed', e));
  }
}
