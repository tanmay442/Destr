import { describe, expect, it } from 'vitest';
import { aggregateResults, fingerprint, percentile, type AgentCaseReport } from './agent-report';

function caseReport(overrides: Partial<AgentCaseReport> & { readonly caseId: string }): AgentCaseReport {
  return {
    categories: [],
    primaryCategory: 'doc_search',
    expectedTools: ['searchDocumentation'],
    actualTools: ['searchDocumentation'],
    argumentsValid: true,
    outcomeStates: ['results'],
    queryVariants: [],
    callIds: [],
    subquestionIds: [],
    queryIds: [],
    documentIds: [],
    documentUids: [],
    chunkUids: [],
    perSubquestionQuotas: {},
    backfillCount: 0,
    truncationReasons: [],
    stopReason: 'completed',
    answerDecision: 'candidate_released',
    groundingExpectation: 'verified',
    citations: [],
    evidenceTokens: 0,
    latency: { totalMs: 1 },
    modelTokens: { input: 10, output: 5, cacheRead: null, cacheWrite: null, status: 'unsupported' },
    errorCategories: [],
    passed: true,
    ...overrides,
  };
}

describe('agent-report math', () => {
  it('percentiles are deterministic and null on empty input', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([-1, Number.NaN], 0.95)).toBeNull();
  });

  it('fingerprints are deterministic across identical inputs', () => {
    expect(fingerprint(['a', 'b'])).toBe(fingerprint(['a', 'b']));
    expect(fingerprint(['a', 'b'])).not.toBe(fingerprint(['a', 'c']));
  });

  it('aggregates tool recall/precision, no-tool accuracy, and latency', () => {
    const results = [
      caseReport({ caseId: 'a', expectedTools: ['searchDocumentation'], actualTools: ['searchDocumentation'], latency: { totalMs: 10 } }),
      caseReport({ caseId: 'b', expectedTools: ['searchDocumentation'], actualTools: [], passed: false, latency: { totalMs: 20 } }),
      caseReport({ caseId: 'c', expectedTools: [], actualTools: [], latency: { totalMs: 30 } }),
    ];
    const aggregate = aggregateResults(results);
    expect(aggregate.cases).toBe(3);
    expect(aggregate.passed).toBe(2);
    expect(aggregate.failed).toBe(1);
    expect(aggregate.toolSelectionRecall).toBeCloseTo(0.5);
    expect(aggregate.toolSelectionPrecision).toBe(1);
    expect(aggregate.noToolAccuracy).toBe(1);
    expect(aggregate.latencyP50).toBe(20);
    expect(aggregate.safetyViolations).toBe(0);
    expect(aggregate.judgeFailures).toBe(0);
    expect(aggregate.costCompleteness).toBe('unknown');
    expect(aggregate.costMicros).toBeNull();
  });

  it('never labels partial cost as total: cost stays unknown without pricing', () => {
    const aggregate = aggregateResults([caseReport({ caseId: 'a' })]);
    expect(aggregate.costCompleteness).not.toBe('complete');
    expect(JSON.stringify(aggregate)).not.toContain('total_cost');
  });
});
