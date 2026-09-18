import { z } from 'zod';
import { logger } from '@app/domain';

/**
 * Durable isolated queue for sampled judges and non-critical analytics
 * (WP-8, F-39).
 *
 * Interactive turns never wait for judges: judges run on this queue with
 * their own concurrency/rate reservation, are shed before interactive work
 * under pressure, and can be paused or disabled without affecting chat.
 *
 * Durability: when `QSTASH_TOKEN` is present the adapter publishes through
 * QStash (existing remote infra only — nothing new is provisioned here) with
 * the idempotency key as the deduplication id, retries, and DLQ/failure
 * callback pass-through. When QStash is absent the adapter runs in
 * disabled-safe mode: enqueues are visibly shed with an observable reason
 * and counters instead of being silently dropped or faked as delivered. The
 * in-process pending set is a dispatch buffer, never the durability story.
 */

export const InfraJobKindSchema = z.enum(['judge', 'analytics', 'maintenance']);
export type InfraJobKind = z.infer<typeof InfraJobKindSchema>;

const InfraPayloadSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export type InfraJobPayload = z.infer<typeof InfraPayloadSchema>;

export const InfraJobSchema = z.object({
  jobId: z.string().min(1).max(200),
  idempotencyKey: z.string().min(1).max(300),
  kind: InfraJobKindSchema,
  turnId: z.string().min(1).max(200).optional(),
  maxAttempts: z.number().int().min(1).max(8).optional(),
  payload: InfraPayloadSchema.optional(),
});
export type InfraJobInput = z.infer<typeof InfraJobSchema>;

export const BackgroundJobModeSchema = z.enum(['qstash', 'disabled-safe']);
export type BackgroundJobMode = z.infer<typeof BackgroundJobModeSchema>;

export function resolveBackgroundJobMode(env?: { readonly QSTASH_TOKEN?: string | undefined }): BackgroundJobMode {
  const token = env?.QSTASH_TOKEN ?? process.env.QSTASH_TOKEN;
  return token !== undefined && token.trim() !== '' ? 'qstash' : 'disabled-safe';
}

export type InfraShedReason =
  | 'paused'
  | 'disabled'
  | 'queue_full'
  | 'interactive_pressure'
  | 'judge_unavailable'
  | 'remote_unavailable';

export type InfraEnqueueResult =
  | { readonly kind: 'enqueued'; readonly jobId: string; readonly durable: boolean }
  | { readonly kind: 'duplicate'; readonly jobId: string }
  | {
      readonly kind: 'shed';
      readonly reason: InfraShedReason;
      readonly retryAfterMs: number;
    };

export interface BackgroundJobStats {
  readonly mode: BackgroundJobMode;
  readonly depth: number;
  readonly judgeDepth: number;
  readonly enqueuedTotal: number;
  readonly dispatchedTotal: number;
  readonly completedTotal: number;
  readonly shedTotal: number;
  readonly duplicateTotal: number;
  readonly deadLetterTotal: number;
  readonly remotePublishFailures: number;
  readonly remoteDeliveredTotal: number;
  readonly oldestAgeMs: number | null;
  readonly backlogStale: boolean;
  readonly paused: boolean;
  readonly disabled: boolean;
  readonly interactivePressure: boolean;
  readonly maxConcurrent: number;
  readonly inFlight: number;
}

export interface DurableBackgroundJobQueueOptions {
  readonly mode?: BackgroundJobMode | undefined;
  readonly maxDepth?: number | undefined;
  readonly judgeMaxDepth?: number | undefined;
  readonly maxConcurrent?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly maxBacklogAgeMs?: number | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly publish?: ((job: StoredInfraJob) => Promise<void>) | undefined;
  readonly recordDeadLetter?: ((job: StoredInfraJob, error: string) => Promise<void>) | undefined;
}

export interface StoredInfraJob {
  readonly jobId: string;
  readonly idempotencyKey: string;
  readonly kind: InfraJobKind;
  readonly turnId: string | undefined;
  readonly enqueuedAtMs: number;
  readonly maxAttempts: number;
  readonly payload: InfraJobPayload;
}

export type JobHandler = (job: StoredInfraJob) => Promise<void>;

const DEFAULT_MAX_DEPTH = 1_000;
const DEFAULT_JUDGE_MAX_DEPTH = 500;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_BACKLOG_AGE_MS = 900_000;
const DEFAULT_RETRY_AFTER_MS = 5_000;
/**
 * Retention for remotely-delivered idempotency keys (WP-8). A remotely
 * published job is owned by the remote worker, so it must not sit in the
 * local dispatch buffer — but its key is retained (bounded) so repeat
 * deliveries still collapse instead of republishing.
 */
const REMOTE_DELIVERED_RETENTION = 5_000;

export class DurableBackgroundJobQueue {
  private readonly mode: BackgroundJobMode;
  private readonly maxDepth: number;
  private readonly judgeMaxDepth: number;
  private readonly maxConcurrent: number;
  private readonly defaultMaxAttempts: number;
  private readonly maxBacklogAgeMs: number;
  private readonly retryAfterMs: number;
  private readonly now: () => number;
  private readonly publish: ((job: StoredInfraJob) => Promise<void>) | undefined;
  private readonly recordDeadLetterHook: ((job: StoredInfraJob, error: string) => Promise<void>) | undefined;
  private readonly pending = new Map<string, StoredInfraJob>();
  private readonly keyToJob = new Map<string, string>();
  private readonly attempts = new Map<string, number>();
  private readonly handlers = new Map<InfraJobKind, JobHandler>();
  private readonly deadLetter: Array<{ readonly jobId: string; readonly reason: string }> = [];
  private readonly remotelyDelivered = new Map<string, string>();
  private remoteDeliveredTotal = 0;
  private inFlight = 0;
  private paused = false;
  private disabled = false;
  private interactivePressure = false;
  private enqueuedTotal = 0;
  private dispatchedTotal = 0;
  private completedTotal = 0;
  private shedTotal = 0;
  private duplicateTotal = 0;
  private remotePublishFailures = 0;
  private destroyed = false;

  constructor(options: DurableBackgroundJobQueueOptions = {}) {
    this.mode = options.mode ?? resolveBackgroundJobMode();
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.judgeMaxDepth = options.judgeMaxDepth ?? DEFAULT_JUDGE_MAX_DEPTH;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.defaultMaxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.maxBacklogAgeMs = options.maxBacklogAgeMs ?? DEFAULT_MAX_BACKLOG_AGE_MS;
    this.retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
    this.now = options.now ?? Date.now;
    this.publish = options.publish;
    this.recordDeadLetterHook = options.recordDeadLetter;
    if (this.mode === 'disabled-safe') {
      logger.warn('capacity.background.disabled_safe_mode', {
        detail: 'QSTASH_TOKEN is not set; background jobs shed visibly instead of pretending durability.',
      });
    }
  }

  registerHandler(kind: InfraJobKind, handler: JobHandler): void {
    this.throwIfDestroyed();
    this.handlers.set(kind, handler);
  }

  async enqueue(raw: unknown): Promise<InfraEnqueueResult> {
    this.throwIfDestroyed();
    const parsed = InfraJobSchema.parse(raw);
    if (this.disabled) return this.shed('disabled');
    if (this.paused) return this.shed('paused');
    if (this.interactivePressure && parsed.kind === 'judge') return this.shed('interactive_pressure');
    const existing = this.keyToJob.get(parsed.idempotencyKey);
    if (existing !== undefined && this.pending.has(existing)) {
      this.duplicateTotal += 1;
      return Object.freeze({ kind: 'duplicate', jobId: existing });
    }
    const delivered = this.remotelyDelivered.get(parsed.idempotencyKey);
    if (delivered !== undefined) {
      this.duplicateTotal += 1;
      return Object.freeze({ kind: 'duplicate', jobId: delivered });
    }
    if (this.pending.size >= this.maxDepth) return this.shed('queue_full');
    if (parsed.kind === 'judge' && this.countKind('judge') >= this.judgeMaxDepth) {
      return this.shed('queue_full');
    }
    if (this.mode === 'disabled-safe' && this.publish === undefined) {
      return this.shed('disabled');
    }
    const job: StoredInfraJob = {
      jobId: parsed.jobId,
      idempotencyKey: parsed.idempotencyKey,
      kind: parsed.kind,
      turnId: parsed.turnId,
      enqueuedAtMs: this.now(),
      maxAttempts: parsed.maxAttempts ?? this.defaultMaxAttempts,
      payload: parsed.payload ?? {},
    };
    if (this.publish !== undefined) {
      try {
        await this.publish(job);
      } catch (error) {
        this.remotePublishFailures += 1;
        logger.warn('capacity.background.remote_publish_failed', {
          jobId: job.jobId,
          error: error instanceof Error ? error.message : String(error),
        });
        return this.shed('remote_unavailable');
      }
      // Remote delivery owns this job: retain only the idempotency key
      // (bounded) for duplicate collapse. Buffering it locally as well would
      // double-execute (remote worker + local pump) and grow depth by one
      // per unique remote turn until the queue sheds.
      this.remotelyDelivered.set(parsed.idempotencyKey, job.jobId);
      while (this.remotelyDelivered.size > REMOTE_DELIVERED_RETENTION) {
        const oldest = this.remotelyDelivered.keys().next().value;
        if (oldest === undefined) break;
        this.remotelyDelivered.delete(oldest);
      }
      this.enqueuedTotal += 1;
      this.remoteDeliveredTotal += 1;
      logger.info('capacity.background.enqueued', {
        jobId: job.jobId,
        kind: job.kind,
        mode: this.mode,
        durable: true,
      });
      return Object.freeze({ kind: 'enqueued', jobId: job.jobId, durable: true });
    }
    this.pending.set(job.jobId, job);
    this.keyToJob.set(job.idempotencyKey, job.jobId);
    this.attempts.set(job.jobId, 0);
    this.enqueuedTotal += 1;
    logger.info('capacity.background.enqueued', {
      jobId: job.jobId,
      kind: job.kind,
      mode: this.mode,
      durable: this.publish !== undefined,
    });
    return Object.freeze({ kind: 'enqueued', jobId: job.jobId, durable: this.publish !== undefined });
  }

  /**
   * Dispatch up to the bounded concurrency limit. Deterministic: the caller
   * drives the pump (no timers), so tests and workers control pacing.
   */
  async pump(maxJobs?: number): Promise<{ readonly dispatched: number; readonly completed: number; readonly deadLettered: number }> {
    this.throwIfDestroyed();
    let dispatched = 0;
    let completed = 0;
    let deadLettered = 0;
    const budget = maxJobs ?? this.pending.size;
    for (const job of [...this.pending.values()]) {
      if (dispatched >= budget) break;
      if (this.inFlight >= this.maxConcurrent) break;
      if (this.paused || this.disabled) break;
      const handler = this.handlers.get(job.kind);
      if (handler === undefined) {
        await this.moveToDeadLetter(job, 'judge_unavailable: no handler registered');
        deadLettered += 1;
        continue;
      }
      this.inFlight += 1;
      dispatched += 1;
      this.dispatchedTotal += 1;
      try {
        await handler(job);
        this.pending.delete(job.jobId);
        this.completedTotal += 1;
        completed += 1;
      } catch (error) {
        const attempts = (this.attempts.get(job.jobId) ?? 0) + 1;
        this.attempts.set(job.jobId, attempts);
        if (attempts >= job.maxAttempts) {
          await this.moveToDeadLetter(job, error instanceof Error ? error.message : String(error));
          deadLettered += 1;
        } else {
          logger.warn('capacity.background.retry_scheduled', { jobId: job.jobId, attempt: attempts });
        }
      } finally {
        this.inFlight = Math.max(0, this.inFlight - 1);
      }
    }
    return Object.freeze({ dispatched, completed, deadLettered });
  }

  stats(): BackgroundJobStats {
    this.throwIfDestroyed();
    const current = this.now();
    let oldestByScan: number | null = null;
    for (const job of this.pending.values()) {
      const age = current - job.enqueuedAtMs;
      oldestByScan = oldestByScan === null ? age : Math.max(oldestByScan, age);
    }
    return Object.freeze({
      mode: this.mode,
      depth: this.pending.size,
      judgeDepth: this.countKind('judge'),
      enqueuedTotal: this.enqueuedTotal,
      dispatchedTotal: this.dispatchedTotal,
      completedTotal: this.completedTotal,
      shedTotal: this.shedTotal,
      duplicateTotal: this.duplicateTotal,
      deadLetterTotal: this.deadLetter.length,
      remotePublishFailures: this.remotePublishFailures,
      remoteDeliveredTotal: this.remoteDeliveredTotal,
      oldestAgeMs: oldestByScan,
      backlogStale: oldestByScan !== null && oldestByScan > this.maxBacklogAgeMs,
      paused: this.paused,
      disabled: this.disabled,
      interactivePressure: this.interactivePressure,
      maxConcurrent: this.maxConcurrent,
      inFlight: this.inFlight,
    });
  }

  pause(): void {
    this.throwIfDestroyed();
    this.paused = true;
    logger.warn('capacity.background.paused', { mode: this.mode });
  }

  resume(): void {
    this.throwIfDestroyed();
    this.paused = false;
    logger.info('capacity.background.resumed', { mode: this.mode });
  }

  disable(): void {
    this.throwIfDestroyed();
    this.disabled = true;
    logger.warn('capacity.background.disabled', { mode: this.mode });
  }

  enable(): void {
    this.throwIfDestroyed();
    this.disabled = false;
    logger.info('capacity.background.enabled', { mode: this.mode });
  }

  setInteractivePressure(shedding: boolean): void {
    this.throwIfDestroyed();
    this.interactivePressure = shedding;
    logger.info('capacity.background.interactive_pressure', { shedding });
  }

  destroy(): void {
    this.pending.clear();
    this.keyToJob.clear();
    this.attempts.clear();
    this.handlers.clear();
    this.deadLetter.length = 0;
    this.remotelyDelivered.clear();
    this.destroyed = true;
  }

  private countKind(kind: InfraJobKind): number {
    let count = 0;
    for (const job of this.pending.values()) {
      if (job.kind === kind) count += 1;
    }
    return count;
  }

  private async moveToDeadLetter(job: StoredInfraJob, reason: string): Promise<void> {
    this.pending.delete(job.jobId);
    this.deadLetter.push({ jobId: job.jobId, reason: reason.slice(0, 500) });
    while (this.deadLetter.length > 500) this.deadLetter.shift();
    if (this.recordDeadLetterHook !== undefined) {
      try {
        await this.recordDeadLetterHook(job, reason);
      } catch (error) {
        logger.warn('capacity.background.dead_letter_hook_failed', {
          jobId: job.jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logger.warn('capacity.background.dead_letter', { jobId: job.jobId, reason: reason.slice(0, 200) });
  }

  private shed(reason: InfraShedReason): InfraEnqueueResult {
    this.shedTotal += 1;
    logger.warn('capacity.background.shed', { reason, mode: this.mode });
    return Object.freeze({ kind: 'shed', reason, retryAfterMs: this.retryAfterMs });
  }

  private throwIfDestroyed(): void {
    if (this.destroyed) throw new Error('background-job-queue: instance destroyed');
  }
}

/**
 * QStash publish function for production composition. Uses the existing
 * QSTASH env only; never provisions new remote infra.
 */
export function createQstashPublish(input: {
  readonly url: string;
  readonly token?: string | undefined;
  readonly dlqUrl?: string | undefined;
}): (job: StoredInfraJob) => Promise<void> {
  const token = input.token ?? process.env.QSTASH_TOKEN;
  if (token === undefined || token.trim() === '') {
    throw new Error('background-job-queue: QSTASH_TOKEN is not set');
  }
  return async (job: StoredInfraJob): Promise<void> => {
    const { Client } = await import('@upstash/qstash');
    const client = new Client({ token });
    try {
      await client.publishJSON({
        url: input.url,
        body: {
          jobId: job.jobId,
          idempotencyKey: job.idempotencyKey,
          kind: job.kind,
          ...(job.turnId !== undefined ? { turnId: job.turnId } : {}),
          payload: job.payload,
        },
        retries: 3,
        deduplicationId: job.idempotencyKey,
        ...(input.dlqUrl !== undefined && input.dlqUrl !== '' ? { dlq: input.dlqUrl } : {}),
      });
    } catch (error) {
      throw new Error(`QStash publish failed for job ${job.jobId}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  };
}
