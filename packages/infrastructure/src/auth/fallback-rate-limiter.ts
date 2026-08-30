import type { RateLimiter } from '@app/domain';

export function createFallbackRateLimiter(input: {
  primary: RateLimiter;
  fallback: RateLimiter;
  onFallback?: (input: { key: string; error: unknown }) => void;
}): RateLimiter {
  return {
    async check(key, options) {
      try {
        return await input.primary.check(key, options);
      } catch (error) {
        input.onFallback?.({ key, error });
        return input.fallback.check(key, options);
      }
    },
  };
}
