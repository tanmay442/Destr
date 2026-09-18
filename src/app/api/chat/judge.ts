import { after } from 'next/server';
import { logger } from '@/lib/logger';
import { judgeFaithfulness, judgeRelevance, type Composition } from '@/composition';

export function scheduleFlush(comp: Composition): void {
  try {
    after(() => {
      void comp.chatEventBatcher.flush();
    });
  } catch {
    void comp.chatEventBatcher.flush();
  }
}

interface EventMetaPatcher {
  updateEventMeta(turnId: string, patch: Record<string, unknown>): Promise<boolean>;
}
interface BatcherMetaPatcher {
  patchMeta(turnId: string, patch: Record<string, unknown>): boolean;
}

export function getMetaPatchers(comp: Composition): {
  eventMeta: EventMetaPatcher | null;
  batcher: BatcherMetaPatcher | null;
} {
  const candidate = comp.chatEventBatcher as unknown as Partial<EventMetaPatcher & BatcherMetaPatcher>;
  return {
    eventMeta:
      typeof candidate.updateEventMeta === 'function'
        ? { updateEventMeta: candidate.updateEventMeta.bind(candidate) }
        : null,
    batcher:
      typeof candidate.patchMeta === 'function'
        ? { patchMeta: candidate.patchMeta.bind(candidate) }
        : null,
  };
}

export async function runJudge(ctx: {
  question: string;
  snippets: string[];
  documents: string;
  answer: string;
  turnId: string;
  eventMetaPatcher: EventMetaPatcher | null;
  batcherPatcher: BatcherMetaPatcher | null;
}): Promise<void> {
  try {
    const [relevance, faithfulness] = await Promise.all([
      judgeRelevance(ctx.question, ctx.snippets),
      judgeFaithfulness(ctx.documents, ctx.answer),
    ]);
    if (!relevance && !faithfulness) return;
    const judgeScores: Record<string, unknown> = { judgedAt: new Date().toISOString() };
    if (relevance) judgeScores.retrievalRelevance = relevance.score;
    if (faithfulness) {
      judgeScores.faithfulness = faithfulness.score;
      if (faithfulness.citationPrecision !== null) judgeScores.citationPrecision = faithfulness.citationPrecision;
    }
    const patch = { judgeScores };
    const buffered = ctx.batcherPatcher ? ctx.batcherPatcher.patchMeta(ctx.turnId, patch) : false;
    if (buffered) return;
    const persisted = ctx.eventMetaPatcher
      ? await ctx.eventMetaPatcher.updateEventMeta(ctx.turnId, patch)
      : false;
    if (!persisted) {
      const retry = () =>
        void ctx.eventMetaPatcher?.updateEventMeta(ctx.turnId, patch).catch((err) => {
          logger.warn('judge.enqueue.meta_retry_failed', { turnId: ctx.turnId, error: String(err) });
        });
      const t = setTimeout(retry, 5_000);
      if (typeof t.unref === 'function') t.unref();
      logger.debug('judge.enqueue.meta_retry_scheduled', { turnId: ctx.turnId });
    }
  } catch (err) {
    logger.warn('quality judge failed', {
      severity: 'warn',
      event: 'judge.enqueue.failed',
      turnId: ctx.turnId,
      error: String(err),
    });
  }
}

export function scheduleAfter(task: () => void): void {
  try {
    after(() => task());
  } catch {
    task();
  }
}

/**
 * WP-8 F-39 durable judge seam.
 *
 * JudgeQueuePort is structural on purpose: route-layer modules must not
 * import infrastructure vendor/queue types (architecture rule); the
 * composition-provided durable queue satisfies this shape. Payloads are plain
 * serializable judge inputs (question/snippets/documents/answer/turnId).
 */
export interface JudgeJobPayload {
  readonly question: string;
  readonly snippets: readonly string[];
  readonly documents: string;
  readonly answer: string;
}

export interface JudgeQueueEnqueueResult {
  readonly kind: 'enqueued' | 'duplicate' | 'shed';
  readonly reason?: string | undefined;
  /** True when a remote worker will execute the job (skip the local pump). */
  readonly durable: boolean;
}

export interface JudgeQueuePort {
  enqueue(job: {
    readonly kind: 'judge';
    readonly turnId: string;
    readonly payload: JudgeJobPayload;
  }): Promise<JudgeQueueEnqueueResult>;
  pump(): Promise<unknown>;
}

export interface JudgeTaskContext {
  readonly question: string;
  readonly snippets: string[];
  readonly documents: string;
  readonly answer: string;
  readonly turnId: string;
}

/**
 * Deferred-task scheduler with a durable path. Flag off (or no queue):
 * identical to the pre-WP-8 `after()` behavior. Flag on: the wrapped task
 * (which enqueues through createQualityJudge below) runs, then the queue is
 * pumped so bounded concurrency, retries, dead-lettering, and backlog-age
 * apply — unless the job was durably published for remote execution, in
 * which case the local pump is skipped so one sampled turn never pays for
 * two judge runs. Pump failures are observed, never fatal.
 */
export function createJudgeScheduler(input: {
  readonly enabled: boolean;
  readonly queue?: JudgeQueuePort | undefined;
  readonly scheduleAfter: (task: () => void) => void;
  /**
   * Per-request durability outbox (see createQualityJudge): after the task
   * runs, a true value means a remote worker owns the job, so the local pump
   * is skipped and one sampled turn never pays for two judge runs.
   */
  readonly isDurable?: (() => boolean) | undefined;
}): (task: () => Promise<void>) => void {
  return (task) => {
    if (!input.enabled || input.queue === undefined) {
      input.scheduleAfter(() => void task());
      return;
    }
    const queue = input.queue;
    const isDurable = input.isDurable;
    input.scheduleAfter(() =>
      void (async () => {
        await task();
        if (isDurable?.() === true) return;
        try {
          await queue.pump();
        } catch (error) {
          logger.warn('judge.durable.pump_failed', { error: String(error) });
        }
      })(),
    );
  };
}

/**
 * Quality-judge dispatch with a durable path. Flag off (or no queue): runs
 * inline exactly as before. Flag on: enqueues a serializable judge job whose
 * idempotency key is the turn ID (repeat deliveries overwrite the same judge
 * scores, so at-least-once execution is safe); execution happens via the
 * scheduled pump. A shed/unavailable queue (full, paused, pressured,
 * disabled, remote outage) falls back to the inline path so sampling
 * degrades visibly instead of dropping silently.
 */
export function createQualityJudge(input: {
  readonly enabled: boolean;
  readonly queue?: JudgeQueuePort | undefined;
  readonly runInline: (ctx: JudgeTaskContext) => Promise<void>;
  /** Per-request outbox read by the scheduler (see createJudgeScheduler). */
  readonly reportDurable?: ((durable: boolean) => void) | undefined;
}): (ctx: JudgeTaskContext) => Promise<void> {
  const report = input.reportDurable;
  return async (ctx) => {
    if (!input.enabled || input.queue === undefined) {
      report?.(false);
      await input.runInline(ctx);
      return;
    }
    let outcome: JudgeQueueEnqueueResult;
    try {
      outcome = await input.queue.enqueue({
        kind: 'judge',
        turnId: ctx.turnId,
        payload: {
          question: ctx.question,
          snippets: [...ctx.snippets],
          documents: ctx.documents,
          answer: ctx.answer,
        },
      });
    } catch (error) {
      logger.warn('judge.durable.enqueue_failed', { turnId: ctx.turnId, error: String(error) });
      report?.(false);
      await input.runInline(ctx);
      return;
    }
    if (outcome.kind === 'shed') {
      logger.warn('judge.durable.shed_fallback_inline', {
        turnId: ctx.turnId,
        reason: outcome.reason ?? 'unknown',
      });
      report?.(false);
      await input.runInline(ctx);
      return;
    }
    report?.(outcome.durable);
  };
}
