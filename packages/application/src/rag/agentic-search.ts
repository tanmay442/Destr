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
} from '../../../../config/constants';

export interface AgenticDeps {
  search: SearchDeps;
  queryRewriter: QueryRewriter;
  documentGrader: DocumentGrader;
  hallucinationGrader: HallucinationGrader;
}

/** Outcome of one agentic retrieval pass. */
export interface AgenticResult {
  chunks: RetrievedChunk[];
  /** Rewritten query actually used for the final retrieval. */
  rewrittenQuery: string;
  /** True when no chunk cleared the relevance grade and similarity was below threshold. */
  outOfDomain: boolean;
}

async function retrieveAndGrade(
  query: string,
  deps: AgenticDeps,
): Promise<{ chunks: RetrievedChunk[]; maxSimilarity: number }> {
  const found = await searchChunks(query, { limit: AGENTIC_RETRIEVE_LIMIT }, deps.search);
  if (!found.ok) {
    throw new ExternalServiceError('Agentic retrieval failed', found.error);
  }
  const rows = found.value;
  const grades = await Promise.all(
    rows.map((r) => deps.documentGrader.grade(query, r.content)),
  );
  const kept = rows.filter((_, i) => grades[i] === 'yes');
  const maxSimilarity = rows.reduce((m, r) => Math.max(m, r.similarity), 0);
  return { chunks: kept, maxSimilarity };
}

/**
 * Agentic retrieval loop (Session 8) over the hybrid/reranked `searchChunks`.
 *
 * 1. rewrite the query, 2. retrieve + grade/drop irrelevant chunks,
 * 3. if nothing kept and similarity is low, re-retrieve with the original
 *    query (one bounded retry), 4. report out-of-domain when the final pool is
 *    empty and below `OUT_OF_DOMAIN_THRESHOLD`. The generation + hallucination
 * check happen in the route after `streamText` returns.
 */
export async function agenticSearch(
  originalQuery: string,
  deps: AgenticDeps,
): Promise<Result<AgenticResult>> {
  if (originalQuery.trim() === '') {
    return ok({ chunks: [], rewrittenQuery: originalQuery, outOfDomain: true });
  }

  try {
    let rewritten: string;
    try {
      rewritten = await deps.queryRewriter.rewrite(originalQuery);
    } catch {
      rewritten = originalQuery;
    }

    let pass = await retrieveAndGrade(rewritten, deps);

    if (pass.chunks.length === 0) {
      for (let attempt = 0; attempt < AGENTIC_MAX_RETRIES && pass.chunks.length === 0; attempt++) {
        pass = await retrieveAndGrade(originalQuery, deps);
      }
    }

    const outOfDomain =
      pass.chunks.length === 0 && pass.maxSimilarity < OUT_OF_DOMAIN_THRESHOLD;

    return ok({
      chunks: pass.chunks,
      rewrittenQuery: rewritten,
      outOfDomain,
    });
  } catch (e) {
    return err(new ExternalServiceError('Agentic search failed', e));
  }
}
