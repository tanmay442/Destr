import { describe, expect, it } from 'vitest';
import {
  MAX_PLAN_MODALITIES,
  MAX_PLAN_SUBQUESTIONS,
  MAX_PLAN_VARIANTS_PER_SUBQUESTION,
  assessBatchPlans,
  estimatePlanPhysicalOps,
  maxReferencePlanOps,
  scheduleRetrieval,
  type RetrievalSchedulerCapabilities,
  type RetrievalSchedulerConfig,
  type RetrievalWorkItem,
  type SchedulerEmbeddingBackend,
  type SchedulerRetrievalBackend,
} from '../retrieval-scheduler';

function capabilitiesFixture(
  overrides: Partial<RetrievalSchedulerCapabilities> = {},
): RetrievalSchedulerCapabilities {
  return {
    batchEmbeddings: true,
    batchedVectorSql: 'supported',
    batchedLexicalSql: 'supported',
    ...overrides,
  };
}

function configFixture(overrides: Partial<RetrievalSchedulerConfig> = {}): RetrievalSchedulerConfig {
  return {
    maxConcurrentRetrievals: 4,
    maxPhysicalOps: 500,
    embeddingBatchSize: 12,
    maxBatchSqlSize: 50,
    ...overrides,
  };
}

function workItem(index: number, overrides: Partial<RetrievalWorkItem> = {}): RetrievalWorkItem {
  const subquestion = `sq-${(index % MAX_PLAN_SUBQUESTIONS) + 1}`;
  return {
    callId: 'call-1',
    subquestionId: subquestion,
    queryId: `q-${index + 1}`,
    queryText: `query text ${index + 1}`,
    modality: index % 2 === 0 ? 'vector' : 'lexical',
    ...overrides,
  };
}

/** Maximum reference plan: 4 subquestions x 3 variants x 2 modalities. */
function maxPlanItems(): RetrievalWorkItem[] {
  const items: RetrievalWorkItem[] = [];
  let ordinal = 0;
  for (let sub = 1; sub <= MAX_PLAN_SUBQUESTIONS; sub += 1) {
    for (let variant = 1; variant <= MAX_PLAN_VARIANTS_PER_SUBQUESTION; variant += 1) {
      for (let modality = 0; modality < MAX_PLAN_MODALITIES; modality += 1) {
        ordinal += 1;
        items.push({
          callId: 'call-1',
          subquestionId: `sq-${sub}`,
          queryId: `sq-${sub}-q-${variant}`,
          queryText: `subquestion ${sub} variant ${variant}`,
          modality: modality === 0 ? 'vector' : 'lexical',
        });
      }
    }
  }
  expect(ordinal).toBe(24);
  return items;
}

function trackingRetrievalBackend(
  candidateCount = 3,
  options: { readonly failIndexes?: ReadonlySet<number> | undefined } = {},
): SchedulerRetrievalBackend & {
  readonly started: number;
  readonly startedAfterAbort: number;
  maxRunning: number;
} {
  const tracker = {
    started: 0,
    startedAfterAbort: 0,
    maxRunning: 0,
    running: 0,
  };
  return {
    get started() {
      return tracker.started;
    },
    get startedAfterAbort() {
      return tracker.startedAfterAbort;
    },
    get maxRunning() {
      return tracker.maxRunning;
    },
    execute: async (_item, input) => {
      tracker.started += 1;
      if (input.signal.aborted) tracker.startedAfterAbort += 1;
      tracker.running += 1;
      tracker.maxRunning = Math.max(tracker.maxRunning, tracker.running);
      try {
        if ((options.failIndexes ?? new Set<number>()).has(tracker.started)) {
          throw new Error('backend unavailable');
        }
        return { candidateCount };
      } finally {
        tracker.running -= 1;
      }
    },
  };
}

function stubEmbeddingBackend(vectors: readonly (readonly number[] | null)[] = []): SchedulerEmbeddingBackend & {
  readonly batches: number;
  readonly texts: readonly string[];
} {
  const seen: string[] = [];
  let batches = 0;
  return {
    get batches() {
      return batches;
    },
    get texts() {
      return seen;
    },
    embedBatch: async (texts) => {
      batches += 1;
      seen.push(...texts);
      return texts.map((_, index) => vectors[index] ?? [0.1, 0.2]);
    },
  };
}

describe('estimatePlanPhysicalOps', () => {
  it('estimates the maximum reference plan separately from result counts', () => {
    expect(maxReferencePlanOps(12)).toBe(1 + 24);
    expect(
      estimatePlanPhysicalOps({ subquestions: 4, variantsPerSubquestion: 3, modalities: 2, embeddingBatchSize: 6 }),
    ).toBe(2 + 24);
  });
});

describe('assessBatchPlans', () => {
  it('batches supported modalities within the efficient-plan ceiling', () => {
    const plans = assessBatchPlans(maxPlanItems(), configFixture(), capabilitiesFixture());
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(plan.strategy).toBe('batched');
      if (plan.strategy === 'batched') expect(plan.batchCount).toBe(1);
    }
  });

  it('rejects batching with a typed reason when unsupported or inefficient', () => {
    const items = maxPlanItems();
    const unsupported = assessBatchPlans(items, configFixture(), capabilitiesFixture({ batchedVectorSql: 'unsupported' }));
    const vectorPlan = unsupported.find((plan) => plan.modality === 'vector');
    expect(vectorPlan?.strategy).toBe('individual');
    if (vectorPlan?.strategy === 'individual') expect(vectorPlan.reason).toBe('batched_sql_unsupported');
    const oversized = assessBatchPlans(items, configFixture({ maxBatchSqlSize: 5 }), capabilitiesFixture());
    for (const plan of oversized) {
      expect(plan.strategy).toBe('individual');
      if (plan.strategy === 'individual') expect(plan.reason).toBe('batch_plan_inefficient');
    }
  });
});

describe('scheduleRetrieval fan-out and ceilings', () => {
  it('runs the maximum plan within concurrency and operation budgets with provenance', async () => {
    const items = maxPlanItems();
    const backend = trackingRetrievalBackend(3);
    const embeddings = stubEmbeddingBackend();
    const maxOps = maxReferencePlanOps(12);
    const result = await scheduleRetrieval(
      { items, config: configFixture({ maxPhysicalOps: maxOps }), capabilities: capabilitiesFixture() },
      { signal: new AbortController().signal, embedBatch: embeddings, executeRetrieval: backend },
    );
    expect(result.outcome).toEqual({ outcome: 'complete' });
    expect(result.maxObservedConcurrency).toBeLessThanOrEqual(4);
    expect(backend.maxRunning).toBeLessThanOrEqual(4);
    expect(result.physicalOpsUsed).toBeLessThanOrEqual(maxOps);
    expect(result.retrievalOpsUsed).toBe(24);
    expect(result.embeddingOpsUsed).toBe(1);
    expect(result.totalCandidates).toBe(24 * 3);
    for (const outcome of result.items) {
      expect(outcome.status).toBe('ok');
      if (outcome.status === 'ok') {
        expect(outcome.callId).toBe('call-1');
        expect(outcome.subquestionId).toMatch(/^sq-[1-4]$/);
        expect(outcome.queryId).toMatch(/^sq-[1-4]-q-[1-3]$/);
      }
    }
  });

  it('counts physical ops separately from result counts', async () => {
    const items = [workItem(0), workItem(1), workItem(2)];
    const backend = trackingRetrievalBackend(5);
    const embeddings = stubEmbeddingBackend();
    const result = await scheduleRetrieval(
      { items, config: configFixture(), capabilities: capabilitiesFixture() },
      { signal: new AbortController().signal, embedBatch: embeddings, executeRetrieval: backend },
    );
    expect(result.outcome).toEqual({ outcome: 'complete' });
    expect(result.retrievalOpsUsed).toBe(3);
    expect(result.totalCandidates).toBe(15);
    expect(result.physicalOpsUsed).toBe(result.embeddingOpsUsed + result.retrievalOpsUsed);
  });

  it('returns typed partial outcomes when the operation budget is exhausted', async () => {
    const items = Array.from({ length: 8 }, (_, index) => workItem(index));
    const backend = trackingRetrievalBackend(2);
    const result = await scheduleRetrieval(
      { items, config: configFixture({ maxPhysicalOps: 5 }), capabilities: capabilitiesFixture() },
      { signal: new AbortController().signal, executeRetrieval: backend },
    );
    expect(result.outcome).toEqual({
      outcome: 'partial',
      reason: 'operation_budget_exceeded',
      completedItems: 5,
      omittedItems: 3,
    });
    expect(result.retrievalOpsUsed).toBe(5);
    const omitted = result.items.filter((outcome) => outcome.status === 'omitted_by_budget');
    expect(omitted).toHaveLength(3);
    for (const outcome of omitted) {
      expect(outcome.callId).toBe('call-1');
      expect(outcome.subquestionId).toMatch(/^sq-[1-4]$/);
    }
  });

  it('keeps per-item errors typed without failing the schedule', async () => {
    const items = Array.from({ length: 4 }, (_, index) => workItem(index));
    const backend = trackingRetrievalBackend(2, { failIndexes: new Set([2]) });
    const result = await scheduleRetrieval(
      { items, config: configFixture(), capabilities: capabilitiesFixture() },
      { signal: new AbortController().signal, executeRetrieval: backend },
    );
    expect(result.outcome).toEqual({ outcome: 'complete' });
    const failed = result.items.filter((outcome) => outcome.status === 'error');
    expect(failed).toHaveLength(1);
    if (failed[0]?.status === 'error') {
      expect(failed[0].code).toBe('retrieval_unavailable');
      expect(failed[0].retryable).toBe(true);
    }
  });
});

describe('scheduleRetrieval batching provenance', () => {
  it('preserves call/subquestion/query ids through batched embeddings', async () => {
    const items: RetrievalWorkItem[] = [
      { callId: 'call-a', subquestionId: 'sq-1', queryId: 'q-1', queryText: 'shared text', modality: 'vector' },
      { callId: 'call-a', subquestionId: 'sq-1', queryId: 'q-2', queryText: 'shared text', modality: 'lexical' },
      { callId: 'call-b', subquestionId: 'sq-2', queryId: 'q-1', queryText: 'other text', modality: 'vector' },
    ];
    const backend = trackingRetrievalBackend(1);
    const embeddings = stubEmbeddingBackend();
    const result = await scheduleRetrieval(
      { items, config: configFixture(), capabilities: capabilitiesFixture() },
      { signal: new AbortController().signal, embedBatch: embeddings, executeRetrieval: backend },
    );
    expect(result.outcome).toEqual({ outcome: 'complete' });
    expect(embeddings.batches).toBe(1);
    expect(embeddings.texts).toEqual(['shared text', 'other text']);
    expect(result.items.map((outcome) => `${outcome.callId}/${outcome.subquestionId}/${outcome.queryId}`).sort()).toEqual(
      ['call-a/sq-1/q-1', 'call-a/sq-1/q-2', 'call-b/sq-2/q-1'],
    );
  });

  it('embeds sequentially per unique text when batching is unsupported', async () => {
    const items = [workItem(0), workItem(1), workItem(0, { modality: 'lexical', queryId: 'q-dup' })];
    const backend = trackingRetrievalBackend(1);
    const embeddings = stubEmbeddingBackend();
    const result = await scheduleRetrieval(
      { items, config: configFixture(), capabilities: capabilitiesFixture({ batchEmbeddings: false }) },
      { signal: new AbortController().signal, embedBatch: embeddings, executeRetrieval: backend },
    );
    expect(result.outcome).toEqual({ outcome: 'complete' });
    expect(embeddings.batches).toBe(2);
    expect(result.embeddingDegraded).toBe(false);
  });

  it('marks embedding degradation without failing retrieval', async () => {
    const items = [workItem(0), workItem(1)];
    const backend = trackingRetrievalBackend(1);
    const failing: SchedulerEmbeddingBackend = {
      embedBatch: async () => {
        throw new Error('embedding backend down');
      },
    };
    const result = await scheduleRetrieval(
      { items, config: configFixture(), capabilities: capabilitiesFixture() },
      { signal: new AbortController().signal, embedBatch: failing, executeRetrieval: backend },
    );
    expect(result.outcome).toEqual({ outcome: 'complete' });
    expect(result.embeddingDegraded).toBe(true);
  });
});

describe('scheduleRetrieval cancellation', () => {
  it('cancels queued work without starting it when already aborted', async () => {
    const items = Array.from({ length: 4 }, (_, index) => workItem(index));
    const backend = trackingRetrievalBackend(1);
    const controller = new AbortController();
    controller.abort(new Error('user cancelled'));
    const result = await scheduleRetrieval(
      { items, config: configFixture(), capabilities: capabilitiesFixture() },
      { signal: controller.signal, executeRetrieval: backend },
    );
    expect(result.outcome).toEqual({ outcome: 'cancelled', completedItems: 0, omittedItems: 4 });
    expect(backend.started).toBe(0);
    expect(result.physicalOpsUsed).toBe(0);
    for (const outcome of result.items) {
      expect(outcome.status).toBe('cancelled');
      if (outcome.status === 'cancelled') expect(outcome.phase).toBe('queued');
    }
  });

  it('supports mid-run cancellation for running and queued items', async () => {
    const items = Array.from({ length: 6 }, (_, index) => workItem(index));
    const controller = new AbortController();
    let started = 0;
    let pollIterations = 0;
    const backend: SchedulerRetrievalBackend = {
      execute: (_item, input) => {
        started += 1;
        const ordinal = started;
        if (ordinal <= 2) return Promise.resolve({ candidateCount: 1 });
        return new Promise<{ readonly candidateCount: number }>((_, reject) => {
          input.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          });
        });
      },
    };
    const pending = scheduleRetrieval(
      { items, config: configFixture({ maxConcurrentRetrievals: 2 }), capabilities: capabilitiesFixture() },
      { signal: controller.signal, executeRetrieval: backend },
    );
    while (started < 4) {
      pollIterations += 1;
      expect(pollIterations).toBeLessThan(200);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort(new Error('user cancelled'));
    const result = await pending;
    expect(result.outcome).toEqual({ outcome: 'cancelled', completedItems: 2, omittedItems: 4 });
    const running = result.items.filter((outcome) => outcome.status === 'cancelled' && outcome.phase === 'running');
    const queued = result.items.filter((outcome) => outcome.status === 'cancelled' && outcome.phase === 'queued');
    expect(running.length).toBe(2);
    expect(queued.length).toBe(2);
    expect(started).toBe(4);
  });

  it('returns partial/cancelled when the backend reports cancellation without an abort', async () => {
    const items = Array.from({ length: 4 }, (_, index) => workItem(index));
    let calls = 0;
    const backend: SchedulerRetrievalBackend = {
      execute: () => {
        calls += 1;
        if (calls <= 2) return Promise.reject(new DOMException('backend cancelled', 'AbortError'));
        return Promise.resolve({ candidateCount: 2 });
      },
    };
    const result = await scheduleRetrieval(
      { items, config: configFixture(), capabilities: capabilitiesFixture() },
      { signal: new AbortController().signal, executeRetrieval: backend },
    );
    expect(result.outcome).toEqual({
      outcome: 'partial',
      reason: 'cancelled',
      completedItems: 2,
      omittedItems: 2,
    });
  });
});
