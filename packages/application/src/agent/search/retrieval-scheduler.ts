import { z } from 'zod';
import { logger } from '@app/domain';

/**
 * Bounded physical retrieval scheduler (WP-8 Task B, F-37 plus the retrieval
 * half of 7.15).
 *
 * One complex turn can multiply subquestions x variants x vector/lexical
 * modalities into many concurrent embedding and SQL operations even though
 * user-visible evidence is tightly capped. This scheduler:
 *
 * - batches embeddings where the backend supports it (one batch = one
 *   physical op), preserving call/subquestion/query provenance from batch
 *   index back to every contributing item;
 * - runs vector/lexical work through a per-turn worker pool (never an
 *   unbounded `Promise.all` over the subquestion x variant x modality
 *   product);
 * - counts physical ops separately from result counts (embedding batches,
 *   retrieval executions, and returned candidates are three numbers);
 * - supports cancellation for queued items (never started after abort) and
 *   running items (abort signal forwarded to the backend);
 * - returns typed complete/partial/budget/cancelled outcomes instead of
 *   throwing on budget or cancellation;
 * - assesses the batched SQL plan per modality and falls back to individual
 *   operations with a typed reason when batching is unsupported or rejected.
 *
 * Planner defaults and thresholds are inputs, never changed here: reaching a
 * ceiling returns a typed partial outcome and never starts another loop.
 */

export const RetrievalModalitySchema = z.enum(['vector', 'lexical']);
export type RetrievalModality = z.infer<typeof RetrievalModalitySchema>;

export const RetrievalSchedulerCapabilitiesSchema = z.object({
  batchEmbeddings: z.boolean(),
  batchedVectorSql: z.enum(['supported', 'unsupported']),
  batchedLexicalSql: z.enum(['supported', 'unsupported']),
});
export type RetrievalSchedulerCapabilities = z.infer<typeof RetrievalSchedulerCapabilitiesSchema>;

export const RetrievalWorkItemSchema = z.object({
  callId: z.string().min(1).max(200),
  subquestionId: z.string().min(1).max(200),
  queryId: z.string().min(1).max(200),
  queryText: z.string().min(1).max(500),
  modality: RetrievalModalitySchema,
});
export type RetrievalWorkItem = z.infer<typeof RetrievalWorkItemSchema>;

export const RetrievalSchedulerConfigSchema = z.object({
  maxConcurrentRetrievals: z.number().int().min(1).max(32),
  maxPhysicalOps: z.number().int().min(1).max(500),
  embeddingBatchSize: z.number().int().min(1).max(100),
  maxBatchSqlSize: z.number().int().min(1).max(100),
});
export type RetrievalSchedulerConfig = z.infer<typeof RetrievalSchedulerConfigSchema>;

export const RetrievalScheduleRequestSchema = z.object({
  items: z.array(RetrievalWorkItemSchema).min(1).max(200),
  config: RetrievalSchedulerConfigSchema,
  capabilities: RetrievalSchedulerCapabilitiesSchema,
});
export type RetrievalScheduleRequest = z.infer<typeof RetrievalScheduleRequestSchema>;

export const SchedulerItemOutcomeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    callId: z.string(),
    subquestionId: z.string(),
    queryId: z.string(),
    modality: RetrievalModalitySchema,
    candidateCount: z.number().int().min(0),
    physicalOps: z.number().int().min(1),
  }),
  z.object({
    status: z.literal('error'),
    callId: z.string(),
    subquestionId: z.string(),
    queryId: z.string(),
    modality: RetrievalModalitySchema,
    code: z.enum(['timeout', 'cancelled', 'embedding_unavailable', 'retrieval_unavailable']),
    retryable: z.boolean(),
    physicalOps: z.number().int().min(0),
  }),
  z.object({
    status: z.literal('cancelled'),
    callId: z.string(),
    subquestionId: z.string(),
    queryId: z.string(),
    modality: RetrievalModalitySchema,
    phase: z.enum(['queued', 'running']),
    physicalOps: z.number().int().min(0),
  }),
  z.object({
    status: z.literal('omitted_by_budget'),
    callId: z.string(),
    subquestionId: z.string(),
    queryId: z.string(),
    modality: RetrievalModalitySchema,
    physicalOps: z.literal(0),
  }),
]);
export type SchedulerItemOutcome = z.infer<typeof SchedulerItemOutcomeSchema>;

export const SchedulerOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('complete') }),
  z.object({
    outcome: z.literal('partial'),
    reason: z.enum(['operation_budget_exceeded', 'cancelled']),
    completedItems: z.number().int().min(0),
    omittedItems: z.number().int().min(0),
  }),
  z.object({
    outcome: z.literal('cancelled'),
    completedItems: z.number().int().min(0),
    omittedItems: z.number().int().min(0),
  }),
]);
export type SchedulerOutcome = z.infer<typeof SchedulerOutcomeSchema>;

export const BatchPlanAssessmentSchema = z.discriminatedUnion('strategy', [
  z.object({
    strategy: z.literal('batched'),
    modality: RetrievalModalitySchema,
    batchCount: z.number().int().min(1),
    itemCount: z.number().int().min(1),
  }),
  z.object({
    strategy: z.literal('individual'),
    modality: RetrievalModalitySchema,
    itemCount: z.number().int().min(1),
    reason: z.enum(['batched_sql_unsupported', 'batch_plan_inefficient']),
  }),
]);
export type BatchPlanAssessment = z.infer<typeof BatchPlanAssessmentSchema>;

export interface ScheduleResult {
  readonly outcome: SchedulerOutcome;
  readonly items: readonly SchedulerItemOutcome[];
  readonly batchPlans: readonly BatchPlanAssessment[];
  readonly physicalOpsUsed: number;
  readonly embeddingOpsUsed: number;
  readonly retrievalOpsUsed: number;
  readonly totalCandidates: number;
  readonly maxObservedConcurrency: number;
  /** True when the embedding phase failed and retrieval ran with null embeddings. */
  readonly embeddingDegraded: boolean;
}

/** Narrow backend seams. Embeddings and SQL stay behind these interfaces. */
export interface SchedulerEmbeddingBackend {
  embedBatch(texts: readonly string[]): Promise<readonly (readonly number[] | null)[]>;
}

export interface SchedulerRetrievalBackend {
  execute(
    item: RetrievalWorkItem,
    input: { readonly embedding: readonly number[] | null; readonly signal: AbortSignal },
  ): Promise<{ readonly candidateCount: number }>;
}

export interface SchedulerDeps {
  readonly signal: AbortSignal;
  readonly embedBatch?: SchedulerEmbeddingBackend | undefined;
  readonly executeRetrieval: SchedulerRetrievalBackend;
}

/** Reference maximum plan shape: 4 subquestions x 3 variants x 2 modalities. */
export const MAX_PLAN_SUBQUESTIONS = 4 as const;
export const MAX_PLAN_VARIANTS_PER_SUBQUESTION = 3 as const;
export const MAX_PLAN_MODALITIES = 2 as const;

/** Physical-op estimator for a plan shape (embedding batches + retrievals). */
export function estimatePlanPhysicalOps(input: {
  readonly subquestions: number;
  readonly variantsPerSubquestion: number;
  readonly modalities: number;
  readonly embeddingBatchSize: number;
}): number {
  const queries = input.subquestions * input.variantsPerSubquestion;
  const embeddingBatches = Math.max(1, Math.ceil(queries / Math.max(1, input.embeddingBatchSize)));
  return embeddingBatches + queries * input.modalities;
}

/** Maximum reference plan ops at the given batch size (24 retrieval + batches). */
export function maxReferencePlanOps(embeddingBatchSize: number): number {
  return estimatePlanPhysicalOps({
    subquestions: MAX_PLAN_SUBQUESTIONS,
    variantsPerSubquestion: MAX_PLAN_VARIANTS_PER_SUBQUESTION,
    modalities: MAX_PLAN_MODALITIES,
    embeddingBatchSize,
  });
}

function batchedSupport(
  capabilities: RetrievalSchedulerCapabilities,
  modality: RetrievalModality,
): 'supported' | 'unsupported' {
  switch (modality) {
    case 'vector':
      return capabilities.batchedVectorSql;
    case 'lexical':
      return capabilities.batchedLexicalSql;
    default: {
      const exhaustive: never = modality;
      throw new Error(`retrieval-scheduler: unhandled modality ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Assess the batched SQL plan per modality with production-like plan rules:
 * batching applies only where the backend declares support and the batch fits
 * the efficient-plan ceiling (`maxBatchSqlSize`); otherwise the assessment
 * rejects batching with a typed reason and the scheduler runs bounded
 * individual operations. Provenance is preserved either way.
 */
export function assessBatchPlans(
  items: readonly RetrievalWorkItem[],
  config: RetrievalSchedulerConfig,
  capabilities: RetrievalSchedulerCapabilities,
): readonly BatchPlanAssessment[] {
  const byModality = new Map<RetrievalModality, number>();
  for (const item of items) byModality.set(item.modality, (byModality.get(item.modality) ?? 0) + 1);
  const plans: BatchPlanAssessment[] = [];
  for (const [modality, count] of [...byModality.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (batchedSupport(capabilities, modality) === 'unsupported') {
      plans.push(
        Object.freeze({ strategy: 'individual', modality, itemCount: count, reason: 'batched_sql_unsupported' }),
      );
      continue;
    }
    if (count > config.maxBatchSqlSize) {
      plans.push(
        Object.freeze({ strategy: 'individual', modality, itemCount: count, reason: 'batch_plan_inefficient' }),
      );
      continue;
    }
    plans.push(Object.freeze({ strategy: 'batched', modality, batchCount: 1, itemCount: count }));
  }
  return Object.freeze(plans);
}

function isCancellationError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (error instanceof Error) return error.name === 'AbortError' || /abort|cancel/i.test(error.message);
  return false;
}

function provenanceOf(item: RetrievalWorkItem): {
  readonly callId: string;
  readonly subquestionId: string;
  readonly queryId: string;
  readonly modality: RetrievalModality;
} {
  return {
    callId: item.callId,
    subquestionId: item.subquestionId,
    queryId: item.queryId,
    modality: item.modality,
  };
}

/**
 * Schedule bounded retrieval for one turn. Never throws for budget exhaustion
 * or cancellation: those return typed outcomes. Unexpected backend misuse
 * (shape violations) still throws via zod at the boundary.
 */
export async function scheduleRetrieval(
  request: unknown,
  deps: SchedulerDeps,
): Promise<ScheduleResult> {
  const parsed = RetrievalScheduleRequestSchema.parse(request);
  const { items, config, capabilities } = parsed;
  const batchPlans = assessBatchPlans(items, config, capabilities);

  let physicalOpsUsed = 0;
  let embeddingOpsUsed = 0;
  let retrievalOpsUsed = 0;
  let totalCandidates = 0;
  let running = 0;
  let maxObservedConcurrency = 0;
  const outcomes: SchedulerItemOutcome[] = new Array<SchedulerItemOutcome>(items.length);
  const embeddings = new Map<number, readonly number[] | null>();

  const cancelledOutcome = (item: RetrievalWorkItem, phase: 'queued' | 'running'): SchedulerItemOutcome =>
    Object.freeze({ status: 'cancelled', ...provenanceOf(item), phase, physicalOps: 0 });

  if (deps.signal.aborted) {
    items.forEach((item, index) => {
      outcomes[index] = cancelledOutcome(item, 'queued');
    });
    return Object.freeze({
      outcome: Object.freeze({ outcome: 'cancelled', completedItems: 0, omittedItems: items.length }),
      items: Object.freeze([...outcomes]),
      batchPlans,
      physicalOpsUsed: 0,
      embeddingOpsUsed: 0,
      retrievalOpsUsed: 0,
      totalCandidates: 0,
      maxObservedConcurrency: 0,
      embeddingDegraded: false,
    });
  }

  // Phase 1: embeddings. Unique texts share one embedding; the batch index
  // maps back to every contributing item so provenance survives batching.
  const uniqueTexts: string[] = [];
  const textIndexByText = new Map<string, number>();
  for (const item of items) {
    if (!textIndexByText.has(item.queryText)) {
      textIndexByText.set(item.queryText, uniqueTexts.length);
      uniqueTexts.push(item.queryText);
    }
  }
  const embeddingBudget = config.maxPhysicalOps;
  const canBatchEmbed = capabilities.batchEmbeddings && deps.embedBatch !== undefined;
  const embeddingUnits: readonly (readonly string[])[] = canBatchEmbed
    ? chunked(uniqueTexts, config.embeddingBatchSize)
    : uniqueTexts.map((text) => [text] as const);

  let embeddingFailed = false;
  for (const unit of embeddingUnits) {
    if (deps.signal.aborted) break;
    if (physicalOpsUsed >= embeddingBudget) break;
    if (deps.embedBatch === undefined) break;
    physicalOpsUsed += 1;
    embeddingOpsUsed += 1;
    try {
      const vectors = await deps.embedBatch.embedBatch(unit);
      unit.forEach((text, offset) => {
        const index = textIndexByText.get(text);
        const vector = vectors[offset] ?? null;
        if (index !== undefined) embeddings.set(index, vector);
      });
    } catch (error) {
      if (isCancellationError(error, deps.signal)) break;
      embeddingFailed = true;
      logger.warn('retrieval.scheduler_embedding_batch_failed', { batchSize: unit.length });
      break;
    }
  }
  const embeddingDegraded = embeddingFailed;

  // Phase 2: bounded retrieval worker pool. Queued items check the signal and
  // the operation budget before starting; running items share the turn signal.
  let next = 0;
  const workerCount = Math.max(1, Math.min(config.maxConcurrentRetrievals, items.length));

  async function worker(): Promise<void> {
    while (true) {
      if (deps.signal.aborted) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      if (deps.signal.aborted) {
        outcomes[index] = cancelledOutcome(item, 'queued');
        continue;
      }
      if (physicalOpsUsed >= config.maxPhysicalOps) {
        outcomes[index] = Object.freeze({ status: 'omitted_by_budget', ...provenanceOf(item), physicalOps: 0 });
        continue;
      }
      physicalOpsUsed += 1;
      retrievalOpsUsed += 1;
      running += 1;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, running);
      try {
        const textIndex = textIndexByText.get(item.queryText);
        const embedding = textIndex === undefined ? null : (embeddings.get(textIndex) ?? null);
        const result = await deps.executeRetrieval.execute(item, { embedding, signal: deps.signal });
        totalCandidates += result.candidateCount;
        outcomes[index] = Object.freeze({
          status: 'ok',
          ...provenanceOf(item),
          candidateCount: result.candidateCount,
          physicalOps: 1,
        });
      } catch (error) {
        if (isCancellationError(error, deps.signal)) {
          outcomes[index] = cancelledOutcome(item, 'running');
        } else {
          outcomes[index] = Object.freeze({
            status: 'error',
            ...provenanceOf(item),
            code: 'retrieval_unavailable',
            retryable: true,
            physicalOps: 1,
          });
        }
      } finally {
        running -= 1;
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // Any item never assigned (abort raced the pool) becomes queued-cancelled.
  for (let index = 0; index < items.length; index += 1) {
    if (outcomes[index] === undefined) {
      const item = items[index];
      if (item !== undefined) outcomes[index] = cancelledOutcome(item, 'queued');
    }
  }

  const completed = outcomes.filter((outcome) => outcome.status === 'ok' || outcome.status === 'error').length;
  const cancelledCount = outcomes.filter((outcome) => outcome.status === 'cancelled').length;
  const omitted = outcomes.filter((outcome) => outcome.status === 'omitted_by_budget').length;

  let outcome: SchedulerOutcome;
  if (deps.signal.aborted || cancelledCount === items.length) {
    outcome = Object.freeze({ outcome: 'cancelled', completedItems: completed, omittedItems: cancelledCount + omitted });
  } else if (omitted > 0 || cancelledCount > 0) {
    outcome = Object.freeze({
      outcome: 'partial',
      reason: omitted > 0 ? 'operation_budget_exceeded' : 'cancelled',
      completedItems: completed,
      omittedItems: omitted + cancelledCount,
    });
  } else {
    outcome = Object.freeze({ outcome: 'complete' });
  }

  logger.info('retrieval.scheduled', {
    itemCount: items.length,
    physicalOpsUsed,
    embeddingOpsUsed,
    retrievalOpsUsed,
    totalCandidates,
    maxObservedConcurrency,
    outcome: outcome.outcome,
  });

  return Object.freeze({
    outcome,
    items: Object.freeze([...outcomes]),
    batchPlans,
    physicalOpsUsed,
    embeddingOpsUsed,
    retrievalOpsUsed,
    totalCandidates,
    maxObservedConcurrency,
    embeddingDegraded,
  });
}

function chunked<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const out: (readonly T[])[] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}
