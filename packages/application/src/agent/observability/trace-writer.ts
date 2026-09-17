import type { AgentEvent, TurnTerminalEvent } from './agent-event';
import type { NormalizedStepUsage } from './usage-normalizer';

export interface AgentTraceWriter {
  emit(event: AgentEvent): void;
}

export const DEFAULT_MAX_TRACE_EVENTS = 5000;

export interface TraceWriterStats {
  readonly emitted: number;
  readonly accepted: number;
  readonly duplicateTerminals: number;
  readonly dropped: number;
  readonly turnsWithTerminal: number;
}

export interface BudgetCounters {
  readonly modelSteps: number;
  readonly toolCalls: number;
  readonly searchCalls: number;
  readonly physicalRetrievals: number;
}

export interface InMemoryTraceWriter extends AgentTraceWriter {
  readonly events: readonly AgentEvent[];
  readonly duplicates: readonly AgentEvent[];
  readonly droppedCount: number;
  terminalFor(turnId: string): TurnTerminalEvent | null;
  stats(): TraceWriterStats;
}

export function createInMemoryTraceWriter(
  options?: { readonly maxEvents?: number },
): InMemoryTraceWriter {
  const maxEvents = options?.maxEvents ?? DEFAULT_MAX_TRACE_EVENTS;
  if (!Number.isInteger(maxEvents) || maxEvents < 1) {
    throw new Error('createInMemoryTraceWriter: maxEvents must be a positive integer');
  }
  const accepted: AgentEvent[] = [];
  const duplicates: AgentEvent[] = [];
  const terminalByTurn = new Map<string, TurnTerminalEvent>();
  let emitted = 0;
  let dropped = 0;

  function emit(event: AgentEvent): void {
    emitted += 1;
    if (event.eventType === 'turn.terminal' && terminalByTurn.has(event.turnId)) {
      duplicates.push(event);
      return;
    }
    accepted.push(event);
    if (event.eventType === 'turn.terminal') terminalByTurn.set(event.turnId, event);
    while (accepted.length > maxEvents) {
      accepted.shift();
      dropped += 1;
    }
  }

  function terminalFor(turnId: string): TurnTerminalEvent | null {
    return terminalByTurn.get(turnId) ?? null;
  }

  function stats(): TraceWriterStats {
    return Object.freeze({
      emitted,
      accepted: accepted.length,
      duplicateTerminals: duplicates.length,
      dropped,
      turnsWithTerminal: terminalByTurn.size,
    });
  }

  return {
    emit,
    terminalFor,
    stats,
    get events(): readonly AgentEvent[] {
      return accepted;
    },
    get duplicates(): readonly AgentEvent[] {
      return duplicates;
    },
    get droppedCount(): number {
      return dropped;
    },
  };
}

export interface TurnTokenRollup {
  readonly inputTokensTotal: number | null;
  readonly outputTokens: number | null;
}

function reportedSum(values: readonly (number | null)[]): number | null {
  let sum = 0;
  let seen = false;
  for (const value of values) {
    if (value !== null) {
      sum += value;
      seen = true;
    }
  }
  return seen ? sum : null;
}

export function assertTurnRollupMatchesSteps(
  steps: readonly NormalizedStepUsage[],
  rollup: TurnTokenRollup,
): void {
  const inputSum = reportedSum(steps.map((step) => step.inputTokensTotal.value));
  const outputSum = reportedSum(steps.map((step) => step.outputTokens.value));
  if (inputSum !== rollup.inputTokensTotal) {
    throw new Error(
      `assertTurnRollupMatchesSteps: input rollup ${rollup.inputTokensTotal} != step sum ${inputSum}`,
    );
  }
  if (outputSum !== rollup.outputTokens) {
    throw new Error(
      `assertTurnRollupMatchesSteps: output rollup ${rollup.outputTokens} != step sum ${outputSum}`,
    );
  }
}

export function checkBudgetCountersConsistent(
  counters: BudgetCounters,
  executed: BudgetCounters,
): readonly string[] {
  const mismatches: string[] = [];
  const keys: readonly (keyof BudgetCounters)[] = [
    'modelSteps',
    'toolCalls',
    'searchCalls',
    'physicalRetrievals',
  ];
  for (const key of keys) {
    if (counters[key] !== executed[key]) {
      mismatches.push(`budget counter ${key}: recorded ${counters[key]} != executed ${executed[key]}`);
    }
  }
  return Object.freeze(mismatches);
}
