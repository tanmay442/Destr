import type { AnswerCache } from '@app/domain';

export interface CacheWaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  if (!signal) return new Promise((resolve) => setTimeout(resolve, delayMs));
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new Error('Aborted'));
    };
    const timer = setTimeout(() => {
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function waitForCachedAnswer(
  cache: AnswerCache,
  key: string,
  options: CacheWaitOptions = {},
): Promise<string | null> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 45_000);
  const deadline = Date.now() + timeoutMs;
  let delayMs = 25;
  while (Date.now() < deadline) {
    await wait(Math.min(delayMs, Math.max(1, deadline - Date.now())), options.signal);
    const value = await cache.get(key).catch(() => null);
    if (value) return value;
    delayMs = Math.min(delayMs * 2, 250);
  }
  return null;
}
