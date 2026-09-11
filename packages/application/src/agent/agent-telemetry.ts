import type { AgentStopReason } from './agent-stop';

export const TRACE_VERSION = 'agent-trace-v1' as const;

export type AgentCacheStatus = 'reported' | 'unsupported' | 'missing';

export interface AgentStepTelemetry {
  readonly stepNumber: number;
  readonly activeTools: readonly string[];
  readonly toolName: string | null;
  readonly durationMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly cacheStatus: AgentCacheStatus;
  readonly physicalRetrievals: number;
  readonly evidenceAdded: number;
}

export interface AgentRunSummary {
  readonly runId: string;
  readonly totalModelSteps: number;
  readonly totalToolCalls: number;
  readonly callsByTool: Readonly<Record<string, number>>;
  readonly searchPlans: number;
  readonly searchCalls: number;
  readonly physicalRetrievals: number;
  readonly uniqueEvidenceChunks: number;
  readonly evidenceTokens: number;
  readonly inputTokensUsed: number | null;
  readonly outputTokensUsed: number | null;
  readonly estimatedCostMicros: number | null;
  readonly stopReason: AgentStopReason;
  readonly totalDurationMs: number;
  readonly traceVersion: string;
}

export interface SummarizeRunInput {
  readonly runId: string;
  readonly steps: readonly AgentStepTelemetry[];
  readonly stopReason: AgentStopReason;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly searchPlans?: number;
  readonly searchCalls?: number;
  readonly physicalRetrievals?: number;
  readonly uniqueEvidenceChunks?: number;
  readonly evidenceTokens?: number;
  readonly inputTokensUsed?: number | null;
  readonly outputTokensUsed?: number | null;
  readonly estimatedCostMicros?: number | null;
}

export function summarizeRun(input: SummarizeRunInput): AgentRunSummary {
  const counts: Record<string, number> = {};
  let totalToolCalls = 0;
  for (const step of input.steps) {
    if (step.toolName === null) continue;
    totalToolCalls += 1;
    counts[step.toolName] = (counts[step.toolName] ?? 0) + 1;
  }
  // Deterministic key order: identical inputs always serialize identically.
  const ordered: Record<string, number> = {};
  for (const key of Object.keys(counts).sort()) {
    const count = counts[key];
    if (count !== undefined) ordered[key] = count;
  }
  const summary: AgentRunSummary = {
    runId: input.runId,
    totalModelSteps: input.steps.length,
    totalToolCalls,
    callsByTool: Object.freeze(ordered),
    searchPlans: input.searchPlans ?? 0,
    searchCalls: input.searchCalls ?? 0,
    physicalRetrievals: input.physicalRetrievals ?? 0,
    uniqueEvidenceChunks: input.uniqueEvidenceChunks ?? 0,
    evidenceTokens: input.evidenceTokens ?? 0,
    inputTokensUsed: input.inputTokensUsed ?? null,
    outputTokensUsed: input.outputTokensUsed ?? null,
    estimatedCostMicros: input.estimatedCostMicros ?? null,
    stopReason: Object.freeze({ ...input.stopReason }),
    totalDurationMs: input.endedAtMs - input.startedAtMs,
    traceVersion: TRACE_VERSION,
  };
  return Object.freeze(summary);
}

const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

function sanitizeIdentifier(value: string): string {
  return SAFE_IDENTIFIER.test(value) ? value : '[redacted]';
}

// Allowlist redaction: only documented numeric/enum fields and validated tool
// identifiers survive. Anything else shaped like a string is replaced, so user
// data that leaked into a telemetry field cannot pass through.
export function redactTelemetry(telemetry: AgentStepTelemetry): AgentStepTelemetry {
  const redacted: AgentStepTelemetry = {
    stepNumber: telemetry.stepNumber,
    activeTools: Object.freeze(telemetry.activeTools.map(sanitizeIdentifier)),
    toolName: telemetry.toolName === null ? null : sanitizeIdentifier(telemetry.toolName),
    durationMs: telemetry.durationMs,
    inputTokens: telemetry.inputTokens,
    outputTokens: telemetry.outputTokens,
    cacheReadTokens: telemetry.cacheReadTokens,
    cacheWriteTokens: telemetry.cacheWriteTokens,
    cacheStatus: telemetry.cacheStatus,
    physicalRetrievals: telemetry.physicalRetrievals,
    evidenceAdded: telemetry.evidenceAdded,
  };
  return Object.freeze(redacted);
}
