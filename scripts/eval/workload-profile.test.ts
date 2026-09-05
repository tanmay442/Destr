import { describe, expect, it } from 'vitest';
import { validateWorkloadProfile, workloadProfileSchema, workloadProfiles } from './workload-profile';

describe('WP-0 workload profiles', () => {
  it('names population as active turns and validates the frozen scenario mix', () => {
    expect(workloadProfiles.map((profile) => profile.population)).toEqual([
      { unit: 'active_turns', target: 4_000 },
      { unit: 'active_turns', target: 20_000 },
    ]);
    for (const profile of workloadProfiles) {
      expect(validateWorkloadProfile(profile)).toEqual([]);
      expect(profile.soakAfterWarmupSeconds).toBeGreaterThanOrEqual(1_800);
      expect(profile.openLoop.ramp.stages.at(-1)?.activeTurns).toBe(profile.population.target);
      expect(profile.closedLoop.concurrency.arrival).toBe('completion_driven');
      expect(profile.closedLoop.concurrency.holdUntilTerminal).toBe(true);
    }
  });

  it('keeps measured distributions distinct from planning assumptions', () => {
    for (const profile of workloadProfiles) {
      const distributions = [
        profile.durationMs,
        profile.totalStepInputTokens,
        profile.outputTokens,
        ...Object.values(profile.downstreamLatencyMs),
      ];
      for (const distribution of distributions) {
        expect(distribution.status).toBe('planning_assumption');
        expect(distribution.source).toBe('planning_assumption_pending_trace_measurement');
        expect(distribution.p50).toBeLessThanOrEqual(distribution.p95);
        expect(distribution.p95).toBeLessThanOrEqual(distribution.p99);
      }
      expect(profile.turnStartsPerSecondSensitivity.source).toBe(
        'little_law_assumption_not_capacity_claim',
      );
      expect(profile.meanActiveTurnDurationMs.status).toBe('planning_assumption');
      expect(profile.meanActiveTurnDurationMs.value).not.toBe(profile.durationMs.p95);
      expect(profile.turnStartsPerSecondSensitivity.meanDurationMs.value).toBe(
        profile.meanActiveTurnDurationMs.value,
      );
      expect(profile.openLoop.arrival.derivedFrom).toBe('mean_active_turn_duration');
      expect(profile.openLoop.interArrival).toEqual({
        distribution: 'poisson',
        scheduler: 'open_loop_wall_clock',
        rateScope: 'one_rate_per_stage',
        source: 'planning_assumption_pending_trace_measurement',
      });
      expect(profile.openLoop.ramp.warmup).toEqual({
        clock: 'wall_clock',
        advanceWhen: 'stage_target_is_active',
        hold: 'hold_seconds_after_stage_target_is_active',
        discardMeasurements: true,
        source: 'planning_assumption_pending_trace_measurement',
      });
      expect(profile.openLoop.steady.semantics).toBe('fixed_rate_after_warmup');
      expect(profile.openLoop.steady.startWhen).toBe('warmup_complete');
      expect(profile.openLoop.steady.clock).toBe('wall_clock');
      expect(profile.closedLoop.interArrival).toEqual({
        distribution: 'completion_plus_think_time',
        scheduler: 'closed_loop_feedback',
        source: 'planning_assumption_pending_trace_measurement',
      });
      expect(profile.scenarioMixSource).toBe('planning_assumption_pending_trace_measurement');
      expect(profile.cacheWarmthSource).toBe('planning_assumption_pending_trace_measurement');
      expect(profile.terminationMixSource).toBe('planning_assumption_pending_trace_measurement');
      expect(profile.openLoop.arrival.ratePerSecond.status).toBe('planning_assumption');
      const expectedRate =
        profile.population.target / (profile.meanActiveTurnDurationMs.value / 1_000);
      expect(profile.openLoop.arrival.ratePerSecond.value).toBe(expectedRate);
      expect(profile.openLoop.steady.arrivalRatePerSecond.value).toBe(expectedRate);
      for (const stage of profile.openLoop.ramp.stages) {
        expect(stage.arrivalRatePerSecond.value).toBe(
          stage.activeTurns / (profile.meanActiveTurnDurationMs.value / 1_000),
        );
      }
      expect(profile.openLoop.steady.durationSeconds.status).toBe('planning_assumption');
      expect(profile.closedLoop.steady.durationSeconds.status).toBe('planning_assumption');
    }
  });

  it('requires separate approval and a cost-capped non-production target for peak', () => {
    const peak = workloadProfiles.find((profile) => profile.name === 'peak-20k');
    expect(peak?.authorization).toEqual({
      separateRunApprovalRequired: true,
      approvedNonProductionTargetRequired: true,
      paidProviderCostCapRequired: true,
    });
  });

  it('rejects a distribution whose percentile ordering is impossible', () => {
    const profile = workloadProfiles[0];
    if (profile === undefined) throw new Error('expected average profile');
    const invalid = {
      ...profile,
      durationMs: { ...profile.durationMs, p50: 30_000, p95: 20_000 },
    };
    expect(validateWorkloadProfile(invalid)).not.toEqual([]);
    expect(() => workloadProfileSchema.parse(invalid)).toThrow();
  });

  it('rejects an arrival rate that is inconsistent with the named mean duration', () => {
    const profile = workloadProfiles[0];
    if (profile === undefined) throw new Error('expected average profile');
    const invalid = {
      ...profile,
      openLoop: {
        ...profile.openLoop,
        arrival: {
          ...profile.openLoop.arrival,
          ratePerSecond: { ...profile.openLoop.arrival.ratePerSecond, value: 160 },
        },
      },
    };
    expect(validateWorkloadProfile(invalid)).not.toEqual([]);
    expect(() => workloadProfileSchema.parse(invalid)).toThrow();
  });

  it('rejects a changed named mean when derived rates and sensitivity are stale', () => {
    const profile = workloadProfiles[0];
    if (profile === undefined) throw new Error('expected average profile');
    const invalid = {
      ...profile,
      meanActiveTurnDurationMs: {
        ...profile.meanActiveTurnDurationMs,
        value: 25_000,
      },
    };
    expect(validateWorkloadProfile(invalid)).not.toEqual([]);
    expect(() => workloadProfileSchema.parse(invalid)).toThrow();
  });

  it('rejects non-increasing stages and a ramp that does not end at target', () => {
    const profile = workloadProfiles[0];
    if (profile === undefined) throw new Error('expected average profile');
    const invalid = {
      ...profile,
      stageActiveTurns: [100, 500, 500, profile.population.target],
      openLoop: {
        ...profile.openLoop,
        ramp: {
          ...profile.openLoop.ramp,
          stages: profile.openLoop.ramp.stages.slice(0, -1),
        },
      },
    };
    expect(validateWorkloadProfile(invalid)).not.toEqual([]);
    expect(() => workloadProfileSchema.parse(invalid)).toThrow();
  });

  it('rejects scenario, cache, and cancellation percentage violations', () => {
    const profile = workloadProfiles[0];
    if (profile === undefined) throw new Error('expected average profile');
    const invalidScenarioMix = {
      ...profile,
      scenarioMixPercent: { ...profile.scenarioMixPercent, answer_cache_hit: 11 },
    };
    const invalidCacheWarmth = {
      ...profile,
      cacheWarmthPercent: { cold: 40, warm: 40 },
    };
    const invalidTerminationMix = {
      ...profile,
      cancellationPercent: 80,
      disconnectPercent: 30,
    };
    for (const invalid of [invalidScenarioMix, invalidCacheWarmth, invalidTerminationMix]) {
      expect(validateWorkloadProfile(invalid)).not.toEqual([]);
      expect(() => workloadProfileSchema.parse(invalid)).toThrow();
    }
  });
});
