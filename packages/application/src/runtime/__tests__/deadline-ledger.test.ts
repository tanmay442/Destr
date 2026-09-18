import { describe, expect, it } from 'vitest';
import {
  attributeWorkStop,
  createDeadlineLedger,
  DEPENDENCY_TIMEOUT_CAPS_MS,
  FINALIZE_PHASES,
  REQUEST_PHASES,
  type DependencyKind,
  type RequestPhase,
} from '../deadline-ledger';
import {
  ROUTE_ENVELOPE_CANDIDATE_90,
  ROUTE_ENVELOPE_CURRENT_60,
  ROUTE_ENVELOPE_PROVISIONAL_120,
} from '../route-envelope';

const ENVELOPES = [
  { name: '60/50/10', platformLimitMs: 60_000, appHardStopMs: 50_000, finalizeReserveMs: 10_000 },
  { name: '90/75/15', platformLimitMs: 90_000, appHardStopMs: 75_000, finalizeReserveMs: 15_000 },
  { name: '120/105/15', platformLimitMs: 120_000, appHardStopMs: 105_000, finalizeReserveMs: 15_000 },
] as const;

function ledgerFor(envelope: (typeof ENVELOPES)[number], acceptedAtMs = 1_000_000) {
  return createDeadlineLedger({ acceptedAtMs, ...envelope });
}

describe('deadline ordering and reserve arithmetic', () => {
  it.each(ENVELOPES)('orders platform/app/phase/dependency budgets for $name', (envelope) => {
    const ledger = ledgerFor(envelope);
    const acceptedAtMs = 1_000_000;
    expect(ledger.deadlineAt).toBe(acceptedAtMs + envelope.appHardStopMs);
    expect(ledger.platformDeadlineAt).toBe(acceptedAtMs + envelope.platformLimitMs);
    expect(ledger.platformDeadlineAt).toBeGreaterThan(ledger.deadlineAt);
    expect(ledger.deadlineAt - ledger.finalizeReserveMs).toBeLessThan(ledger.deadlineAt);
    // Reserve equals the platform/app gap.
    expect(ledger.finalizeReserveMs).toBe(envelope.platformLimitMs - envelope.appHardStopMs);

    // Dependency caps sit strictly inside the work budget at acceptance.
    const nowMs = acceptedAtMs;
    for (const dependency of Object.keys(DEPENDENCY_TIMEOUT_CAPS_MS) as DependencyKind[]) {
      const timeout = ledger.dependencyTimeoutMs(nowMs, dependency);
      expect(timeout).toBe(DEPENDENCY_TIMEOUT_CAPS_MS[dependency]);
      expect(timeout).toBeLessThan(ledger.remainingMs(nowMs));
      expect(timeout).toBeLessThanOrEqual(ledger.remainingWorkMs(nowMs));
    }
    // Child timeout never exceeds the remaining parent work budget.
    expect(ledger.childTimeoutMs(nowMs, 500_000)).toBe(ledger.remainingWorkMs(nowMs));
    expect(ledger.childTimeoutMs(nowMs, 1_000)).toBe(Math.min(1_000, ledger.remainingWorkMs(nowMs)));
  });

  it('holds at least max(10s, 10% of platform) in every profile', () => {
    for (const envelope of ENVELOPES) {
      const floor = Math.max(10_000, Math.ceil(envelope.platformLimitMs * 0.1));
      expect(envelope.finalizeReserveMs).toBeGreaterThanOrEqual(floor);
    }
    // The provisional 120/105/15 profile reserves the full 15s.
    expect(ROUTE_ENVELOPE_PROVISIONAL_120.finalizeReserveMs).toBe(15_000);
    expect(ROUTE_ENVELOPE_CANDIDATE_90.finalizeReserveMs).toBe(15_000);
    expect(ROUTE_ENVELOPE_CURRENT_60.finalizeReserveMs).toBe(10_000);
  });

  it('covers every required request phase', () => {
    expect([...REQUEST_PHASES]).toEqual([
      'admission',
      'cache_lookup',
      'model_tool_search',
      'grounding',
      'persistence',
      'cache_publication',
      'stream_finalization',
      'cleanup',
    ]);
    expect([...FINALIZE_PHASES]).toEqual([
      'persistence',
      'cache_publication',
      'stream_finalization',
      'cleanup',
    ]);
  });

  it('rejects inconsistent envelopes at the boundary', () => {
    expect(() =>
      createDeadlineLedger({
        acceptedAtMs: 0,
        platformLimitMs: 60_000,
        appHardStopMs: 60_000,
        finalizeReserveMs: 0,
      }),
    ).toThrow(/must be smaller/);
    expect(() =>
      createDeadlineLedger({
        acceptedAtMs: 0,
        platformLimitMs: 60_000,
        appHardStopMs: 50_000,
        finalizeReserveMs: 5_000,
      }),
    ).toThrow(/must equal/);
    expect(() => createDeadlineLedger(null)).toThrow();
  });

  it('rejects a ledger deadline above the route envelope', () => {
    expect(() =>
      createDeadlineLedger(
        {
          acceptedAtMs: 0,
          platformLimitMs: 60_000,
          appHardStopMs: 55_000,
          finalizeReserveMs: 5_000,
        },
        { envelope: ROUTE_ENVELOPE_CURRENT_60 },
      ),
    ).toThrow(/exceeds/);
  });
});

describe('refusal to start work that cannot fit', () => {
  it('refuses phases whose expected duration plus reserve no longer fits', () => {
    const ledger = ledgerFor(ENVELOPES[0]!);
    const acceptedAtMs = 1_000_000;
    // Work budget ends at deadlineAt - reserve = accepted + 40s.
    expect(
      ledger.canStart({ phase: 'model_tool_search', nowMs: acceptedAtMs + 39_999, expectedDurationMs: 0 }),
    ).toBe(true);
    const refused = ledger.tryStartPhase({
      phase: 'model_tool_search',
      nowMs: acceptedAtMs + 40_000,
      expectedDurationMs: 0,
    });
    expect(refused.started).toBe(false);
    if (!refused.started) {
      expect(refused.outcome.kind).toBe('insufficient_budget');
      expect(refused.outcome.phase).toBe('model_tool_search');
    }
    const heavy = ledger.tryStartPhase({
      phase: 'grounding',
      nowMs: acceptedAtMs + 30_000,
      expectedDurationMs: 12_000,
    });
    expect(heavy.started).toBe(false);
    if (!heavy.started && heavy.outcome.kind === 'insufficient_budget') {
      expect(heavy.outcome.expectedMs).toBe(12_000);
      expect(heavy.outcome.reserveMs).toBe(10_000);
    } else {
      expect.unreachable('expected an insufficient_budget outcome with typed fields');
    }
  });

  it('shrinks child timeouts to zero instead of lending the reserve', () => {
    const ledger = ledgerFor(ENVELOPES[0]!);
    const acceptedAtMs = 1_000_000;
    expect(ledger.childTimeoutMs(acceptedAtMs, 8_000)).toBe(8_000);
    expect(ledger.childTimeoutMs(acceptedAtMs + 35_000, 8_000)).toBe(5_000);
    // At the reserve boundary no new child work fits: never a fresh timer.
    expect(ledger.childTimeoutMs(acceptedAtMs + 40_000, 8_000)).toBe(0);
    expect(ledger.childTimeoutMs(acceptedAtMs + 100_000, 8_000)).toBe(0);
    expect(ledger.dependencyTimeoutMs(acceptedAtMs + 40_000, 'grounding')).toBe(0);
    expect(ledger.childTimeoutMs(acceptedAtMs, -5)).toBe(0);
  });
});

describe('child deadlines shorter than the parent', () => {
  it('clamps every dependency below the remaining parent budget', () => {
    const ledger = ledgerFor(ENVELOPES[2]!);
    const acceptedAtMs = 1_000_000;
    const probes = [0, 10_000, 50_000, 89_999, 90_000, 104_999, 105_000];
    for (const offset of probes) {
      const nowMs = acceptedAtMs + offset;
      const parentRemaining = ledger.remainingMs(nowMs);
      const workRemaining = ledger.remainingWorkMs(nowMs);
      expect(workRemaining).toBeLessThanOrEqual(parentRemaining);
      for (const dependency of Object.keys(DEPENDENCY_TIMEOUT_CAPS_MS) as DependencyKind[]) {
        const timeout = ledger.dependencyTimeoutMs(nowMs, dependency);
        expect(timeout).toBeLessThanOrEqual(workRemaining);
        expect(timeout).toBeLessThanOrEqual(DEPENDENCY_TIMEOUT_CAPS_MS[dependency]);
        if (workRemaining === 0) expect(timeout).toBe(0);
      }
      expect(ledger.childTimeoutMs(nowMs, Number.MAX_SAFE_INTEGER)).toBe(workRemaining);
    }
  });
});

describe('platform timeout independence', () => {
  it('derives the WP-5 AgentRunBudget from the same absolute deadline', () => {
    const acceptedAtMs = 2_000_000;
    const ledger = createDeadlineLedger({
      acceptedAtMs,
      platformLimitMs: 60_000,
      appHardStopMs: 50_000,
      finalizeReserveMs: 10_000,
    });
    const budget = ledger.toAgentRunBudget();
    expect(budget.deadlineAt).toBe(ledger.deadlineAt);
    expect(budget.deadlineAt).toBe(acceptedAtMs + 50_000);
    expect(budget.finalizeReserveMs).toBe(ledger.finalizeReserveMs);
  });

  it('does not raise model/tool/search/evidence/token/retry/cost budgets on longer platforms', () => {
    const acceptedAtMs = 2_000_000;
    const budgets = ENVELOPES.map((envelope) =>
      createDeadlineLedger({ acceptedAtMs, ...envelope }).toAgentRunBudget(),
    );
    const first = budgets[0]!;
    for (const budget of budgets.slice(1)) {
      expect(budget.maxModelSteps).toBe(first.maxModelSteps);
      expect(budget.maxTotalToolCalls).toBe(first.maxTotalToolCalls);
      expect(budget.maxSearchCalls).toBe(first.maxSearchCalls);
      expect(budget.maxSearchPlans).toBe(first.maxSearchPlans);
      expect(budget.maxPhysicalRetrievals).toBe(first.maxPhysicalRetrievals);
      expect(budget.maxConcurrentRetrievals).toBe(first.maxConcurrentRetrievals);
      expect(budget.maxResultsPerSearchCall).toBe(first.maxResultsPerSearchCall);
      expect(budget.maxCandidatesPerModality).toBe(first.maxCandidatesPerModality);
      expect(budget.maxResultsPerSubquestion).toBe(first.maxResultsPerSubquestion);
      expect(budget.maxUniqueEvidenceChunks).toBe(first.maxUniqueEvidenceChunks);
      expect(budget.maxEvidenceTokens).toBe(first.maxEvidenceTokens);
      expect(budget.maxCallsByTool).toEqual(first.maxCallsByTool);
      expect(budget.maxInputTokens).toBe(first.maxInputTokens);
      expect(budget.maxOutputTokens).toBe(first.maxOutputTokens);
      expect(budget.maxEstimatedCostMicros).toBe(first.maxEstimatedCostMicros);
    }
    // Only the absolute deadline moves with the envelope; counts never do.
    expect(budgets[0]!.deadlineAt).toBeLessThan(budgets[1]!.deadlineAt);
    expect(budgets[1]!.deadlineAt).toBeLessThan(budgets[2]!.deadlineAt);
  });
});

describe('2d075e5 work-deadline attribution', () => {
  const deadlineAt = 1_050_000;
  const finalizeReserveMs = 10_000;

  it('attributes the reserve boundary to deadline_exceeded, never a budget stop', () => {
    expect(
      attributeWorkStop({ nowMs: deadlineAt - finalizeReserveMs, deadlineAt, finalizeReserveMs, budgetStop: 'max_model_steps' }),
    ).toBe('deadline_exceeded');
    expect(
      attributeWorkStop({ nowMs: deadlineAt, deadlineAt, finalizeReserveMs, budgetStop: 'max_total_tool_calls' }),
    ).toBe('deadline_exceeded');
  });

  it('keeps the budget stop below the reserve boundary', () => {
    expect(
      attributeWorkStop({
        nowMs: deadlineAt - finalizeReserveMs - 1,
        deadlineAt,
        finalizeReserveMs,
        budgetStop: 'max_model_steps',
      }),
    ).toBe('max_model_steps');
    expect(
      attributeWorkStop({
        nowMs: deadlineAt - finalizeReserveMs - 1,
        deadlineAt,
        finalizeReserveMs,
        budgetStop: 'max_search_calls',
      }),
    ).toBe('max_search_calls');
  });
});

describe('cancellation across every major phase', () => {
  it.each(REQUEST_PHASES)('stops new work and in-flight checks during %s', (phase: RequestPhase) => {
    const ledger = ledgerFor(ENVELOPES[0]!);
    const acceptedAtMs = 1_000_000;
    const started = ledger.tryStartPhase({
      phase,
      nowMs: acceptedAtMs + 1_000,
      expectedDurationMs: 500,
    });
    expect(started.started).toBe(true);

    ledger.cancel();
    expect(ledger.cancelled).toBe(true);
    expect(ledger.signal.aborted).toBe(true);

    const refused = ledger.tryStartPhase({
      phase,
      nowMs: acceptedAtMs + 2_000,
      expectedDurationMs: 0,
    });
    expect(refused.started).toBe(false);
    if (!refused.started) expect(refused.outcome.kind).toBe('cancelled');
    expect(ledger.canStart({ phase, nowMs: acceptedAtMs + 2_000, expectedDurationMs: 0 })).toBe(false);
    expect(() => ledger.throwIfCancelled(phase, acceptedAtMs + 2_000)).toThrowError(DOMException);
    try {
      ledger.throwIfCancelled(phase, acceptedAtMs + 2_000);
      expect.unreachable('throwIfCancelled must throw after cancel');
    } catch (error) {
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe('AbortError');
    }
  });

  it('links a parent request signal into the ledger signal', () => {
    const parent = new AbortController();
    const ledger = createDeadlineLedger(
      { acceptedAtMs: 0, platformLimitMs: 60_000, appHardStopMs: 50_000, finalizeReserveMs: 10_000 },
      { parentSignal: parent.signal },
    );
    expect(ledger.signal.aborted).toBe(false);
    parent.abort();
    expect(ledger.signal.aborted).toBe(true);
    expect(ledger.cancelled).toBe(true);
  });

  it('starts cancelled when the parent signal is already aborted', () => {
    const parent = new AbortController();
    parent.abort();
    const ledger = createDeadlineLedger(
      { acceptedAtMs: 0, platformLimitMs: 60_000, appHardStopMs: 50_000, finalizeReserveMs: 10_000 },
      { parentSignal: parent.signal },
    );
    expect(ledger.cancelled).toBe(true);
  });
});

describe('remaining-time telemetry and outcomes', () => {
  it('records deadline_remaining_ms at phase start and end', () => {
    const seen: Array<{ event: string; remaining: unknown }> = [];
    const ledger = createDeadlineLedger(
      { acceptedAtMs: 1_000_000, platformLimitMs: 60_000, appHardStopMs: 50_000, finalizeReserveMs: 10_000 },
      {
        log: (event, fields) => {
          seen.push({ event, remaining: fields['deadline_remaining_ms'] });
        },
      },
    );
    const started = ledger.tryStartPhase({
      phase: 'model_tool_search',
      nowMs: 1_005_000,
      expectedDurationMs: 5_000,
    });
    expect(started.started).toBe(true);
    if (started.started) {
      expect(started.telemetry.deadlineRemainingAtStartMs).toBe(45_000);
      expect(started.telemetry.deadlineRemainingAtEndMs).toBeNull();
    }
    const ended = ledger.endPhase({ phase: 'model_tool_search', nowMs: 1_010_000, outcome: 'completed' });
    expect(ended.deadlineRemainingAtStartMs).toBe(45_000);
    expect(ended.deadlineRemainingAtEndMs).toBe(40_000);
    expect(ended.outcome?.kind).toBe('completed');
    expect(seen.map((entry) => entry.event)).toEqual(['phase.started', 'phase.ended']);
    expect(seen[0]!.remaining).toBe(45_000);
    expect(seen[1]!.remaining).toBe(40_000);
  });

  it('supports every typed outcome including skipped and degraded', () => {
    const ledger = ledgerFor(ENVELOPES[0]!);
    const skipped = ledger.endPhase({
      phase: 'cache_lookup',
      nowMs: 1_001_000,
      outcome: { kind: 'skipped', phase: 'cache_lookup', reason: 'cache_hit', remainingMs: 49_000 },
    });
    expect(skipped.outcome?.kind).toBe('skipped');
    const degraded = ledger.endPhase({
      phase: 'grounding',
      nowMs: 1_002_000,
      outcome: {
        kind: 'degraded',
        phase: 'grounding',
        reason: 'grader_timeout',
        fallback: 'unverified_release_blocked',
        remainingMs: 48_000,
      },
    });
    expect(degraded.outcome?.kind).toBe('degraded');
    const timedOut = ledger.endPhase({ phase: 'model_tool_search', nowMs: 1_051_000, outcome: 'timeout' });
    expect(timedOut.outcome?.kind).toBe('timeout');
    const snapshot = ledger.snapshot();
    expect(snapshot.phases).toHaveLength(REQUEST_PHASES.length);
  });
});

describe('idempotent bounded finalization', () => {
  it('finalizes exactly once and returns the identical snapshot', () => {
    const ledger = ledgerFor(ENVELOPES[0]!);
    ledger.tryStartPhase({ phase: 'admission', nowMs: 1_000_000, expectedDurationMs: 100 });
    ledger.endPhase({ phase: 'admission', nowMs: 1_000_100, outcome: 'completed' });
    const first = ledger.finalize(1_000_200);
    const second = ledger.finalize(1_000_300);
    expect(second).toBe(first);
    expect(ledger.finalized).toBe(true);
    expect(first.finalized).toBe(true);
    expect(first.phases).toHaveLength(REQUEST_PHASES.length);
    const admission = first.phases.find((entry) => entry.phase === 'admission');
    expect(admission?.outcome?.kind).toBe('completed');
    const untouched = first.phases.find((entry) => entry.phase === 'cleanup');
    expect(untouched?.outcome).toBeNull();
  });
});
