import { z } from 'zod';
import { logger } from '@app/domain';
import { randomUUID } from 'node:crypto';

/**
 * Application-layer background-work queue port and policy (WP-8, F-39).
 *
 * Sampled LLM judges and non-critical analytics must never compete
 * unboundedly with interactive turns and must not depend on a best-effort
 * in-memory timer for durable delivery. This module defines the narrow
 * application port plus a deterministic policy implementation:
 *
 * - Bounded depth with explicit shedding (judges shed first).
 * - Idempotent enqueue by idempotencyKey (duplicate deliveries collapse).
 * - Retries with deterministic backoff, then dead-letter.
 * - Backlog-age metrics so pressure is observable.
 * - pause/disable that shed visibly instead of dropping silently.
 * - Interactive-pressure shedding: when the interactive path reports
 *   pressure, judge jobs are shed before they can consume provider/DB
 *   capacity, and they never consume the interactive reservation.
 *
 * Durability across suspension comes from the infrastructure adapter (durable
 * queue when QSTASH env is present, disabled-safe shedding otherwise). This
 * in-process implementation is the policy core and the deterministic test
 * double; it is not itself the durability story.
 */

export const BackgroundJobKindSchema = z.enum(['judge', 'analytics', 'maintenance']);
export type BackgroundJobKind = z.infer<typeof BackgroundJobKindSchema>;

const BackgroundPayloadSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export type BackgroundPayload = z.infer<typeof BackgroundPayloadSchema>;

export const BackgroundJobSchema = z.object({
  jobId: z.string().min(1).max(200),
  idempotencyKey: z.string().min(1).max(300),
  kind: BackgroundJobKindSchema,
  turnId: z.string().min(1).max(200).optional(),
  enqueuedAtMs: z.number().int().nonnegative().optional(),
  maxAttempts: z.number().int().min(1).max(8).optional(),
  payload: BackgroundPayloadSchema.optional(),
});
export type BackgroundJobInput = z.infer<typeof BackgroundJobSchema>;

export const BackgroundShedReasonSchema = z.enum([
  'paused',
  'disabled',
  'queue_full',
  'interactive_pressure',
  'judge_unavailable',
]);
export type BackgroundShedReason = z.infer<typeof BackgroundShedReasonSchema>;

export type BackgroundEnqueueResult =
  | { readonly kind: 'enqueued'; readonly jobId: string; readonly position: number }
  | { readonly kind: 'duplicate'; readonly jobId: string }
  | { readonly kind: 'shed'; readonly reason: BackgroundShedReason; readonly retryAfterMs: number };

export type BackgroundFailResult =
  | { readonly kind: 'retry_scheduled'; readonly jobId: string; readonly attempt: number; readonly notBeforeMs: number }
  | { readonly kind: 'dead_letter'; readonly jobId: string; readonly reason: string }
  | { readonly kind: 'unknown_job'; readonly jobId: string };

export const BackgroundQueueConfigSchema = z.object({
  maxDepth: z.number().int().min(1).max(100_000),
  judgeMaxDepth: z.number().int().min(1).max(100_000),
  retryDelaysMs: z.array(z.number().int().min(0).max(3_600_000)).min(1).max(8),
  maxBacklogAgeMs: z.number().int().min(1_000).max(3_600_000),
  retryAfterMs: z.number().int().min(0).max(600_000),
  completedKeyRetention: z.number().int().min(1).max(50_000),
});
export type BackgroundQueueConfig = z.infer<typeof BackgroundQueueConfigSchema>;

export const DEFAULT_BACKGROUND_QUEUE_CONFIG: BackgroundQueueConfig = Object.freeze({
  maxDepth: 1_000,
  judgeMaxDepth: 500,
  retryDelaysMs: [5_000, 30_000, 300_000],
  maxBacklogAgeMs: 900_000,
  retryAfterMs: 5_000,
  completedKeyRetention: 5_000,
});

export interface BackgroundQueueStats {
  readonly depth: number;
  readonly judgeDepth: number;
  readonly enqueuedTotal: number;
  readonly completedTotal: number;
  readonly shedTotal: number;
  readonly duplicateTotal: number;
  readonly deadLetterTotal: number;
  readonly oldestAgeMs: number | null;
  readonly backlogStale: boolean;
  readonly paused: boolean;
  readonly disabled: boolean;
  readonly interactivePressure: boolean;
}

export interface BackgroundJobQueue {
  enqueue(raw: unknown): BackgroundEnqueueResult;
  complete(jobId: string): boolean;
  fail(jobId: string, error: string): BackgroundFailResult;
  stats(): BackgroundQueueStats;
  pendingKind(kind: BackgroundJobKind): number;
  pause(): void;
  resume(): void;
  disable(): void;
  enable(): void;
  setInteractivePressure(shedding: boolean): void;
  setJudgeAvailable(available: boolean): void;
  destroy(): void;
}

interface StoredJob {
  readonly jobId: string;
  readonly idempotencyKey: string;
  readonly kind: BackgroundJobKind;
  readonly turnId: string | undefined;
  readonly enqueuedAtMs: number;
  readonly maxAttempts: number;
  readonly payload: BackgroundPayload;
  attempts: number;
  notBeforeMs: number;
}

export interface BackgroundJobQueueOptions {
  readonly config?: BackgroundQueueConfig | undefined;
  readonly now?: (() => number) | undefined;
  readonly newId?: (() => string) | undefined;
}

const MAX_COMPLETED_KEYS_HARD_CAP = 50_000;

export function createBackgroundJobQueue(options: BackgroundJobQueueOptions = {}): BackgroundJobQueue {
  const config: BackgroundQueueConfig = options.config ?? DEFAULT_BACKGROUND_QUEUE_CONFIG;
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomUUID;
  const pending = new Map<string, StoredJob>();
  const keyToJob = new Map<string, string>();
  const completedKeys: string[] = [];
  const completedKeySet = new Set<string>();
  const deadLetter: Array<{ jobId: string; reason: string }> = [];
  let paused = false;
  let disabled = false;
  let interactivePressure = false;
  let judgeAvailable = true;
  let enqueuedTotal = 0;
  let completedTotal = 0;
  let shedTotal = 0;
  let duplicateTotal = 0;
  let destroyed = false;

  function throwIfDestroyed(): void {
    if (destroyed) throw new Error('background-queue: queue destroyed');
  }

  function rememberCompletedKey(key: string): void {
    if (completedKeySet.has(key)) return;
    completedKeys.push(key);
    completedKeySet.add(key);
    const retention = Math.min(config.completedKeyRetention, MAX_COMPLETED_KEYS_HARD_CAP);
    while (completedKeys.length > retention) {
      const oldest = completedKeys.shift();
      if (oldest !== undefined) completedKeySet.delete(oldest);
    }
  }

  function shed(reason: BackgroundShedReason): BackgroundEnqueueResult {
    shedTotal += 1;
    logger.warn('capacity.background.shed', { reason });
    return Object.freeze({ kind: 'shed', reason, retryAfterMs: config.retryAfterMs });
  }

  function judgeDepth(): number {
    let count = 0;
    for (const job of pending.values()) {
      if (job.kind === 'judge') count += 1;
    }
    return count;
  }

  function oldestAgeMs(): number | null {
    let oldest: number | null = null;
    const current = now();
    for (const job of pending.values()) {
      const age = current - job.enqueuedAtMs;
      oldest = oldest === null ? age : Math.max(oldest, age);
    }
    return oldest;
  }

  return {
    enqueue(raw: unknown): BackgroundEnqueueResult {
      throwIfDestroyed();
      const parsed = BackgroundJobSchema.parse(raw);
      const atMs = parsed.enqueuedAtMs ?? now();
      if (disabled) return shed('disabled');
      if (paused) return shed('paused');
      if (!judgeAvailable && parsed.kind === 'judge') return shed('judge_unavailable');
      if (interactivePressure && parsed.kind === 'judge') return shed('interactive_pressure');
      const existingJobId = keyToJob.get(parsed.idempotencyKey);
      if (existingJobId !== undefined && pending.has(existingJobId)) {
        duplicateTotal += 1;
        return Object.freeze({ kind: 'duplicate', jobId: existingJobId });
      }
      if (completedKeySet.has(parsed.idempotencyKey)) {
        duplicateTotal += 1;
        const prior = keyToJob.get(parsed.idempotencyKey) ?? parsed.jobId;
        return Object.freeze({ kind: 'duplicate', jobId: prior });
      }
      if (pending.size >= config.maxDepth) return shed('queue_full');
      if (parsed.kind === 'judge' && judgeDepth() >= config.judgeMaxDepth) return shed('queue_full');
      const jobId = parsed.jobId || newId();
      const job: StoredJob = {
        jobId,
        idempotencyKey: parsed.idempotencyKey,
        kind: parsed.kind,
        turnId: parsed.turnId,
        enqueuedAtMs: atMs,
        maxAttempts: parsed.maxAttempts ?? 3,
        payload: parsed.payload ?? {},
        attempts: 0,
        notBeforeMs: atMs,
      };
      pending.set(jobId, job);
      keyToJob.set(parsed.idempotencyKey, jobId);
      enqueuedTotal += 1;
      logger.info('capacity.background.enqueued', { jobId, kind: parsed.kind, depth: pending.size });
      return Object.freeze({ kind: 'enqueued', jobId, position: pending.size });
    },

    complete(jobId: string): boolean {
      throwIfDestroyed();
      const job = pending.get(jobId);
      if (job === undefined) return false;
      pending.delete(jobId);
      rememberCompletedKey(job.idempotencyKey);
      completedTotal += 1;
      logger.info('capacity.background.completed', { jobId, kind: job.kind });
      return true;
    },

    fail(jobId: string, error: string): BackgroundFailResult {
      throwIfDestroyed();
      const job = pending.get(jobId);
      if (job === undefined) return Object.freeze({ kind: 'unknown_job', jobId });
      job.attempts += 1;
      if (job.attempts >= job.maxAttempts) {
        pending.delete(jobId);
        rememberCompletedKey(job.idempotencyKey);
        deadLetter.push({ jobId, reason: error.slice(0, 500) });
        while (deadLetter.length > 500) deadLetter.shift();
        logger.warn('capacity.background.dead_letter', { jobId, kind: job.kind, attempts: job.attempts });
        return Object.freeze({ kind: 'dead_letter', jobId, reason: error.slice(0, 500) });
      }
      const delayIndex = Math.min(job.attempts - 1, config.retryDelaysMs.length - 1);
      const delay = config.retryDelaysMs[delayIndex] ?? config.retryAfterMs;
      job.notBeforeMs = now() + delay;
      logger.warn('capacity.background.retry_scheduled', { jobId, attempt: job.attempts, notBeforeMs: job.notBeforeMs });
      return Object.freeze({ kind: 'retry_scheduled', jobId, attempt: job.attempts, notBeforeMs: job.notBeforeMs });
    },

    stats(): BackgroundQueueStats {
      throwIfDestroyed();
      const age = oldestAgeMs();
      return Object.freeze({
        depth: pending.size,
        judgeDepth: judgeDepth(),
        enqueuedTotal,
        completedTotal,
        shedTotal,
        duplicateTotal,
        deadLetterTotal: deadLetter.length,
        oldestAgeMs: age,
        backlogStale: age !== null && age > config.maxBacklogAgeMs,
        paused,
        disabled,
        interactivePressure,
      });
    },

    pendingKind(kind: BackgroundJobKind): number {
      throwIfDestroyed();
      let count = 0;
      for (const job of pending.values()) {
        if (job.kind === kind) count += 1;
      }
      return count;
    },

    pause(): void {
      throwIfDestroyed();
      paused = true;
      logger.warn('capacity.background.paused', {});
    },

    resume(): void {
      throwIfDestroyed();
      paused = false;
      logger.info('capacity.background.resumed', {});
    },

    disable(): void {
      throwIfDestroyed();
      disabled = true;
      logger.warn('capacity.background.disabled', {});
    },

    enable(): void {
      throwIfDestroyed();
      disabled = false;
      logger.info('capacity.background.enabled', {});
    },

    setInteractivePressure(shedding: boolean): void {
      throwIfDestroyed();
      interactivePressure = shedding;
      logger.info('capacity.background.interactive_pressure', { shedding });
    },

    setJudgeAvailable(available: boolean): void {
      throwIfDestroyed();
      judgeAvailable = available;
    },

    destroy(): void {
      pending.clear();
      keyToJob.clear();
      completedKeys.length = 0;
      completedKeySet.clear();
      deadLetter.length = 0;
      destroyed = true;
    },
  };
}

/**
 * Judge job payload codec (WP-8 F-39).
 *
 * Queue payloads are flat string maps (both the application port and the
 * infrastructure adapter validate `record(string, string|number|boolean|
 * null)`), so the `snippets: string[]` judge input travels as a JSON string.
 * These pure helpers are the single source for encoding at enqueue time and
 * decoding in workers/consumers; every boundary rejects malformed payloads
 * instead of executing partial work.
 */
export const JUDGE_SNIPPETS_MAX_ITEMS = 50;
export const JUDGE_SNIPPETS_MAX_CHARS = 20_000;
export const JUDGE_TEXT_MAX_CHARS = 100_000;
export const JUDGE_ANSWER_MAX_CHARS = 50_000;

export interface JudgePayloadInput {
  readonly question: string;
  readonly snippets: readonly string[];
  readonly documents: string;
  readonly answer: string;
}

export interface JudgePayloadEncoded {
  readonly question: string;
  readonly snippetsJson: string;
  readonly documents: string;
  readonly answer: string;
}

export function encodeJudgePayload(input: JudgePayloadInput): JudgePayloadEncoded {
  if (
    typeof input.question !== 'string' ||
    input.question.length === 0 ||
    input.question.length > JUDGE_TEXT_MAX_CHARS
  ) {
    throw new Error('encodeJudgePayload: question must be a non-empty string within bounds');
  }
  if (!Array.isArray(input.snippets) || input.snippets.length > JUDGE_SNIPPETS_MAX_ITEMS) {
    throw new Error('encodeJudgePayload: snippets must be an array within bounds');
  }
  // Mirror the decode bounds: oversized payloads throw here so the caller
  // falls back inline instead of enqueueing work the worker would drop.
  for (const snippet of input.snippets) {
    if (typeof snippet !== 'string' || snippet.length > JUDGE_SNIPPETS_MAX_CHARS) {
      throw new Error('encodeJudgePayload: snippet out of bounds');
    }
  }
  if (typeof input.documents !== 'string' || input.documents.length > JUDGE_TEXT_MAX_CHARS) {
    throw new Error('encodeJudgePayload: documents out of bounds');
  }
  if (typeof input.answer !== 'string' || input.answer.length > JUDGE_ANSWER_MAX_CHARS) {
    throw new Error('encodeJudgePayload: answer out of bounds');
  }
  return Object.freeze({
    question: input.question,
    snippetsJson: JSON.stringify([...input.snippets]),
    documents: input.documents,
    answer: input.answer,
  });
}

export function decodeJudgePayload(payload: unknown): JudgePayloadInput | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const record = payload as Readonly<Record<string, unknown>>;
  const { question, snippetsJson, documents, answer } = record;
  if (typeof question !== 'string' || question.length === 0 || question.length > JUDGE_TEXT_MAX_CHARS) {
    return null;
  }
  if (typeof snippetsJson !== 'string') return null;
  let snippets: unknown;
  try {
    snippets = JSON.parse(snippetsJson);
  } catch {
    return null;
  }
  if (
    !Array.isArray(snippets) ||
    snippets.length > JUDGE_SNIPPETS_MAX_ITEMS ||
    snippets.some((entry) => typeof entry !== 'string' || entry.length > JUDGE_SNIPPETS_MAX_CHARS)
  ) {
    return null;
  }
  if (typeof documents !== 'string' || documents.length > JUDGE_TEXT_MAX_CHARS) return null;
  if (typeof answer !== 'string' || answer.length > JUDGE_ANSWER_MAX_CHARS) return null;
  return Object.freeze({
    question,
    snippets: Object.freeze([...snippets]) as readonly string[],
    documents,
    answer,
  });
}

/** Stable job identity for one turn's sampled judge (repeat deliveries collapse). */
export function judgeJobId(turnId: string): string {
  return `judge-${turnId}`.slice(0, 200);
}

/** Idempotency key scope for one turn's sampled judge. */
export function judgeIdempotencyKey(turnId: string): string {
  return `judge-turn:${turnId}`.slice(0, 300);
}
