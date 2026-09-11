import { describe, expect, it } from 'vitest';
import {
  canStartNewModelStep,
  childTimeoutMs,
  createAgentRunBudget,
  remainingCallsForTool,
  remainingModelSteps,
  remainingTotalCalls,
  validateBudget,
} from '../agent-budget';
import { appendEvent, createInitialRunState } from '../agent-state';
import type { AgentEvent } from '../agent-state';
import { detectDuplicateCall, normalizeArgsHash, pickEarliestStop } from '../agent-stop';
import type { AgentStopReason } from '../agent-stop';
import { redactTelemetry, summarizeRun } from '../agent-telemetry';
import type { AgentStepTelemetry } from '../agent-telemetry';
import { readSupportAgentFlag } from '../agent-flags';

function envWith(value: string | undefined): { get(key: string): string | undefined } {
  return { get: (key: string) => (key === 'SUPPORT_AGENT_ENABLED' ? value : undefined) };
}

describe('agent budget', () => {
  it('applies documented defaults', () => {
    const budget = createAgentRunBudget({ nowMs: 1000 });
    expect(budget.deadlineAt).toBe(51_000);
    expect(budget.finalizeReserveMs).toBe(15_000);
    expect(budget.maxModelSteps).toBe(8);
    expect(budget.maxTotalToolCalls).toBe(10);
    expect(budget.maxSearchCalls).toBe(4);
    expect(budget.maxSearchPlans).toBe(2);
    expect(budget.maxPhysicalRetrievals).toBe(24);
    expect(budget.maxConcurrentRetrievals).toBe(4);
    expect(budget.maxResultsPerSearchCall).toBe(10);
    expect(budget.maxCandidatesPerModality).toBe(30);
    expect(budget.maxResultsPerSubquestion).toBe(3);
    expect(budget.maxUniqueEvidenceChunks).toBe(30);
    expect(budget.maxEvidenceTokens).toBe(8000);
    expect(budget.maxCallsByTool).toEqual({ searchDocumentation: 4, createKnowledgeTicket: 1 });
    expect(budget.maxInputTokens).toBeUndefined();
    expect(Object.isFrozen(budget)).toBe(true);
    expect(validateBudget(budget)).toEqual([]);
  });

  it('clamps the finalize reserve to the deadline envelope', () => {
    const budget = createAgentRunBudget({ nowMs: 0, deadlineInMs: 5000, finalizeReserveMs: 99999 });
    expect(budget.finalizeReserveMs).toBe(5000);
    expect(budget.deadlineAt).toBe(5000);
  });

  it('rejects invalid maxima and unsupported cost accounting', () => {
    expect(() => createAgentRunBudget({ nowMs: 0, overrides: { maxModelSteps: 0 } })).toThrow();
    expect(() => createAgentRunBudget({ nowMs: 0, overrides: { maxSearchCalls: -1 } })).toThrow();
    expect(() =>
      createAgentRunBudget({ nowMs: 0, overrides: { maxCallsByTool: { x: 1.5 } } }),
    ).toThrow();
    expect(() =>
      createAgentRunBudget({ nowMs: 0, overrides: { maxEstimatedCostMicros: 1 } }),
    ).toThrow(/provider pricing/);
    const valid = createAgentRunBudget({ nowMs: 0 });
    expect(validateBudget({ ...valid, maxSearchPlans: -2 })).toContain(
      'maxSearchPlans must be a non-negative integer',
    );
  });

  it('computes remaining budgets and child timeouts against the reserve', () => {
    const budget = createAgentRunBudget({ nowMs: 1000 });
    expect(remainingModelSteps(budget, 6)).toBe(2);
    expect(remainingModelSteps(budget, 99)).toBe(0);
    expect(remainingTotalCalls(budget, 9)).toBe(1);
    expect(remainingCallsForTool(budget, 'searchDocumentation', 3)).toBe(1);
    expect(remainingCallsForTool(budget, 'unlistedTool', 3)).toBe(Number.POSITIVE_INFINITY);
    expect(canStartNewModelStep(budget, 7, 1000)).toBe(true);
    expect(canStartNewModelStep(budget, 8, 1000)).toBe(false);
    expect(canStartNewModelStep(budget, 0, 35_999)).toBe(true);
    expect(canStartNewModelStep(budget, 0, 36_000)).toBe(false);
    expect(childTimeoutMs(budget, 1000, 8000)).toBe(8000);
    expect(childTimeoutMs(budget, 35_000, 8000)).toBe(1000);
    expect(childTimeoutMs(budget, 36_000, 8000)).toBe(0);
    expect(childTimeoutMs(budget, 100_000, 8000)).toBe(0);
  });
});

describe('agent stop conditions', () => {
  it('hashes args with stable key order', () => {
    const first = normalizeArgsHash({ b: 2, a: 1 });
    expect(normalizeArgsHash({ a: 1, b: 2 })).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(normalizeArgsHash({ a: 1 })).not.toBe(normalizeArgsHash({ a: 2 }));
    expect(normalizeArgsHash({ query: ' foo ', nested: [' bar '] })).toBe(
      normalizeArgsHash({ query: 'foo', nested: ['bar'] }),
    );
  });

  it('detects duplicates by exact tool and hash equality', () => {
    const seen = [{ toolName: 'searchDocumentation', normalizedArgsHash: 'abc' }];
    expect(detectDuplicateCall(seen, { toolName: 'searchDocumentation', normalizedArgsHash: 'abc' })).toBe(
      true,
    );
    expect(detectDuplicateCall(seen, { toolName: 'searchDocumentation', normalizedArgsHash: 'abd' })).toBe(
      false,
    );
    expect(detectDuplicateCall(seen, { toolName: 'other', normalizedArgsHash: 'abc' })).toBe(false);
    expect(detectDuplicateCall([], { toolName: 'searchDocumentation', normalizedArgsHash: 'abc' })).toBe(
      false,
    );
  });

  it('resolves competing stops by priority', () => {
    const completed: AgentStopReason = { kind: 'completed' };
    const cancelled: AgentStopReason = { kind: 'cancelled' };
    expect(pickEarliestStop([completed, cancelled])).toEqual(cancelled);
    expect(
      pickEarliestStop([
        { kind: 'max_total_tool_calls', used: 10, limit: 10 },
        { kind: 'timeout', timeoutMs: 5000 },
      ]),
    ).toEqual({ kind: 'timeout', timeoutMs: 5000 });
    expect(
      pickEarliestStop([
        { kind: 'approval_interrupted', toolName: 't', callId: 'c' },
        { kind: 'duplicate_tool_call', toolName: 't', normalizedArgs: 'h' },
      ]).kind,
    ).toBe('duplicate_tool_call');
    expect(
      pickEarliestStop([{ kind: 'completed' }, { kind: 'model_requested_stop' }]).kind,
    ).toBe('model_requested_stop');
  });
});

describe('agent run state', () => {
  it('reduces events immutably into frozen state', () => {
    const initial = createInitialRunState('run-1');
    const afterStart = appendEvent(initial, { type: 'run_started', runId: 'run-1', atMs: 10 });
    const afterStep = appendEvent(afterStart, {
      type: 'step_started',
      stepNumber: 1,
      activeTools: ['searchDocumentation'],
      atMs: 20,
    });
    const afterCall = appendEvent(afterStep, {
      type: 'tool_called',
      toolName: 'searchDocumentation',
      callId: 'call-1',
      argsHash: 'hash-1',
      atMs: 30,
    });
    const afterFinish = appendEvent(afterCall, {
      type: 'tool_finished',
      toolName: 'searchDocumentation',
      callId: 'call-1',
      kind: 'success',
      durationMs: 40,
    });
    const stopped = appendEvent(afterFinish, {
      type: 'stopped',
      reason: { kind: 'max_search_calls', used: 4, limit: 4 },
      atMs: 50,
    });
    expect(initial.events).toEqual([]);
    expect(initial.steps).toEqual([]);
    expect(initial.status).toBe('running');
    expect(stopped.status).toBe('stopped');
    expect(stopped.stopReason).toEqual({ kind: 'max_search_calls', used: 4, limit: 4 });
    expect(stopped.events).toHaveLength(5);
    expect(stopped.steps).toHaveLength(1);
    expect(stopped.steps[0]?.toolCalls).toEqual([
      { toolName: 'searchDocumentation', callId: 'call-1', argsHash: 'hash-1', kind: 'success' },
    ]);
    expect(Object.isFrozen(stopped)).toBe(true);
    expect(Object.isFrozen(stopped.events)).toBe(true);
    expect(Object.isFrozen(stopped.steps)).toBe(true);
    const approvalEvent: AgentEvent = {
      type: 'approval_interrupted',
      toolName: 'createKnowledgeTicket',
      callId: 'call-2',
      atMs: 35,
    };
    const approval = appendEvent(afterStep, approvalEvent);
    expect(approval.status).toBe('awaiting_approval');
    expect(afterStep.status).toBe('running');
  });
});

describe('agent telemetry', () => {
  const steps: AgentStepTelemetry[] = [
    {
      stepNumber: 1,
      activeTools: ['searchDocumentation'],
      toolName: 'searchDocumentation',
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      cacheStatus: 'reported',
      physicalRetrievals: 4,
      evidenceAdded: 3,
    },
    {
      stepNumber: 2,
      activeTools: ['searchDocumentation'],
      toolName: null,
      durationMs: 50,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      cacheStatus: 'missing',
      physicalRetrievals: 0,
      evidenceAdded: 0,
    },
  ];

  it('summarizes deterministically with stable key order', () => {
    const reason: AgentStopReason = { kind: 'completed' };
    const first = summarizeRun({
      runId: 'run-1',
      steps,
      stopReason: reason,
      startedAtMs: 1000,
      endedAtMs: 1500,
      searchCalls: 1,
      physicalRetrievals: 4,
      uniqueEvidenceChunks: 3,
      evidenceTokens: 120,
    });
    const second = summarizeRun({
      runId: 'run-1',
      steps,
      stopReason: reason,
      startedAtMs: 1000,
      endedAtMs: 1500,
      searchCalls: 1,
      physicalRetrievals: 4,
      uniqueEvidenceChunks: 3,
      evidenceTokens: 120,
    });
    expect(second).toEqual(first);
    expect(first.totalModelSteps).toBe(2);
    expect(first.totalToolCalls).toBe(1);
    expect(first.callsByTool).toEqual({ searchDocumentation: 1 });
    expect(Object.keys(first.callsByTool)).toEqual(['searchDocumentation']);
    expect(first.totalDurationMs).toBe(500);
    expect(first.traceVersion).toBe('agent-trace-v1');
  });

  it('redacts secret-like strings while keeping numerics', () => {
    const tainted: AgentStepTelemetry = {
      stepNumber: 1,
      activeTools: ['searchDocumentation', 'token=secret-value'],
      toolName: 'leak@example.com',
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      cacheStatus: 'reported',
      physicalRetrievals: 4,
      evidenceAdded: 3,
    };
    const redacted = redactTelemetry(tainted);
    expect(redacted.toolName).toBe('[redacted]');
    expect(redacted.activeTools).toEqual(['searchDocumentation', '[redacted]']);
    expect(redacted.durationMs).toBe(100);
    expect(redacted.cacheStatus).toBe('reported');
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('leak@example.com');
    expect(serialized).not.toContain('token=secret-value');
  });
});

describe('support agent flag', () => {
  it('defaults to enabled and parses explicit values', () => {
    expect(readSupportAgentFlag(envWith(undefined))).toEqual({ enabled: true, source: 'default' });
    expect(readSupportAgentFlag(envWith('1'))).toEqual({ enabled: true, source: 'env' });
    expect(readSupportAgentFlag(envWith('YES'))).toEqual({ enabled: true, source: 'env' });
    expect(readSupportAgentFlag(envWith('0'))).toEqual({ enabled: false, source: 'env' });
    expect(readSupportAgentFlag(envWith('off'))).toEqual({ enabled: false, source: 'env' });
  });
});
