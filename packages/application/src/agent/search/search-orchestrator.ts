import { SearchFailure } from '../../rag/search/search-contract';
import type {
  RetrievedChunk,
  SearchDeps,
  SearchExecutionResult,
} from '../../rag/search/search-types';
import { searchChunks } from '../../rag/search/search-chunks';
import { stableChunkIdentities, stableChunkIdentity } from '../../rag/search/stable-chunk-identity';
import type { SearchDegradation } from '../../rag/search/search-contract';
import type { SearchSubquestionResult } from '../../rag/search/search-contract';
import {
  dedupeQueriesWithinSubquestion,
  createFallbackPlan,
  normalizeQueryForDedup,
  normalizeQueryText,
  type SearchPlan,
} from './search-plan';
import { createDeterministicPlan, resolvePlan, type PlannerFn, type PlannerInput } from './search-planner';
import {
  assessSubquestionQuality,
  type PriorAttemptFeedback,
  type PriorResultSummary,
  type QualityReasonCode,
} from './search-quality';
import { packEvidence } from './evidence-packer';
import {
  type BudgetConsumption,
  type SearchBudgetLimits,
  type SearchStopReason,
} from './search-budget';

export interface OrchestratorDeps {
  readonly search: SearchDeps;
  readonly similarityThreshold?: number | undefined;
  readonly rerankerThreshold?: number | undefined;
  readonly hybridEnabled?: boolean | undefined;
  readonly lexicalSearchMode?: 'content_plain' | 'weighted_websearch' | undefined;
  readonly filter?: { documentId?: number } | undefined;
  readonly mode?: 'parent' | 'window' | 'segment' | undefined;
  readonly parentChildWindow?: number | undefined;
  readonly rrfK?: number | undefined;
  readonly lexicalWeight?: number | undefined;
  readonly rsePenalty?: number | undefined;
  readonly rseMaxSegmentChunks?: number | undefined;
  readonly rseOverallMaxChunks?: number | undefined;
  readonly rseMinSegmentValue?: number | undefined;
}

export interface OrchestratorInput {
  readonly originalQuery: string;
  readonly callId: string;
  readonly requestedLimit: number;
  readonly signal: AbortSignal;
  readonly deadlineAt?: number | undefined;
  readonly budgets?: Partial<SearchBudgetLimits> | undefined;
  readonly planner?: PlannerFn | undefined;
  readonly conversationSummary?: string | undefined;
  readonly excludeChunkIdentities?: ReadonlySet<string> | undefined;
  readonly trace?: { write(event: { toolName: string; callId: string; phase: string; durationMs: number | null }): void } | undefined;
}

export interface OrchestratorResult {
  readonly sets: readonly SearchSubquestionResult[];
  readonly stopReason: SearchStopReason;
  readonly plansUsed: number;
  readonly physicalRetrievalsUsed: number;
  readonly isFallback: boolean;
  readonly fallbackReason: string | null;
  readonly budgets: Record<string, BudgetConsumption>;
  readonly uniqueEvidenceCount: number;
  readonly evidenceTokens: number;
  readonly truncatedBy: ReadonlyArray<
    'call_result_limit' | 'subquestion_result_limit' | 'turn_chunk_limit' | 'turn_token_limit'
  >;
  readonly rawPackedBySubquestion: ReadonlyMap<string, readonly RetrievedChunk[]>;
  readonly chunkProvenance: ReadonlyMap<string, { subquestionIds: readonly string[]; queryIds: readonly string[] }>;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Search orchestrator aborted');
}

function isCancellation(cause: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (cause instanceof SearchFailure && cause.code === 'cancelled') return true;
  if (cause instanceof Error) {
    return cause.name === 'AbortError' || /abort|cancel/i.test(cause.message);
  }
  return false;
}

function interruptionReason(signal: AbortSignal, cause: unknown): unknown {
  if (signal.aborted) return signal.reason;
  return cause;
}

function classifyAbort(signal: AbortSignal): {
  code: 'timeout' | 'cancelled';
  stopReason: 'timeout' | 'cancelled';
  userSafeMessage: string;
  retryable: boolean;
} {
  if (signal.reason instanceof Error && signal.reason.name === 'TimeoutError') {
    return {
      code: 'timeout',
      stopReason: 'timeout',
      userSafeMessage: 'The documentation search timed out. Please try again.',
      retryable: true,
    };
  }
  return {
    code: 'cancelled',
    stopReason: 'cancelled',
    userSafeMessage: 'The documentation search was cancelled.',
    retryable: false,
  };
}

function toFailureCode(cause: unknown, signal: AbortSignal): SearchFailure['code'] {
  if (cause instanceof SearchFailure) return cause.code;
  const interruption = interruptionReason(signal, cause);
  if (interruption instanceof Error && interruption.name === 'TimeoutError') return 'timeout';
  if (signal.aborted || isCancellation(cause, signal)) return 'cancelled';
  return 'retrieval_unavailable';
}

interface VariantExecution {
  readonly normalizedKey: string;
  readonly text: string;
  readonly subquestionId: string;
  readonly queryIds: readonly string[];
}

interface VariantOutcome {
  readonly key: string;
  readonly chunks: readonly RetrievedChunk[];
  readonly failure: SearchFailure | null;
  readonly duplicatesSkipped: number;
  readonly hasMore: boolean;
  readonly degradedBy: readonly SearchDegradation[];
}

async function runWithConcurrency<T>(
  tasks: readonly (() => Promise<T>)[],
  maxConcurrent: number,
  signal: AbortSignal,
  abortAll: (reason: unknown) => void,
): Promise<T[]> {
  const results: T[] = new Array<T>(tasks.length) as T[];
  let next = 0;
  const workers: Promise<void>[] = [];
  const workerCount = Math.max(1, Math.min(maxConcurrent, tasks.length));
  for (let worker = 0; worker < workerCount; worker += 1) {
    workers.push(
      (async () => {
        while (next < tasks.length) {
          if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Search orchestrator aborted');
          const index = next;
          next += 1;
          const task = tasks[index];
          if (!task) continue;
          results[index] = await task();
        }
      })(),
    );
  }
  const guarded = workers.map(async (worker) => {
    try {
      await worker;
    } catch (cause) {
      abortAll(cause);
      throw cause;
    }
  });
  const settled = await Promise.allSettled(guarded);
  const rejected = settled.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
  if (rejected) throw rejected.reason;
  return results;
}

const VARIANT_FUSION_RRF_K = 60;

function combineVariantsForSubquestion(input: {
  subquestionId: string;
  subquestionQuestion: string;
  variantOutcomes: readonly VariantOutcome[];
  queryIdByKey: ReadonlyMap<string, readonly string[]>;
}): { combined: RetrievedChunk[]; provenanceByKey: Map<string, string[]> } {
  const byStable = new Map<string, { chunk: RetrievedChunk; queryIds: Set<string>; fused: number }>();
  const identityToEntry = new Map<string, string>();
  for (const outcome of input.variantOutcomes) {
    const queryIds = input.queryIdByKey.get(outcome.key) ?? [];
    outcome.chunks.forEach((chunk, rank) => {
      const identities = stableChunkIdentities(chunk);
      const topKey = stableChunkIdentity(chunk);
      let entryKey: string | null = null;
      for (const identity of identities) {
        const mapped = identityToEntry.get(identity);
        if (mapped !== undefined) {
          entryKey = mapped;
          break;
        }
      }
      const contribution = 1 / (VARIANT_FUSION_RRF_K + rank + 1);
      if (entryKey !== null) {
        const existing = byStable.get(entryKey);
        if (existing) {
          for (const queryId of queryIds) existing.queryIds.add(queryId);
          existing.fused += contribution;
          for (const identity of identities) identityToEntry.set(identity, entryKey);
          return;
        }
      }
      byStable.set(topKey, { chunk, queryIds: new Set(queryIds), fused: contribution });
      for (const identity of identities) identityToEntry.set(identity, topKey);
    });
  }
  void input.subquestionId;
  void input.subquestionQuestion;
  const combined = [...byStable.entries()]
    .sort((a, b) => {
      if (a[1].fused !== b[1].fused) return b[1].fused - a[1].fused;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .map(([, entry], index) => ({
      ...entry.chunk,
      scores: { ...entry.chunk.scores, fusion: entry.fused, finalRank: index + 1, finalSignal: 'fusion' as const },
    }));
  const provenanceByKey = new Map<string, string[]>();
  for (const [key, entry] of byStable) provenanceByKey.set(key, [...entry.queryIds].sort());
  return { combined, provenanceByKey };
}

async function rerankOnceForSubquestion(input: {
  subquestionQuestion: string;
  combined: RetrievedChunk[];
  deps: OrchestratorDeps;
  signal: AbortSignal;
  topN: number;
}): Promise<{ ranked: RetrievedChunk[]; degraded: boolean }> {
  const reranker = input.deps.search.reranker;
  if (!reranker || input.combined.length === 0) return { ranked: input.combined, degraded: false };
  try {
    if (input.signal.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new Error('Search orchestrator aborted');
    const documents = input.combined.map((chunk) => chunk.content);
    const ranked = await reranker.rank(input.subquestionQuestion, documents, { signal: input.signal });
    throwIfAborted(input.signal);
    if (ranked.length !== input.combined.length) return { ranked: input.combined, degraded: true };
    const indices = new Set<number>();
    for (const item of ranked) {
      if (!Number.isInteger(item.index) || item.index < 0 || item.index >= input.combined.length) {
        return { ranked: input.combined, degraded: true };
      }
      if (!Number.isFinite(item.relevanceScore) || item.relevanceScore < 0 || item.relevanceScore > 1) {
        return { ranked: input.combined, degraded: true };
      }
      indices.add(item.index);
    }
    if (indices.size !== input.combined.length) return { ranked: input.combined, degraded: true };
    const threshold = input.deps.rerankerThreshold ?? 0.5;
    const ordered = [...ranked]
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .flatMap((entry) => {
        const chunk = input.combined[entry.index];
        return chunk ? [{ chunk, score: entry.relevanceScore }] : [];
      })
      .filter((entry) => entry.score >= threshold)
      .slice(0, input.topN)
      .map((entry, rank) => ({
        ...entry.chunk,
        scores: { ...entry.chunk.scores, reranker: entry.score, finalRank: rank + 1, finalSignal: 'reranker' as const },
      }));
    return { ranked: ordered, degraded: false };
  } catch (cause) {
    if (input.signal.aborted || isCancellation(cause, input.signal)) throw cause;
    return { ranked: input.combined, degraded: true };
  }
}

export async function runStructuredSearch(
  deps: OrchestratorDeps,
  input: OrchestratorInput,
): Promise<OrchestratorResult> {
  const runAbortController = new AbortController();
  const deadlineSignal = input.deadlineAt === undefined
    ? null
    : AbortSignal.timeout(Math.max(1, input.deadlineAt - Date.now()));
  const runSignal = AbortSignal.any([
    input.signal,
    runAbortController.signal,
    ...(deadlineSignal ? [deadlineSignal] : []),
  ]);
  const effectiveInput: OrchestratorInput = { ...input, signal: runSignal };
  const hardCallLimit = Math.max(1, Math.min(input.requestedLimit, 10));
  const limits: SearchBudgetLimits = {
    maxResultsPerSearchCall: Math.min(input.budgets?.maxResultsPerSearchCall ?? hardCallLimit, hardCallLimit),
    maxCandidatesPerModality: input.budgets?.maxCandidatesPerModality ?? 30,
    maxResultsPerSubquestion: Math.min(
      input.budgets?.maxResultsPerSubquestion ?? 3,
      Math.max(1, input.requestedLimit),
    ),
    maxSearchPlans: input.budgets?.maxSearchPlans ?? 2,
    maxPhysicalRetrievals: input.budgets?.maxPhysicalRetrievals ?? 24,
    maxConcurrentRetrievals: input.budgets?.maxConcurrentRetrievals ?? 4,
    maxUniqueEvidenceChunks: input.budgets?.maxUniqueEvidenceChunks ?? 30,
    maxEvidenceTokens: input.budgets?.maxEvidenceTokens ?? 8000,
    minQuotaPerSubquestion: input.budgets?.minQuotaPerSubquestion ?? 1,
  };
  const planner: PlannerFn = input.planner ?? (async (request: PlannerInput) => createDeterministicPlan(request));
  const seenKeys = input.excludeChunkIdentities ?? new Set<string>();

  const budgetView = (
    plansConsumed = 0,
    physicalConsumed = 0,
    uniqueConsumed = 0,
    tokenConsumed = 0,
  ): Record<string, BudgetConsumption> => {
    const snapshot: Record<string, BudgetConsumption> = {};
    snapshot.plans = {
      consumed: plansConsumed,
      limit: limits.maxSearchPlans,
      remaining: Math.max(0, limits.maxSearchPlans - plansConsumed),
    };
    snapshot.physicalRetrievals = {
      consumed: physicalConsumed,
      limit: limits.maxPhysicalRetrievals,
      remaining: Math.max(0, limits.maxPhysicalRetrievals - physicalConsumed),
    };
    snapshot.uniqueChunks = {
      consumed: uniqueConsumed,
      limit: limits.maxUniqueEvidenceChunks,
      remaining: Math.max(0, limits.maxUniqueEvidenceChunks - uniqueConsumed),
    };
    snapshot.evidenceTokens = {
      consumed: tokenConsumed,
      limit: limits.maxEvidenceTokens,
      remaining: Math.max(0, limits.maxEvidenceTokens - tokenConsumed),
    };
    return snapshot;
  };

  if (runSignal.aborted) {
    const abort = classifyAbort(runSignal);
    return {
      sets: [
        {
          kind: 'error',
          subquestionId: 'sq-1',
          requestedQuery: input.originalQuery,
          attemptedQueries: [input.originalQuery],
          code: abort.code,
          retryable: abort.retryable,
          userSafeMessage: abort.userSafeMessage,
        },
      ],
      stopReason: abort.stopReason,
      plansUsed: 0,
      physicalRetrievalsUsed: 0,
      isFallback: false,
      fallbackReason: null,
      budgets: budgetView(),
      uniqueEvidenceCount: 0,
      evidenceTokens: 0,
      truncatedBy: [],
      rawPackedBySubquestion: new Map(),
      chunkProvenance: new Map(),
    };
  }
  if (input.deadlineAt !== undefined && Date.now() > input.deadlineAt) {
    return {
      sets: [
        {
          kind: 'error',
          subquestionId: 'sq-1',
          requestedQuery: input.originalQuery,
          attemptedQueries: [input.originalQuery],
          code: 'timeout',
          retryable: true,
          userSafeMessage: 'The documentation search timed out. Please try again.',
        },
      ],
      stopReason: 'deadline_exceeded',
      plansUsed: 0,
      physicalRetrievalsUsed: 0,
      isFallback: false,
      fallbackReason: null,
      budgets: budgetView(),
      uniqueEvidenceCount: 0,
      evidenceTokens: 0,
      truncatedBy: [],
      rawPackedBySubquestion: new Map(),
      chunkProvenance: new Map(),
    };
  }

  const remainingMs = (): number | null =>
    input.deadlineAt === undefined ? null : Math.max(0, input.deadlineAt - Date.now());

  let plansUsed = 0;
  let physicalUsed = 0;
  let isFallback = false;
  let fallbackReason: string | null = null;
  const priorQuerySets: string[] = [];
  const priorResultSets: string[] = [];
  let priorFeedback: PriorAttemptFeedback[] = [];
  let lastPacked: Pick<
    OrchestratorResult,
    'sets' | 'budgets' | 'uniqueEvidenceCount' | 'evidenceTokens' | 'truncatedBy' | 'rawPackedBySubquestion' | 'chunkProvenance'
  > | null = null;

  let currentPlan: SearchPlan;
  throwIfAborted(runSignal);
  let resolved;
  try {
    resolved = await resolvePlan({
      planner,
      request: {
        originalQuery: input.originalQuery,
        ...(input.conversationSummary ? { conversationSummary: input.conversationSummary } : {}),
        priorAttempts: [],
        remainingPlans: limits.maxSearchPlans,
        remainingMs: remainingMs(),
        signal: runSignal,
      },
      originalQuery: input.originalQuery,
      ...(input.trace ? { trace: input.trace } : {}),
      callId: input.callId,
    });
  } catch {
    const abort = classifyAbort(runSignal);
    return {
      sets: errorSetsForPlan(createFallbackPlan(input.originalQuery), input.originalQuery, abort.code, abort.userSafeMessage, abort.retryable),
      stopReason: abort.stopReason,
      plansUsed,
      physicalRetrievalsUsed: physicalUsed,
      isFallback: false,
      fallbackReason: null,
      budgets: budgetView(),
      uniqueEvidenceCount: 0,
      evidenceTokens: 0,
      truncatedBy: [],
      rawPackedBySubquestion: new Map(),
      chunkProvenance: new Map(),
    };
  }
  currentPlan = resolved.plan;
  isFallback = resolved.isFallback;
  fallbackReason = resolved.fallbackReason;
  plansUsed += 1;

  if (currentPlan.intent === 'out_of_scope') {
    return {
      sets: currentPlan.subquestions.map((sub) => ({
        kind: 'no_match' as const,
        subquestionId: sub.subquestionId,
        requestedQuery: sub.question,
        attemptedQueries: [normalizeQueryText(input.originalQuery)],
        reason: 'out_of_scope' as const,
        ticketEligible: false,
      })),
      stopReason: 'out_of_scope',
      plansUsed,
      physicalRetrievalsUsed: physicalUsed,
      isFallback,
      fallbackReason,
      budgets: {
        plans: { consumed: plansUsed, limit: limits.maxSearchPlans, remaining: Math.max(0, limits.maxSearchPlans - plansUsed) },
        physicalRetrievals: { consumed: physicalUsed, limit: limits.maxPhysicalRetrievals, remaining: limits.maxPhysicalRetrievals - physicalUsed },
      },
      uniqueEvidenceCount: 0,
      evidenceTokens: 0,
      truncatedBy: [],
      rawPackedBySubquestion: new Map(),
      chunkProvenance: new Map(),
    };
  }
  if (currentPlan.intent === 'clarification_needed') {
    return {
      sets: currentPlan.subquestions.map((sub) => ({
        kind: 'no_match' as const,
        subquestionId: sub.subquestionId,
        requestedQuery: sub.question,
        attemptedQueries: [normalizeQueryText(input.originalQuery)],
        reason: 'no_relevant_evidence' as const,
        ticketEligible: false,
      })),
      stopReason: 'clarification_needed',
      plansUsed,
      physicalRetrievalsUsed: physicalUsed,
      isFallback,
      fallbackReason,
      budgets: {
        plans: { consumed: plansUsed, limit: limits.maxSearchPlans, remaining: Math.max(0, limits.maxSearchPlans - plansUsed) },
        physicalRetrievals: { consumed: physicalUsed, limit: limits.maxPhysicalRetrievals, remaining: limits.maxPhysicalRetrievals - physicalUsed },
      },
      uniqueEvidenceCount: 0,
      evidenceTokens: 0,
      truncatedBy: [],
      rawPackedBySubquestion: new Map(),
      chunkProvenance: new Map(),
    };
  }

  for (let round = 0; round < limits.maxSearchPlans; round += 1) {
    if (runSignal.aborted) {
      const abort = classifyAbort(runSignal);
      return {
        sets: errorSetsForPlan(currentPlan, input.originalQuery, abort.code, abort.userSafeMessage, abort.retryable),
        stopReason: abort.stopReason,
        plansUsed,
        physicalRetrievalsUsed: physicalUsed,
        isFallback,
        fallbackReason,
        budgets: {
          plans: { consumed: plansUsed, limit: limits.maxSearchPlans, remaining: Math.max(0, limits.maxSearchPlans - plansUsed) },
          physicalRetrievals: { consumed: physicalUsed, limit: limits.maxPhysicalRetrievals, remaining: Math.max(0, limits.maxPhysicalRetrievals - physicalUsed) },
        },
        uniqueEvidenceCount: 0,
        evidenceTokens: 0,
      truncatedBy: [],
      rawPackedBySubquestion: new Map(),
      chunkProvenance: new Map(),
      };
    }
    if (input.deadlineAt !== undefined && Date.now() > input.deadlineAt) {
      return {
        sets: errorSetsForPlan(currentPlan, input.originalQuery, 'timeout', 'The documentation search timed out. Please try again.', true),
        stopReason: 'deadline_exceeded',
        plansUsed,
        physicalRetrievalsUsed: physicalUsed,
        isFallback,
        fallbackReason,
        budgets: {
          plans: { consumed: plansUsed, limit: limits.maxSearchPlans, remaining: Math.max(0, limits.maxSearchPlans - plansUsed) },
          physicalRetrievals: { consumed: physicalUsed, limit: limits.maxPhysicalRetrievals, remaining: Math.max(0, limits.maxPhysicalRetrievals - physicalUsed) },
        },
        uniqueEvidenceCount: 0,
        evidenceTokens: 0,
      truncatedBy: [],
      rawPackedBySubquestion: new Map(),
      chunkProvenance: new Map(),
      };
    }

    const normalizedQuerySet = currentPlan.subquestions
      .map((sub) => {
        const queries = dedupeQueriesWithinSubquestion(sub.queries)
          .map((entry) => `${entry.query.strategy}:${entry.dedupKey}`)
          .sort()
          .join('\u0001');
        return `${sub.subquestionId}:${queries}`;
      })
      .sort()
      .join('\u0000');
    if (round > 0 && priorQuerySets.includes(normalizedQuerySet)) {
      if (lastPacked) {
        return {
          ...lastPacked,
          stopReason: 'repeated_query_set',
          plansUsed,
          physicalRetrievalsUsed: physicalUsed,
          isFallback,
          fallbackReason,
        };
      }
      const packed = await executeAndPack(currentPlan, {
        deps,
        input,
        limits,
        seenKeys,
        physicalUsedRef: { get: () => physicalUsed, add: (count: number) => { physicalUsed += count; } },
        skipRetrieval: true,
      });
      return {
        ...packed,
        stopReason: 'repeated_query_set',
        plansUsed,
        physicalRetrievalsUsed: physicalUsed,
        isFallback,
        fallbackReason,
      };
    }
    priorQuerySets.push(normalizedQuerySet);

    const execution = await executePlanOnce(currentPlan, {
      deps,
      input: effectiveInput,
      limits,
      seenKeys,
      getPhysicalUsed: () => physicalUsed,
      addPhysicalUsed: (count: number) => { physicalUsed += count; },
      abortRun: (reason: unknown) => runAbortController.abort(reason),
    });
    physicalUsed = execution.physicalUsed;

    if (execution.cancelled) {
      const abort = classifyAbort(runSignal);
      return {
        sets: errorSetsForPlan(currentPlan, input.originalQuery, abort.code, abort.userSafeMessage, abort.retryable),
        stopReason: abort.stopReason,
        plansUsed,
        physicalRetrievalsUsed: physicalUsed,
        isFallback,
        fallbackReason,
        budgets: {
          plans: { consumed: plansUsed, limit: limits.maxSearchPlans, remaining: Math.max(0, limits.maxSearchPlans - plansUsed) },
          physicalRetrievals: { consumed: physicalUsed, limit: limits.maxPhysicalRetrievals, remaining: Math.max(0, limits.maxPhysicalRetrievals - physicalUsed) },
        },
        uniqueEvidenceCount: 0,
        evidenceTokens: 0,
      truncatedBy: [],
      rawPackedBySubquestion: new Map(),
      chunkProvenance: new Map(),
      };
    }
    if (execution.timedOut) {
      return {
        sets: errorSetsForPlan(currentPlan, input.originalQuery, 'timeout', 'The documentation search timed out. Please try again.', true),
        stopReason: 'deadline_exceeded',
        plansUsed,
        physicalRetrievalsUsed: physicalUsed,
        isFallback,
        fallbackReason,
        budgets: {
          plans: { consumed: plansUsed, limit: limits.maxSearchPlans, remaining: Math.max(0, limits.maxSearchPlans - plansUsed) },
          physicalRetrievals: { consumed: physicalUsed, limit: limits.maxPhysicalRetrievals, remaining: Math.max(0, limits.maxPhysicalRetrievals - physicalUsed) },
        },
        uniqueEvidenceCount: 0,
        evidenceTokens: 0,
      truncatedBy: [],
      rawPackedBySubquestion: new Map(),
      chunkProvenance: new Map(),
      };
    }
    if (execution.physicalCeiling) {
      const packed = packExecution(execution, currentPlan, limits, { isFallback, plansUsed });
      return {
        ...packed,
        stopReason: 'physical_retrieval_ceiling',
        plansUsed,
        physicalRetrievalsUsed: physicalUsed,
        isFallback,
        fallbackReason,
      };
    }

    const resultSetKey = execution.subResults
      .map((sub) => `${sub.subquestionId}:${sub.ranked.map((chunk) => stableChunkIdentity(chunk)).sort().join(',')}`)
      .sort()
      .join('\u0000');
    if (round > 0 && priorResultSets.includes(resultSetKey)) {
      const packed = packExecution(execution, currentPlan, limits, { isFallback, plansUsed });
      return {
        ...packed,
        stopReason: 'repeated_result_set',
        plansUsed,
        physicalRetrievalsUsed: physicalUsed,
        isFallback,
        fallbackReason,
      };
    }
    priorResultSets.push(resultSetKey);
    lastPacked = packExecution(execution, currentPlan, limits, { isFallback, plansUsed });

    const allSufficient = execution.subResults.every((sub) => sub.quality === 'sufficient');
    const anyErrorOnly = execution.subResults.length > 0 && execution.subResults.every((sub) => sub.failure !== null);
    if (anyErrorOnly) {
      const firstCode = execution.subResults[0]?.failure?.code ?? 'retrieval_unavailable';
      const stopReason = firstCode === 'cancelled'
        ? 'cancelled' as const
        : firstCode === 'timeout'
          ? 'timeout' as const
          : 'candidate_exhausted' as const;
      return {
        sets: execution.subResults.map((sub) => ({
          kind: 'error' as const,
          subquestionId: sub.subquestionId,
          requestedQuery: sub.requestedQuery,
          attemptedQueries: sub.attemptedQueries,
          code: sub.failure?.code ?? 'retrieval_unavailable',
          retryable: sub.failure?.retryable ?? true,
          userSafeMessage: sub.failure?.userSafeMessage ?? 'The documentation search is temporarily unavailable. Please try again.',
        })),
        stopReason,
        plansUsed,
        physicalRetrievalsUsed: physicalUsed,
        isFallback,
        fallbackReason,
        budgets: {
          plans: { consumed: plansUsed, limit: limits.maxSearchPlans, remaining: Math.max(0, limits.maxSearchPlans - plansUsed) },
          physicalRetrievals: { consumed: physicalUsed, limit: limits.maxPhysicalRetrievals, remaining: Math.max(0, limits.maxPhysicalRetrievals - physicalUsed) },
        },
        uniqueEvidenceCount: 0,
        evidenceTokens: 0,
      truncatedBy: [],
      rawPackedBySubquestion: new Map(),
      chunkProvenance: new Map(),
      };
    }

    if (allSufficient) {
      const packed = packExecution(execution, currentPlan, limits, { isFallback, plansUsed });
      return {
        ...packed,
        stopReason: 'sufficient_evidence',
        plansUsed,
        physicalRetrievalsUsed: physicalUsed,
        isFallback,
        fallbackReason,
      };
    }

    const hasWeakOrPartial = execution.subResults.some((sub) => sub.quality === 'weak' || sub.quality === 'partial');
    const canFollowUp = hasWeakOrPartial && plansUsed < limits.maxSearchPlans && physicalUsed < limits.maxPhysicalRetrievals;
    priorFeedback = execution.subResults.map((sub) => ({
      normalizedQueries: sub.attemptedQueries.map((query) => normalizeQueryForDedup(query)),
      resultSummaries: sub.ranked.slice(0, 10).map((chunk, index): PriorResultSummary => ({
        documentId: chunk.documentId,
        ...(chunk.chunkUid ? { chunkUid: chunk.chunkUid } : {}),
        chunkIndex: chunk.chunkIndex,
        ...(chunk.title ? { title: chunk.title.slice(0, 120) } : {}),
        ...(chunk.sectionTitle ? { section: chunk.sectionTitle.slice(0, 120) } : {}),
        rank: index + 1,
        qualityReason: qualityToReason(sub.quality),
      })),
      remainingPlans: Math.max(0, limits.maxSearchPlans - plansUsed - 1),
      remainingMs: remainingMs(),
    }));

    if (!canFollowUp || round + 1 >= limits.maxSearchPlans) {
      const packed = packExecution(execution, currentPlan, limits, { isFallback, plansUsed });
      const stopReason = execution.subResults.every((sub) => sub.ranked.length === 0)
        ? 'candidate_exhausted'
        : 'partial_evidence';
      return {
        ...packed,
        stopReason,
        plansUsed,
        physicalRetrievalsUsed: physicalUsed,
        isFallback,
        fallbackReason,
      };
    }

    let followupPlan: SearchPlan;
    plansUsed += 1;
    try {
      const followup = await resolvePlan({
        planner,
        request: {
          originalQuery: input.originalQuery,
          ...(input.conversationSummary ? { conversationSummary: input.conversationSummary } : {}),
          priorAttempts: priorFeedback,
          remainingPlans: limits.maxSearchPlans - plansUsed + 1,
          remainingMs: remainingMs(),
          signal: runSignal,
        },
        originalQuery: input.originalQuery,
        ...(input.trace ? { trace: input.trace } : {}),
        callId: input.callId,
      });
      followupPlan = followup.plan;
      if (followup.isFallback) {
        isFallback = true;
        fallbackReason ??= followup.fallbackReason === 'planner_error'
          ? 'followup_planner_error'
          : 'followup_planner_malformed';
      }
    } catch {
      const abort = classifyAbort(runSignal);
      return {
        sets: errorSetsForPlan(currentPlan, input.originalQuery, abort.code, abort.userSafeMessage, abort.retryable),
        stopReason: abort.stopReason,
        plansUsed,
        physicalRetrievalsUsed: physicalUsed,
        isFallback,
        fallbackReason,
        budgets: budgetView(plansUsed, physicalUsed),
        uniqueEvidenceCount: 0,
        evidenceTokens: 0,
        truncatedBy: [],
        rawPackedBySubquestion: new Map(),
        chunkProvenance: new Map(),
      };
    }
    const executedPlan = currentPlan;
    currentPlan = followupPlan;
    if (currentPlan.intent !== 'documentation') {
      const packed = packExecution(execution, executedPlan, limits, { isFallback, plansUsed });
      return {
        ...packed,
        stopReason: currentPlan.intent === 'out_of_scope' ? 'out_of_scope' : 'clarification_needed',
        plansUsed,
        physicalRetrievalsUsed: physicalUsed,
        isFallback,
        fallbackReason,
      };
    }
  }

  return {
    sets: errorSetsForPlan(currentPlan, input.originalQuery, 'retrieval_unavailable', 'The documentation search is temporarily unavailable. Please try again.', true),
    stopReason: 'attempt_exhausted',
    plansUsed,
    physicalRetrievalsUsed: physicalUsed,
    isFallback,
    fallbackReason,
    budgets: {
      plans: { consumed: plansUsed, limit: limits.maxSearchPlans, remaining: Math.max(0, limits.maxSearchPlans - plansUsed) },
      physicalRetrievals: { consumed: physicalUsed, limit: limits.maxPhysicalRetrievals, remaining: Math.max(0, limits.maxPhysicalRetrievals - physicalUsed) },
    },
    uniqueEvidenceCount: 0,
    evidenceTokens: 0,
      truncatedBy: [],
      rawPackedBySubquestion: new Map(),
      chunkProvenance: new Map(),
  };
}

function qualityToReason(quality: string): QualityReasonCode {
  if (quality === 'sufficient') return 'sufficient_evidence';
  if (quality === 'weak') return 'weak_relevance';
  if (quality === 'partial') return 'coverage_gap';
  return 'no_results';
}

function errorSetsForPlan(
  plan: SearchPlan,
  originalQuery: string,
  code: SearchFailure['code'],
  message: string,
  retryable: boolean,
): readonly SearchSubquestionResult[] {
  return plan.subquestions.map((sub) => ({
    kind: 'error' as const,
    subquestionId: sub.subquestionId,
    requestedQuery: sub.question,
    attemptedQueries: [normalizeQueryText(originalQuery)],
    code,
    retryable,
    userSafeMessage: message,
  }));
}

interface SubExecution {
  readonly subquestionId: string;
  readonly requestedQuery: string;
  readonly attemptedQueries: string[];
  readonly ranked: readonly RetrievedChunk[];
  readonly quality: 'sufficient' | 'partial' | 'weak' | 'empty';
  readonly failure: SearchFailure | null;
  readonly degraded: boolean;
  readonly degradedBy: readonly SearchDegradation[];
  readonly hasMore: boolean;
  readonly provenanceByKey: ReadonlyMap<string, readonly string[]>;
  readonly totalDuplicatesSkipped: number;
  readonly executedQueryIds: readonly string[];
  readonly omittedByBudget: boolean;
}

interface PlanExecution {
  readonly subResults: readonly SubExecution[];
  readonly physicalUsed: number;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly physicalCeiling: boolean;
}

async function executePlanOnce(
  plan: SearchPlan,
  ctx: {
    deps: OrchestratorDeps;
    input: OrchestratorInput;
    limits: SearchBudgetLimits;
    seenKeys: ReadonlySet<string>;
    getPhysicalUsed: () => number;
    addPhysicalUsed: (count: number) => void;
    abortRun: (reason: unknown) => void;
  },
): Promise<PlanExecution> {
  const executions = new Map<string, VariantExecution>();
  const queryIdBySubKey = new Map<string, Map<string, readonly string[]>>();
  for (const sub of plan.subquestions) {
    const deduped = dedupeQueriesWithinSubquestion(sub.queries);
    const perSub = new Map<string, readonly string[]>();
    for (const entry of deduped) {
      perSub.set(entry.dedupKey, entry.aliasQueryIds);
      const existing = executions.get(entry.dedupKey);
      if (existing) continue;
      executions.set(entry.dedupKey, {
        normalizedKey: entry.dedupKey,
        text: entry.query.text,
        subquestionId: sub.subquestionId,
        queryIds: entry.aliasQueryIds,
      });
    }
    queryIdBySubKey.set(sub.subquestionId, perSub);
  }

  const uniqueKeys = [...executions.keys()].sort();
  const modalitiesPerVariant = (ctx.deps.hybridEnabled ?? true) ? 2 : 1;
  const remainingBudget = ctx.limits.maxPhysicalRetrievals - ctx.getPhysicalUsed();
  if (remainingBudget < modalitiesPerVariant) {
    return { subResults: [], physicalUsed: ctx.getPhysicalUsed(), cancelled: false, timedOut: false, physicalCeiling: true };
  }
  const maxExecutableVariants = Math.max(1, Math.floor(remainingBudget / modalitiesPerVariant));
  const executableKeys = uniqueKeys.slice(0, maxExecutableVariants);
  const truncatedByCeiling = executableKeys.length < uniqueKeys.length;

  const outcomeByKey = new Map<string, VariantOutcome>();
  const variantLimit = Math.max(1, Math.min(ctx.limits.maxResultsPerSubquestion * 2, ctx.limits.maxCandidatesPerModality));
  const executedKeySet = new Set(executableKeys);
  const tasks = executableKeys.map((key) => async (): Promise<void> => {
    const execution = executions.get(key);
    if (!execution) return;
    throwIfAborted(ctx.input.signal);
    if (ctx.input.deadlineAt !== undefined && Date.now() > ctx.input.deadlineAt) {
      throw Object.assign(new Error('Search orchestrator deadline exceeded'), { name: 'TimeoutError' });
    }
    let result: SearchExecutionResult | null = null;
    let failure: SearchFailure | null = null;
    try {
      const searchResult = await searchChunks(
        execution.text,
        {
          limit: variantLimit,
          threshold: ctx.deps.similarityThreshold ?? 0.5,
          rerankerThreshold: ctx.deps.rerankerThreshold,
          hybridEnabled: ctx.deps.hybridEnabled,
          lexicalSearchMode: ctx.deps.lexicalSearchMode,
          filter: ctx.deps.filter,
          ...(ctx.deps.mode ? { mode: ctx.deps.mode } : {}),
          ...(ctx.deps.parentChildWindow !== undefined ? { parentChildWindow: ctx.deps.parentChildWindow } : {}),
          ...(ctx.deps.rrfK !== undefined ? { rrfK: ctx.deps.rrfK } : {}),
          ...(ctx.deps.lexicalWeight !== undefined ? { lexicalWeight: ctx.deps.lexicalWeight } : {}),
          ...(ctx.deps.rsePenalty !== undefined ? { rsePenalty: ctx.deps.rsePenalty } : {}),
          ...(ctx.deps.rseMaxSegmentChunks !== undefined ? { rseMaxSegmentChunks: ctx.deps.rseMaxSegmentChunks } : {}),
          ...(ctx.deps.rseOverallMaxChunks !== undefined ? { rseOverallMaxChunks: ctx.deps.rseOverallMaxChunks } : {}),
          ...(ctx.deps.rseMinSegmentValue !== undefined ? { rseMinSegmentValue: ctx.deps.rseMinSegmentValue } : {}),
          excludeChunkIdentities: ctx.input.excludeChunkIdentities,
          candidateLimit: ctx.limits.maxCandidatesPerModality,
          signal: ctx.input.signal,
        },
        { chunks: ctx.deps.search.chunks, embeddings: ctx.deps.search.embeddings, reranker: undefined },
      );
      if (!searchResult.ok) {
        failure = searchResult.error;
      } else {
        result = searchResult.value;
      }
    } catch (cause) {
      if (isCancellation(cause, ctx.input.signal)) {
        throw cause;
      }
      failure = new SearchFailure(
        toFailureCode(cause, ctx.input.signal),
        true,
        'The documentation search is temporarily unavailable. Please try again.',
        cause,
      );
    }
    outcomeByKey.set(key, {
      key,
      chunks: result?.chunks ?? [],
      failure,
      duplicatesSkipped: result?.diagnostics.stableDuplicatesSkipped ?? 0,
      hasMore: result?.diagnostics.hasMore ?? false,
      degradedBy: result ? [...result.degradedBy] : [],
    });
  });

  let startedVariants = 0;
  const countedTasks = tasks.map((task) => async (): Promise<void> => {
    startedVariants += 1;
    await task();
  });
  try {
    await runWithConcurrency(
      countedTasks,
      ctx.limits.maxConcurrentRetrievals,
      ctx.input.signal,
      ctx.abortRun,
    );
  } catch (cause) {
    if (isCancellation(cause, ctx.input.signal)) {
      return { subResults: [], physicalUsed: ctx.getPhysicalUsed() + startedVariants * modalitiesPerVariant, cancelled: true, timedOut: false, physicalCeiling: false };
    }
    if (cause instanceof Error && cause.name === 'TimeoutError') {
      return { subResults: [], physicalUsed: ctx.getPhysicalUsed() + startedVariants * modalitiesPerVariant, cancelled: false, timedOut: true, physicalCeiling: false };
    }
    throw cause;
  }
  ctx.addPhysicalUsed(executableKeys.length * modalitiesPerVariant);

  const subResults: SubExecution[] = [];
  for (const sub of plan.subquestions) {
    const perSub = queryIdBySubKey.get(sub.subquestionId) ?? new Map<string, readonly string[]>();
    const outcomes: VariantOutcome[] = [];
    for (const key of perSub.keys()) {
      if (!executedKeySet.has(key)) continue;
      const outcome = outcomeByKey.get(key);
      if (outcome) outcomes.push(outcome);
    }
    if (outcomes.length === 0 && truncatedByCeiling) {
      subResults.push({
        subquestionId: sub.subquestionId,
        requestedQuery: sub.question,
        attemptedQueries: sub.queries.map((query) => query.text),
        ranked: [],
        quality: 'empty',
        failure: null,
        degraded: false,
        degradedBy: [],
        hasMore: false,
        provenanceByKey: new Map(),
        totalDuplicatesSkipped: 0,
        executedQueryIds: [],
        omittedByBudget: true,
      });
      continue;
    }
    const failures = outcomes.map((outcome) => outcome.failure).filter((failure): failure is SearchFailure => failure !== null);
    const successful = outcomes.filter((outcome) => outcome.failure === null);
    const queryIdByKey = new Map<string, readonly string[]>();
    for (const [key, queryIds] of perSub) queryIdByKey.set(key, queryIds);
    const attemptedQueries = sub.queries.map((query) => query.text);

    const executedQueryIds = [...new Set(outcomes.flatMap((outcome) => [...(perSub.get(outcome.key) ?? [])]))].sort();
    if (successful.length === 0 && failures.length > 0) {
      const first = failures[0];
      if (!first) continue;
      subResults.push({
        subquestionId: sub.subquestionId,
        requestedQuery: sub.question,
        attemptedQueries,
        ranked: [],
        quality: 'empty',
        failure: first,
        degraded: false,
        degradedBy: [],
        hasMore: false,
        provenanceByKey: new Map(),
        totalDuplicatesSkipped: outcomes.reduce((total, outcome) => total + outcome.duplicatesSkipped, 0),
        executedQueryIds,
        omittedByBudget: false,
      });
      continue;
    }

    const { combined, provenanceByKey } = combineVariantsForSubquestion({
      subquestionId: sub.subquestionId,
      subquestionQuestion: sub.question,
      variantOutcomes: successful,
      queryIdByKey,
    });
    if (combined.length === 0 && failures.length > 0) {
      const first = failures[0];
      if (first) {
        subResults.push({
          subquestionId: sub.subquestionId,
          requestedQuery: sub.question,
          attemptedQueries,
          ranked: [],
          quality: 'empty',
          failure: first,
          degraded: false,
          degradedBy: [],
          hasMore: false,
          provenanceByKey: new Map(),
          totalDuplicatesSkipped: outcomes.reduce((total, outcome) => total + outcome.duplicatesSkipped, 0),
          executedQueryIds,
          omittedByBudget: false,
        });
        continue;
      }
    }
    let ranked = combined;
    let degraded = false;
    try {
      const reranked = await rerankOnceForSubquestion({
        subquestionQuestion: sub.question,
        combined,
        deps: ctx.deps,
        signal: ctx.input.signal,
        topN: ctx.limits.maxCandidatesPerModality,
      });
      ranked = reranked.ranked;
      degraded = reranked.degraded;
    } catch (cause) {
      if (isCancellation(cause, ctx.input.signal)) {
        return { subResults: [], physicalUsed: ctx.getPhysicalUsed(), cancelled: true, timedOut: false, physicalCeiling: false };
      }
      degraded = true;
    }
    const duplicatesSkipped = successful.reduce((total, outcome) => total + outcome.duplicatesSkipped, 0);
    const hasMore = successful.some((outcome) => outcome.hasMore);
    const assessment = assessSubquestionQuality({
      chunks: ranked,
      requestedCount: ctx.limits.maxResultsPerSubquestion,
      hasMore,
      degraded,
      duplicatesSkipped,
      rerankerThreshold: ctx.deps.rerankerThreshold,
    });
    const variantDegraded = [...new Set(successful.flatMap((outcome) => [...outcome.degradedBy]))].sort();
    subResults.push({
      subquestionId: sub.subquestionId,
      requestedQuery: sub.question,
      attemptedQueries,
      ranked,
      quality: assessment.quality,
      failure: null,
      degraded,
      degradedBy: degraded ? [...variantDegraded, 'reranker_unavailable'] : variantDegraded,
      hasMore,
      provenanceByKey,
      totalDuplicatesSkipped: duplicatesSkipped,
      executedQueryIds: [...new Set(successful.flatMap((outcome) => [...(perSub.get(outcome.key) ?? [])]))].sort(),
      omittedByBudget: false,
    });
  }

  return { subResults, physicalUsed: ctx.getPhysicalUsed(), cancelled: false, timedOut: false, physicalCeiling: truncatedByCeiling };
}

function packExecution(
  execution: PlanExecution,
  plan: SearchPlan,
  limits: SearchBudgetLimits,
  opts?: { isFallback?: boolean | undefined; plansUsed?: number | undefined },
): Pick<OrchestratorResult, 'sets' | 'budgets' | 'uniqueEvidenceCount' | 'evidenceTokens' | 'truncatedBy' | 'rawPackedBySubquestion' | 'chunkProvenance'> {
  const plansUsed = opts?.plansUsed ?? 0;
  const isFallback = opts?.isFallback ?? false;
  const budgetsFor = (physicalUsed: number, uniqueCount = 0, tokenCount = 0): OrchestratorResult['budgets'] => ({
    plans: { consumed: plansUsed, limit: limits.maxSearchPlans, remaining: Math.max(0, limits.maxSearchPlans - plansUsed) },
    physicalRetrievals: { consumed: physicalUsed, limit: limits.maxPhysicalRetrievals, remaining: Math.max(0, limits.maxPhysicalRetrievals - physicalUsed) },
    uniqueChunks: { consumed: uniqueCount, limit: limits.maxUniqueEvidenceChunks, remaining: Math.max(0, limits.maxUniqueEvidenceChunks - uniqueCount) },
    evidenceTokens: { consumed: tokenCount, limit: limits.maxEvidenceTokens, remaining: Math.max(0, limits.maxEvidenceTokens - tokenCount) },
  });
  const errorSets: SearchSubquestionResult[] = [];
  const packable: { subquestionId: string; rankedResults: readonly RetrievedChunk[]; requestedCount: number }[] = [];
  for (const sub of execution.subResults) {
    if (sub.failure !== null) {
      errorSets.push({
        kind: 'error',
        subquestionId: sub.subquestionId,
        requestedQuery: sub.requestedQuery,
        attemptedQueries: sub.attemptedQueries,
        code: sub.failure.code,
        retryable: sub.failure.retryable,
        userSafeMessage: sub.failure.userSafeMessage,
      });
      continue;
    }
    if (sub.omittedByBudget) {
      errorSets.push({
        kind: 'error',
        subquestionId: sub.subquestionId,
        requestedQuery: sub.requestedQuery,
        attemptedQueries: [...sub.attemptedQueries],
        code: 'retrieval_unavailable',
        retryable: false,
        userSafeMessage: 'Not executed: the turn search budget was exhausted before this subquestion could run.',
      });
      continue;
    }
    if (sub.ranked.length === 0) {
      const attempted = sub.attemptedQueries.length > 0 ? sub.attemptedQueries : [sub.requestedQuery];
      if (sub.degradedBy.length > 0) {
        const code = sub.degradedBy.every((item) => item === 'reranker_unavailable')
          ? 'reranker_unavailable' as const
          : 'retrieval_unavailable' as const;
        errorSets.push({
          kind: 'error',
          subquestionId: sub.subquestionId,
          requestedQuery: sub.requestedQuery,
          attemptedQueries: [...attempted],
          code,
          retryable: true,
          userSafeMessage: 'The documentation search is temporarily unavailable. Please try again.',
        });
        continue;
      }
      if (sub.totalDuplicatesSkipped > 0) {
        errorSets.push({
          kind: 'no_match',
          subquestionId: sub.subquestionId,
          requestedQuery: sub.requestedQuery,
          attemptedQueries: [...attempted],
          reason: 'filtered_duplicates',
          ticketEligible: false,
        });
        continue;
      }
      errorSets.push({
        kind: 'no_match',
        subquestionId: sub.subquestionId,
        requestedQuery: sub.requestedQuery,
        attemptedQueries: [...attempted],
        reason: 'no_relevant_evidence',
        ticketEligible: isFallback ? false : true,
      });
      continue;
    }
    packable.push({
      subquestionId: sub.subquestionId,
      rankedResults: sub.ranked,
      requestedCount: Math.min(limits.maxResultsPerSubquestion, sub.ranked.length > 0 ? limits.maxResultsPerSubquestion : 0),
    });
  }
  if (packable.length === 0) {
    return {
      sets: errorSets.length > 0 ? errorSets : [{
        kind: 'no_match',
        subquestionId: plan.subquestions[0]?.subquestionId ?? 'sq-1',
        requestedQuery: plan.subquestions[0]?.question ?? '',
        attemptedQueries: [plan.subquestions[0]?.question ?? ''],
        reason: 'no_relevant_evidence',
        ticketEligible: false,
      }],
      budgets: budgetsFor(execution.physicalUsed),
      uniqueEvidenceCount: 0,
      evidenceTokens: 0,
      truncatedBy: [],
      rawPackedBySubquestion: new Map(),
      chunkProvenance: new Map(),
    };
  }
  const packed = packEvidence({
    subquestionSets: packable.map((entry) => ({
      subquestionId: entry.subquestionId,
      rankedResults: entry.rankedResults,
      requestedCount: entry.requestedCount,
    })),
    maxUniqueChunks: limits.maxUniqueEvidenceChunks,
    maxEvidenceTokens: limits.maxEvidenceTokens,
    minQuotaPerSubquestion: limits.minQuotaPerSubquestion,
    maxResultsPerSubquestion: limits.maxResultsPerSubquestion,
    maxResultsPerSearchCall: limits.maxResultsPerSearchCall,
  });
  const packedKeys = new Set(
    packed.packedSets.flatMap((set) => set.results.map((chunk) => stableChunkIdentity(chunk))),
  );
  const sets: SearchSubquestionResult[] = [...errorSets];
  for (const packedSet of packed.packedSets) {
    const original = execution.subResults.find((sub) => sub.subquestionId === packedSet.subquestionId);
    if (!original) continue;
    if (packedSet.results.length === 0) {
      const hadCandidates = original.ranked.length > 0;
      const sharedConsumed = hadCandidates &&
        original.ranked.some((chunk) => packedKeys.has(stableChunkIdentity(chunk)));
      sets.push({
        kind: 'no_match',
        subquestionId: packedSet.subquestionId,
        requestedQuery: original.requestedQuery,
        attemptedQueries: [...original.attemptedQueries],
        reason: (original.totalDuplicatesSkipped > 0 && !hadCandidates) || sharedConsumed
          ? 'filtered_duplicates'
          : 'no_relevant_evidence',
        ticketEligible: false,
      });
      continue;
    }
    const plannedQueries = plan.subquestions
      .find((sub) => sub.subquestionId === packedSet.subquestionId)
      ?.queries.map((query) => ({ queryId: query.queryId, query: query.text })) ?? [{ queryId: 'q-1', query: original.requestedQuery }];
    const executedIdSet = new Set(original.executedQueryIds.length > 0 ? original.executedQueryIds : plannedQueries.map((entry) => entry.queryId));
    const executedQueries = plannedQueries.filter((entry) => executedIdSet.has(entry.queryId));
    const effectiveExecuted = executedQueries.length > 0 ? executedQueries : plannedQueries.slice(0, 1);
    const validIds = new Set(effectiveExecuted.map((entry) => entry.queryId));
    sets.push({
      kind: 'results',
      subquestionId: packedSet.subquestionId,
      requestedQuery: original.requestedQuery,
      executedQueries: effectiveExecuted,
      results: packedSet.results.map((chunk) => {
        const key = stableChunkIdentity(chunk);
        const contributed = (original.provenanceByKey.get(key) ?? []).filter((queryId) => validIds.has(queryId)).sort();
        const allSubquestionIds = packed.chunkProvenance.get(key)?.subquestionIds ?? [packedSet.subquestionId];
        const allQueryIds = [...new Set(
          execution.subResults.flatMap((sub) => [...(sub.provenanceByKey.get(key) ?? [])]),
        )].sort();
        const localQueryIds = contributed.length > 0 ? contributed : [effectiveExecuted[0]?.queryId ?? 'q-1'];
        return {
          id: chunk.id,
          ...(chunk.chunkUid ? { chunkUid: chunk.chunkUid } : {}),
          documentId: chunk.documentId,
          chunkIndex: chunk.chunkIndex,
          subquestionId: packedSet.subquestionId,
          executedQueryIds: localQueryIds,
          provenance: {
            subquestionIds: [...allSubquestionIds].sort(),
            queryIds: allQueryIds.length > 0 ? allQueryIds : localQueryIds,
          },
          content: chunk.content,
          source: chunk.source,
          ...(chunk.title ? { documentTitle: chunk.title } : {}),
          ...(chunk.sectionTitle ? { section: chunk.sectionTitle } : {}),
          scores: chunk.scores,
        };
      }),
      coverage: packedSet.coverage,
      hasMore: original.hasMore,
      degradedBy: [...original.degradedBy],
    });
  }
  sets.sort((a, b) => (a.subquestionId < b.subquestionId ? -1 : a.subquestionId > b.subquestionId ? 1 : 0));
  const chunkProvenance = new Map<string, { subquestionIds: readonly string[]; queryIds: readonly string[] }>();
  for (const packedSet of packed.packedSets) {
    for (const chunk of packedSet.results) {
      const key = stableChunkIdentity(chunk);
      const subquestionIds = packed.chunkProvenance.get(key)?.subquestionIds ?? [packedSet.subquestionId];
      const queryIds = [...new Set(
        execution.subResults.flatMap((sub) => [...(sub.provenanceByKey.get(key) ?? [])]),
      )].sort();
      chunkProvenance.set(key, { subquestionIds: [...subquestionIds].sort(), queryIds });
    }
  }
  return {
    sets,
    budgets: budgetsFor(execution.physicalUsed, packed.totalUniqueChunks, packed.totalTokens),
    uniqueEvidenceCount: packed.totalUniqueChunks,
    evidenceTokens: packed.totalTokens,
    truncatedBy: [...packed.truncatedBy],
    rawPackedBySubquestion: new Map(packed.packedSets.map((s) => [s.subquestionId, s.results])),
    chunkProvenance,
  };
}

async function executeAndPack(
  plan: SearchPlan,
  ctx: {
    deps: OrchestratorDeps;
    input: OrchestratorInput;
    limits: SearchBudgetLimits;
    seenKeys: ReadonlySet<string>;
    physicalUsedRef: { get: () => number; add: (count: number) => void };
    skipRetrieval: boolean;
  },
): Promise<Pick<OrchestratorResult, 'sets' | 'budgets' | 'uniqueEvidenceCount' | 'evidenceTokens' | 'truncatedBy' | 'rawPackedBySubquestion' | 'chunkProvenance'>> {
  void ctx.skipRetrieval;
  return {
    sets: plan.subquestions.map((sub) => ({
      kind: 'no_match' as const,
      subquestionId: sub.subquestionId,
      requestedQuery: sub.question,
      attemptedQueries: sub.queries.map((query) => query.text),
      reason: 'no_relevant_evidence' as const,
      ticketEligible: false,
    })),
    budgets: {
      plans: { consumed: 0, limit: ctx.limits.maxSearchPlans, remaining: ctx.limits.maxSearchPlans },
      physicalRetrievals: {
        consumed: ctx.physicalUsedRef.get(),
        limit: ctx.limits.maxPhysicalRetrievals,
        remaining: Math.max(0, ctx.limits.maxPhysicalRetrievals - ctx.physicalUsedRef.get()),
      },
    },
    uniqueEvidenceCount: 0,
    evidenceTokens: 0,
      truncatedBy: [],
      rawPackedBySubquestion: new Map(),
      chunkProvenance: new Map(),
  };
}
