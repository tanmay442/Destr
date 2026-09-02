import { APICallError } from 'ai';
import { MAX_DURATION_MS } from '@app/domain';

const RETRY_ATTEMPTS = 3;
const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 5_000;

export const EMBED_REQUEST_TIMEOUT_MS = 120_000;
export const AUX_REQUEST_TIMEOUT_MS = 60_000;
export const EMBEDDING_RETRY_BUDGET_MS = Math.max(MAX_DURATION_MS - 5_000, 1);

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function signalReason(signal: AbortSignal): unknown {
  return signal.reason ?? abortError();
}

export function isDeadlineAbort(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const delay = Math.max(0, ms);
  if (signal === undefined) {
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
  if (signal.aborted) return Promise.reject(signalReason(signal));

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signalReason(signal));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delay);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/** Exponential backoff with full jitter so concurrent retries don't align. */
export function retryDelay(attempt: number, cap?: number, rng: () => number = Math.random): number {
  const effectiveCap = cap ?? Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return rng() * effectiveCap;
}

function isHeaderGetter(value: object): value is { get(name: string): unknown } {
  return 'get' in value && typeof value.get === 'function';
}

function readRetryAfterHeader(headers: unknown): string | undefined {
  if (headers === null || typeof headers !== 'object') return undefined;
  if (isHeaderGetter(headers)) {
    const value = headers.get('retry-after');
    if (typeof value === 'string') return value;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'retry-after' && typeof value === 'string') return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function parseRetryAfter(value: string, now: number): number | undefined {
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;

  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const delayMs = Number(normalized) * 1_000;
    return Number.isFinite(delayMs) ? Math.max(0, delayMs) : undefined;
  }

  const retryAt = Date.parse(normalized);
  return Number.isNaN(retryAt) ? undefined : Math.max(0, retryAt - now);
}

export function getRetryAfterMs(err: unknown, now: number = Date.now()): number | undefined {
  const candidates: unknown[] = [];
  if (APICallError.isInstance(err)) candidates.push(err.responseHeaders);
  if (isRecord(err)) {
    candidates.push(err.responseHeaders, err.headers);
    const response = err.response;
    if (isRecord(response)) candidates.push(response.headers);
  }

  for (const headers of candidates) {
    const value = readRetryAfterHeader(headers);
    if (value !== undefined) return parseRetryAfter(value, now);
  }
  return undefined;
}

/** Transient failures are worth retrying: 429/5xx, timeouts, and network errors. */
export function isRetryableError(err: unknown): boolean {
  const status = (err as { statusCode?: number } | null | undefined)?.statusCode;
  if (typeof status === 'number') {
    return status === 429 || status >= 500;
  }
  if (APICallError.isInstance(err)) {
    if (err.statusCode === undefined) return true;
    return err.statusCode === 429 || err.statusCode >= 500;
  }
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND/i.test(code)) {
    return true;
  }
  const name = (err as { name?: unknown } | null)?.name;
  if (typeof name === 'string' && (name === 'TimeoutError' || name === 'AbortError')) return true;
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
    if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(err.message)) {
      return true;
    }
  }
  return false;
}

export class RetryBudgetExceededError extends Error {
  constructor(context: string, cause?: unknown) {
    super(
      `${context} exceeded its wall-clock retry budget`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'TimeoutError';
  }
}

export function isRetryBudgetExceeded(err: unknown): err is RetryBudgetExceededError {
  return err instanceof RetryBudgetExceededError;
}

export interface RetryBudget {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  remainingMs(): number;
  dispose(): void;
}

export function createRetryBudget(durationMs: number, parentSignal?: AbortSignal): RetryBudget {
  const boundedDurationMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const deadlineAt = Date.now() + boundedDurationMs;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let parentAbortHandler: (() => void) | undefined;

  const abortAtDeadline = () => {
    if (!controller.signal.aborted) controller.abort(new RetryBudgetExceededError('Retry'));
  };

  if (boundedDurationMs <= 0) abortAtDeadline();
  else timer = setTimeout(abortAtDeadline, boundedDurationMs);

  if (parentSignal) {
    const abortFromParent = () => {
      if (!controller.signal.aborted) controller.abort(signalReason(parentSignal));
    };
    parentAbortHandler = abortFromParent;
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }

  return {
    deadlineAt,
    signal: controller.signal,
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    dispose: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (parentSignal && parentAbortHandler) {
        parentSignal.removeEventListener('abort', parentAbortHandler);
        parentAbortHandler = undefined;
      }
    },
  };
}

export function assertRetryBudget(budget: RetryBudget, context: string): void {
  if (budget.remainingMs() <= 0) throw new RetryBudgetExceededError(context);
  if (!budget.signal.aborted) return;

  const reason = budget.signal.reason;
  if (isRetryBudgetExceeded(reason)) throw new RetryBudgetExceededError(context, reason);
  throw reason ?? abortError();
}

async function withAbortSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => undefined);
    throw signalReason(signal);
  }

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(signalReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

export interface RetryOptions {
  isNonRetryable?: (err: unknown) => boolean;
  budget?: RetryBudget;
  signal?: AbortSignal;
}

function assertRetryAvailable(opts: RetryOptions, context: string): void {
  if (opts.budget) {
    assertRetryBudget(opts.budget, context);
    return;
  }
  if (opts.signal?.aborted) throw signalReason(opts.signal);
}

/**
 * Run `fn` with bounded retries. Only retryable failures are retried; permanent
 * errors surface immediately. The final error carries the failing batch offset
 * so callers can report exactly which slice of work failed.
 * `opts.isNonRetryable` forces an error class (e.g. deadline aborts) to bypass
 * all retries and surface on the first attempt.
 */
export async function retryOnTransient<T>(
  fn: () => Promise<T>,
  context: string,
  attempts: number = RETRY_ATTEMPTS,
  opts: RetryOptions = {},
): Promise<T> {
  let lastErr: unknown;
  const retrySignal = opts.budget?.signal ?? opts.signal;

  for (let attempt = 0; attempt < attempts; attempt++) {
    assertRetryAvailable(opts, context);
    try {
      const result = await withAbortSignal(fn(), retrySignal);
      assertRetryAvailable(opts, context);
      return result;
    } catch (err) {
      lastErr = err;
      if (opts.budget) assertRetryAvailable(opts, context);
      else if (opts.signal?.aborted) throw signalReason(opts.signal);
      if (!isRetryableError(err)) throw err;
      if (opts.isNonRetryable?.(err)) throw err;
      if (attempt === attempts - 1) break;

      const backoffMs = retryDelay(attempt);
      const retryAfterMs = getRetryAfterMs(err);
      const delayMs = Math.max(backoffMs, retryAfterMs ?? 0);
      const sleepMs = opts.budget ? Math.min(delayMs, opts.budget.remainingMs()) : delayMs;
      try {
        await sleep(sleepMs, retrySignal);
      } catch (sleepError) {
        if (opts.budget) assertRetryAvailable(opts, context);
        throw sleepError;
      }
    }
  }
  throw new Error(`${context} failed after ${attempts} attempts`, { cause: lastErr });
}
