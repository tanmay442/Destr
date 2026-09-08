import type { RateLimiter } from '@app/domain';

export function createFallbackRateLimiter(input: {
  primary: RateLimiter;
  fallback: RateLimiter;
  onFallback?: (input: { key: string; error: unknown }) => void;
}): RateLimiter {
  return {
    async check(key, options, signal) {
      if (signal?.aborted) throw new DOMException('Rate limit check was cancelled.', 'AbortError');
      try {
        const result = await input.primary.check(key, options, signal);
        if (signal?.aborted) throw new DOMException('Rate limit check was cancelled.', 'AbortError');
        return result;
      } catch (error) {
        if (signal?.aborted) throw new DOMException('Rate limit check was cancelled.', 'AbortError');
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw error;
        input.onFallback?.({ key, error });
        const result = await input.fallback.check(key, options, signal);
        if (signal?.aborted) throw new DOMException('Rate limit check was cancelled.', 'AbortError');
        return result;
      }
    },
  };
}
