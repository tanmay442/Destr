import { err, ok, type Result, RateLimitedError } from '@app/domain';
import type { RateLimiter } from '@app/domain';

interface RateLimitInput {
  key: string;
  limit: number;
  windowMs: number;
}

export async function enforceRateLimit(
  input: RateLimitInput,
  deps: { limiter: RateLimiter },
): Promise<Result<{ remaining: number; resetMs: number }>> {
  const r = await deps.limiter.check(input.key, { limit: input.limit, windowMs: input.windowMs });
  if (r.ok) return ok({ remaining: r.remaining, resetMs: r.resetMs });
  return err(new RateLimitedError('Rate limit exceeded', r.retryAfterMs));
}
export type RateLimitDeps = { limiter: import('@app/domain').RateLimiter };
