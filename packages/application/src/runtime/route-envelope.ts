import { z } from 'zod';

/**
 * Deployment-owned route envelope for the chat route (WP-8 Task A, F-31).
 *
 * The Vercel `maxDuration` export in `src/app/api/chat/route.ts` stays at 60
 * seconds. This module is the single deployment-owned constant describing what
 * that envelope means: platform hard limit, application hard stop, and the
 * mandatory finalization reserve. Longer candidate profiles are data for
 * measurement, not a config change: enabling one still requires the WP-8
 * load/deadline gates plus a separate route-export change.
 */

export const CHAT_ROUTE_MAX_DURATION_SECS = 60 as const;

export const RouteEnvelopeSchema = z.object({
  name: z.string().min(1).max(100),
  platformLimitMs: z.number().int().positive(),
  appHardStopMs: z.number().int().positive(),
  finalizeReserveMs: z.number().int().nonnegative(),
});
export type RouteEnvelope = z.infer<typeof RouteEnvelopeSchema>;

export const MIN_FINALIZE_RESERVE_MS = 10_000 as const;
export const FINALIZE_RESERVE_RATIO = 0.1 as const;

/**
 * Minimum finalization reserve for a platform envelope: never less than
 * `max(10_000 ms, 10% of the platform limit)`. Reserves tune upward from p99
 * persistence/cache-release data, never downward from wishful latency.
 */
export function minimumReserveForPlatform(platformLimitMs: number): number {
  if (!Number.isFinite(platformLimitMs) || platformLimitMs <= 0) {
    throw new Error('minimumReserveForPlatform: platformLimitMs must be a positive number');
  }
  return Math.max(MIN_FINALIZE_RESERVE_MS, Math.ceil(platformLimitMs * FINALIZE_RESERVE_RATIO));
}

/**
 * Build assertion for a route envelope. The application hard stop must be
 * strictly smaller than the platform limit, and the reserve must cover the
 * gap between them plus the minimum floor.
 */
export function assertRouteEnvelopeValid(input: unknown): RouteEnvelope {
  const envelope = RouteEnvelopeSchema.parse(input);
  if (!(envelope.appHardStopMs < envelope.platformLimitMs)) {
    throw new Error(
      `assertRouteEnvelopeValid: envelope ${envelope.name} app hard stop ` +
        `(${envelope.appHardStopMs}ms) must be smaller than the platform limit ` +
        `(${envelope.platformLimitMs}ms)`,
    );
  }
  const gap = envelope.platformLimitMs - envelope.appHardStopMs;
  if (envelope.finalizeReserveMs !== gap) {
    throw new Error(
      `assertRouteEnvelopeValid: envelope ${envelope.name} reserve ` +
        `(${envelope.finalizeReserveMs}ms) must equal platform limit minus app hard stop (${gap}ms)`,
    );
  }
  const minimum = minimumReserveForPlatform(envelope.platformLimitMs);
  if (envelope.finalizeReserveMs < minimum) {
    throw new Error(
      `assertRouteEnvelopeValid: envelope ${envelope.name} reserve ` +
        `(${envelope.finalizeReserveMs}ms) is below the minimum ${minimum}ms ` +
        `(max(10s, 10% of platform))`,
    );
  }
  return Object.freeze({ ...envelope });
}

/** Current production envelope: 60s platform, 50s app hard stop, 10s reserve. */
export const ROUTE_ENVELOPE_CURRENT_60: RouteEnvelope = assertRouteEnvelopeValid({
  name: 'current-60s',
  platformLimitMs: 60_000,
  appHardStopMs: 50_000,
  finalizeReserveMs: 10_000,
});

/** Candidate envelope for measurement only: 90s platform, 75s stop, 15s reserve. */
export const ROUTE_ENVELOPE_CANDIDATE_90: RouteEnvelope = assertRouteEnvelopeValid({
  name: 'candidate-90s',
  platformLimitMs: 90_000,
  appHardStopMs: 75_000,
  finalizeReserveMs: 15_000,
});

/** Provisional envelope for measurement only: 120s platform, 105s stop, 15s reserve. */
export const ROUTE_ENVELOPE_PROVISIONAL_120: RouteEnvelope = assertRouteEnvelopeValid({
  name: 'provisional-120s',
  platformLimitMs: 120_000,
  appHardStopMs: 105_000,
  finalizeReserveMs: 15_000,
});

export const ROUTE_ENVELOPE_PROFILES: readonly RouteEnvelope[] = Object.freeze([
  ROUTE_ENVELOPE_CURRENT_60,
  ROUTE_ENVELOPE_CANDIDATE_90,
  ROUTE_ENVELOPE_PROVISIONAL_120,
]);

export function resolveRouteEnvelope(name: string): RouteEnvelope {
  const found = ROUTE_ENVELOPE_PROFILES.find((profile) => profile.name === name);
  if (found === undefined) {
    throw new Error(`resolveRouteEnvelope: unknown envelope ${name}`);
  }
  return found;
}

/**
 * Rejects a ledger deadline that is incompatible with the envelope: a higher
 * absolute deadline than `acceptedAtMs + appHardStopMs` can never fit the
 * platform limit plus its shutdown reserve, so it fails at build/composition
 * time instead of dying as a platform hard kill.
 */
export function assertLedgerFitsEnvelope(input: {
  readonly acceptedAtMs: number;
  readonly deadlineAt: number;
  readonly envelope: RouteEnvelope;
}): void {
  const latest = input.acceptedAtMs + input.envelope.appHardStopMs;
  if (!(input.deadlineAt <= latest)) {
    throw new Error(
      `assertLedgerFitsEnvelope: deadlineAt ${input.deadlineAt} exceeds the ` +
        `${input.envelope.name} app hard stop ${latest} (accepted ${input.acceptedAtMs} + ` +
        `${input.envelope.appHardStopMs}ms)`,
    );
  }
}
