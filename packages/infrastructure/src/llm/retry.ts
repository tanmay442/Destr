import { APICallError } from 'ai';

const RETRY_ATTEMPTS = 5;
const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 5_000;

export const EMBED_REQUEST_TIMEOUT_MS = 120_000;
export const AUX_REQUEST_TIMEOUT_MS = 60_000;

export function isDeadlineAbort(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with full jitter so concurrent retries don't align. */
export function retryDelay(attempt: number, cap?: number, rng: () => number = Math.random): number {
  const effectiveCap = cap ?? Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return rng() * effectiveCap;
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
  opts: { isNonRetryable?: (err: unknown) => boolean } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err)) throw err;
      if (opts.isNonRetryable?.(err)) throw err;
      if (attempt === attempts - 1) break;
      await sleep(retryDelay(attempt));
    }
  }
  throw new Error(`${context} failed after ${attempts} attempts`, { cause: lastErr });
}
