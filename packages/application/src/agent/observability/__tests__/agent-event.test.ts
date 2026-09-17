import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EVENT_VERSION,
  TOOL_CATALOG_VERSION,
  TURN_TERMINAL_STATES,
  assertEventVersion,
  assertExactlyOneTerminal,
  createEnvelope,
  createEvent,
  isTerminalEvent,
  validateEventOrdering,
  type AgentEvent,
} from '../agent-event';

function baseEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventVersion: 1,
    eventId: 'evt-001',
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

function terminalEvent(overrides: Record<string, unknown> = {}): AgentEvent {
  return createEvent(
    baseEnvelope({
      eventType: 'turn.terminal',
      status: 'completed',
      startedAt: '2026-09-13T00:00:05.000Z',
      elapsedMs: 5000,
      terminalState: 'answered_verified',
      decisiveReason: 'grounding_verified',
      releasedOutput: 'verified_answer',
      persistenceStatus: 'persisted',
      ...overrides,
    }),
  );
}

describe('agent-event envelope', () => {
  it('accepts a valid envelope and freezes the output', () => {
    const envelope = createEnvelope(baseEnvelope({ attributes: { environment: 'test' } }));
    expect(envelope.eventVersion).toBe(EVENT_VERSION);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.attributes)).toBe(true);
  });

  it('rejects wrong versions, bad timestamps, and unknown statuses', () => {
    expect(() => createEnvelope(baseEnvelope({ eventVersion: 2 }))).toThrow();
    expect(() => createEnvelope(baseEnvelope({ startedAt: 'not-a-date' }))).toThrow();
    expect(() => createEnvelope(baseEnvelope({ status: 'bogus' }))).toThrow();
    expect(() => createEnvelope(baseEnvelope({ eventId: '' }))).toThrow();
  });

  it('re-exports the production tool catalog version', () => {
    expect(TOOL_CATALOG_VERSION).toBe('tool-catalog-v1');
  });
});

describe('agent-event families', () => {
  it('accepts one event from every required family', () => {
    const events: AgentEvent[] = [
      createEvent(baseEnvelope({ eventType: 'turn.received' })),
      createEvent(
        baseEnvelope({
          eventType: 'turn.admission',
          admissionDecision: 'admitted',
        }),
      ),
      createEvent(baseEnvelope({ eventType: 'turn.started' })),
      terminalEvent(),
      createEvent(baseEnvelope({ eventType: 'model.step.started', stepNumber: 1 })),
      createEvent(
        baseEnvelope({
          eventType: 'model.step.first_token',
          stepNumber: 1,
          timeToFirstTokenMs: 120,
        }),
      ),
      createEvent(
        baseEnvelope({
          eventType: 'model.step.completed',
          status: 'completed',
          stepNumber: 1,
          finishReason: 'tool_calls',
          inputTokensTotal: 100,
          cacheReadTokens: 40,
          tokenStatus: 'reported',
        }),
      ),
      createEvent(
        baseEnvelope({ eventType: 'tool.available', toolName: 'searchDocumentation' }),
      ),
      createEvent(
        baseEnvelope({
          eventType: 'tool.selected',
          toolName: 'searchDocumentation',
          callId: 'call-1',
        }),
      ),
      createEvent(
        baseEnvelope({
          eventType: 'tool.started',
          toolName: 'searchDocumentation',
          callId: 'call-1',
        }),
      ),
      createEvent(
        baseEnvelope({
          eventType: 'tool.terminal',
          status: 'completed',
          toolName: 'searchDocumentation',
          callId: 'call-1',
          resultKind: 'success',
          durationMs: 300,
        }),
      ),
      createEvent(
        baseEnvelope({
          eventType: 'search.plan',
          intent: 'documentation',
          subquestionCount: 2,
          variantCount: 4,
          callId: 'call-1',
        }),
      ),
      createEvent(
        baseEnvelope({
          eventType: 'search.subquestion',
          subquestionId: 'sq-1',
          executedQueryIds: ['q-1', 'q-2'],
          callId: 'call-1',
        }),
      ),
      createEvent(
        baseEnvelope({
          eventType: 'search.retrieval',
          modality: 'vector',
          candidateCount: 20,
          status: 'completed',
          callId: 'call-1',
          subquestionId: 'sq-1',
          queryId: 'q-1',
        }),
      ),
      createEvent(
        baseEnvelope({
          eventType: 'search.rerank',
          finalSignal: 'reranker',
          rankedCount: 10,
          fallbackUsed: false,
          callId: 'call-1',
          subquestionId: 'sq-1',
        }),
      ),
      createEvent(
        baseEnvelope({
          eventType: 'evidence.backfill',
          requestedNew: 3,
          addedNew: 2,
          reason: 'pool_exhausted',
          callId: 'call-1',
          subquestionId: 'sq-1',
        }),
      ),
      createEvent(
        baseEnvelope({
          eventType: 'evidence.pack',
          uniqueChunks: 5,
          evidenceTokens: 1200,
          truncatedBy: ['turn_token_limit'],
          partial: true,
        }),
      ),
      createEvent(
        baseEnvelope({
          eventType: 'grounding.validation',
          decision: 'verified',
          citationCount: 2,
        }),
      ),
    ];
    expect(events).toHaveLength(18);
    for (const event of events) {
      expect(Object.isFrozen(event)).toBe(true);
      assertEventVersion(event);
    }
  });

  it('accepts exactly the 12 specified turn terminal states', () => {
    expect(TURN_TERMINAL_STATES).toHaveLength(12);
    for (const terminalState of TURN_TERMINAL_STATES) {
      const event = terminalEvent({ terminalState });
      expect(event.eventType).toBe('turn.terminal');
      if (event.eventType === 'turn.terminal') expect(event.terminalState).toBe(terminalState);
    }
    expect(() => terminalEvent({ terminalState: 'answered_maybe' })).toThrow();
  });

  it('rejects unknown event types', () => {
    expect(() => createEvent(baseEnvelope({ eventType: 'model.step.hallucinated' }))).toThrow();
  });
});

describe('terminal helpers', () => {
  it('returns the single terminal event', () => {
    const started = createEvent(baseEnvelope({ eventType: 'turn.started' }));
    const terminal = terminalEvent();
    expect(isTerminalEvent(started)).toBe(false);
    expect(isTerminalEvent(terminal)).toBe(true);
    expect(assertExactlyOneTerminal([started, terminal])).toBe(terminal);
  });

  it('throws on zero terminals', () => {
    const started = createEvent(baseEnvelope({ eventType: 'turn.started' }));
    expect(() => assertExactlyOneTerminal([started])).toThrow(/exactly one/);
    expect(() => assertExactlyOneTerminal([])).toThrow(/exactly one/);
  });

  it('throws on two terminals', () => {
    expect(() => assertExactlyOneTerminal([terminalEvent(), terminalEvent()])).toThrow(
      /exactly one/,
    );
  });
});

describe('event ordering', () => {
  it('accepts started before terminal for a turn', () => {
    const started = createEvent(
      baseEnvelope({ eventType: 'turn.started', startedAt: '2026-09-13T00:00:00.000Z' }),
    );
    expect(() => validateEventOrdering([started, terminalEvent()])).not.toThrow();
  });

  it('rejects a terminal without a preceding start', () => {
    expect(() => validateEventOrdering([terminalEvent()])).toThrow(/without turn.started/);
  });

  it('rejects a terminal predating the start', () => {
    const started = createEvent(
      baseEnvelope({ eventType: 'turn.started', startedAt: '2026-09-13T00:00:10.000Z' }),
    );
    const early = terminalEvent({ startedAt: '2026-09-13T00:00:01.000Z' });
    expect(() => validateEventOrdering([started, early])).toThrow(/predates/);
  });

  it('rejects mismatched event versions', () => {
    expect(() => assertEventVersion({ eventVersion: 0 })).toThrow(/eventVersion/);
    expect(() => assertEventVersion({ eventVersion: 2 })).toThrow(/eventVersion/);
    expect(() => assertEventVersion({ eventVersion: EVENT_VERSION })).not.toThrow();
  });
});

describe('observability import graph', () => {
  const SOURCES = [
    'agent-event.ts',
    'redaction.ts',
    'trace-writer.ts',
    'usage-normalizer.ts',
    'index.ts',
  ];
  const FORBIDDEN_FAMILIES = [
    'ai',
    '@ai-sdk',
    '@clerk',
    'next',
    'drizzle-orm',
    'drizzle-kit',
    'drizzle',
    'pdf-lib',
    'pg',
    '@neondatabase',
    'unpdf',
    '@upstash',
    'ioredis',
    'redis',
    'bullmq',
    '@xenova/transformers',
    'onnxruntime-node',
    '@opentelemetry',
    '@sentry',
    'react',
  ];

  function specifiersOf(source: string): string[] {
    const found: string[] = [];
    const pattern = /(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1];
      if (specifier !== undefined) found.push(specifier);
    }
    return found;
  }

  it('imports only zod and relative modules', () => {
    for (const file of SOURCES) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      for (const specifier of specifiersOf(source)) {
        const forbidden = FORBIDDEN_FAMILIES.find(
          (family) => specifier === family || specifier.startsWith(`${family}/`),
        );
        expect(forbidden, `${file} imports forbidden ${specifier}`).toBeUndefined();
        const allowed = specifier === 'zod' || specifier.startsWith('.');
        expect(allowed, `${file} imports unexpected ${specifier}`).toBe(true);
      }
    }
  });
});
