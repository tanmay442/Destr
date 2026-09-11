export interface AgentRunBudget {
  readonly deadlineAt: number;
  readonly finalizeReserveMs: number;
  readonly maxModelSteps: number;
  readonly maxTotalToolCalls: number;
  readonly maxSearchCalls: number;
  readonly maxSearchPlans: number;
  readonly maxPhysicalRetrievals: number;
  readonly maxConcurrentRetrievals: number;
  readonly maxResultsPerSearchCall: number;
  readonly maxCandidatesPerModality: number;
  readonly maxResultsPerSubquestion: number;
  readonly maxUniqueEvidenceChunks: number;
  readonly maxEvidenceTokens: number;
  readonly maxCallsByTool: Readonly<Record<string, number>>;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxEstimatedCostMicros?: number;
}

export interface CreateAgentRunBudgetInput {
  readonly nowMs: number;
  readonly deadlineInMs?: number;
  readonly finalizeReserveMs?: number;
  readonly overrides?: Partial<Omit<AgentRunBudget, 'deadlineAt' | 'finalizeReserveMs'>>;
}

const DEFAULT_DEADLINE_IN_MS = 50_000;
const DEFAULT_FINALIZE_RESERVE_MS = 15_000;

const DEFAULT_MAX_CALLS_BY_TOOL: Readonly<Record<string, number>> = Object.freeze({
  searchDocumentation: 4,
  createKnowledgeTicket: 1,
});

function isNonNegativeInt(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function pickInt(override: number | undefined, fallback: number): number {
  return override ?? fallback;
}

export function validateBudget(budget: AgentRunBudget): string[] {
  const violations: string[] = [];
  if (!Number.isFinite(budget.deadlineAt)) violations.push('deadlineAt must be a finite timestamp');
  if (!isNonNegativeInt(budget.finalizeReserveMs)) {
    violations.push('finalizeReserveMs must be a non-negative integer');
  }
  if (!Number.isInteger(budget.maxModelSteps) || budget.maxModelSteps < 1) {
    violations.push('maxModelSteps must be an integer >= 1');
  }
  const intFields: ReadonlyArray<[string, number]> = [
    ['maxTotalToolCalls', budget.maxTotalToolCalls],
    ['maxSearchCalls', budget.maxSearchCalls],
    ['maxSearchPlans', budget.maxSearchPlans],
    ['maxPhysicalRetrievals', budget.maxPhysicalRetrievals],
    ['maxConcurrentRetrievals', budget.maxConcurrentRetrievals],
    ['maxResultsPerSearchCall', budget.maxResultsPerSearchCall],
    ['maxCandidatesPerModality', budget.maxCandidatesPerModality],
    ['maxResultsPerSubquestion', budget.maxResultsPerSubquestion],
    ['maxUniqueEvidenceChunks', budget.maxUniqueEvidenceChunks],
    ['maxEvidenceTokens', budget.maxEvidenceTokens],
  ];
  for (const [name, value] of intFields) {
    if (!isNonNegativeInt(value)) violations.push(`${name} must be a non-negative integer`);
  }
  for (const [toolName, limit] of Object.entries(budget.maxCallsByTool)) {
    if (!isNonNegativeInt(limit)) violations.push(`maxCallsByTool[${toolName}] must be a non-negative integer`);
  }
  for (const [name, value] of [
    ['maxInputTokens', budget.maxInputTokens],
    ['maxOutputTokens', budget.maxOutputTokens],
    ['maxEstimatedCostMicros', budget.maxEstimatedCostMicros],
  ] as const) {
    if (value !== undefined && !isNonNegativeInt(value)) {
      violations.push(`${name} must be a non-negative integer when set`);
    }
  }
  return violations;
}

export function createAgentRunBudget(input: CreateAgentRunBudgetInput): AgentRunBudget {
  if (!Number.isFinite(input.nowMs)) {
    throw new Error('createAgentRunBudget: nowMs must be a finite timestamp');
  }
  const deadlineInMs = input.deadlineInMs ?? DEFAULT_DEADLINE_IN_MS;
  if (!Number.isFinite(deadlineInMs) || deadlineInMs < 0) {
    throw new Error('createAgentRunBudget: deadlineInMs must be a finite number >= 0');
  }
  const requestedReserve = input.finalizeReserveMs ?? DEFAULT_FINALIZE_RESERVE_MS;
  if (!Number.isFinite(requestedReserve) || requestedReserve < 0) {
    throw new Error('createAgentRunBudget: finalizeReserveMs must be a finite number >= 0');
  }
  // The finalize reserve can never exceed the run envelope; clamping keeps
  // childTimeoutMs non-negative by construction instead of failing late.
  const finalizeReserveMs = Math.min(Math.floor(requestedReserve), Math.floor(deadlineInMs));
  const overrides = input.overrides ?? {};
  if (overrides.maxEstimatedCostMicros !== undefined) {
    throw new Error('createAgentRunBudget: maxEstimatedCostMicros requires provider pricing that is not configured.');
  }
  const budget: AgentRunBudget = {
    deadlineAt: input.nowMs + deadlineInMs,
    finalizeReserveMs,
    maxModelSteps: pickInt(overrides.maxModelSteps, 8),
    maxTotalToolCalls: pickInt(overrides.maxTotalToolCalls, 10),
    maxSearchCalls: pickInt(overrides.maxSearchCalls, 4),
    maxSearchPlans: pickInt(overrides.maxSearchPlans, 2),
    maxPhysicalRetrievals: pickInt(overrides.maxPhysicalRetrievals, 24),
    maxConcurrentRetrievals: pickInt(overrides.maxConcurrentRetrievals, 4),
    maxResultsPerSearchCall: pickInt(overrides.maxResultsPerSearchCall, 10),
    maxCandidatesPerModality: pickInt(overrides.maxCandidatesPerModality, 30),
    maxResultsPerSubquestion: pickInt(overrides.maxResultsPerSubquestion, 3),
    maxUniqueEvidenceChunks: pickInt(overrides.maxUniqueEvidenceChunks, 30),
    maxEvidenceTokens: pickInt(overrides.maxEvidenceTokens, 8000),
    maxCallsByTool: Object.freeze({ ...DEFAULT_MAX_CALLS_BY_TOOL, ...overrides.maxCallsByTool }),
    ...(overrides.maxInputTokens === undefined ? {} : { maxInputTokens: overrides.maxInputTokens }),
    ...(overrides.maxOutputTokens === undefined ? {} : { maxOutputTokens: overrides.maxOutputTokens }),
    ...(overrides.maxEstimatedCostMicros === undefined
      ? {}
      : { maxEstimatedCostMicros: overrides.maxEstimatedCostMicros }),
  };
  const violations = validateBudget(budget);
  if (violations.length > 0) {
    throw new Error(`createAgentRunBudget: invalid budget: ${violations.join('; ')}`);
  }
  return Object.freeze(budget);
}

export const DEFAULT_AGENT_RUN_BUDGET: AgentRunBudget = createAgentRunBudget({ nowMs: Date.now() });

export function remainingModelSteps(budget: AgentRunBudget, usedSteps: number): number {
  return Math.max(0, budget.maxModelSteps - usedSteps);
}

export function remainingTotalCalls(budget: AgentRunBudget, usedCalls: number): number {
  return Math.max(0, budget.maxTotalToolCalls - usedCalls);
}

export function remainingCallsForTool(
  budget: AgentRunBudget,
  toolName: string,
  usedCalls: number,
): number {
  const limit = budget.maxCallsByTool[toolName] ?? Number.POSITIVE_INFINITY;
  return Math.max(0, limit - usedCalls);
}

export function canStartNewModelStep(
  budget: AgentRunBudget,
  usedSteps: number,
  nowMs: number,
): boolean {
  // Strict inequality: at the exact reserve boundary the child timeout is
  // already zero, so no new work fits and none may start.
  return usedSteps < budget.maxModelSteps && nowMs < budget.deadlineAt - budget.finalizeReserveMs;
}

// Latest instant at which child work may still start; the finalize reserve is
// never lent to model calls or retrievals.
export function childTimeoutMs(budget: AgentRunBudget, nowMs: number, p95EstimateMs: number): number {
  return Math.max(0, Math.min(budget.deadlineAt - budget.finalizeReserveMs - nowMs, p95EstimateMs));
}
