export type SearchStopReason =
  | 'sufficient_evidence'
  | 'partial_evidence'
  | 'repeated_query_set'
  | 'repeated_result_set'
  | 'out_of_scope'
  | 'clarification_needed'
  | 'cancelled'
  | 'timeout'
  | 'deadline_exceeded'
  | 'attempt_exhausted'
  | 'call_result_limit'
  | 'subquestion_result_limit'
  | 'turn_chunk_limit'
  | 'turn_token_limit'
  | 'candidate_exhausted'
  | 'relevance_floor'
  | 'physical_retrieval_ceiling'
  | 'planner_fallback';

export type SearchPartialReason =
  | 'weak_relevance'
  | 'coverage_gap'
  | 'candidate_exhausted'
  | 'relevance_floor'
  | 'turn_chunk_limit'
  | 'turn_token_limit'
  | 'call_result_limit'
  | 'subquestion_result_limit';

export interface SearchBudgetLimits {
  readonly maxResultsPerSearchCall: number;
  readonly maxCandidatesPerModality: number;
  readonly maxResultsPerSubquestion: number;
  readonly maxSearchPlans: number;
  readonly maxPhysicalRetrievals: number;
  readonly maxConcurrentRetrievals: number;
  readonly maxUniqueEvidenceChunks: number;
  readonly maxEvidenceTokens: number;
  readonly minQuotaPerSubquestion: number;
}

export const DEFAULT_SEARCH_BUDGET_LIMITS: SearchBudgetLimits = {
  maxResultsPerSearchCall: 10,
  maxCandidatesPerModality: 30,
  maxResultsPerSubquestion: 3,
  maxSearchPlans: 2,
  maxPhysicalRetrievals: 24,
  maxConcurrentRetrievals: 4,
  maxUniqueEvidenceChunks: 30,
  maxEvidenceTokens: 8000,
  minQuotaPerSubquestion: 1,
};

export interface BudgetConsumption {
  readonly consumed: number;
  readonly limit: number;
  readonly remaining: number;
}

export function consumption(consumed: number, limit: number): BudgetConsumption {
  return { consumed: Math.max(0, consumed), limit, remaining: Math.max(0, limit - consumed) };
}

export interface SearchBudgetState {
  readonly limits: SearchBudgetLimits;
  readonly physicalRetrievalsUsed: number;
  readonly plansUsed: number;
  readonly uniqueEvidenceUsed: number;
  readonly evidenceTokensUsed: number;
}

export function createBudgetState(
  limits: Partial<SearchBudgetLimits> = {},
  used: Partial<Omit<SearchBudgetState, 'limits'>> = {},
): SearchBudgetState {
  return {
    limits: { ...DEFAULT_SEARCH_BUDGET_LIMITS, ...limits },
    physicalRetrievalsUsed: used.physicalRetrievalsUsed ?? 0,
    plansUsed: used.plansUsed ?? 0,
    uniqueEvidenceUsed: used.uniqueEvidenceUsed ?? 0,
    evidenceTokensUsed: used.evidenceTokensUsed ?? 0,
  };
}

export function budgetSnapshot(state: SearchBudgetState): Record<string, BudgetConsumption> {
  return {
    plans: consumption(state.plansUsed, state.limits.maxSearchPlans),
    physicalRetrievals: consumption(state.physicalRetrievalsUsed, state.limits.maxPhysicalRetrievals),
    uniqueChunks: consumption(state.uniqueEvidenceUsed, state.limits.maxUniqueEvidenceChunks),
    evidenceTokens: consumption(state.evidenceTokensUsed, state.limits.maxEvidenceTokens),
  };
}

export function canStartAnotherPlan(state: SearchBudgetState): boolean {
  return state.plansUsed < state.limits.maxSearchPlans;
}

export function canRunRetrievals(state: SearchBudgetState, count: number): boolean {
  return state.physicalRetrievalsUsed + count <= state.limits.maxPhysicalRetrievals;
}
