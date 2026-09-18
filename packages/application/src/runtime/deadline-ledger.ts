import { z } from 'zod';
import { createAgentRunBudget, type AgentRunBudget } from '../agent/agent-budget';
import { assertLedgerFitsEnvelope, type RouteEnvelope } from './route-envelope';

/**
 * Request-level deadline ledger (WP-8 Task A, F-30).
 *
 * One absolute `deadlineAt` is fixed at request acceptance. Every phase of the
 * turn — admission/auth/body parsing, cache coordination, the model/tool/search
 * loop, grounding verification, persistence, cache publication/lease release,
 * stream finalization, and mandatory cleanup — derives its allowance from the
 * remaining time. Child work never creates a fresh full-duration timer: every
 * child timeout is clamped to the remaining parent budget minus the
 * finalization reserve.
 *
 * Work-deadline attribution preserves the 2d075e5 rule: at or past the reserve
 * boundary the stop is `deadline_exceeded`, never a budget stop.
 */

export const REQUEST_PHASES = [
  'admission',
  'cache_lookup',
  'model_tool_search',
  'grounding',
  'persistence',
  'cache_publication',
  'stream_finalization',
  'cleanup',
] as const;
export type RequestPhase = (typeof REQUEST_PHASES)[number];

export const RequestPhaseSchema = z.enum(REQUEST_PHASES);

/** Phases that must complete inside the mandatory finalization reserve. */
export const FINALIZE_PHASES: readonly RequestPhase[] = Object.freeze([
  'persistence',
  'cache_publication',
  'stream_finalization',
  'cleanup',
]);

export const DEPENDENCY_TIMEOUT_CAPS_MS = Object.freeze({
  redis_coordination: 1_000,
  sql_lookup: 2_000,
  sql_vector: 5_000,
  sql_lexical: 5_000,
  embedding: 8_000,
  rerank: 5_000,
  grounding: 12_000,
});
export type DependencyKind = keyof typeof DEPENDENCY_TIMEOUT_CAPS_MS;
export const DependencyKindSchema = z.enum([
  'redis_coordination',
  'sql_lookup',
  'sql_vector',
  'sql_lexical',
  'embedding',
  'rerank',
  'grounding',
] as const);

export const DeadlineOutcomeKindSchema = z.enum([
  'completed',
  'cancelled',
  'timeout',
  'insufficient_budget',
  'skipped',
  'degraded',
]);
export type DeadlineOutcomeKind = z.infer<typeof DeadlineOutcomeKindSchema>;

export const SkipReasonSchema = z.enum([
  'budget_exhausted',
  'cancelled',
  'dependency_failed',
  'cache_hit',
  'not_required',
]);
export type SkipReason = z.infer<typeof SkipReasonSchema>;

export type DeadlineOutcome =
  | {
      readonly kind: 'completed';
      readonly phase: RequestPhase;
      readonly remainingMs: number;
    }
  | {
      readonly kind: 'cancelled';
      readonly phase: RequestPhase;
      readonly remainingMs: number;
    }
  | {
      readonly kind: 'timeout';
      readonly phase: RequestPhase;
      readonly deadlineAt: number;
      readonly remainingMs: number;
    }
  | {
      readonly kind: 'insufficient_budget';
      readonly phase: RequestPhase;
      readonly remainingMs: number;
      readonly expectedMs: number;
      readonly reserveMs: number;
    }
  | {
      readonly kind: 'skipped';
      readonly phase: RequestPhase;
      readonly reason: SkipReason;
      readonly remainingMs: number;
    }
  | {
      readonly kind: 'degraded';
      readonly phase: RequestPhase;
      readonly reason: string;
      readonly fallback: string;
      readonly remainingMs: number;
    };

export interface PhaseTelemetry {
  readonly phase: RequestPhase;
  readonly startedAtMs: number | null;
  readonly endedAtMs: number | null;
  /** Remaining time to the app hard stop at phase start (`deadline_remaining_ms`). */
  readonly deadlineRemainingAtStartMs: number | null;
  /** Remaining time to the app hard stop at phase end (`deadline_remaining_ms`). */
  readonly deadlineRemainingAtEndMs: number | null;
  readonly outcome: DeadlineOutcome | null;
}

export interface LedgerSnapshot {
  readonly acceptedAtMs: number;
  readonly platformLimitMs: number;
  readonly appHardStopMs: number;
  readonly finalizeReserveMs: number;
  readonly deadlineAt: number;
  readonly platformDeadlineAt: number;
  readonly cancelled: boolean;
  readonly finalized: boolean;
  readonly phases: readonly PhaseTelemetry[];
}

export type LedgerLogEvent = 'phase.started' | 'phase.ended' | 'phase.refused' | 'ledger.cancelled' | 'ledger.finalized';
export type LedgerLogSink = (
  event: LedgerLogEvent,
  fields: Readonly<Record<string, string | number | boolean | null>>,
) => void;

const DeadlineLedgerInputSchema = z.object({
  acceptedAtMs: z.number().int(),
  platformLimitMs: z.number().int().positive(),
  appHardStopMs: z.number().int().positive(),
  finalizeReserveMs: z.number().int().nonnegative(),
});

export interface CreateDeadlineLedgerInput {
  readonly acceptedAtMs: number;
  readonly platformLimitMs: number;
  readonly appHardStopMs: number;
  readonly finalizeReserveMs: number;
}

export interface DeadlineLedger {
  readonly acceptedAtMs: number;
  readonly platformLimitMs: number;
  readonly appHardStopMs: number;
  readonly finalizeReserveMs: number;
  /** Absolute application hard stop: acceptedAtMs + appHardStopMs. */
  readonly deadlineAt: number;
  /** Absolute platform kill instant: acceptedAtMs + platformLimitMs. */
  readonly platformDeadlineAt: number;
  /** Request cancellation signal; every tool/search call must share it. */
  readonly signal: AbortSignal;
  readonly cancelled: boolean;
  readonly finalized: boolean;
  /** Remaining ms to the app hard stop; never negative. */
  remainingMs(nowMs: number): number;
  /**
   * Remaining ms in which new work may start: time to the hard stop minus the
   * finalization reserve. Never negative; zero means no new work fits.
   */
  remainingWorkMs(nowMs: number): number;
  /**
   * True when `expectedDurationMs` of work plus the finalize reserve still
   * fits. New model calls or physical retrievals must not start otherwise.
   */
  canStart(input: { readonly phase: RequestPhase; readonly nowMs: number; readonly expectedDurationMs: number }): boolean;
  /**
   * Child timeout clamped to the remaining work budget. Never a fresh
   * full-duration timer: always `<= remainingWorkMs(nowMs)` and
   * `<= timeoutCapMs`.
   */
  childTimeoutMs(nowMs: number, timeoutCapMs: number): number;
  /** Per-dependency timeout: the dependency cap clamped to the work budget. */
  dependencyTimeoutMs(nowMs: number, dependency: DependencyKind): number;
  tryStartPhase(input: {
    readonly phase: RequestPhase;
    readonly nowMs: number;
    readonly expectedDurationMs: number;
  }): { readonly started: true; readonly telemetry: PhaseTelemetry } | { readonly started: false; readonly outcome: DeadlineOutcome };
  endPhase(input: {
    readonly phase: RequestPhase;
    readonly nowMs: number;
    readonly outcome: DeadlineOutcomeKind | DeadlineOutcome;
    readonly reason?: string;
    readonly fallback?: string;
  }): PhaseTelemetry;
  cancel(): void;
  throwIfCancelled(phase: RequestPhase, nowMs: number): void;
  /**
   * Idempotent bounded finalization. The first call records the terminal
   * telemetry; later calls return the identical frozen result and run nothing.
   */
  finalize(nowMs: number): LedgerSnapshot;
  snapshot(): LedgerSnapshot;
  /**
   * Derives the WP-5 AgentRunBudget from the same absolute deadline. Budget
   * counts are fixed run constants: a longer platform envelope never raises
   * model/tool/search/evidence/token/retry/cost limits.
   */
  toAgentRunBudget(overrides?: Partial<Omit<AgentRunBudget, 'deadlineAt' | 'finalizeReserveMs'>>): AgentRunBudget;
}

function freezeTelemetry(entry: PhaseTelemetry): PhaseTelemetry {
  return Object.freeze({ ...entry });
}

/**
 * 2d075e5 work-deadline attribution: at or past the reserve boundary the stop
 * is a deadline stop even when a budget is also exhausted; below the boundary
 * the budget stop stands.
 */
export function attributeWorkStop(input: {
  readonly nowMs: number;
  readonly deadlineAt: number;
  readonly finalizeReserveMs: number;
  readonly budgetStop: 'max_model_steps' | 'max_total_tool_calls' | 'max_search_calls' | 'budget_exhausted';
}): 'deadline_exceeded' | 'max_model_steps' | 'max_total_tool_calls' | 'max_search_calls' | 'budget_exhausted' {
  if (input.nowMs >= input.deadlineAt - input.finalizeReserveMs) {
    return 'deadline_exceeded';
  }
  return input.budgetStop;
}

export function createDeadlineLedger(
  rawInput: unknown,
  options?: {
    readonly parentSignal?: AbortSignal;
    readonly log?: LedgerLogSink;
    readonly envelope?: RouteEnvelope;
  },
): DeadlineLedger {
  const parsed = DeadlineLedgerInputSchema.parse(rawInput);
  const input: CreateDeadlineLedgerInput = {
    acceptedAtMs: parsed.acceptedAtMs,
    platformLimitMs: parsed.platformLimitMs,
    appHardStopMs: parsed.appHardStopMs,
    finalizeReserveMs: parsed.finalizeReserveMs,
  };
  if (!(input.appHardStopMs < input.platformLimitMs)) {
    throw new Error(
      `createDeadlineLedger: app hard stop (${input.appHardStopMs}ms) must be smaller than the platform limit (${input.platformLimitMs}ms)`,
    );
  }
  if (input.finalizeReserveMs !== input.platformLimitMs - input.appHardStopMs) {
    throw new Error(
      `createDeadlineLedger: finalize reserve (${input.finalizeReserveMs}ms) must equal ` +
        `platform limit minus app hard stop (${input.platformLimitMs - input.appHardStopMs}ms)`,
    );
  }
  if (options?.envelope !== undefined) {
    assertLedgerFitsEnvelope({
      acceptedAtMs: input.acceptedAtMs,
      deadlineAt: input.acceptedAtMs + input.appHardStopMs,
      envelope: options.envelope,
    });
  }

  const deadlineAt = input.acceptedAtMs + input.appHardStopMs;
  const platformDeadlineAt = input.acceptedAtMs + input.platformLimitMs;
  const controller = new AbortController();
  if (options?.parentSignal !== undefined) {
    if (options.parentSignal.aborted) {
      controller.abort();
    } else {
      options.parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }
  const log = options?.log;

  const telemetry = new Map<RequestPhase, PhaseTelemetry>();
  let cancelled = false;
  let finalized: LedgerSnapshot | null = null;

  const remainingMs = (nowMs: number): number => Math.max(0, deadlineAt - nowMs);
  const remainingWorkMs = (nowMs: number): number =>
    Math.max(0, deadlineAt - input.finalizeReserveMs - nowMs);

  const record = (entry: PhaseTelemetry): PhaseTelemetry => {
    const frozen = freezeTelemetry(entry);
    telemetry.set(entry.phase, frozen);
    return frozen;
  };

  const ledger: DeadlineLedger = {
    acceptedAtMs: input.acceptedAtMs,
    platformLimitMs: input.platformLimitMs,
    appHardStopMs: input.appHardStopMs,
    finalizeReserveMs: input.finalizeReserveMs,
    deadlineAt,
    platformDeadlineAt,
    signal: controller.signal,
    get cancelled() {
      return cancelled || controller.signal.aborted;
    },
    get finalized() {
      return finalized !== null;
    },
    remainingMs,
    remainingWorkMs,
    canStart(start) {
      if (cancelled || controller.signal.aborted) return false;
      if (!Number.isFinite(start.expectedDurationMs) || start.expectedDurationMs < 0) return false;
      // Strict work-budget rule (mirrors WP-5 canStartNewModelStep): at the
      // exact reserve boundary the child timeout is already zero, so no new
      // work fits and none may start.
      const work = remainingWorkMs(start.nowMs);
      return work > 0 && work >= start.expectedDurationMs;
    },
    childTimeoutMs(nowMs, timeoutCapMs) {
      if (!Number.isFinite(timeoutCapMs) || timeoutCapMs < 0) return 0;
      return Math.max(0, Math.min(remainingWorkMs(nowMs), Math.floor(timeoutCapMs)));
    },
    dependencyTimeoutMs(nowMs, dependency) {
      const cap = DEPENDENCY_TIMEOUT_CAPS_MS[dependency];
      return Math.max(0, Math.min(remainingWorkMs(nowMs), cap));
    },
    tryStartPhase(start) {
      const remaining = remainingMs(start.nowMs);
      if (cancelled || controller.signal.aborted) {
        const outcome: DeadlineOutcome = {
          kind: 'cancelled',
          phase: start.phase,
          remainingMs: remaining,
        };
        log?.('phase.refused', {
          phase: start.phase,
          outcome: 'cancelled',
          deadline_remaining_ms: remaining,
        });
        return { started: false as const, outcome };
      }
      if (!ledger.canStart(start)) {
        const outcome: DeadlineOutcome = {
          kind: 'insufficient_budget',
          phase: start.phase,
          remainingMs: remaining,
          expectedMs: start.expectedDurationMs,
          reserveMs: input.finalizeReserveMs,
        };
        log?.('phase.refused', {
          phase: start.phase,
          outcome: 'insufficient_budget',
          deadline_remaining_ms: remaining,
        });
        return { started: false as const, outcome };
      }
      const entry = record({
        phase: start.phase,
        startedAtMs: start.nowMs,
        endedAtMs: null,
        deadlineRemainingAtStartMs: remaining,
        deadlineRemainingAtEndMs: null,
        outcome: null,
      });
      log?.('phase.started', { phase: start.phase, deadline_remaining_ms: remaining });
      return { started: true as const, telemetry: entry };
    },
    endPhase(end) {
      const remaining = remainingMs(end.nowMs);
      const previous = telemetry.get(end.phase);
      const outcome: DeadlineOutcome =
        typeof end.outcome === 'string'
          ? end.outcome === 'completed'
            ? { kind: 'completed', phase: end.phase, remainingMs: remaining }
            : end.outcome === 'cancelled'
              ? { kind: 'cancelled', phase: end.phase, remainingMs: remaining }
              : end.outcome === 'timeout'
                ? { kind: 'timeout', phase: end.phase, deadlineAt, remainingMs: remaining }
                : end.outcome === 'insufficient_budget'
                  ? {
                      kind: 'insufficient_budget',
                      phase: end.phase,
                      remainingMs: remaining,
                      expectedMs: 0,
                      reserveMs: input.finalizeReserveMs,
                    }
                  : end.outcome === 'skipped'
                    ? {
                        kind: 'skipped',
                        phase: end.phase,
                        reason: 'not_required',
                        remainingMs: remaining,
                      }
                    : {
                        kind: 'degraded',
                        phase: end.phase,
                        reason: end.reason ?? 'unspecified',
                        fallback: end.fallback ?? 'none',
                        remainingMs: remaining,
                      }
          : end.outcome;
      const entry = record({
        phase: end.phase,
        startedAtMs: previous?.startedAtMs ?? null,
        endedAtMs: end.nowMs,
        deadlineRemainingAtStartMs: previous?.deadlineRemainingAtStartMs ?? null,
        deadlineRemainingAtEndMs: remaining,
        outcome,
      });
      log?.('phase.ended', {
        phase: end.phase,
        outcome: outcome.kind,
        deadline_remaining_ms: remaining,
      });
      return entry;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      try {
        controller.abort();
      } catch {
        // Abort must never throw; the cancelled flag is authoritative.
      }
      log?.('ledger.cancelled', { deadline_remaining_ms: remainingMs(Date.now()) });
    },
    throwIfCancelled() {
      if (cancelled || controller.signal.aborted) {
        throw new DOMException('Chat turn was cancelled.', 'AbortError');
      }
    },
    finalize(nowMs) {
      if (finalized !== null) return finalized;
      const phases = REQUEST_PHASES.map(
        (phase) =>
          telemetry.get(phase) ??
          freezeTelemetry({
            phase,
            startedAtMs: null,
            endedAtMs: null,
            deadlineRemainingAtStartMs: null,
            deadlineRemainingAtEndMs: null,
            outcome: null,
          }),
      );
      finalized = Object.freeze({
        acceptedAtMs: input.acceptedAtMs,
        platformLimitMs: input.platformLimitMs,
        appHardStopMs: input.appHardStopMs,
        finalizeReserveMs: input.finalizeReserveMs,
        deadlineAt,
        platformDeadlineAt,
        cancelled: cancelled || controller.signal.aborted,
        finalized: true,
        phases: Object.freeze(phases),
      });
      log?.('ledger.finalized', { deadline_remaining_ms: remainingMs(nowMs) });
      return finalized;
    },
    snapshot() {
      if (finalized !== null) return finalized;
      const phases = REQUEST_PHASES.map(
        (phase) =>
          telemetry.get(phase) ??
          freezeTelemetry({
            phase,
            startedAtMs: null,
            endedAtMs: null,
            deadlineRemainingAtStartMs: null,
            deadlineRemainingAtEndMs: null,
            outcome: null,
          }),
      );
      return Object.freeze({
        acceptedAtMs: input.acceptedAtMs,
        platformLimitMs: input.platformLimitMs,
        appHardStopMs: input.appHardStopMs,
        finalizeReserveMs: input.finalizeReserveMs,
        deadlineAt,
        platformDeadlineAt,
        cancelled: cancelled || controller.signal.aborted,
        finalized: false,
        phases: Object.freeze(phases),
      });
    },
    toAgentRunBudget(overrides) {
      return createAgentRunBudget({
        nowMs: input.acceptedAtMs,
        deadlineInMs: input.appHardStopMs,
        finalizeReserveMs: input.finalizeReserveMs,
        ...(overrides === undefined ? {} : { overrides }),
      });
    },
  };

  return ledger;
}
