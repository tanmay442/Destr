import type { Composition } from '@/composition';

type CompositionRateLimitDecision = Awaited<ReturnType<Composition['rateLimit']>>;
type RateLimitedDecision = { ok: false; retryAfterMs: number };
type RateLimitDecision = { ok: true; remaining: number; resetMs: number } | RateLimitedDecision;

function isRateLimited(decision: CompositionRateLimitDecision): decision is RateLimitedDecision {
  return decision.ok === false && 'retryAfterMs' in decision;
}

export function normalizeRateLimitDecision(decision: CompositionRateLimitDecision): RateLimitDecision {
  if (isRateLimited(decision)) return decision;
  if (decision.ok === true && 'remaining' in decision && 'resetMs' in decision) {
    return { ok: true, remaining: decision.remaining, resetMs: decision.resetMs };
  }
  return { ok: false, retryAfterMs: 0 };
}
