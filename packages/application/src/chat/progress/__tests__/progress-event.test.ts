import { describe, expect, it } from 'vitest';
import {
  AGENT_PROGRESS_PHASES,
  AgentProgressEventSchema,
  assertNoForbiddenProgressFields,
  assertP99BytesWithinBudget,
  assertP99ProgressPayloadWithinBudget,
  assertProgressPayloadWithinBudget,
  assertProgressTransient,
  createProgressEvent,
  FORBIDDEN_PROGRESS_FIELDS,
  isTerminalProgressEvent,
  isTerminalProgressPhase,
  MAX_PROGRESS_PAYLOAD_BYTES,
  PROGRESS_LABEL_CODES,
  PROGRESS_PART_TYPE,
  serializedProgressSizeBytes,
  serializeProgressEvent,
  stripProgressParts,
} from '../progress-event';

function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt-1',
    phase: 'searching',
    status: 'updated',
    labelCode: 'search_running',
    elapsedMs: 1200,
    ...overrides,
  };
}

describe('progress event schema', () => {
  it('accepts a valid event and freezes it', () => {
    const event = createProgressEvent(validInput());
    expect(event.phase).toBe('searching');
    expect(event.labelCode).toBe('search_running');
    expect(Object.isFrozen(event)).toBe(true);
  });

  it('accepts every required phase and terminal vocabulary', () => {
    expect([...AGENT_PROGRESS_PHASES]).toEqual([
      'accepted',
      'checking_cache',
      'planning',
      'searching',
      'reranking',
      'reading_sources',
      'drafting',
      'verifying',
      'saving',
      'complete',
      'degraded',
      'cancelled',
    ]);
    for (const phase of ['complete', 'degraded', 'cancelled'] as const) {
      expect(isTerminalProgressPhase(phase)).toBe(true);
      const terminal = createProgressEvent(
        validInput({ phase, labelCode: 'answer_complete', status: phase === 'complete' ? 'completed' : 'failed' }),
      );
      expect(isTerminalProgressEvent(terminal)).toBe(true);
    }
    expect(isTerminalProgressPhase('searching')).toBe(false);
    expect(PROGRESS_PART_TYPE).toBe('data-agent-progress');
  });

  it('accepts bounded provenance and counters', () => {
    const event = createProgressEvent(
      validInput({ callId: 'call-1', subquestionId: 'sq-1', completed: 1, total: 2 }),
    );
    expect(event.callId).toBe('call-1');
    expect(event.subquestionId).toBe('sq-1');
    expect(event.completed).toBe(1);
    expect(event.total).toBe(2);
  });

  it('rejects unknown phases, label codes, and statuses', () => {
    expect(() => createProgressEvent(validInput({ phase: 'thinking' }))).toThrow();
    expect(() => createProgressEvent(validInput({ labelCode: 'Searching the docs now!' }))).toThrow();
    expect(() => createProgressEvent(validInput({ status: 'streaming' }))).toThrow();
    expect(() => AgentProgressEventSchema.parse(validInput({ extra: 'nope' }))).toThrow();
  });

  it('rejects unbounded identifiers and incoherent counters', () => {
    expect(() => createProgressEvent(validInput({ id: 'x'.repeat(101) }))).toThrow();
    expect(() => createProgressEvent(validInput({ callId: 'c'.repeat(101) }))).toThrow();
    expect(() => createProgressEvent(validInput({ completed: 10_000 }))).toThrow();
    expect(() => createProgressEvent(validInput({ completed: 3, total: 2 }))).toThrow();
    expect(() => createProgressEvent(validInput({ elapsedMs: -1 }))).toThrow();
    expect(() => createProgressEvent(validInput({ id: '' }))).toThrow();
  });
});

describe('progress redaction', () => {
  it('rejects reasoning, queries, tool args, provider errors, and document text', () => {
    const hostile: Record<string, unknown> = {
      reasoning: 'private chain of thought',
      queryText: 'raw user query text',
      toolArgs: { q: 'x' },
      providerError: 'upstream 500 with key',
      documentText: 'proprietary corpus chunk',
      ticketBody: 'user ticket content',
      apiKey: 'sk-secret',
    };
    for (const [key, value] of Object.entries(hostile)) {
      expect(() => createProgressEvent(validInput({ [key]: value })), `field ${key}`).toThrow();
      expect(() => assertNoForbiddenProgressFields({ [key]: value }), `field ${key}`).toThrow();
    }
    // Nested occurrences are rejected too.
    expect(() => assertNoForbiddenProgressFields({ outer: { content: 'doc text' } })).toThrow();
    expect(() =>
      assertNoForbiddenProgressFields([{ labelCode: 'search_running', query: 'leak' }]),
    ).toThrow();
  });

  it('pins the forbidden vocabulary including ticket, identity, and secret fields', () => {
    for (const field of ['reasoning', 'query', 'toolArgs', 'providerError', 'documentText', 'ticketBody', 'email', 'secret', 'content']) {
      expect(FORBIDDEN_PROGRESS_FIELDS.map((name) => name.toLowerCase())).toContain(field.toLowerCase());
    }
  });

  it('keeps every label code bounded and renderable as fixed text', () => {
    expect(PROGRESS_LABEL_CODES.length).toBeGreaterThan(0);
    for (const code of PROGRESS_LABEL_CODES) {
      expect(typeof code).toBe('string');
      expect(code.length).toBeLessThanOrEqual(64);
    }
  });
});

describe('progress payload budget', () => {
  it('serializes deterministically with fixed key order', () => {
    const event = createProgressEvent(validInput({ callId: 'call-1' }));
    const text = serializeProgressEvent(event);
    expect(Object.keys(JSON.parse(text) as Record<string, unknown>)).toEqual([
      'id',
      'phase',
      'status',
      'labelCode',
      'elapsedMs',
      'callId',
    ]);
    expect(serializeProgressEvent(event)).toBe(text);
  });

  it('holds the largest schema-valid event within 512 bytes', () => {
    const largest = createProgressEvent({
      id: 'i'.repeat(100),
      phase: 'reading_sources',
      status: 'updated',
      labelCode: 'degraded_partial',
      elapsedMs: 999_999_999,
      callId: 'c'.repeat(100),
      subquestionId: 's'.repeat(100),
      completed: 9999,
      total: 9999,
    });
    const size = assertProgressPayloadWithinBudget(largest);
    expect(size).toBeLessThanOrEqual(MAX_PROGRESS_PAYLOAD_BYTES);
    expect(serializedProgressSizeBytes(largest)).toBe(size);
  });

  it('asserts p99 payload statistics across many events', () => {
    const events = Array.from({ length: 50 }, (_, index) =>
      createProgressEvent(
        validInput({ id: `evt-${index}`, elapsedMs: index, completed: index % 3, total: 2 }),
      ),
    );
    const stats = assertP99ProgressPayloadWithinBudget(events);
    expect(stats.count).toBe(50);
    expect(stats.p99).toBeLessThanOrEqual(MAX_PROGRESS_PAYLOAD_BYTES);
    expect(stats.max).toBeGreaterThanOrEqual(stats.p99);
    expect(stats.p50).toBeLessThanOrEqual(stats.p99);
    expect(Object.isFrozen(stats)).toBe(true);
  });

  it('rejects a p99 over budget through the byte-level helper', () => {
    expect(() => assertP99BytesWithinBudget([100, 200, 600])).toThrow(/p99/);
    expect(assertP99BytesWithinBudget([])).toEqual({ count: 0, p50: 0, p99: 0, max: 0 });
    expect(assertP99BytesWithinBudget([512])).toEqual({ count: 1, p50: 512, p99: 512, max: 512 });
  });
});

describe('progress transience', () => {
  const history = [{ type: 'text', text: 'hello' }];
  const modelMessages = [{ role: 'user', text: 'hello' }];
  const cachedAnswers = [{ answer: 'cached', citations: [] }];
  const evidence = [{ chunkUid: 'doc-1:0', source: 'docs' }];

  it('passes clean history, model input, cache, and evidence payloads', () => {
    expect(() =>
      assertProgressTransient({ history, modelMessages, cachedAnswers, evidence }),
    ).not.toThrow();
  });

  it('rejects a progress part in every persistence surface', () => {
    const leaked = [{ type: PROGRESS_PART_TYPE, data: { phase: 'searching' } }];
    expect(() =>
      assertProgressTransient({ history: leaked, modelMessages, cachedAnswers, evidence }),
    ).toThrow(/history/);
    expect(() =>
      assertProgressTransient({ history, modelMessages: leaked, cachedAnswers, evidence }),
    ).toThrow(/modelMessages/);
    expect(() =>
      assertProgressTransient({ history, modelMessages, cachedAnswers: leaked, evidence }),
    ).toThrow(/cachedAnswers/);
    expect(() =>
      assertProgressTransient({ history, modelMessages, cachedAnswers, evidence: leaked }),
    ).toThrow(/evidence/);
  });

  it('strips progress parts before persistence without touching other parts', () => {
    const parts = [
      { type: 'text', text: 'answer' },
      { type: PROGRESS_PART_TYPE, data: { phase: 'searching' } },
      { type: 'data-citation', data: { id: 1 } },
    ];
    const stripped = stripProgressParts(parts);
    expect(stripped).toHaveLength(2);
    expect(stripped.map((part) => part.type)).toEqual(['text', 'data-citation']);
    expect(Object.isFrozen(stripped)).toBe(true);
  });
});
