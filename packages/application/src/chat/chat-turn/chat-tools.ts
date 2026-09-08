import { logger, type AgenticResultState } from '@app/domain';
import {
  composeTicketIssue,
  createKnowledgeTicketInputSchema,
  TICKET_TOOL_DESCRIPTION,
  TICKET_TOOL_TIMEOUT_MS,
  ticketToolOutputSchema,
} from '../../agent/tools/create-knowledge-ticket';
import {
  SEARCH_TOOL_DESCRIPTION,
  searchDocumentationInputSchema,
} from '../../agent/tools/search-documentation';
import {
  sanitizeUntrustedMetadata,
  serializeUntrustedChunk,
} from '../../agent/prompt/serialize-untrusted-result';
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
import { TurnToolLedger } from '../../agent/run-state';
import { ToolPolicyError, withTimeout } from '../../agent/tool-policy-pipeline';

const DEFAULT_TOOL_RESULT_LIMIT = 3;

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

function toolCallSignal(options: { readonly abortSignal?: AbortSignal | undefined } | undefined, requestSignal: AbortSignal): AbortSignal {
  const callSignal = options?.abortSignal;
  if (callSignal === undefined || callSignal === requestSignal) return requestSignal;
  return AbortSignal.any([requestSignal, callSignal]);
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
    content: serializeUntrustedChunk({ content: chunk.content, source: chunk.source }),
    source: chunk.source === null ? null : sanitizeUntrustedMetadata(chunk.source),
    ...(chunk.title ? { documentTitle: sanitizeUntrustedMetadata(chunk.title) } : {}),
    ...(chunk.sectionTitle ? { section: sanitizeUntrustedMetadata(chunk.sectionTitle) } : {}),
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

function thrownSearchKind(error: unknown, signal: AbortSignal): 'error' | 'timeout' | 'cancelled' {
  const kind = typeof error === 'object' && error !== null && 'kind' in error
    ? (error as { kind?: unknown }).kind
    : undefined;
  if (kind === 'timeout') return 'timeout';
  if (kind === 'cancelled') return 'cancelled';
  if (error instanceof SearchFailure && error.code === 'timeout') return 'timeout';
  if (error instanceof SearchFailure && error.code === 'cancelled') return 'cancelled';
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
  if (error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message))) return 'cancelled';
  if (signal.aborted) return 'cancelled';
  return 'error';
}

function buildChatTools(deps: ChatTurnDeps, opts: {
  cfg: AppConfig;
  effectiveMode: 'agentic' | 'normal';
  userId: string;
  request: Request;
  groundingEvidence: GroundingEvidence;
  ledger: TurnToolLedger;
  metrics: TurnMetrics;
  prefetched?: PrefetchedSearchOutcome | undefined;
  signal?: AbortSignal | undefined;
  deadlineAt?: number | undefined;
}) {
  const {
    cfg,
    effectiveMode,
    userId,
    request,
    groundingEvidence,
    ledger,
    metrics,
    prefetched,
  } = opts;
  const turnSignal = opts.signal ?? request.signal;
  let ticketOpenedInTurn = false;
  let ticketOutcomeUnknown = false;
  let searchInfrastructureFailed =
    prefetched?.kind === 'error' ||
    (prefetched?.kind === 'results' && prefetched.degradedBy.length > 0);
  let prefetchedConsumed = false;
  let prefetchQueryChanged = false;

  return {
    searchDocumentation: deps.ai.tool({
      description: SEARCH_TOOL_DESCRIPTION,
      inputSchema: searchDocumentationInputSchema,
      outputSchema: searchToolResultSchema,
      execute: async ({ query, limit }, options) => {
        const callId = toolCallId(options);
        const callSignal = toolCallSignal(options, turnSignal);
        const subquestionId = 'sq-1';
        const requestedLimit = limit ?? DEFAULT_TOOL_RESULT_LIMIT;
        const t0 = performance.now();
        let thrownKind: 'error' | 'timeout' | 'cancelled' | null = null;
        let resultState: AgenticResultState | null = null;
        try {
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
            resultState = 'error';
            return validatedToolResult({
              callId,
              sets: [errorSet(subquestionId, query, [query], prefetched.failure)],
              uniqueEvidenceAdded: 0,
              evidenceTokensAdded: 0,
              truncatedBy: [],
            });
          }
          if (prefetched.kind === 'no_match') {

            resultState = 'no_match';
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
          resultState = degradation.length > 0 ? 'degraded' : 'results';
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
          let result: Awaited<ReturnType<ChatTurnDeps['agenticSearch']>>;
          try {
            result = await deps.agenticSearch(cfg, query, {
              limit: requestedLimit,
              signal: callSignal,
              excludeChunkIdentities: groundingEvidence.seenChunkKeys,
            });
          } catch (error) {
            searchInfrastructureFailed = true;
            resultState = 'error';
            throw error;
          }
          metrics.retrieveMs += Math.round(performance.now() - t0);
          if (!result.ok) {
            logger.error('Agentic retrieval failed', { code: result.error.code });
            searchInfrastructureFailed = true;
            resultState = 'error';
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
          let result: Awaited<ReturnType<ChatTurnDeps['searchChunks']>>;
          try {
            result = await deps.searchChunks(cfg, query, {
              limit: requestedLimit,
              signal: callSignal,
              excludeChunkIdentities: groundingEvidence.seenChunkKeys,
            });
          } catch (error) {
            searchInfrastructureFailed = true;
            resultState = 'error';
            throw error;
          }
          metrics.retrieveMs += Math.round(performance.now() - t0);
          if (!result.ok) {
            logger.error('RAG retrieval failed', { code: result.error.code });
            searchInfrastructureFailed = true;
            resultState = 'error';
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
          resultState = 'error';
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
          resultState = state;
          metrics.searchResultStates.push(state);

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

        const state: AgenticResultState = degradation.length > 0 ? 'degraded' : 'results';
        resultState = state;
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
        } catch (error) {
          searchInfrastructureFailed = true;
          resultState = 'error';
          thrownKind = thrownSearchKind(error, callSignal);
          metrics.searchResultStates.push('error');
          throw error;
        } finally {
          const state = resultState ?? 'error';
          const kind = thrownKind ?? (state === 'results'
            ? 'success'
            : state === 'no_match' ? 'no_match' : state);
          ledger.record({
            toolName: 'searchDocumentation',
            callId,
            kind,
            resultState: state,
            ticketCreated: false,
            searchInfrastructureFailed,
            uniqueEvidenceAdded: 0,
            durationMs: Math.max(0, performance.now() - t0),
          });
        }
      },
    }),
    createKnowledgeTicket: deps.ai.tool({
      description: TICKET_TOOL_DESCRIPTION,
      inputSchema: createKnowledgeTicketInputSchema,
      outputSchema: ticketToolOutputSchema,
      execute: async (rawInput, options) => {
        const callId = toolCallId(options);
        const startedAt = performance.now();
        const callSignal = toolCallSignal(options, turnSignal);
        let outcomeKind: 'success' | 'error' | 'denied' | 'cancelled' | 'timeout' | 'outcome_unknown' = 'error';
        let createdTicketId: string | null = null;
        try {
          if (callSignal.aborted) throw new DOMException('Ticket creation was cancelled.', 'AbortError');
          const parsed = createKnowledgeTicketInputSchema.safeParse(rawInput);
          if (!parsed.success) throw parsed.error;
          const ticketInput = parsed.data;
          if (searchInfrastructureFailed) {
            outcomeKind = 'denied';
            return ticketToolOutputSchema.parse({
              ticketId: null,
              status: 'denied',
              message: 'A knowledge ticket cannot be created from a failed documentation search.',
            });
          }
          if (ticketOutcomeUnknown) {
            outcomeKind = 'denied';
            return ticketToolOutputSchema.parse({
              ticketId: null,
              status: 'denied',
              message: 'A previous ticket request has an unknown outcome; do not retry it.',
            });
          }
          if (ticketOpenedInTurn) {
            outcomeKind = 'denied';
            return ticketToolOutputSchema.parse({
              ticketId: null,
              status: 'denied',
              message: 'A knowledge ticket was already created in this turn.',
            });
          }
          let userProfile: { name?: string; email?: string };
          try {
            userProfile = await deps.userResolver(request, { signal: callSignal });
          } catch {
            if (callSignal.aborted) throw new DOMException('Ticket creation was cancelled.', 'AbortError');
            return ticketToolOutputSchema.parse({ ticketId: null, status: 'error' });
          }
          if (callSignal.aborted) throw new DOMException('Ticket creation was cancelled.', 'AbortError');
          const realName = userProfile.name?.trim();
          const realEmail = userProfile.email?.trim();
          if (!realName || !realEmail || !realEmail.includes('@')) {
            return ticketToolOutputSchema.parse({ ticketId: null, status: 'error' });
          }
          const ticketLimit = await deps.rateLimit.check(`ticket:${userId}`, { limit: 1, windowMs: 5 * 60_000 }, callSignal);
          if (callSignal.aborted) throw new DOMException('Ticket creation was cancelled.', 'AbortError');
          if (!ticketLimit.ok) {
            outcomeKind = 'denied';
            const retryAfterSec = Number.isFinite(ticketLimit.retryAfterMs)
              ? Math.ceil(ticketLimit.retryAfterMs / 1000)
              : undefined;
            return ticketToolOutputSchema.parse({
              ticketId: null,
              status: 'denied',
              message:
                retryAfterSec !== undefined
                  ? `Ticket creation is rate limited for this user; retry in about ${retryAfterSec} second${retryAfterSec === 1 ? '' : 's'}.`
                  : 'Ticket creation is rate limited for this user.',
            });
          }
          let result: Awaited<ReturnType<ChatTurnDeps['createTicket']>>;
          try {
            result = await withTimeout(
              (signal) => deps.createTicket({
                userId,
                name: realName,
                email: realEmail,
                issue: composeTicketIssue(ticketInput),
              }, { signal }),
              TICKET_TOOL_TIMEOUT_MS,
              'createKnowledgeTicket',
              [callSignal],
              true,
              () => (opts.deadlineAt !== undefined ? Math.max(0, opts.deadlineAt - Date.now()) : undefined),
            );
          } catch (error) {
            if (error instanceof ToolPolicyError && error.kind === 'outcome_unknown') {
              ticketOutcomeUnknown = true;
              outcomeKind = 'outcome_unknown';
              return ticketToolOutputSchema.parse({
                ticketId: null,
                status: 'error',
                message: 'Ticket outcome is unknown; do not retry this request.',
              });
            }
            throw error;
          }
          if (callSignal.aborted && !result.ok) throw new DOMException('Ticket creation was cancelled.', 'AbortError');
          if (!result.ok) {
            logger.error('createKnowledgeTicket: createTicket failed', { error: result.error });
            return ticketToolOutputSchema.parse({ ticketId: null, status: 'error' });
          }
          outcomeKind = 'success';
          ticketOpenedInTurn = true;
          createdTicketId = result.value.ticketId;
          metrics.ticketCreated = true;
          metrics.ticketId = createdTicketId;
          return ticketToolOutputSchema.parse(result.value);
        } catch (error) {
          if (error instanceof ToolPolicyError) {
            if (error.kind === 'cancelled') outcomeKind = 'cancelled';
            else if (error.kind === 'timeout') outcomeKind = 'timeout';
            else if (error.kind === 'outcome_unknown') outcomeKind = 'outcome_unknown';
          } else if (callSignal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
            outcomeKind = 'cancelled';
          }
          throw error;
        } finally {
          ledger.record({
            toolName: 'createKnowledgeTicket',
            callId,
            kind: outcomeKind,
            resultState: null,
            ticketCreated: createdTicketId !== null,
            searchInfrastructureFailed,
            uniqueEvidenceAdded: 0,
            durationMs: Math.max(0, performance.now() - startedAt),
          }, createdTicketId);
        }
      },
    }),
  };
}

export { buildChatTools };
export { searchDocumentationInputSchema };
export type { PrefetchedSearchOutcome };
