import { z } from 'zod';
import { logger, sanitizeText, type AgenticResultState } from '@app/domain';
import type { AppConfig } from '@app/domain/app-config';
import {
  searchToolResultSchema,
  SearchFailure,
  type RetrievalSignal,
  type RetrievalDiagnostics,
  type RetrievedChunk,
  type SearchDegradation,
  type SearchSubquestionResult,
  type SearchToolItem,
  type SearchToolResult,
} from '../../rag/search';
import { addGroundingEvidence, formatGroundingReference, type GroundingEvidence } from '../grounding-evidence';
import type { ChatTurnDeps, TurnMetrics } from './turn-types';

const DEFAULT_TOOL_RESULT_LIMIT = 3;

const searchDocumentationInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe(
      'A focused, specific search query. Reformulate vague user wording into a tight phrase (e.g. "school cell phone policy" instead of "phones").',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Maximum number of evidence chunks to return. Defaults to 3.'),
});

type PrefetchedSearchOutcome =
  | {
      kind: 'results';
      query: string;
      matches: RetrievedChunk[];
      degradedBy: readonly SearchDegradation[];
    }
  | { kind: 'no_match'; query: string }
  | { kind: 'error'; query: string; failure: SearchFailure };

function toolCallId(options: unknown): string {
  if (
    typeof options === 'object' &&
    options !== null &&
    'toolCallId' in options &&
    typeof options.toolCallId === 'string' &&
    options.toolCallId.trim() !== ''
  ) {
    return options.toolCallId.trim().slice(0, 100);
  }
  return `search-${crypto.randomUUID()}`;
}

function recordScores(metrics: TurnMetrics, chunks: readonly RetrievedChunk[]): void {
  const scoreKeys = ['dense', 'lexical', 'fusion', 'reranker'] as const satisfies readonly RetrievalSignal[];
  for (const chunk of chunks) {
    for (const signal of scoreKeys) {
      const value = chunk.scores[signal];
      if (value === undefined) continue;
      const previous = metrics.maxRetrievalScores[signal];
      if (previous === undefined || value > previous) metrics.maxRetrievalScores[signal] = value;
    }
  }
}

function estimatedTokens(chunks: readonly RetrievedChunk[]): number {
  return chunks.reduce((total, chunk) => total + Math.ceil(formatGroundingReference(chunk).length / 4), 0);
}

function executedQueries(queries: readonly string[]): Array<{ queryId: string; query: string }> {
  return queries.map((query, index) => ({ queryId: `q-${index + 1}`, query }));
}

function toToolItems(
  chunks: readonly RetrievedChunk[],
  subquestionId: string,
  executedQueryId: string,
): SearchToolItem[] {
  return chunks.map((chunk) => ({
    id: chunk.id,
    ...(chunk.chunkUid ? { chunkUid: chunk.chunkUid } : {}),
    documentId: chunk.documentId,
    chunkIndex: chunk.chunkIndex,
    subquestionId,
    executedQueryIds: [executedQueryId],
    content: formatGroundingReference(chunk),
    source: chunk.source,
    ...(chunk.title ? { documentTitle: chunk.title } : {}),
    ...(chunk.sectionTitle ? { section: chunk.sectionTitle } : {}),
    scores: chunk.scores,
  }));
}

function validatedToolResult(result: SearchToolResult): SearchToolResult {
  return searchToolResultSchema.parse(result);
}

function errorSet(
  subquestionId: string,
  requestedQuery: string,
  attemptedQueries: string[],
  failure: SearchFailure,
): SearchSubquestionResult {
  return {
    kind: 'error',
    subquestionId,
    requestedQuery,
    attemptedQueries,
    code: failure.code,
    retryable: failure.retryable,
    userSafeMessage: failure.userSafeMessage,
  };
}

function buildChatTools(deps: ChatTurnDeps, opts: {
  cfg: AppConfig;
  effectiveMode: 'agentic' | 'normal';
  userId: string;
  request: Request;
  groundingEvidence: GroundingEvidence;
  outOfDomainRef: { value: boolean };
  isEmptyRef: { value: boolean };
  resultStateRef: { value: AgenticResultState | null };
  metrics: TurnMetrics;
  prefetched?: PrefetchedSearchOutcome | undefined;
}) {
  const {
    cfg,
    effectiveMode,
    userId,
    request,
    groundingEvidence,
    outOfDomainRef,
    isEmptyRef,
    resultStateRef,
    metrics,
    prefetched,
  } = opts;
  let ticketOpenedInTurn = false;
  let searchInfrastructureFailed =
    prefetched?.kind === 'error' ||
    (prefetched?.kind === 'results' && prefetched.degradedBy.length > 0);
  let prefetchedConsumed = false;
  let prefetchQueryChanged = false;

  return {
    searchDocumentation: deps.ai.tool({
      description:
        "Search the org documentation for evidence relevant to the user's question. Returns a structured result with independently typed results, no-match, or infrastructure-error states. Results are ordered by final rank and include score provenance; scores from different retrieval methods are not interchangeable percentages. Call this tool whenever an answer needs official documentation. You may call it again with a distinct reformulation after a genuine no-match. Do not treat an error as no documentation and do not open a ticket because search infrastructure failed.",
      inputSchema: searchDocumentationInputSchema,
      outputSchema: searchToolResultSchema,
      execute: async ({ query, limit }, options) => {
        const callId = toolCallId(options);
        const subquestionId = 'sq-1';
        const requestedLimit = limit ?? DEFAULT_TOOL_RESULT_LIMIT;
        const t0 = performance.now();
        const canReusePrefetch =
          !prefetchedConsumed &&
          prefetched !== undefined &&
          prefetched.query.trim().toLocaleLowerCase() === query.trim().toLocaleLowerCase();

        let matches: RetrievedChunk[];
        let degradation: readonly SearchDegradation[] = [];
        let attempts = [query];
        let resultQuery = query;
        let retrievalDiagnostics: RetrievalDiagnostics | undefined;

        if (canReusePrefetch) {
          prefetchedConsumed = true;
          metrics.prefetchStatus = 'exact_match_reused';
          if (prefetched.kind === 'error') {
            resultStateRef.value = 'error';
            return validatedToolResult({
              callId,
              sets: [errorSet(subquestionId, query, [query], prefetched.failure)],
              uniqueEvidenceAdded: 0,
              evidenceTokensAdded: 0,
              truncatedBy: [],
            });
          }
          if (prefetched.kind === 'no_match') {
            if (groundingEvidence.documents.length === 0) {
              outOfDomainRef.value = true;
              isEmptyRef.value = true;
            }
            resultStateRef.value = 'no_match';
            return validatedToolResult({
              callId,
              sets: [{
                kind: 'no_match',
                subquestionId,
                requestedQuery: query,
                attemptedQueries: [query],
                reason: 'no_relevant_evidence',
                ticketEligible: true,
              }],
              uniqueEvidenceAdded: 0,
              evidenceTokensAdded: 0,
              truncatedBy: [],
            });
          }
          const truncated = prefetched.matches.length > requestedLimit;
          matches = prefetched.matches.slice(0, requestedLimit);
          degradation = prefetched.degradedBy;
          resultStateRef.value = degradation.length > 0 ? 'degraded' : 'results';
          const queries = executedQueries(attempts);
          const set: SearchSubquestionResult = {
            kind: 'results',
            subquestionId,
            requestedQuery: query,
            executedQueries: queries,
            results: toToolItems(matches, subquestionId, queries[0]!.queryId),
            coverage: degradation.length > 0 ? 'partial' : 'sufficient',
            hasMore: truncated,
            degradedBy: [...degradation],
          };
          return validatedToolResult({
            callId,
            sets: [set],
            uniqueEvidenceAdded: 0,
            evidenceTokensAdded: 0,
            truncatedBy: truncated ? ['call_result_limit'] : [],
          });
        }

        if (prefetched !== undefined && !prefetchQueryChanged) {
          prefetchQueryChanged = true;
          metrics.prefetchStatus = 'query_changed';
          metrics.reformulationCount += 1;
        }

        if (effectiveMode === 'agentic') {
          const result = await deps.agenticSearch(cfg, query, {
            limit: requestedLimit,
            signal: request.signal,
            excludeChunkIdentities: groundingEvidence.seenChunkKeys,
          });
          metrics.retrieveMs += Math.round(performance.now() - t0);
          if (!result.ok) {
            logger.error('Agentic retrieval failed', { code: result.error.code });
            searchInfrastructureFailed = true;
            resultStateRef.value = 'error';
            metrics.searchResultStates.push('error');
            attempts = result.error.attemptedQueries?.length
              ? [...result.error.attemptedQueries]
              : attempts;
            return validatedToolResult({
              callId,
              sets: [errorSet(subquestionId, query, attempts, result.error)],
              uniqueEvidenceAdded: 0,
              evidenceTokensAdded: 0,
              truncatedBy: [],
            });
          }
          attempts = result.value.attemptedQueries;
          resultQuery = result.value.resultQuery ?? attempts.at(-1) ?? query;
          degradation = result.value.degradedBy;
          retrievalDiagnostics = result.value.retrievalDiagnostics?.at(-1);
          if (deps.traceEnabled) {
            logger.info('rag.retrieve', {
              mode: 'agentic',
              ms: performance.now() - t0,
              hits: result.value.chunks.length,
              resultState: result.value.resultState,
              diagnostics: retrievalDiagnostics,
            });
          }
          if (result.value.rewrittenQuery && result.value.rewrittenQuery !== query) {
            metrics.rewritten = true;
            metrics.reformulationCount += 1;
          }
          matches = result.value.chunks.slice(0, requestedLimit);
        } else {
          const result = await deps.searchChunks(cfg, query, {
            limit: requestedLimit,
            signal: request.signal,
            excludeChunkIdentities: groundingEvidence.seenChunkKeys,
          });
          metrics.retrieveMs += Math.round(performance.now() - t0);
          if (!result.ok) {
            logger.error('RAG retrieval failed', { code: result.error.code });
            searchInfrastructureFailed = true;
            resultStateRef.value = 'error';
            metrics.searchResultStates.push('error');
            return validatedToolResult({
              callId,
              sets: [errorSet(subquestionId, query, attempts, result.error)],
              uniqueEvidenceAdded: 0,
              evidenceTokensAdded: 0,
              truncatedBy: [],
            });
          }
          if (deps.traceEnabled) {
            logger.info('rag.retrieve', {
              mode: 'vector',
              ms: performance.now() - t0,
              hits: result.value.chunks.length,
              degradedBy: result.value.degradedBy,
              diagnostics: result.value.diagnostics,
            });
          }
          matches = result.value.chunks.slice(0, requestedLimit);
          degradation = result.value.degradedBy;
          retrievalDiagnostics = result.value.diagnostics;
        }

        recordScores(metrics, matches);
        const uniqueMatches = addGroundingEvidence(groundingEvidence, matches);
        metrics.hitCount = (metrics.hitCount ?? 0) + uniqueMatches.length;

        if (degradation.length > 0) searchInfrastructureFailed = true;
        if (matches.length === 0 && degradation.length > 0) {
          const code = degradation.every((item) => item === 'reranker_unavailable')
            ? 'reranker_unavailable'
            : 'retrieval_unavailable';
          const failure = new SearchFailure(
            code,
            true,
            'The documentation search is temporarily unavailable. Please try again.',
          );
          resultStateRef.value = 'error';
          metrics.searchResultStates.push('error');
          return validatedToolResult({
            callId,
            sets: [errorSet(subquestionId, query, attempts, failure)],
            uniqueEvidenceAdded: 0,
            evidenceTokensAdded: 0,
            truncatedBy: [],
          });
        }

        if (matches.length === 0 || uniqueMatches.length === 0) {
          const filteredDuplicates = matches.length > 0;
          const state: AgenticResultState = filteredDuplicates ? 'degraded' : 'no_match';
          resultStateRef.value = state;
          metrics.searchResultStates.push(state);
          if (!filteredDuplicates && groundingEvidence.documents.length === 0) {
            outOfDomainRef.value = true;
            isEmptyRef.value = true;
          }
          const set: SearchSubquestionResult = {
            kind: 'no_match',
            subquestionId,
            requestedQuery: query,
            attemptedQueries: attempts,
            reason: filteredDuplicates ? 'filtered_duplicates' : 'no_relevant_evidence',
            ticketEligible: !filteredDuplicates,
          };
          return validatedToolResult({
            callId,
            sets: [set],
            uniqueEvidenceAdded: 0,
            evidenceTokensAdded: 0,
            truncatedBy: [],
          });
        }

        outOfDomainRef.value = false;
        isEmptyRef.value = false;
        const state: AgenticResultState = degradation.length > 0 ? 'degraded' : 'results';
        resultStateRef.value = state;
        metrics.searchResultStates.push(state);
        const queries = executedQueries(attempts);
        const resultQueryIndex = Math.max(0, attempts.lastIndexOf(resultQuery));
        const set: SearchSubquestionResult = {
          kind: 'results',
          subquestionId,
          requestedQuery: query,
          executedQueries: queries,
          results: toToolItems(uniqueMatches, subquestionId, queries[resultQueryIndex]!.queryId),
          coverage: degradation.length > 0 ? 'partial' : 'sufficient',
          hasMore: retrievalDiagnostics?.hasMore ?? false,
          degradedBy: [...degradation],
        };
        return validatedToolResult({
          callId,
          sets: [set],
          uniqueEvidenceAdded: uniqueMatches.length,
          evidenceTokensAdded: estimatedTokens(uniqueMatches),
          truncatedBy: retrievalDiagnostics?.hasMore ? ['call_result_limit'] : [],
        });
      },
    }),
    createKnowledgeTicket: deps.ai.tool({
      description:
        'Open a knowledge ticket. Invoke this tool when a genuine documentation no-match is ticket-eligible or the user has explicitly asked to open one, file one, escalate, talk to a human, or submit a complaint. Never invoke it merely because documentation search returned an infrastructure error. When invoking, provide a structured `issue` summary with appropriate context so the reviewer can understand the full situation without reading the transcript: Product / Question / What was tried / Docs searched / User context.',
      inputSchema: z.object({
        name: z.string().describe("Ignored by the server — the signed-in user's name is used instead."),
        email: z
          .string()
          .regex(/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/)
          .describe("Ignored by the server — the signed-in user's email is used instead."),
        issue: z
          .string()
          .max(10_000)
          .describe(
            'Structured ticket summary in the form: Question: ...\nWhat was tried: ...\nDocs searched: ...\nUser context: ...',
          ),
      }),
      execute: async ({ issue }) => {
        if (searchInfrastructureFailed) {
          return {
            ticketId: null,
            status: 'error',
            message: 'A knowledge ticket cannot be created from a failed documentation search.',
          };
        }
        if (ticketOpenedInTurn) {
          return {
            ticketId: null,
            status: 'error',
            message: 'A knowledge ticket was already created in this turn.',
          };
        }
        ticketOpenedInTurn = true;
        const ticketLimit = await deps.rateLimit.check(`ticket:${userId}`, { limit: 1, windowMs: 5 * 60_000 });
        if (!ticketLimit.ok) {
          const retryAfterSec = Number.isFinite(ticketLimit.retryAfterMs)
            ? Math.ceil(ticketLimit.retryAfterMs / 1000)
            : undefined;
          return {
            ticketId: null,
            status: 'error',
            message:
              retryAfterSec !== undefined
                ? `Ticket creation is rate limited for this user; retry in about ${retryAfterSec} second${retryAfterSec === 1 ? '' : 's'}.`
                : 'Ticket creation is rate limited for this user.',
          };
        }
        const userProfile = await deps.userResolver(request);
        const realName = userProfile.name ?? 'User';
        const realEmail = userProfile.email ?? `${userId}@clerk.user`;
        const result = await deps.createTicket({
          userId,
          name: realName,
          email: realEmail,
          issue: sanitizeText(issue),
        });
        if (!result.ok) {
          logger.error('createKnowledgeTicket: createTicket failed', { error: result.error });
          return { ticketId: null, status: 'error' };
        }
        metrics.ticketCreated = true;
        metrics.ticketId = result.value.ticketId;
        return result.value;
      },
    }),
  };
}

export { buildChatTools };
export { searchDocumentationInputSchema };
export type { PrefetchedSearchOutcome };
