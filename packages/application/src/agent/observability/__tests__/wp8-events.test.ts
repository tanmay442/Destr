import { describe, expect, it } from 'vitest';
import { EVENT_VERSION, TOOL_CATALOG_VERSION } from '../agent-event';
import {
  WP8_EVENT_TYPES,
  WP8_NUMERIC_BOUNDS,
  WP8_STORAGE_FORBIDDEN,
  assertWp8EventVersion,
  assertWp8ExactlyOneTerminal,
  assertWp8StepLabelsSafe,
  buildWp8Counters,
  assertWp8CounterKeysBounded,
  buildWp8StepCostTelemetry,
  createWp8Event,
  describeWp8StoragePlacement,
  fingerprintWp8Context,
  isWp8TerminalEvent,
  redactWp8Event,
  rollupWp8StepCosts,
  validateWp8EventOrdering,
  wp8StepCostLabels,
  type Wp8Event,
  type Wp8OrderableEvent,
} from '../wp8-events';
import { createInMemoryTraceWriter } from '../trace-writer';
import { assertMetricLabelsSafe, redactAttributes } from '../redaction';
import { createEvent } from '../agent-event';
import { normalizeStepUsage } from '../usage-normalizer';

let sequence = 0;

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  sequence += 1;
  return {
    eventVersion: 1,
    eventId: `wp8-evt-${sequence}`,
    traceId: 'trace-001',
    turnId: 'turn-001',
    eventType: 'cache.lookup',
    startedAt: '2026-09-13T00:00:01.000Z',
    elapsedMs: 5,
    status: 'completed',
    configurationFingerprint: 'config-v1',
    agentBudgetVersion: 'budget-v1',
    toolCatalogVersion: TOOL_CATALOG_VERSION,
    deploymentVersion: 'deploy-v1',
    attributes: {},
    cacheLayer: 'prompt_prefix',
    outcome: 'hit',
    reason: 'version_match',
    latencyMs: 4,
    ...overrides,
  };
}

function wp7Started(turnId = 'turn-001', startedAt = '2026-09-13T00:00:00.000Z') {
  return createEvent(
    envelope({
      eventType: 'turn.started',
      startedAt,
      status: 'started',
      turnId,
      cacheLayer: undefined,
      outcome: undefined,
      reason: undefined,
      latencyMs: undefined,
    }),
  );
}

function wp7Terminal(turnId = 'turn-001', startedAt = '2026-09-13T00:00:05.000Z') {
  return createEvent(
    envelope({
      eventType: 'turn.terminal',
      startedAt,
      status: 'completed',
      turnId,
      cacheLayer: undefined,
      outcome: undefined,
      reason: undefined,
      latencyMs: undefined,
      terminalState: 'answered_verified',
      decisiveReason: 'grounding_verified',
      releasedOutput: 'verified_answer',
      persistenceStatus: 'persisted',
    }),
  );
}

function toOrderable(event: { turnId: string; startedAt: string; eventType: string }): Wp8OrderableEvent {
  return {
    eventVersion: 1,
    eventType: event.eventType,
    turnId: event.turnId,
    startedAt: event.startedAt,
  };
}

describe('wp8 event families', () => {
  it('validates one event from every additive WP-8 family on the shared envelope', () => {
    const events: Wp8Event[] = [
      createWp8Event(envelope({ eventType: 'cache.lookup' })),
      createWp8Event(
        envelope({
          eventType: 'cache.store',
          cacheLayer: 'embedding',
          outcome: 'stored',
          reason: 'versioned_key',
          latencyMs: undefined,
        }),
      ),
      createWp8Event(
        envelope({
          eventType: 'cache.evicted',
          cacheLayer: 'retrieval_candidates',
          reason: 'ttl_expired',
          evictedCount: 3,
          outcome: undefined,
          latencyMs: undefined,
        }),
      ),
      createWp8Event(
        envelope({
          eventType: 'admission.lease',
          action: 'acquired',
          leaseKind: 'user_turn',
          reason: 'within_capacity',
          cacheLayer: undefined,
          outcome: undefined,
          latencyMs: undefined,
        }),
      ),
      createWp8Event(
        envelope({
          eventType: 'admission.queue',
          action: 'shed',
          queueKind: 'interactive',
          queueDepth: 12,
          waitMs: 40,
          shedReason: 'queue_full',
          cacheLayer: undefined,
          outcome: undefined,
          reason: undefined,
          latencyMs: undefined,
        }),
      ),
      createWp8Event(
        envelope({
          eventType: 'capacity.rejected',
          reason: 'provider_throttle',
          retryAfterMs: 1000,
          shedBeforeModelWork: true,
          cacheLayer: undefined,
          outcome: undefined,
          latencyMs: undefined,
        }),
      ),
      createWp8Event(
        envelope({
          eventType: 'progress.emitted',
          phase: 'searching',
          labelCode: 'progress_searching_docs',
          completed: 1,
          total: 2,
          payloadBytes: 200,
          cacheLayer: undefined,
          outcome: undefined,
          reason: undefined,
          latencyMs: undefined,
        }),
      ),
      createWp8Event(
        envelope({
          eventType: 'stream.heartbeat',
          reason: 'silence_keepalive',
          intervalMs: 10_000,
          cacheLayer: undefined,
          outcome: undefined,
          latencyMs: undefined,
        }),
      ),
      createWp8Event(
        envelope({
          eventType: 'deadline.phase',
          phase: 'model_loop',
          outcome: 'completed',
          remainingMs: 30_000,
          cacheLayer: undefined,
          reason: undefined,
          latencyMs: undefined,
        }),
      ),
      createWp8Event(
        envelope({
          eventType: 'budget.exhausted',
          budgetKind: 'model_steps',
          outcome: 'exhausted',
          used: 8,
          limit: 8,
          cacheLayer: undefined,
          reason: undefined,
          latencyMs: undefined,
        }),
      ),
      createWp8Event(
        envelope({
          eventType: 'dependency.call',
          dependency: 'redis',
          outcome: 'ok',
          latencyMs: 6,
          orphaned: false,
          cacheLayer: undefined,
          reason: undefined,
        }),
      ),
      createWp8Event(
        envelope({
          eventType: 'pool.wait',
          poolKind: 'neon_pooled',
          outcome: 'acquired',
          waitMs: 20,
          waitingCount: 0,
          cacheLayer: undefined,
          reason: undefined,
          latencyMs: undefined,
        }),
      ),
      createWp8Event(
        envelope({
          eventType: 'pool.query',
          poolKind: 'neon_pooled',
          queryClass: 'vector',
          outcome: 'completed',
          latencyMs: 120,
          orphaned: false,
          cacheLayer: undefined,
          reason: undefined,
        }),
      ),
      createWp8Event(
        envelope({
          eventType: 'persistence.result',
          store: 'turn_summary',
          persistenceStatus: 'persisted',
          reason: 'write_ok',
          cacheLayer: undefined,
          outcome: undefined,
          latencyMs: undefined,
        }),
      ),
      createWp8Event(
        envelope({
          eventType: 'background.job',
          jobKind: 'sampled_judge',
          action: 'enqueued',
          attemptCount: 0,
          backlogAgeMs: null,
          cacheLayer: undefined,
          outcome: undefined,
          reason: undefined,
          latencyMs: undefined,
        }),
      ),
      createWp8Event(
        envelope({
          eventType: 'breaker.transition',
          breaker: 'redis_cache',
          fromState: 'closed',
          toState: 'open',
          reason: 'error_threshold',
          cacheLayer: undefined,
          outcome: undefined,
          latencyMs: undefined,
        }),
      ),
    ];
    expect(events).toHaveLength(WP8_EVENT_TYPES.length);
    for (const event of events) {
      expect(Object.isFrozen(event)).toBe(true);
      assertWp8EventVersion(event);
    }
  });

  it('keeps EVENT_VERSION at 1 and rejects a version bump', () => {
    expect(EVENT_VERSION).toBe(1);
    expect(() => createWp8Event(envelope({ eventVersion: 2 }))).toThrow();
    expect(() => assertWp8EventVersion({ eventVersion: 2 })).toThrow(/eventVersion/);
  });

  it('requires explicit persistence status on every persistence event', () => {
    for (const persistenceStatus of ['persisted', 'durably_queued', 'failed', 'skipped']) {
      const event = createWp8Event(
        envelope({
          eventType: 'persistence.result',
          store: 'history_write',
          persistenceStatus,
          reason: 'write_ok',
          cacheLayer: undefined,
          outcome: undefined,
          latencyMs: undefined,
        }),
      );
      if (event.eventType === 'persistence.result') {
        expect(event.persistenceStatus).toBe(persistenceStatus);
      } else {
        throw new Error('expected persistence.result event');
      }
    }
    expect(() =>
      createWp8Event(
        envelope({
          eventType: 'persistence.result',
          store: 'history_write',
          reason: 'write_ok',
          persistenceStatus: undefined,
          cacheLayer: undefined,
          outcome: undefined,
          latencyMs: undefined,
        }),
      ),
    ).toThrow();
  });
});

describe('wp8 redaction and low-cardinality labels', () => {
  it('strips secret, reasoning, query, args, error, and document content classes', () => {
    const { redacted, removedKeys } = redactAttributes({
      environment: 'production',
      provider: 'openai_compatible',
      status: 'completed',
      systemPrompt: 'hidden instructions',
      reasoning: 'private chain of thought',
      queryText: 'how do I reset my password',
      toolArgs: '{"limit":3}',
      rawProviderError: 'provider 500 trace payload',
      documentText: 'runbook paragraph',
      secret: 'sk-abcdef1234567890abcdef',
      userEmail: 'someone@example.com',
    });
    expect(redacted).toEqual({
      environment: 'production',
      provider: 'openai_compatible',
      status: 'completed',
    });
    expect(removedKeys.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(redacted);
    for (const leak of [
      'hidden instructions',
      'chain of thought',
      'reset my password',
      '"limit":3',
      'trace payload',
      'runbook paragraph',
      'sk-abcdef1234567890abcdef',
      'someone@example.com',
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it('redacts WP-8 envelope attributes while keeping bounded enum fields', () => {
    const event = createWp8Event(
      envelope({
        attributes: {
          environment: 'production',
          userMessage: 'must not survive',
          secret: 'sk-abcdef1234567890abcdef',
        },
      }),
    );
    const redacted = redactWp8Event(event);
    expect(redacted.attributes).toEqual({ environment: 'production' });
    if (redacted.eventType === 'cache.lookup') {
      expect(redacted.reason).toBe('version_match');
    } else {
      throw new Error('expected cache.lookup event');
    }
    expect(JSON.stringify(redacted)).not.toContain('must not survive');
  });

  it('drops unknown free-text fields from progress events instead of storing them', () => {
    const parsed = createWp8Event(
      envelope({
        eventType: 'progress.emitted',
        phase: 'searching',
        labelCode: 'progress_searching_docs',
        completed: 1,
        total: 2,
        payloadBytes: 200,
        cacheLayer: undefined,
        outcome: undefined,
        reason: undefined,
        latencyMs: undefined,
        queryText: 'raw user query must not persist',
        toolArgs: '{"limit":5}',
      }),
    );
    expect('queryText' in parsed).toBe(false);
    expect('toolArgs' in parsed).toBe(false);
  });

  it('asserts step-cost labels are low-cardinality and rejects content values', () => {
    const labels = wp8StepCostLabels({
      provider: 'openai_compatible',
      modelId: 'chat-model-v1',
      promptVersion: 'system-v3',
      toolCatalogVersion: TOOL_CATALOG_VERSION,
      schemaDigest: 'abc123ef',
      cacheStatus: 'reported',
      completeness: 'complete',
    });
    expect(labels.provider).toBe('openai_compatible');
    expect(() =>
      assertMetricLabelsSafe({
        environment: 'production',
        status: 'completed',
        modality: 'vector',
      }),
    ).not.toThrow();
    expect(() =>
      assertWp8StepLabelsSafe({ ...labels, modelId: 'how do I reset my password' }),
    ).toThrow(/unbounded/);
    expect(() =>
      assertWp8StepLabelsSafe({ ...labels, modelId: 'sk-abcdef1234567890abcdef' }),
    ).toThrow(/secret-shaped/);
    expect(() =>
      assertWp8StepLabelsSafe({
        ...labels,
        modelId: '550e8400-e29b-41d4-a716-446655440000',
      }),
    ).toThrow(/opaque identifier/);
    expect(() => assertWp8StepLabelsSafe({ ...labels, rawQuery: 'reset' })).toThrow(/label key/);
  });
});

describe('wp8 numeric hardening (N2)', () => {
  it('rejects NaN, Infinity, floats, negatives, and over-max numerics', () => {
    const badValues = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      1.5,
      WP8_NUMERIC_BOUNDS.maxLatencyMs + 1,
    ];
    for (const latencyMs of badValues) {
      expect(() => createWp8Event(envelope({ latencyMs }))).toThrow();
    }
    expect(() =>
      createWp8Event(
        envelope({ eventType: 'pool.wait', poolKind: 'redis', outcome: 'acquired', waitMs: 1, waitingCount: WP8_NUMERIC_BOUNDS.maxQueueDepth + 1, cacheLayer: undefined, reason: undefined, latencyMs: undefined }),
      ),
    ).toThrow();
    expect(() =>
      createWp8Event(
        envelope({
          eventType: 'progress.emitted',
          phase: 'searching',
          labelCode: 'progress_searching_docs',
          completed: 0,
          total: 1,
          payloadBytes: WP8_NUMERIC_BOUNDS.maxPayloadBytes + 1,
          cacheLayer: undefined,
          outcome: undefined,
          reason: undefined,
          latencyMs: undefined,
        }),
      ),
    ).toThrow();
  });
});

describe('wp8 reason codes are enum-bounded (N3)', () => {
  it('rejects free-string reasons, outcomes, phases, and label codes', () => {
    expect(() =>
      createWp8Event(envelope({ reason: 'connection reset by peer at db-primary' })),
    ).toThrow();
    expect(() =>
      createWp8Event(
        envelope({
          eventType: 'breaker.transition',
          breaker: 'database',
          fromState: 'closed',
          toState: 'open',
          reason: 'something unexpected happened upstream',
          cacheLayer: undefined,
          outcome: undefined,
          latencyMs: undefined,
        }),
      ),
    ).toThrow();
    expect(() =>
      createWp8Event(
        envelope({
          eventType: 'progress.emitted',
          phase: 'searching',
          labelCode: 'Searching documentation for reset password flow',
          completed: 1,
          total: 2,
          payloadBytes: 100,
          cacheLayer: undefined,
          outcome: undefined,
          reason: undefined,
          latencyMs: undefined,
        }),
      ),
    ).toThrow();
    expect(() =>
      createWp8Event(
        envelope({
          eventType: 'capacity.rejected',
          reason: 'too much traffic right now, try later',
          retryAfterMs: null,
          shedBeforeModelWork: true,
          cacheLayer: undefined,
          outcome: undefined,
          latencyMs: undefined,
        }),
      ),
    ).toThrow();
    expect(() =>
      createWp8Event(
        envelope({
          eventType: 'background.job',
          jobKind: 'sampled_judge',
          action: 'dropped',
          attemptCount: 3,
          backlogAgeMs: 1000,
          cacheLayer: undefined,
          outcome: undefined,
          reason: undefined,
          latencyMs: undefined,
        }),
      ),
    ).toThrow(/dropReason/);
  });

  it('pins capacity rejection to shed-before-model-work', () => {
    expect(() =>
      createWp8Event(
        envelope({
          eventType: 'capacity.rejected',
          reason: 'queue_full',
          retryAfterMs: null,
          shedBeforeModelWork: false,
          cacheLayer: undefined,
          outcome: undefined,
          latencyMs: undefined,
        }),
      ),
    ).toThrow();
  });
});

describe('wp8 ordering and terminal authority', () => {
  it('accepts WP-8 events between turn.started and turn.terminal', () => {
    const started = toOrderable(wp7Started());
    const lookup = toOrderable(createWp8Event(envelope()));
    const terminal = toOrderable(wp7Terminal());
    expect(() => validateWp8EventOrdering([started, lookup, terminal])).not.toThrow();
    expect(assertWp8ExactlyOneTerminal([started, lookup, terminal])).toBe(terminal);
  });

  it('rejects a terminal without turn.started even when WP-8 events exist', () => {
    const lookup = toOrderable(createWp8Event(envelope()));
    const terminal = toOrderable(wp7Terminal());
    expect(() => validateWp8EventOrdering([lookup, terminal])).toThrow(/without turn.started/);
  });

  it('rejects a terminal predating turn.started', () => {
    const started = toOrderable(wp7Started('turn-001', '2026-09-13T00:00:10.000Z'));
    const terminal = toOrderable(wp7Terminal('turn-001', '2026-09-13T00:00:01.000Z'));
    expect(() => validateWp8EventOrdering([started, terminal])).toThrow(/predates/);
  });

  it('never treats eviction or other WP-8 events as terminals (N4)', () => {
    const started = toOrderable(wp7Started());
    const terminal = toOrderable(wp7Terminal());
    const evicted = toOrderable(
      createWp8Event(
        envelope({
          eventType: 'cache.evicted',
          cacheLayer: 'answer',
          reason: 'capacity_pressure',
          evictedCount: 9,
          outcome: undefined,
          latencyMs: undefined,
          startedAt: '2026-09-13T00:00:06.000Z',
        }),
      ),
    );
    for (const eventType of WP8_EVENT_TYPES) {
      expect(isWp8TerminalEvent({ eventType })).toBe(false);
    }
    expect(assertWp8ExactlyOneTerminal([started, terminal, evicted])).toBe(terminal);
    expect(() => assertWp8ExactlyOneTerminal([started, evicted])).toThrow(/exactly one/);
    expect(() => assertWp8ExactlyOneTerminal([started, terminal, terminal])).toThrow(
      /exactly one/,
    );
  });

  it('keeps writer-level duplicate-terminal idempotency when eviction arrives late', () => {
    const writer = createInMemoryTraceWriter();
    writer.emit(wp7Started());
    const first = wp7Terminal('turn-001', '2026-09-13T00:00:05.000Z');
    writer.emit(first);
    expect(writer.terminalFor('turn-001')).toBe(first);
    expect(writer.stats()).toMatchObject({ duplicateTerminals: 0, turnsWithTerminal: 1 });
  });
});

describe('wp8 fingerprints (N1 corpus coverage, N6 sampling params)', () => {
  const base = {
    corpusId: 'corpus-v7',
    documentSnapshotId: 'synthetic-mock-corpus.v2',
    configHash: 'config-v1',
    promptVersion: 'system-v3',
    toolCatalogVersion: TOOL_CATALOG_VERSION,
    schemaDigest: 'abc123ef',
    priceVersion: 'prices-2026-09',
    sampling: { traceSampleRate: 0.05, judgeSampleRate: 0.1, seed: 'seed-1' },
  };

  it('is stable for identical input and rotates on corpus or sampling changes', () => {
    const first = fingerprintWp8Context(base);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintWp8Context({ ...base })).toBe(first);
    expect(fingerprintWp8Context({ ...base, corpusId: 'corpus-v8' })).not.toBe(first);
    expect(fingerprintWp8Context({ ...base, documentSnapshotId: 'other-snapshot' })).not.toBe(
      first,
    );
    expect(
      fingerprintWp8Context({ ...base, sampling: { ...base.sampling, traceSampleRate: 0.5 } }),
    ).not.toBe(first);
    expect(
      fingerprintWp8Context({ ...base, sampling: { ...base.sampling, seed: 'seed-2' } }),
    ).not.toBe(first);
  });

  it('requires corpus identity and bounded sampling rates', () => {
    const { corpusId: _corpusId, ...withoutCorpus } = base;
    expect(_corpusId).toBe('corpus-v7');
    expect(() => fingerprintWp8Context(withoutCorpus)).toThrow();
    const { documentSnapshotId: _documentSnapshotId, ...withoutSnapshot } = base;
    expect(_documentSnapshotId).toBe('synthetic-mock-corpus.v2');
    expect(() => fingerprintWp8Context(withoutSnapshot)).toThrow();
    expect(() =>
      fingerprintWp8Context({
        ...base,
        sampling: { ...base.sampling, traceSampleRate: Number.NaN },
      }),
    ).toThrow();
    expect(() =>
      fingerprintWp8Context({
        ...base,
        sampling: { ...base.sampling, judgeSampleRate: 2 },
      }),
    ).toThrow();
  });
});

describe('wp8 counters, storage, and cost rollup', () => {
  it('builds bounded counters whose keys stay low-cardinality', () => {
    const events = [
      createWp8Event(envelope()),
      createWp8Event(envelope({ outcome: 'miss', reason: 'ttl_expired' })),
      createWp8Event(
        envelope({
          eventType: 'breaker.transition',
          breaker: 'database',
          fromState: 'open',
          toState: 'half_open',
          reason: 'cooldown_elapsed',
          cacheLayer: undefined,
          outcome: undefined,
          latencyMs: undefined,
        }),
      ),
    ];
    const counters = buildWp8Counters(events);
    expect(counters).toEqual({
      'wp8.cache.lookup:hit': 1,
      'wp8.cache.lookup:miss': 1,
      'wp8.breaker.transition:half_open': 1,
    });
    expect(() => assertWp8CounterKeysBounded(counters)).not.toThrow();
    expect(() =>
      assertWp8CounterKeysBounded({ 'wp8.cache.lookup:how do I reset my password': 1 }),
    ).toThrow(/unbounded/);
    expect(() => assertWp8CounterKeysBounded({ 'wp8.unknown.family:hit': 1 })).toThrow(
      /unknown counter family/,
    );
  });

  it('places high-volume families outside the primary DB trajectory table', () => {
    for (const eventType of WP8_EVENT_TYPES) {
      const placement = describeWp8StoragePlacement(eventType);
      expect(typeof placement).toBe('string');
      expect(WP8_STORAGE_FORBIDDEN.join(' ')).not.toContain(placement);
    }
    expect(WP8_STORAGE_FORBIDDEN).toContain('per_step_jsonb_trajectory_table');
    expect(describeWp8StoragePlacement('persistence.result')).toBe(
      'existing_postgres_chat_events_path',
    );
    expect(describeWp8StoragePlacement('background.job')).toBe('existing_durable_queue');
  });

  it('keeps turn cost consistent with per-step costs without claiming a total', () => {
    const steps = [
      normalizeStepUsage({
        inputTokensTotal: { value: 100, status: 'reported' },
        cacheReadTokens: { value: 40, status: 'reported' },
        cacheWriteTokens: { value: 10, status: 'reported' },
        uncachedTokens: { value: 60, status: 'reported' },
        outputTokens: { value: 20, status: 'reported' },
      }),
      normalizeStepUsage({}),
    ];
    const rates = {
      uncachedInputMicrosPerToken: 2,
      cacheReadMicrosPerToken: 1,
      cacheWriteMicrosPerToken: 3,
      outputMicrosPerToken: 10,
      priceVersion: 'prices-2026-09',
    };
    const rollup = rollupWp8StepCosts(steps, rates);
    expect(rollup.perStepMicros).toHaveLength(2);
    expect(rollup.micros).toBe(rollup.perStepMicros[0]! + rollup.perStepMicros[1]!);
    expect(rollup.completeness).toBe('partial');
    expect(rollupWp8StepCosts([steps[0]!], rates).completeness).toBe('complete');
  });

  it('builds per-step cost telemetry with TTFT, latency, and version labels', () => {
    const telemetry = buildWp8StepCostTelemetry({
      stepNumber: 2,
      provider: 'google',
      usage: normalizeStepUsage({
        inputTokensTotal: { value: 80, status: 'reported' },
        cacheReadTokens: { value: 20, status: 'reported' },
        cacheWriteTokens: { value: 10, status: 'reported' },
        uncachedTokens: { value: 60, status: 'reported' },
        outputTokens: { value: 5, status: 'reported' },
      }),
      rates: {
        uncachedInputMicrosPerToken: 8,
        cacheReadMicrosPerToken: 2,
        cacheWriteMicrosPerToken: 8,
        outputMicrosPerToken: 24,
        priceVersion: 'prices-2026-09',
      },
      timeToFirstTokenMs: 120,
      latencyMs: 900,
      promptVersion: 'system-v3',
      toolCatalogVersion: TOOL_CATALOG_VERSION,
      schemaDigest: 'abc123ef',
    });
    expect(telemetry.providerStatus).toBe('reported');
    expect(telemetry.costCompleteness).toBe('complete');
    expect(telemetry.billableMicros).toBe(60 * 8 + 20 * 2 + 10 * 8 + 5 * 24);
    expect(Object.isFrozen(telemetry)).toBe(true);
  });
});
