import { describe, expect, it } from 'vitest';
import { createEvent, TOOL_CATALOG_VERSION, type AgentEvent } from '../agent-event';
import {
  assertTurnRollupMatchesSteps,
  checkBudgetCountersConsistent,
  createInMemoryTraceWriter,
} from '../trace-writer';
import type { NormalizedStepUsage } from '../usage-normalizer';

let sequence = 0;

function baseEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  sequence += 1;
  return {
    eventVersion: 1,
    eventId: `evt-${sequence}`,
    traceId: 'trace-001',
    turnId: 'turn-001',
    eventType: 'turn.started',
    startedAt: '2026-09-13T00:00:00.000Z',
    elapsedMs: 0,
    status: 'started',
    configurationFingerprint: 'config-v1',
    agentBudgetVersion: 'budget-v1',
    toolCatalogVersion: TOOL_CATALOG_VERSION,
    deploymentVersion: 'deploy-v1',
    attributes: {},
    ...overrides,
  };
}

function terminalFor(turnId: string, startedAt: string): AgentEvent {
  return createEvent(
    baseEnvelope({
      turnId,
      eventType: 'turn.terminal',
      status: 'completed',
      startedAt,
      elapsedMs: 100,
      terminalState: 'answered_verified',
      decisiveReason: 'grounding_verified',
      releasedOutput: 'verified_answer',
      persistenceStatus: 'persisted',
    }),
  );
}

function reportedStep(input: number | null, output: number | null): NormalizedStepUsage {
  const field = (value: number | null) =>
    value === null
      ? { value: null as number | null, status: 'missing' as const }
      : { value, status: 'reported' as const };
  return Object.freeze({
    inputTokensTotal: Object.freeze(field(input)),
    cacheReadTokens: Object.freeze(field(null)),
    cacheWriteTokens: Object.freeze(field(null)),
    uncachedTokens: Object.freeze(field(null)),
    outputTokens: Object.freeze(field(output)),
    answerCacheHit: Object.freeze({ value: null, status: 'missing' as const }),
  });
}

describe('InMemoryTraceWriter', () => {
  it('collects emitted events synchronously', () => {
    const writer = createInMemoryTraceWriter();
    const started = createEvent(baseEnvelope({ eventType: 'turn.started' }));
    writer.emit(started);
    expect(writer.events).toEqual([started]);
    expect(writer.stats()).toMatchObject({ emitted: 1, accepted: 1, duplicateTerminals: 0 });
  });

  it('enforces exactly one terminal per turn with duplicate idempotency', () => {
    const writer = createInMemoryTraceWriter();
    writer.emit(createEvent(baseEnvelope({ eventType: 'turn.started' })));
    const first = terminalFor('turn-001', '2026-09-13T00:00:05.000Z');
    const late = terminalFor('turn-001', '2026-09-13T00:00:06.000Z');
    writer.emit(first);
    writer.emit(late);
    expect(writer.terminalFor('turn-001')).toBe(first);
    expect(writer.duplicates).toEqual([late]);
    expect(writer.stats()).toMatchObject({
      emitted: 3,
      duplicateTerminals: 1,
      turnsWithTerminal: 1,
    });
    const terminals = writer.events.filter((event) => event.eventType === 'turn.terminal');
    expect(terminals).toEqual([first]);
  });

  it('tracks terminals independently per turn id', () => {
    const writer = createInMemoryTraceWriter();
    writer.emit(terminalFor('turn-a', '2026-09-13T00:00:05.000Z'));
    writer.emit(terminalFor('turn-b', '2026-09-13T00:00:05.000Z'));
    expect(writer.terminalFor('turn-a')?.turnId).toBe('turn-a');
    expect(writer.terminalFor('turn-b')?.turnId).toBe('turn-b');
    expect(writer.terminalFor('turn-missing')).toBeNull();
  });

  it('bounds the buffer and counts dropped oldest events', () => {
    const writer = createInMemoryTraceWriter({ maxEvents: 3 });
    for (let index = 0; index < 5; index += 1) {
      writer.emit(createEvent(baseEnvelope({ eventType: 'turn.received' })));
    }
    expect(writer.events).toHaveLength(3);
    expect(writer.droppedCount).toBe(2);
    expect(writer.stats().dropped).toBe(2);
  });

  it('rejects invalid buffer caps', () => {
    expect(() => createInMemoryTraceWriter({ maxEvents: 0 })).toThrow(/maxEvents/);
  });
});

describe('step-sum validation', () => {
  it('passes when step sums equal the turn rollup', () => {
    const steps = [reportedStep(100, 20), reportedStep(50, 10)];
    expect(() =>
      assertTurnRollupMatchesSteps(steps, { inputTokensTotal: 150, outputTokens: 30 }),
    ).not.toThrow();
  });

  it('throws when a rollup diverges from its steps', () => {
    const steps = [reportedStep(100, 20)];
    expect(() =>
      assertTurnRollupMatchesSteps(steps, { inputTokensTotal: 999, outputTokens: 20 }),
    ).toThrow(/input rollup/);
    expect(() =>
      assertTurnRollupMatchesSteps(steps, { inputTokensTotal: 100, outputTokens: 999 }),
    ).toThrow(/output rollup/);
  });
});

describe('budget-counter consistency', () => {
  it('returns no mismatches for matching counters', () => {
    const counters = { modelSteps: 3, toolCalls: 2, searchCalls: 1, physicalRetrievals: 4 };
    expect(checkBudgetCountersConsistent(counters, { ...counters })).toEqual([]);
  });

  it('names every divergent counter', () => {
    const mismatches = checkBudgetCountersConsistent(
      { modelSteps: 3, toolCalls: 2, searchCalls: 1, physicalRetrievals: 4 },
      { modelSteps: 2, toolCalls: 2, searchCalls: 0, physicalRetrievals: 4 },
    );
    expect(mismatches).toHaveLength(2);
    expect(mismatches.join(' ')).toContain('modelSteps');
    expect(mismatches.join(' ')).toContain('searchCalls');
  });
});
