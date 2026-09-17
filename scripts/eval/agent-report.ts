import { createHash, randomUUID } from 'node:crypto';
import type { AgentGoldenCase } from './agent-golden-corpus';
import { AGENT_GOLDEN_CORPUS_VERSION } from './agent-golden-corpus';

export const AGENT_EVAL_REPORT_SCHEMA_VERSION = 'agent-eval-report.v1';

export type AgentEvalGate = 'mock' | 'real' | 'adversarial' | 'cost';

export interface AgentCaseLatency {
  readonly totalMs: number;
  readonly retrievalMs?: number;
  readonly verificationMs?: number;
}

export interface AgentCaseTokens {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly status: 'reported' | 'unsupported' | 'missing';
}

export interface AgentCaseReport {
  readonly caseId: string;
  readonly categories: readonly string[];
  readonly primaryCategory: string;
  readonly expectedTools: readonly string[];
  readonly actualTools: readonly string[];
  readonly argumentsValid: boolean;
  readonly outcomeStates: readonly string[];
  readonly queryVariants: readonly string[];
  readonly callIds: readonly string[];
  readonly subquestionIds: readonly string[];
  readonly queryIds: readonly string[];
  readonly documentIds: readonly number[];
  readonly documentUids: readonly string[];
  readonly chunkUids: readonly string[];
  readonly perSubquestionQuotas: Readonly<Record<string, number>>;
  readonly backfillCount: number;
  readonly truncationReasons: readonly string[];
  readonly stopReason: string;
  readonly answerDecision: string;
  readonly groundingExpectation: string;
  readonly citations: readonly string[];
  readonly evidenceTokens: number;
  readonly latency: AgentCaseLatency;
  readonly modelTokens: AgentCaseTokens;
  readonly errorCategories: readonly string[];
  readonly passed: boolean;
  readonly notes?: string;
}

export interface AgentAggregate {
  readonly cases: number;
  readonly passed: number;
  readonly failed: number;
  readonly toolSelectionRecall: number | null;
  readonly toolSelectionPrecision: number | null;
  readonly noToolAccuracy: number | null;
  readonly safetyViolations: number;
  readonly unverifiedCount: number;
  readonly judgeFailures: number;
  readonly latencyP50: number | null;
  readonly latencyP95: number | null;
  readonly latencyP99: number | null;
  readonly modelCalls: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costMicros: number | null;
  readonly costCompleteness: 'complete' | 'partial' | 'unknown';
}

export interface AgentEvalReport {
  readonly schemaVersion: typeof AGENT_EVAL_REPORT_SCHEMA_VERSION;
  readonly gate: AgentEvalGate;
  readonly runId: string;
  readonly commit: string;
  readonly dirty: boolean;
  readonly timestamp: string;
  readonly modelId: string;
  readonly providerId: string;
  readonly toolCapabilityMode: string;
  readonly toolContractVersion: string;
  readonly corpusId: string;
  readonly corpusFingerprint: string;
  readonly documentSnapshotId: string;
  readonly configFingerprint: string;
  readonly status: 'pass' | 'fail' | 'unverified';
  readonly statusReason: string;
  readonly results: readonly AgentCaseReport[];
  readonly aggregate: AgentAggregate;
}

export function fingerprint(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part, 'utf8');
    hash.update('\u0000', 'utf8');
  }
  return `sha256:${hash.digest('hex')}`;
}

export function newRunId(): string {
  return `agent-eval-${randomUUID()}`;
}

export function corpusFingerprint(cases: readonly AgentGoldenCase[]): string {
  return fingerprint([
    AGENT_GOLDEN_CORPUS_VERSION,
    ...cases.map((entry) => `${entry.id}\u0000${entry.primaryCategory}\u0000${entry.userText}`),
  ]);
}

export function percentile(values: readonly number[], fraction: number): number | null {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower];
  if (lowerValue === undefined) return null;
  if (lower === upper) return lowerValue;
  const upperValue = sorted[upper];
  if (upperValue === undefined) return lowerValue;
  return Math.round((lowerValue + (upperValue - lowerValue) * (position - lower)) * 1000) / 1000;
}

export function aggregateResults(results: readonly AgentCaseReport[]): AgentAggregate {
  const passed = results.filter((result) => result.passed).length;
  const searchExpected = results.filter((result) => result.expectedTools.includes('searchDocumentation'));
  const searchHit = searchExpected.filter((result) => result.actualTools.includes('searchDocumentation')).length;
  const searchActual = results.filter((result) => result.actualTools.includes('searchDocumentation'));
  const searchCorrect = searchActual.filter((result) => result.expectedTools.includes('searchDocumentation')).length;
  const noToolExpected = results.filter((result) => result.expectedTools.length === 0);
  const noToolHit = noToolExpected.filter((result) => result.actualTools.length === 0).length;
  const latencies = results.map((result) => result.latency.totalMs);
  const inputSum = results.reduce<number | null>((acc, result) => {
    if (result.modelTokens.input === null) return acc;
    return (acc ?? 0) + result.modelTokens.input;
  }, null);
  const outputSum = results.reduce<number | null>((acc, result) => {
    if (result.modelTokens.output === null) return acc;
    return (acc ?? 0) + result.modelTokens.output;
  }, null);
  return {
    cases: results.length,
    passed,
    failed: results.length - passed,
    toolSelectionRecall: searchExpected.length > 0 ? searchHit / searchExpected.length : null,
    toolSelectionPrecision: searchActual.length > 0 ? searchCorrect / searchActual.length : null,
    noToolAccuracy: noToolExpected.length > 0 ? noToolHit / noToolExpected.length : null,
    safetyViolations: results.filter((result) => result.errorCategories.includes('safety')).length,
    unverifiedCount: results.filter((result) => result.answerDecision === 'unverified').length,
    judgeFailures: 0,
    latencyP50: percentile(latencies, 0.5),
    latencyP95: percentile(latencies, 0.95),
    latencyP99: percentile(latencies, 0.99),
    modelCalls: results.length,
    inputTokens: inputSum,
    outputTokens: outputSum,
    costMicros: null,
    costCompleteness: 'unknown',
  };
}

export function buildAgentEvalReport(input: {
  readonly gate: AgentEvalGate;
  readonly runId: string;
  readonly commit: string;
  readonly dirty: boolean;
  readonly modelId: string;
  readonly providerId: string;
  readonly toolCapabilityMode: string;
  readonly toolContractVersion: string;
  readonly documentSnapshotId: string;
  readonly configFingerprint: string;
  readonly corpus: readonly AgentGoldenCase[];
  readonly results: readonly AgentCaseReport[];
  readonly status: 'pass' | 'fail' | 'unverified';
  readonly statusReason: string;
}): AgentEvalReport {
  return {
    schemaVersion: AGENT_EVAL_REPORT_SCHEMA_VERSION,
    gate: input.gate,
    runId: input.runId,
    commit: input.commit,
    dirty: input.dirty,
    timestamp: new Date().toISOString(),
    modelId: input.modelId,
    providerId: input.providerId,
    toolCapabilityMode: input.toolCapabilityMode,
    toolContractVersion: input.toolContractVersion,
    corpusId: AGENT_GOLDEN_CORPUS_VERSION,
    corpusFingerprint: corpusFingerprint(input.corpus),
    documentSnapshotId: input.documentSnapshotId,
    configFingerprint: input.configFingerprint,
    status: input.status,
    statusReason: input.statusReason,
    results: input.results,
    aggregate: aggregateResults(input.results),
  };
}
