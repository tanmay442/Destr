import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@app/domain/app-config';
import type { AgenticResultState } from '@app/domain';
import { SearchFailure } from '../../rag/search/search-contract';
import type { RetrievedChunk } from '../../rag/search/search-types';
import { addGroundingEvidence, type GroundingEvidence } from '../../chat/grounding-evidence';
import type { TurnMetrics } from '../../chat/chat-turn/turn-types';
import type { PrefetchedSearchOutcome } from '../../chat/chat-turn/chat-tools';
import type {
  AgentToolContext,
  AgentTraceWriter,
  GroundingEvidenceCollector,
} from '../tool-contract';
import { createDefaultBudget } from '../tool-contract';
import {
  DEFAULT_TOOL_CAPABILITIES,
  type ModelToolCapabilities,
} from '../model-tool-capabilities';
import { createApprovalPolicyForTurn } from '../tool-approval';
import { createInMemoryTraceWriter } from '../tool-contract';
import { asUntypedTool, DefaultToolCatalog, TOOL_CATALOG_VERSION } from '../tool-catalog';
import {
  createSearchDocumentationTool,
  SEARCH_TOOL_NAME,
  type AgenticSearchFn,
  type SearchChunksFn,
} from '../tools/search-documentation';
import {
  createKnowledgeTicketTool,
  TICKET_TOOL_NAME,
  ticketToolOutputSchema,
} from '../tools/create-knowledge-ticket';
import { TurnToolLedger } from '../run-state';
import { serializeUntrustedChunk } from '../prompt/serialize-untrusted-result';
import { ToolPolicyError } from '../tool-policy-pipeline';

export interface CatalogCompatDeps {
  readonly searchChunks: SearchChunksFn;
  readonly agenticSearch: AgenticSearchFn;
  readonly createTicket: (input: {
    userId: string;
    name: string;
    email: string;
    issue: string;
  }) => Promise<{ ok: true; value: { ticketId: string; status: 'created' } } | { ok: false; error: unknown }>;
  readonly userResolver: (userId: string) => Promise<{ name?: string; email?: string }>;
  readonly rateLimit: {
    check(
      key: string,
      opts: { limit: number; windowMs: number },
    ): Promise<{ ok: true; remaining: number; resetMs: number } | { ok: false; retryAfterMs: number }>;
  };
  readonly toolFactory: (opts: {
    description: string;
    inputSchema: unknown;
    outputSchema: unknown;
    execute: (args: never, options: unknown) => Promise<unknown>;
  }) => unknown;
  readonly capabilities?: ModelToolCapabilities | undefined;
}

export interface CatalogCompatTurn {
  readonly cfg: AppConfig;
  readonly effectiveMode: 'agentic' | 'normal';
  readonly userId: string;
  readonly turnId: string;
  readonly lastUserText: string;
  readonly signal: AbortSignal;
  readonly groundingEvidence: GroundingEvidence;
  readonly metrics: TurnMetrics;
  readonly ledger: TurnToolLedger;
  readonly prefetched?: PrefetchedSearchOutcome | undefined;
  readonly enabledTools?: ReadonlySet<string> | undefined;
}

export interface CatalogCompatResult {
  readonly tools: Record<string, unknown>;
  readonly trace: AgentTraceWriter;
  readonly ledger: TurnToolLedger;
  readonly catalogVersion: string;
  readonly guidanceBlock: string;
}

function toolCallId(options: unknown): string {
  if (
    typeof options === 'object' &&
    options !== null &&
    'toolCallId' in options &&
    typeof (options as { toolCallId: unknown }).toolCallId === 'string' &&
    ((options as { toolCallId: string }).toolCallId.trim() !== '')
  ) {
    return (options as { toolCallId: string }).toolCallId.trim().slice(0, 100);
  }
  return `search-${randomUUID().slice(0, 8)}`;
}

function recordScores(metrics: TurnMetrics, chunks: readonly RetrievedChunk[]): void {
  const keys = ['dense', 'lexical', 'fusion', 'reranker'] as const;
  for (const chunk of chunks) {
    for (const signal of keys) {
      const value = chunk.scores[signal];
      if (value === undefined) continue;
      const previous = metrics.maxRetrievalScores[signal];
      if (previous === undefined || value > previous) metrics.maxRetrievalScores[signal] = value;
    }
  }
}

function toEvidenceCollector(groundingEvidence: GroundingEvidence): GroundingEvidenceCollector {
  return {
    get seenChunkKeys(): ReadonlySet<string> {
      return groundingEvidence.seenChunkKeys;
    },
    addEvidence(chunks) {
      const typed = chunks as readonly RetrievedChunk[];
      const unique = addGroundingEvidence(groundingEvidence, [...typed]);
      return unique;
    },
  };
}

export function isCatalogEnabled(env: { get(key: string): string | undefined }): boolean {
  const raw = env.get('TOOL_CATALOG_ENABLED');
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no') return false;
  return true;
}

export function buildCatalogToolsForTurn(deps: CatalogCompatDeps, turn: CatalogCompatTurn): CatalogCompatResult {
  const trace = createInMemoryTraceWriter();
  const approvals = createApprovalPolicyForTurn({
    lastUserText: turn.lastUserText,
    userId: turn.userId,
    turnId: turn.turnId,
  });
  const context: AgentToolContext = {
    actor: { userId: turn.userId },
    turnId: turn.turnId,
    signal: turn.signal,
    budget: createDefaultBudget({
      maxTotalToolCalls: 10,
      maxCallsByTool: { [SEARCH_TOOL_NAME]: 4, [TICKET_TOOL_NAME]: 1 },
    }),
    evidence: toEvidenceCollector(turn.groundingEvidence),
    trace,
    approvals,
  };
  const searchDefinition = createSearchDocumentationTool({
    searchChunks: deps.searchChunks,
    agenticSearch: deps.agenticSearch,
    cfg: turn.cfg,
    effectiveMode: turn.effectiveMode,
  });
  const ticketDefinition = createKnowledgeTicketTool({
    createTicket: deps.createTicket as never,
    userResolver: deps.userResolver,
    rateLimit: deps.rateLimit,
  });
  const catalog = new DefaultToolCatalog([asUntypedTool(searchDefinition), asUntypedTool(ticketDefinition)]);
  const enabledTools = turn.enabledTools ?? new Set([SEARCH_TOOL_NAME, TICKET_TOOL_NAME]);
  const built = catalog.buildForRun({
    context,
    capabilities: deps.capabilities ?? DEFAULT_TOOL_CAPABILITIES,
    enabledTools,
  });
  const ledger = turn.ledger;
  let ticketOpened = false;
  let searchInfrastructureFailed =
    turn.prefetched?.kind === 'error' ||
    (turn.prefetched?.kind === 'results' && turn.prefetched.degradedBy.length > 0);
  let prefetchedConsumed = false;
  let prefetchQueryChanged = false;
  const metrics = turn.metrics;

  const searchBuilt = built.tools.get(SEARCH_TOOL_NAME);
  const ticketBuilt = built.tools.get(TICKET_TOOL_NAME);

  function recordSearchOutcome(output: unknown, durationMs: number, requestedQuery?: string): void {
    const parsed = output as {
      sets?: Array<{ kind: string; requestedQuery?: string; attemptedQueries?: readonly string[]; executedQueries?: readonly { queryId: string; query: string }[] }>;
      uniqueEvidenceAdded?: number;
    };
    const firstKind = parsed.sets?.[0]?.kind;
    let resultState: AgenticResultState | null = null;
    let kind: 'success' | 'no_match' | 'error' | 'degraded' = 'success';
    if (firstKind === 'results') {
      const degraded = (parsed.sets?.[0] as { degradedBy?: readonly unknown[] })?.degradedBy;
      const isDegraded = Array.isArray(degraded) && degraded.length > 0;
      resultState = isDegraded ? 'degraded' : 'results';
      kind = isDegraded ? 'degraded' : 'success';
      if (isDegraded) searchInfrastructureFailed = true;
    } else if (firstKind === 'no_match') {
      const reason = (parsed.sets?.[0] as { reason?: string })?.reason;
      resultState = reason === 'filtered_duplicates' ? 'degraded' : 'no_match';
      kind = 'no_match';
    } else if (firstKind === 'error') {
      resultState = 'error';
      kind = 'error';
      searchInfrastructureFailed = true;
    }
    if (resultState) metrics.searchResultStates.push(resultState);
    try {
      const first = parsed.sets?.[0];
      const requested = requestedQuery ?? first?.requestedQuery;
      if (requested) {
        const executed = first?.executedQueries?.map((entry) => entry.query) ?? [];
        const attempted = first?.attemptedQueries ?? [];
        const candidates = executed.length > 0 ? executed : attempted;
        if (candidates.some((candidate) => candidate !== requested)) {
          metrics.rewritten = true;
          metrics.reformulationCount += 1;
        }
      }
    } catch {
      // Rewrite tracking is best-effort; retrieval outcome already recorded.
    }
    ledger.record({
      toolName: SEARCH_TOOL_NAME,
      callId: 'search',
      kind,
      resultState,
      ticketCreated: false,
      searchInfrastructureFailed,
      uniqueEvidenceAdded: typeof parsed.uniqueEvidenceAdded === 'number' ? parsed.uniqueEvidenceAdded : 0,
      durationMs,
    });
  }

  const tools: Record<string, unknown> = {};
  if (searchBuilt) {
    tools[SEARCH_TOOL_NAME] = deps.toolFactory({
      description: searchBuilt.description,
      inputSchema: searchDefinition.inputSchema,
      outputSchema: searchDefinition.outputSchema,
      execute: (async (args: never, options: unknown) => {
        const callId = toolCallId(options);
        const t0 = Date.now();
        const parsed = args as { query?: unknown; limit?: unknown };
        const query = typeof parsed.query === 'string' ? parsed.query : '';
        const limit = typeof parsed.limit === 'number' ? parsed.limit : undefined;
        const canReusePrefetch =
          !prefetchedConsumed &&
          turn.prefetched !== undefined &&
          turn.prefetched.query.trim().toLocaleLowerCase() === query.trim().toLocaleLowerCase();
        if (canReusePrefetch) {
          prefetchedConsumed = true;
          metrics.prefetchStatus = 'exact_match_reused';
          const prefetch = turn.prefetched as PrefetchedSearchOutcome;
          if (prefetch.kind === 'error') {
            ledger.record({
              toolName: SEARCH_TOOL_NAME,
              callId,
              kind: 'error',
              resultState: 'error',
              ticketCreated: false,
              searchInfrastructureFailed: true,
              uniqueEvidenceAdded: 0,
              durationMs: Math.max(0, Date.now() - t0),
            });
            searchInfrastructureFailed = true;
            return {
              callId,
              sets: [{
                kind: 'error',
                subquestionId: 'sq-1',
                requestedQuery: query,
                attemptedQueries: [query],
                code: prefetch.failure.code,
                retryable: prefetch.failure.retryable,
                userSafeMessage: prefetch.failure.userSafeMessage,
              }],
              uniqueEvidenceAdded: 0,
              evidenceTokensAdded: 0,
              truncatedBy: [],
            };
          }
          if (prefetch.kind === 'no_match') {
            ledger.record({
              toolName: SEARCH_TOOL_NAME,
              callId,
              kind: 'no_match',
              resultState: 'no_match',
              ticketCreated: false,
              searchInfrastructureFailed,
              uniqueEvidenceAdded: 0,
              durationMs: Math.max(0, Date.now() - t0),
            });
            return {
              callId,
              sets: [{
                kind: 'no_match',
                subquestionId: 'sq-1',
                requestedQuery: query,
                attemptedQueries: [query],
                reason: 'no_relevant_evidence',
                ticketEligible: true,
              }],
              uniqueEvidenceAdded: 0,
              evidenceTokensAdded: 0,
              truncatedBy: [],
            };
          }
          const requestedLimit = limit ?? 3;
          const truncated = prefetch.matches.length > requestedLimit;
          const matches = prefetch.matches.slice(0, requestedLimit);
          recordScores(metrics, matches);
          const state: AgenticResultState = prefetch.degradedBy.length > 0 ? 'degraded' : 'results';
          ledger.record({
            toolName: SEARCH_TOOL_NAME,
            callId,
            kind: state === 'degraded' ? 'degraded' : 'success',
            resultState: state,
            ticketCreated: false,
            searchInfrastructureFailed,
            uniqueEvidenceAdded: 0,
            durationMs: Math.max(0, Date.now() - t0),
          });
          const { executedQueries: _ignoredPrefetch } = { executedQueries: [] as Array<{ queryId: string; query: string }> };
          void _ignoredPrefetch;
          return {
            callId,
            sets: [{
              kind: 'results',
              subquestionId: 'sq-1',
              requestedQuery: query,
              executedQueries: [{ queryId: 'q-1', query }],
              results: matches.map((chunk) => ({
                id: chunk.id,
                ...(chunk.chunkUid ? { chunkUid: chunk.chunkUid } : {}),
                documentId: chunk.documentId,
                chunkIndex: chunk.chunkIndex,
                subquestionId: 'sq-1',
                executedQueryIds: ['q-1'],
                content: serializeUntrustedChunk({ content: chunk.content, source: chunk.source }),
                source: chunk.source,
                ...(chunk.title ? { documentTitle: chunk.title } : {}),
                ...(chunk.sectionTitle ? { section: chunk.sectionTitle } : {}),
                scores: chunk.scores,
              })),
              coverage: prefetch.degradedBy.length > 0 ? 'partial' : 'sufficient',
              hasMore: truncated,
              degradedBy: [...prefetch.degradedBy],
            }],
            uniqueEvidenceAdded: 0,
            evidenceTokensAdded: 0,
            truncatedBy: truncated ? ['call_result_limit'] : [],
          };
        }
        if (turn.prefetched !== undefined && !prefetchQueryChanged) {
          prefetchQueryChanged = true;
          metrics.prefetchStatus = 'query_changed';
          metrics.reformulationCount += 1;
        }
        const started = Date.now();
        metrics.retrieveMs += 0;
        try {
          const output = await searchBuilt.execute({ query, ...(limit !== undefined ? { limit } : {}) }, { callId, signal: turn.signal });
          const typed = output as { sets: Array<{ kind: string; results?: readonly RetrievedChunk[] }>; uniqueEvidenceAdded: number; evidenceTokensAdded: number };
          if (typed.sets[0]?.kind === 'results') {
            const results = (typed.sets[0] as { results: readonly { content: string }[] }).results;
            void results;
          }
          recordSearchOutcome(output, Math.max(0, Date.now() - started), query);
          const withScores = output as { sets: Array<{ kind: string; results?: Array<{ scores?: RetrievedChunk['scores'] }> }> };
          if (withScores.sets[0]?.kind === 'results') {
            const items = withScores.sets[0]?.results ?? [];
            for (const item of items) {
              if (!item.scores) continue;
              const scores = item.scores as unknown as Record<string, unknown>;
              for (const signal of ['dense', 'lexical', 'fusion', 'reranker'] as const) {
                const value = scores[signal];
                if (typeof value !== 'number' || !Number.isFinite(value)) continue;
                const previous = metrics.maxRetrievalScores[signal];
                if (previous === undefined || value > previous) metrics.maxRetrievalScores[signal] = value;
              }
            }
          }
          const uniqueAdded = (output as { uniqueEvidenceAdded?: number }).uniqueEvidenceAdded ?? 0;
          metrics.hitCount = (metrics.hitCount ?? 0) + uniqueAdded;
          return output;
        } catch (error) {
          if (error instanceof ToolPolicyError) throw error;
          if (error instanceof SearchFailure) throw error;
          throw error;
        } finally {
          metrics.retrieveMs += Math.max(0, Date.now() - started);
        }
      }) as never,
    });
  }
  if (ticketBuilt) {
    tools[TICKET_TOOL_NAME] = deps.toolFactory({
      description: ticketBuilt.description,
      inputSchema: ticketDefinition.inputSchema,
      outputSchema: ticketDefinition.outputSchema,
      execute: (async (args: never) => {
        if (searchInfrastructureFailed) {
          ledger.record({
            toolName: TICKET_TOOL_NAME,
            callId: 'ticket',
            kind: 'denied',
            resultState: null,
            ticketCreated: false,
            searchInfrastructureFailed: true,
            uniqueEvidenceAdded: 0,
            durationMs: 0,
          });
          return ticketToolOutputSchema.parse({
            ticketId: null,
            status: 'denied',
            message: 'A knowledge ticket cannot be created from a failed documentation search.',
          });
        }
        if (ticketOpened) {
          ledger.record({
            toolName: TICKET_TOOL_NAME,
            callId: 'ticket',
            kind: 'denied',
            resultState: null,
            ticketCreated: false,
            searchInfrastructureFailed,
            uniqueEvidenceAdded: 0,
            durationMs: 0,
          });
          return ticketToolOutputSchema.parse({
            ticketId: null,
            status: 'denied',
            message: 'A knowledge ticket was already created in this turn.',
          });
        }
        try {
          const output = await ticketBuilt.execute(args as unknown, { callId: `ticket-${turn.turnId}`, signal: turn.signal });
          const typed = output as { ticketId: string | null; status: string };
          if (typed.status === 'created' && typed.ticketId) {
            ticketOpened = true;
            metrics.ticketCreated = true;
            metrics.ticketId = typed.ticketId;
            ledger.record({
              toolName: TICKET_TOOL_NAME,
              callId: 'ticket',
              kind: 'success',
              resultState: null,
              ticketCreated: true,
              searchInfrastructureFailed,
              uniqueEvidenceAdded: 0,
              durationMs: 0,
            }, typed.ticketId);
          } else {
            ledger.record({
              toolName: TICKET_TOOL_NAME,
              callId: 'ticket',
              kind: typed.status === 'denied' ? 'denied' : 'error',
              resultState: null,
              ticketCreated: false,
              searchInfrastructureFailed,
              uniqueEvidenceAdded: 0,
              durationMs: 0,
            });
          }
          return output;
        } catch (error) {
          const kind = error instanceof ToolPolicyError
            ? error.kind
            : typeof error === 'object' && error !== null && 'kind' in error
              ? (error as { kind?: unknown }).kind
              : undefined;
          if (kind === 'denied' || kind === 'budget_exceeded') {
            ledger.record({
              toolName: TICKET_TOOL_NAME,
              callId: 'ticket',
              kind: 'denied',
              resultState: null,
              ticketCreated: false,
              searchInfrastructureFailed,
              uniqueEvidenceAdded: 0,
              durationMs: 0,
            });
            const rawMessage = error instanceof Error
              ? error.message
              : typeof error === 'object' && error !== null && 'message' in error && typeof (error as { message?: unknown }).message === 'string'
                ? (error as { message: string }).message
                : 'Ticket creation requires explicit user intent or approval.';
            return ticketToolOutputSchema.parse({
              ticketId: null,
              status: 'denied',
              message: rawMessage.slice(0, 500),
            });
          }
          throw error;
        }
      }) as never,
    });
  }
  return { tools, trace, ledger, catalogVersion: TOOL_CATALOG_VERSION, guidanceBlock: built.guidanceBlock };
}
