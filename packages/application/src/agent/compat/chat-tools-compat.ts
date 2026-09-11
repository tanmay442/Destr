import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@app/domain/app-config';
import type { AgenticResultState } from '@app/domain';
import type { RetrievedChunk } from '../../rag/search/search-types';
import type { SearchDegradation, SearchFailure } from '../../rag/search';
import { addGroundingEvidence, type GroundingEvidence } from '../../chat/grounding-evidence';
import type { StructuredSearchOptions, TurnMetrics } from '../../chat/chat-turn/turn-types';
import type { BuiltToolInstance, BuiltToolSet } from '../tool-catalog';

export interface SearchUsage {
  readonly plansUsed: number;
  readonly physicalRetrievalsUsed: number;
  readonly uniqueEvidenceAdded: number;
  readonly evidenceTokensAdded: number;
}

export type PrefetchedSearchOutcome =
  | {
      kind: 'results';
      query: string;
      matches: RetrievedChunk[];
      degradedBy: readonly SearchDegradation[];
      usage?: SearchUsage | undefined;
    }
  | { kind: 'no_match'; query: string; usage?: SearchUsage | undefined }
  | { kind: 'error'; query: string; failure: SearchFailure; usage?: SearchUsage | undefined };
import type {
  AgentToolContext,
  AgentTraceWriter,
  GroundingEvidenceCollector,
  ToolExecuteCall,
  ToolApprovalPolicy,
} from '../tool-contract';
import { createAgentRunBudget, type AgentRunBudget } from '../agent-budget';
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
  type TicketRateLimiter,
  type TicketUserResolver,
  type TicketWriter,
} from '../tools/create-knowledge-ticket';
import { TurnToolLedger, type ToolCallOutcomeKind } from '../run-state';
import { sanitizeUntrustedMetadata, serializeUntrustedChunk } from '../prompt/serialize-untrusted-result';
import { ToolPolicyError } from '../tool-policy-pipeline';
import { readPlannerFlags } from '../search/search-flags';
import type { OrchestratorResult } from '../search/search-orchestrator';

export interface CatalogCompatDeps {
  readonly searchChunks: SearchChunksFn;
  readonly agenticSearch: AgenticSearchFn;
  readonly structuredSearch?: (
    cfg: AppConfig,
    query: string,
    opts?: StructuredSearchOptions,
  ) => Promise<OrchestratorResult>;
  readonly createTicket: TicketWriter;
  readonly userResolver: TicketUserResolver;
  readonly rateLimit: TicketRateLimiter;
  readonly toolFactory: (opts: {
    description: string;
    inputSchema: unknown;
    outputSchema: unknown;
    inputExamples?: readonly { readonly input: unknown }[];
    strict?: boolean;
    execute: (args: unknown, options: unknown) => Promise<unknown>;
  }) => unknown;
  readonly capabilities?: ModelToolCapabilities | undefined;
}

export interface CatalogCompatInternalToolContext {
  readonly userId: string;
  readonly turnId: string;
  readonly approvalToken?: string | undefined;
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
  /** The immutable budget created by chatTurn for this request. */
  readonly budget?: AgentRunBudget | undefined;
  /** Remaining turn budget in ms for direct compatibility callers without a budget. */
  readonly budgetDeadlineInMs?: number | undefined;
  /** Retrieval already spent before tools run (e.g. first-turn prefetch). */
  readonly initialPlansUsed?: number | undefined;
  readonly initialPhysicalUsed?: number | undefined;
  readonly initialUniqueEvidenceUsed?: number | undefined;
  readonly initialTokensUsed?: number | undefined;
  /** A request-owned context; never take approval credentials from model-visible arguments. */
  readonly internalToolContext?: CatalogCompatInternalToolContext | undefined;
  readonly approvals?: ToolApprovalPolicy | undefined;
}

export interface CatalogCompatToolEnvelope {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: BuiltToolInstance['inputSchema'];
  readonly outputSchema: BuiltToolInstance['outputSchema'];
  readonly inputExamples?: readonly { readonly input: unknown }[] | undefined;
  readonly strict?: boolean | undefined;
  readonly internalToolContext?: CatalogCompatInternalToolContext | undefined;
  execute(args: unknown, options?: CatalogCompatExecutionOptions): Promise<unknown>;
}

export interface CatalogCompatExecutionOptions {
  readonly toolCallId?: string | undefined;
  readonly abortSignal?: AbortSignal | undefined;
  readonly approvalToken?: string | undefined;
  readonly experimental_context?: CatalogCompatInternalToolContext | undefined;
}

export interface CatalogCompatResult {
  readonly tools: Record<string, unknown>;
  readonly executionTools: Record<string, CatalogCompatToolEnvelope>;
  readonly trace: AgentTraceWriter;
  readonly ledger: TurnToolLedger;
  readonly catalogVersion: string;
  readonly guidanceBlock: string;
  /**
   * Inner catalog set (request-scoped tool instances with policy wrappers).
   * The SupportAgent loop drives these instances; the `tools` record above
   * carries the same instances in provider-tool envelopes for the model.
   */
  readonly built: BuiltToolSet;
}

interface ParsedToolExecutionOptions {
  readonly callId: string;
  readonly signal: AbortSignal;
  readonly approvalToken?: string | undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof AbortSignal !== 'undefined' && value instanceof AbortSignal;
}

function combineSignals(primary: AbortSignal, secondary: AbortSignal | undefined): AbortSignal {
  if (secondary === undefined || primary === secondary) return primary;
  if (primary.aborted) return primary;
  if (secondary.aborted) return secondary;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([primary, secondary]);
  const controller = new AbortController();
  const forward = (source: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  primary.addEventListener('abort', () => forward(primary), { once: true });
  secondary.addEventListener('abort', () => forward(secondary), { once: true });
  return controller.signal;
}

function validatedApprovalToken(
  options: Readonly<Record<string, unknown>> | undefined,
  turn: CatalogCompatTurn,
): string | undefined {
  const internal = turn.internalToolContext;
  if (internal === undefined) return undefined;
  if (internal.userId !== turn.userId || internal.turnId !== turn.turnId) return undefined;
  if (options?.experimental_context !== undefined && options.experimental_context !== internal) return undefined;
  const requestedToken = options?.approvalToken;
  if (typeof requestedToken === 'string' && requestedToken.trim() !== '') return requestedToken.trim();
  const token = internal.approvalToken;
  return typeof token === 'string' && token.trim() !== '' ? token.trim() : undefined;
}

function parseToolExecutionOptions(
  options: unknown,
  turn: CatalogCompatTurn,
  fallbackPrefix: string,
): ParsedToolExecutionOptions {
  const record = isRecord(options) ? options : undefined;
  const rawCallId = record?.toolCallId;
  const callId = typeof rawCallId === 'string' && rawCallId.trim() !== ''
    ? rawCallId.trim().slice(0, 100)
    : `${fallbackPrefix}-${randomUUID().slice(0, 8)}`;
  const signal = combineSignals(turn.signal, isAbortSignal(record?.abortSignal) ? record.abortSignal : undefined);
  const approvalToken = validatedApprovalToken(record, turn);
  return { callId, signal, ...(approvalToken !== undefined ? { approvalToken } : {}) };
}

function toToolExecuteCall(options: ParsedToolExecutionOptions): ToolExecuteCall {
  return {
    callId: options.callId,
    signal: options.signal,
    ...(options.approvalToken !== undefined ? { approvalToken: options.approvalToken } : {}),
  };
}

function thrownSearchKind(error: unknown, signal: AbortSignal): Extract<ToolCallOutcomeKind, 'error' | 'timeout' | 'cancelled'> {
  const candidate = error instanceof ToolPolicyError
    ? error.kind
    : isRecord(error) && typeof error.kind === 'string'
      ? error.kind
      : undefined;
  if (candidate === 'timeout') return 'timeout';
  if (candidate === 'cancelled' || signal.aborted) return 'cancelled';
  return 'error';
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

/**
 * @deprecated The chat path always uses SupportAgent. This legacy probe no
 * longer selects an execution path.
 */
export function isCatalogEnabled(env: { get(key: string): string | undefined }): boolean {
  const raw = env.get('TOOL_CATALOG_ENABLED');
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no') return false;
  return true;
}

function readNonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function physicalRetrievalsFromDiagnostics(value: unknown): number {
  if (!isRecord(value)) return 0;
  let count = 0;
  for (const key of ['dense', 'lexical']) {
    const stage = value[key];
    if (!isRecord(stage)) continue;
    const status = stage.status;
    if (typeof status === 'string' && status !== 'not_run') count += 1;
  }
  return count;
}

function exhaustedOrchestratorResult(
  query: string,
  input: {
    plansUsed: number;
    physicalRetrievalsUsed: number;
    uniqueEvidenceUsed: number;
    evidenceTokensUsed: number;
    maxSearchPlans: number;
    maxPhysicalRetrievals: number;
    maxUniqueEvidenceChunks: number;
    maxEvidenceTokens: number;
    reason: 'turn_token_limit' | 'physical_retrieval_ceiling';
  },
): OrchestratorResult {
  return {
    sets: [{
      kind: 'error',
      subquestionId: 'sq-1',
      requestedQuery: query,
      attemptedQueries: [query],
      code: 'retrieval_unavailable',
      retryable: false,
      userSafeMessage: 'The documentation search budget for this turn is exhausted.',
    }],
    stopReason: input.reason,
    plansUsed: 0,
    physicalRetrievalsUsed: 0,
    isFallback: false,
    fallbackReason: null,
    budgets: {
      plans: {
        consumed: input.plansUsed,
        limit: input.maxSearchPlans,
        remaining: Math.max(0, input.maxSearchPlans - input.plansUsed),
      },
      physicalRetrievals: {
        consumed: input.physicalRetrievalsUsed,
        limit: input.maxPhysicalRetrievals,
        remaining: Math.max(0, input.maxPhysicalRetrievals - input.physicalRetrievalsUsed),
      },
      uniqueChunks: {
        consumed: input.uniqueEvidenceUsed,
        limit: input.maxUniqueEvidenceChunks,
        remaining: Math.max(0, input.maxUniqueEvidenceChunks - input.uniqueEvidenceUsed),
      },
      evidenceTokens: {
        consumed: input.evidenceTokensUsed,
        limit: input.maxEvidenceTokens,
        remaining: Math.max(0, input.maxEvidenceTokens - input.evidenceTokensUsed),
      },
    },
    uniqueEvidenceCount: 0,
    evidenceTokens: 0,
    truncatedBy: input.reason === 'turn_token_limit' ? ['turn_token_limit'] : [],
    rawPackedBySubquestion: new Map(),
    chunkProvenance: new Map(),
  };
}

export function buildCatalogToolsForTurn(deps: CatalogCompatDeps, turn: CatalogCompatTurn): CatalogCompatResult {
  const trace = createInMemoryTraceWriter();
  const approvals = turn.approvals ?? createApprovalPolicyForTurn({
    lastUserText: turn.lastUserText,
    userId: turn.userId,
    turnId: turn.turnId,
  });
  const budget = turn.budget ?? createAgentRunBudget({
    nowMs: Date.now(),
    finalizeReserveMs: 0,
    ...(turn.budgetDeadlineInMs !== undefined ? { deadlineInMs: Math.max(0, turn.budgetDeadlineInMs) } : {}),
    overrides: {
      maxTotalToolCalls: 10,
      maxCallsByTool: { [SEARCH_TOOL_NAME]: 4, [TICKET_TOOL_NAME]: 1 },
    },
  });
  const context: AgentToolContext = {
    actor: { userId: turn.userId },
    turnId: turn.turnId,
    signal: turn.signal,
    budget,
    evidence: toEvidenceCollector(turn.groundingEvidence),
    trace,
    approvals,
  };
  const plannerFlags = readPlannerFlags({ get: (key: string) => process.env[key] });
  let sharedPlansUsed = Math.max(0, turn.initialPlansUsed ?? 0);
  let sharedPhysicalUsed = Math.max(0, turn.initialPhysicalUsed ?? 0);
  let sharedUniqueEvidenceUsed = Math.max(0, turn.initialUniqueEvidenceUsed ?? 0);
  let sharedTokensUsed = Math.max(0, turn.initialTokensUsed ?? 0);
  let chain: Promise<void> = Promise.resolve();
  const workDeadlineAt = budget.deadlineAt - budget.finalizeReserveMs;
  let lastStructuredResult: OrchestratorResult | null = null;
  let lastSearchExecutionUsage: SearchUsage | null = null;
  const structuredSearch = deps.structuredSearch;
  const searchDefinition = createSearchDocumentationTool({
    searchChunks: async (cfg, query, opts) => {
      const result = await deps.searchChunks(cfg, query, opts);
      lastStructuredResult = null;
      lastSearchExecutionUsage = {
        plansUsed: 0,
        physicalRetrievalsUsed: result.ok ? physicalRetrievalsFromDiagnostics(result.value.diagnostics) : 0,
        uniqueEvidenceAdded: 0,
        evidenceTokensAdded: 0,
      };
      return result;
    },
    agenticSearch: async (cfg, query, opts) => {
      const result = await deps.agenticSearch(cfg, query, opts);
      lastStructuredResult = null;
      lastSearchExecutionUsage = {
        plansUsed: 0,
        physicalRetrievalsUsed: result.ok
          ? result.value.retrievalDiagnostics.reduce((total, diagnostics) => total + physicalRetrievalsFromDiagnostics(diagnostics), 0)
          : 0,
        uniqueEvidenceAdded: 0,
        evidenceTokensAdded: 0,
      };
      return result;
    },
    cfg: turn.cfg,
    effectiveMode: turn.effectiveMode,
    ...(structuredSearch
      ? {
          structuredSearch: async (query: string, opts?: StructuredSearchOptions): Promise<OrchestratorResult> => {
            const isShadow = opts?.shadow === true;
            const remainingPhysical = budget.maxPhysicalRetrievals - sharedPhysicalUsed;
            const remainingTokens = budget.maxEvidenceTokens - sharedTokensUsed;
            const remainingPlans = budget.maxSearchPlans - sharedPlansUsed;
            const remainingUnique = budget.maxUniqueEvidenceChunks - sharedUniqueEvidenceUsed;
            if (!isShadow && (remainingPhysical <= 0 || remainingTokens <= 0 || remainingPlans <= 0 || remainingUnique <= 0)) {
              return exhaustedOrchestratorResult(query, {
                plansUsed: sharedPlansUsed,
                physicalRetrievalsUsed: sharedPhysicalUsed,
                uniqueEvidenceUsed: sharedUniqueEvidenceUsed,
                evidenceTokensUsed: sharedTokensUsed,
                maxSearchPlans: budget.maxSearchPlans,
                maxPhysicalRetrievals: budget.maxPhysicalRetrievals,
                maxUniqueEvidenceChunks: budget.maxUniqueEvidenceChunks,
                maxEvidenceTokens: budget.maxEvidenceTokens,
                reason: remainingTokens <= 0 ? 'turn_token_limit' : 'physical_retrieval_ceiling',
              });
            }
            const result = await structuredSearch(turn.cfg, query, {
              ...(opts ?? {}),
              deadlineAt: Math.min(opts?.deadlineAt ?? workDeadlineAt, workDeadlineAt),
              ...(isShadow ? {} : {
                budgets: {
                  maxSearchPlans: remainingPlans,
                  maxPhysicalRetrievals: remainingPhysical,
                  maxUniqueEvidenceChunks: remainingUnique,
                  maxEvidenceTokens: remainingTokens,
                  maxResultsPerSearchCall: budget.maxResultsPerSearchCall,
                  maxCandidatesPerModality: budget.maxCandidatesPerModality,
                  maxResultsPerSubquestion: budget.maxResultsPerSubquestion,
                  maxConcurrentRetrievals: budget.maxConcurrentRetrievals,
                  minQuotaPerSubquestion: 1,
                },
              }),
            });
            if (!isShadow) lastStructuredResult = result;
            return result;
          },
          plannerEnabled: plannerFlags.plannerEnabled,
          shadowEnabled: plannerFlags.shadowEnabled,
          query2docEnabled: plannerFlags.query2docEnabled,
        }
      : {}),
  });
  const ticketDefinition = createKnowledgeTicketTool({
    createTicket: deps.createTicket,
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
  let ticketOutcomeUnknown = false;
  let searchInfrastructureFailed =
    turn.prefetched?.kind === 'error' ||
    (turn.prefetched?.kind === 'results' && turn.prefetched.degradedBy.length > 0);
  let prefetchedConsumed = false;
  let prefetchQueryChanged = false;
  const metrics = turn.metrics;

  const searchBuilt = built.tools.get(SEARCH_TOOL_NAME);
  const ticketBuilt = built.tools.get(TICKET_TOOL_NAME);

  function readSearchUsage(value: unknown): SearchUsage {
    if (!isRecord(value)) {
      return { plansUsed: 0, physicalRetrievalsUsed: 0, uniqueEvidenceAdded: 0, evidenceTokensAdded: 0 };
    }
    return {
      plansUsed: readNonNegativeInt(value.plansUsed),
      physicalRetrievalsUsed: readNonNegativeInt(value.physicalRetrievalsUsed),
      uniqueEvidenceAdded: readNonNegativeInt(value.uniqueEvidenceAdded),
      evidenceTokensAdded: readNonNegativeInt(value.evidenceTokensAdded),
    };
  }

  function addSearchUsage(output: unknown, usage: SearchUsage): Record<string, unknown> {
    const record = isRecord(output) ? { ...output } : {};
    return {
      ...record,
      plansUsed: usage.plansUsed,
      physicalRetrievalsUsed: usage.physicalRetrievalsUsed,
      uniqueEvidenceAdded: usage.uniqueEvidenceAdded,
      evidenceTokensAdded: usage.evidenceTokensAdded,
    };
  }

  function recordSearchOutcome(output: unknown, usage: SearchUsage, durationMs: number, callId: string, requestedQuery?: string): void {
    const parsed = isRecord(output) ? output : {};
    const rawSets = parsed.sets;
    const sets = Array.isArray(rawSets)
      ? rawSets.filter((set): set is Readonly<Record<string, unknown>> => isRecord(set))
      : [];
    const hasError = sets.some((set) => set.kind === 'error');
    const hasDegradedResults = sets.some((set) => set.kind === 'results' && Array.isArray(set.degradedBy) && set.degradedBy.length > 0);
    const hasResults = sets.some((set) => set.kind === 'results');
    const hasNoMatch = sets.some((set) => set.kind === 'no_match');
    let resultState: AgenticResultState | null = null;
    let kind: 'success' | 'no_match' | 'error' | 'degraded' = 'success';
    if (hasError) {
      resultState = 'error';
      kind = 'error';
      searchInfrastructureFailed = true;
    } else if (hasDegradedResults) {
      resultState = 'degraded';
      kind = 'degraded';
      searchInfrastructureFailed = true;
    } else if (hasResults) {
      resultState = 'results';
      kind = 'success';
    } else if (hasNoMatch) {
      const firstNoMatch = sets.find((set) => set.kind === 'no_match');
      const reason = firstNoMatch?.reason;
      resultState = reason === 'filtered_duplicates' ? 'degraded' : 'no_match';
      kind = 'no_match';
    }
    if (resultState) metrics.searchResultStates.push(resultState);
    try {
      const first = sets[0];
      const requested = requestedQuery ?? (typeof first?.requestedQuery === 'string' ? first.requestedQuery : undefined);
      if (requested) {
        const executedEntries = Array.isArray(first?.executedQueries)
          ? first.executedQueries.filter(isRecord)
          : [];
        const executed = executedEntries
          .map((entry) => typeof entry.query === 'string' ? entry.query : '')
          .filter((query) => query !== '');
        const attempted = Array.isArray(first?.attemptedQueries)
          ? first.attemptedQueries.filter((query): query is string => typeof query === 'string')
          : [];
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
      callId,
      kind,
      resultState,
      ticketCreated: false,
      searchInfrastructureFailed,
      uniqueEvidenceAdded: usage.uniqueEvidenceAdded,
      durationMs,
    });
  }

  function recordSearchThrownOutcome(error: unknown, durationMs: number, callId: string, signal: AbortSignal): void {
    const kind = thrownSearchKind(error, signal);
    searchInfrastructureFailed = true;
    metrics.searchResultStates.push('error');
    ledger.record({
      toolName: SEARCH_TOOL_NAME,
      callId,
      kind,
      resultState: 'error',
      ticketCreated: false,
      searchInfrastructureFailed: true,
      uniqueEvidenceAdded: 0,
      durationMs,
    });
  }

  const tools: Record<string, unknown> = {};
  const executionTools: Record<string, CatalogCompatToolEnvelope> = {};
  if (searchBuilt) {
    const executeSearch = async (args: unknown, options: unknown): Promise<unknown> => {
      const execution = parseToolExecutionOptions(options, turn, SEARCH_TOOL_NAME);
      const { callId } = execution;
        const t0 = Date.now();
        const parsed = args as { query?: unknown; limit?: unknown };
        const query = typeof parsed.query === 'string' ? parsed.query : '';
        const limit = typeof parsed.limit === 'number' ? parsed.limit : undefined;
        const canReusePrefetch =
          !prefetchedConsumed &&
          !plannerFlags.plannerEnabled &&
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
              plansUsed: 0,
              physicalRetrievalsUsed: 0,
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
              plansUsed: 0,
              physicalRetrievalsUsed: 0,
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
                source: chunk.source === null ? null : sanitizeUntrustedMetadata(chunk.source),
                ...(chunk.title ? { documentTitle: sanitizeUntrustedMetadata(chunk.title) } : {}),
                ...(chunk.sectionTitle ? { section: sanitizeUntrustedMetadata(chunk.sectionTitle) } : {}),
                scores: chunk.scores,
              })),
              coverage: prefetch.degradedBy.length > 0 ? 'partial' : 'sufficient',
              hasMore: truncated,
              degradedBy: [...prefetch.degradedBy],
            }],
            plansUsed: 0,
            physicalRetrievalsUsed: 0,
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
        try {
          const runSearch = chain.then(() => {
            const remainingPhysical = budget.maxPhysicalRetrievals - sharedPhysicalUsed;
            const remainingTokens = budget.maxEvidenceTokens - sharedTokensUsed;
            const remainingUnique = budget.maxUniqueEvidenceChunks - sharedUniqueEvidenceUsed;
            const plannerExhausted = plannerFlags.plannerEnabled && sharedPlansUsed >= budget.maxSearchPlans;
            if (remainingPhysical <= 0 || remainingTokens <= 0 || remainingUnique <= 0 || plannerExhausted) {
              return {
                callId,
                sets: [{
                  kind: 'error' as const,
                  subquestionId: 'sq-1',
                  requestedQuery: query,
                  attemptedQueries: [query],
                  code: 'retrieval_unavailable' as const,
                  retryable: false,
                  userSafeMessage: 'The documentation search budget for this turn is exhausted.',
                }],
                plansUsed: 0,
                physicalRetrievalsUsed: 0,
                uniqueEvidenceAdded: 0,
                evidenceTokensAdded: 0,
                truncatedBy: remainingTokens <= 0 ? ['turn_token_limit' as const] : [],
              };
            }
            lastStructuredResult = null;
            lastSearchExecutionUsage = null;
            return searchBuilt.execute(
              { query, ...(limit !== undefined ? { limit } : {}) },
              toToolExecuteCall(execution),
            );
          });
          chain = runSearch.then(() => undefined, () => undefined);
          const output = await runSearch;
          const baseUsage = lastStructuredResult === null
            ? (lastSearchExecutionUsage ?? {
                plansUsed: 0,
                physicalRetrievalsUsed: 0,
                uniqueEvidenceAdded: 0,
                evidenceTokensAdded: 0,
              })
            : {
                plansUsed: lastStructuredResult.plansUsed,
                physicalRetrievalsUsed: lastStructuredResult.physicalRetrievalsUsed,
                uniqueEvidenceAdded: 0,
                evidenceTokensAdded: 0,
              };
          const rawUsage = readSearchUsage(output);
          const usage: SearchUsage = {
            plansUsed: baseUsage.plansUsed,
            physicalRetrievalsUsed: baseUsage.physicalRetrievalsUsed,
            uniqueEvidenceAdded: rawUsage.uniqueEvidenceAdded,
            evidenceTokensAdded: rawUsage.evidenceTokensAdded,
          };
          const enrichedOutput = addSearchUsage(output, usage);
          recordSearchOutcome(enrichedOutput, usage, Math.max(0, Date.now() - started), callId, query);
          sharedPlansUsed += usage.plansUsed;
          sharedPhysicalUsed += usage.physicalRetrievalsUsed;
          sharedUniqueEvidenceUsed += usage.uniqueEvidenceAdded;
          sharedTokensUsed += usage.evidenceTokensAdded;
          const withScores = isRecord(enrichedOutput) ? enrichedOutput : {};
          const rawOutputSets = withScores.sets;
          const outputSets = Array.isArray(rawOutputSets)
            ? rawOutputSets.filter((set): set is Readonly<Record<string, unknown>> => isRecord(set))
            : [];
          const firstSet = outputSets[0];
          if (firstSet?.kind === 'results' && Array.isArray(firstSet.results)) {
            for (const item of firstSet.results) {
              if (!isRecord(item) || !isRecord(item.scores)) continue;
              for (const signal of ['dense', 'lexical', 'fusion', 'reranker'] as const) {
                const value = item.scores[signal];
                if (typeof value !== 'number' || !Number.isFinite(value)) continue;
                const previous = metrics.maxRetrievalScores[signal];
                if (previous === undefined || value > previous) metrics.maxRetrievalScores[signal] = value;
              }
            }
          }
          metrics.hitCount = (metrics.hitCount ?? 0) + usage.uniqueEvidenceAdded;
          return enrichedOutput;
        } catch (error) {
          recordSearchThrownOutcome(error, Math.max(0, Date.now() - started), callId, execution.signal);
          throw error;
        } finally {
          metrics.retrieveMs += Math.max(0, Date.now() - started);
        }
    };
    tools[SEARCH_TOOL_NAME] = deps.toolFactory({
      description: searchBuilt.description,
      inputSchema: searchBuilt.inputSchema,
      outputSchema: searchBuilt.outputSchema,
      ...(searchBuilt.inputExamples !== undefined ? { inputExamples: searchBuilt.inputExamples } : {}),
      ...(searchBuilt.strict !== undefined ? { strict: searchBuilt.strict } : {}),
      execute: executeSearch,
    });
    executionTools[SEARCH_TOOL_NAME] = {
      name: SEARCH_TOOL_NAME,
      description: searchBuilt.description,
      inputSchema: searchBuilt.inputSchema,
      outputSchema: searchBuilt.outputSchema,
      ...(searchBuilt.inputExamples !== undefined ? { inputExamples: searchBuilt.inputExamples } : {}),
      ...(searchBuilt.strict !== undefined ? { strict: searchBuilt.strict } : {}),
      ...(turn.internalToolContext !== undefined ? { internalToolContext: turn.internalToolContext } : {}),
      execute: executeSearch,
    };
  }
  if (ticketBuilt) {
    const executeTicket = async (args: unknown, options: unknown): Promise<unknown> => {
      const execution = parseToolExecutionOptions(options, turn, TICKET_TOOL_NAME);
        const { callId } = execution;
        if (searchInfrastructureFailed) {
          ledger.record({
            toolName: TICKET_TOOL_NAME,
            callId,
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
        if (ticketOutcomeUnknown) {
          ledger.record({
            toolName: TICKET_TOOL_NAME,
            callId,
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
            message: 'A previous ticket request has an unknown outcome; do not retry it.',
          });
        }
        if (ticketOpened) {
          ledger.record({
            toolName: TICKET_TOOL_NAME,
            callId,
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
          const output = await ticketBuilt.execute(args as unknown, toToolExecuteCall(execution));
          const typed = output as { ticketId?: string | null; status?: string; message?: string };
          if (typed.status === 'created' && typed.ticketId) {
            ticketOpened = true;
            metrics.ticketCreated = true;
            metrics.ticketId = typed.ticketId;
            ledger.record({
              toolName: TICKET_TOOL_NAME,
              callId,
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
              callId,
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
          if (kind === 'outcome_unknown') {
            ticketOutcomeUnknown = true;
            ledger.record({
              toolName: TICKET_TOOL_NAME,
              callId,
              kind: 'outcome_unknown',
              resultState: null,
              ticketCreated: false,
              searchInfrastructureFailed,
              uniqueEvidenceAdded: 0,
              durationMs: 0,
            });
            return ticketToolOutputSchema.parse({
              ticketId: null,
              status: 'error',
              message: 'Ticket outcome is unknown; do not retry this request.',
            });
          }
          if (kind === 'denied' || kind === 'budget_exceeded') {
            ledger.record({
              toolName: TICKET_TOOL_NAME,
              callId,
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
          ledger.record({
            toolName: TICKET_TOOL_NAME,
            callId,
            kind: kind === 'timeout' ? 'timeout' : kind === 'cancelled' ? 'cancelled' : 'error',
            resultState: null,
            ticketCreated: false,
            searchInfrastructureFailed,
            uniqueEvidenceAdded: 0,
            durationMs: 0,
          });
          throw error;
        }
    };
    tools[TICKET_TOOL_NAME] = deps.toolFactory({
      description: ticketBuilt.description,
      inputSchema: ticketBuilt.inputSchema,
      outputSchema: ticketBuilt.outputSchema,
      ...(ticketBuilt.inputExamples !== undefined ? { inputExamples: ticketBuilt.inputExamples } : {}),
      ...(ticketBuilt.strict !== undefined ? { strict: ticketBuilt.strict } : {}),
      execute: executeTicket,
    });
    executionTools[TICKET_TOOL_NAME] = {
      name: TICKET_TOOL_NAME,
      description: ticketBuilt.description,
      inputSchema: ticketBuilt.inputSchema,
      outputSchema: ticketBuilt.outputSchema,
      ...(ticketBuilt.inputExamples !== undefined ? { inputExamples: ticketBuilt.inputExamples } : {}),
      ...(ticketBuilt.strict !== undefined ? { strict: ticketBuilt.strict } : {}),
      ...(turn.internalToolContext !== undefined ? { internalToolContext: turn.internalToolContext } : {}),
      execute: executeTicket,
    };
  }
  return { tools, executionTools, trace, ledger, catalogVersion: TOOL_CATALOG_VERSION, guidanceBlock: built.guidanceBlock, built };
}
