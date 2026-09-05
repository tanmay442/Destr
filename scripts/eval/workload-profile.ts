import { z } from 'zod';

export const workloadScenarioSchema = z.enum([
  'answer_cache_hit',
  'no_tool',
  'one_search',
  'two_search_compound',
  'retry_backfill',
  'degraded_dependency',
  'cancellation',
]);

const planningDistributionSchema = z
  .object({
    status: z.literal('planning_assumption'),
    source: z.literal('planning_assumption_pending_trace_measurement'),
    p50: z.number().nonnegative(),
    p95: z.number().nonnegative(),
    p99: z.number().nonnegative(),
  })
  .superRefine((distribution, ctx) => {
    if (distribution.p50 > distribution.p95) {
      ctx.addIssue({
        code: 'custom',
        path: ['p95'],
        message: 'p95 must be greater than or equal to p50',
      });
    }
    if (distribution.p95 > distribution.p99) {
      ctx.addIssue({
        code: 'custom',
        path: ['p99'],
        message: 'p99 must be greater than or equal to p95',
      });
    }
  });

const planningNumberSchema = z.object({
  status: z.literal('planning_assumption'),
  source: z.literal('planning_assumption_pending_trace_measurement'),
  value: z.number().nonnegative(),
});

const planningPositiveNumberSchema = planningNumberSchema.extend({
  value: z.number().positive(),
});

const planningSteadyDurationSchema = planningNumberSchema.extend({
  value: z.number().int().min(1_800),
});

const profileTargetSchema = z.object({
  status: z.literal('profile_target'),
  source: z.literal('approved_active_turn_target'),
  value: z.number().int().positive(),
});

const rampStageSchema = z.object({
  activeTurns: z.number().int().positive(),
  arrivalRatePerSecond: planningPositiveNumberSchema,
  holdSeconds: planningPositiveNumberSchema,
});

const interArrivalSchema = z.object({
  distribution: z.literal('poisson'),
  scheduler: z.literal('open_loop_wall_clock'),
  rateScope: z.literal('one_rate_per_stage'),
  source: z.literal('planning_assumption_pending_trace_measurement'),
});

const openLoopSchema = z.object({
  arrival: z.object({
    ratePerSecond: planningPositiveNumberSchema,
    derivedFrom: z.literal('mean_active_turn_duration'),
    source: z.literal('little_law_assumption_not_capacity_claim'),
  }),
  interArrival: interArrivalSchema,
  ramp: z.object({
    semantics: z.literal('stepwise_warmup_ramp'),
    warmup: z.object({
      clock: z.literal('wall_clock'),
      advanceWhen: z.literal('stage_target_is_active'),
      hold: z.literal('hold_seconds_after_stage_target_is_active'),
      discardMeasurements: z.literal(true),
      source: z.literal('planning_assumption_pending_trace_measurement'),
    }),
    stages: z.array(rampStageSchema).nonempty(),
    source: z.literal('planning_assumption_pending_trace_measurement'),
  }),
  steady: z.object({
    semantics: z.literal('fixed_rate_after_warmup'),
    startWhen: z.literal('warmup_complete'),
    clock: z.literal('wall_clock'),
    arrivalRatePerSecond: planningPositiveNumberSchema,
    durationSeconds: planningSteadyDurationSchema,
    collectMeasurements: z.literal(true),
    source: z.literal('planning_assumption_pending_trace_measurement'),
  }),
});

const closedLoopSchema = z.object({
  semantics: z.literal('fixed_active_turns_completion_driven'),
  concurrency: z.object({
    target: profileTargetSchema,
    maxInFlightTurns: profileTargetSchema,
    arrival: z.literal('completion_driven'),
    holdUntilTerminal: z.literal(true),
  }),
  interArrival: z.object({
    distribution: z.literal('completion_plus_think_time'),
    scheduler: z.literal('closed_loop_feedback'),
    source: z.literal('planning_assumption_pending_trace_measurement'),
  }),
  steady: z.object({
    semantics: z.literal('maintain_target_until_soak_complete'),
    durationSeconds: planningSteadyDurationSchema,
    collectMeasurements: z.literal(true),
    source: z.literal('planning_assumption_pending_trace_measurement'),
  }),
});

const downstreamLatencyDistributionsSchema = z.object({
  redisCoordinationMs: planningDistributionSchema,
  databaseQueryMs: planningDistributionSchema,
  embeddingMs: planningDistributionSchema,
  rerankerMs: planningDistributionSchema,
  modelFirstTokenMs: planningDistributionSchema,
  modelTotalMs: planningDistributionSchema,
  groundingMs: planningDistributionSchema,
  persistenceMs: planningDistributionSchema,
  streamCloseMs: planningDistributionSchema,
});

const assumedDistributionSchema = planningDistributionSchema;

const workloadProfileSchemaBase = z.object({
  version: z.literal('wp0-v3'),
  name: z.enum(['average-4k', 'peak-20k']),
  population: z.object({
    unit: z.literal('active_turns'),
    target: z.union([z.literal(4_000), z.literal(20_000)]),
  }),
  authorization: z.object({
    separateRunApprovalRequired: z.boolean(),
    approvedNonProductionTargetRequired: z.literal(true),
    paidProviderCostCapRequired: z.literal(true),
  }),
  methods: z.tuple([z.literal('open_loop'), z.literal('closed_loop')]),
  stageActiveTurns: z.array(z.number().int().positive()).nonempty(),
  soakAfterWarmupSeconds: z.number().int().min(1_800),
  meanActiveTurnDurationMs: planningPositiveNumberSchema,
  openLoop: openLoopSchema,
  closedLoop: closedLoopSchema,
  downstreamLatencyMs: downstreamLatencyDistributionsSchema,
  scenarioMixPercent: z.record(workloadScenarioSchema, z.number().int().min(0).max(100)),
  scenarioMixSource: z.literal('planning_assumption_pending_trace_measurement'),
  durationMs: assumedDistributionSchema,
  totalStepInputTokens: assumedDistributionSchema,
  outputTokens: assumedDistributionSchema,
  cacheWarmthPercent: z.object({
    cold: z.number().int().min(0).max(100),
    warm: z.number().int().min(0).max(100),
  }),
  cacheWarmthSource: z.literal('planning_assumption_pending_trace_measurement'),
  cancellationPercent: z.number().int().min(0).max(100),
  disconnectPercent: z.number().int().min(0).max(100),
  terminationMixSource: z.literal('planning_assumption_pending_trace_measurement'),
  turnStartsPerSecondSensitivity: z.object({
    meanDurationMs: planningPositiveNumberSchema,
    arrivalRatePerSecond: planningPositiveNumberSchema,
    source: z.literal('little_law_assumption_not_capacity_claim'),
  }),
});

export const workloadProfileSchema = workloadProfileSchemaBase.superRefine((profile, ctx) => {
  const addIssue = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: 'custom', path, message });
  };

  const mixTotal = Object.values(profile.scenarioMixPercent).reduce((sum, value) => sum + value, 0);
  if (mixTotal !== 100) addIssue(['scenarioMixPercent'], `scenario mix totals ${mixTotal}, expected 100`);

  if (profile.cacheWarmthPercent.cold + profile.cacheWarmthPercent.warm !== 100) {
    addIssue(['cacheWarmthPercent'], 'cache cold and warm percentages must total 100');
  }

  if (profile.cancellationPercent + profile.disconnectPercent > 100) {
    addIssue(['cancellationPercent'], 'cancellation and disconnect percentages cannot total more than 100');
  }

  const isStrictlyIncreasing = (values: readonly number[]): boolean =>
    values.every((value, index) => index === 0 || value > (values[index - 1] ?? value));
  const expectedRate = profile.population.target / (profile.meanActiveTurnDurationMs.value / 1_000);
  const ratesMatch = (actual: number, expected: number): boolean =>
    Math.abs(actual - expected) <= Math.max(1e-9, Math.abs(expected) * 1e-9);

  if (!ratesMatch(profile.openLoop.arrival.ratePerSecond.value, expectedRate)) {
    addIssue(
      ['openLoop', 'arrival', 'ratePerSecond'],
      'open-loop arrival rate must equal target active turns divided by the named mean duration',
    );
  }
  if (!ratesMatch(profile.openLoop.steady.arrivalRatePerSecond.value, expectedRate)) {
    addIssue(
      ['openLoop', 'steady', 'arrivalRatePerSecond'],
      'open-loop steady arrival rate must equal target active turns divided by the named mean duration',
    );
  }
  if (!ratesMatch(profile.turnStartsPerSecondSensitivity.arrivalRatePerSecond.value, expectedRate)) {
    addIssue(
      ['turnStartsPerSecondSensitivity', 'arrivalRatePerSecond'],
      'Little\'s Law arrival sensitivity must use the named mean duration',
    );
  }
  if (profile.turnStartsPerSecondSensitivity.meanDurationMs.value !== profile.meanActiveTurnDurationMs.value) {
    addIssue(
      ['turnStartsPerSecondSensitivity', 'meanDurationMs'],
      'arrival sensitivity must identify the same named mean active-turn duration',
    );
  }
  if (!isStrictlyIncreasing(profile.stageActiveTurns)) {
    addIssue(['stageActiveTurns'], 'staged active turns must be strictly increasing');
  }
  if (profile.stageActiveTurns.at(-1) !== profile.population.target) {
    addIssue(['stageActiveTurns'], 'final staged active-turn target does not match the profile population');
  }

  const rampTurns = profile.openLoop.ramp.stages.map((stage) => stage.activeTurns);
  if (!isStrictlyIncreasing(rampTurns)) {
    addIssue(['openLoop', 'ramp', 'stages'], 'open-loop ramp active turns must be strictly increasing');
  }
  if (rampTurns.at(-1) !== profile.population.target) {
    addIssue(['openLoop', 'ramp', 'stages'], 'open-loop ramp must end at the profile population target');
  }
  for (const stage of profile.openLoop.ramp.stages) {
    const stageRate = stage.activeTurns / (profile.meanActiveTurnDurationMs.value / 1_000);
    if (!ratesMatch(stage.arrivalRatePerSecond.value, stageRate)) {
      addIssue(
        ['openLoop', 'ramp', 'stages'],
        'each open-loop stage arrival rate must use the named mean duration',
      );
      break;
    }
  }
  if (profile.openLoop.steady.durationSeconds.value < profile.soakAfterWarmupSeconds) {
    addIssue(['openLoop', 'steady', 'durationSeconds'], 'open-loop steady duration must cover the required soak');
  }
  if (profile.closedLoop.concurrency.target.value !== profile.population.target) {
    addIssue(['closedLoop', 'concurrency', 'target'], 'closed-loop target must equal the active-turn population');
  }
  if (profile.closedLoop.concurrency.maxInFlightTurns.value !== profile.population.target) {
    addIssue(['closedLoop', 'concurrency', 'maxInFlightTurns'], 'closed-loop max in-flight turns must equal the active-turn population');
  }
  if (profile.closedLoop.steady.durationSeconds.value < profile.soakAfterWarmupSeconds) {
    addIssue(['closedLoop', 'steady', 'durationSeconds'], 'closed-loop steady duration must cover the required soak');
  }

  if (profile.name === 'average-4k' && profile.authorization.separateRunApprovalRequired) {
    addIssue(['authorization', 'separateRunApprovalRequired'], 'average-4k does not require separate peak-run approval');
  }
  if (profile.name === 'peak-20k' && !profile.authorization.separateRunApprovalRequired) {
    addIssue(['authorization', 'separateRunApprovalRequired'], 'peak-20k requires separate run approval');
  }
});

export type WorkloadProfile = z.infer<typeof workloadProfileSchema>;

const scenarioMixPercent = {
  answer_cache_hit: 10,
  no_tool: 20,
  one_search: 40,
  two_search_compound: 15,
  retry_backfill: 5,
  degraded_dependency: 5,
  cancellation: 5,
} satisfies WorkloadProfile['scenarioMixPercent'];

const assumedDurationMs = {
  status: 'planning_assumption',
  source: 'planning_assumption_pending_trace_measurement',
  p50: 10_000,
  p95: 25_000,
  p99: 50_000,
} satisfies z.input<typeof planningDistributionSchema>;

const assumedMeanActiveTurnDurationMs = {
  status: 'planning_assumption',
  source: 'planning_assumption_pending_trace_measurement',
  value: 20_000,
} satisfies z.input<typeof planningPositiveNumberSchema>;

const assumedInputTokens = {
  status: 'planning_assumption',
  source: 'planning_assumption_pending_trace_measurement',
  p50: 3_000,
  p95: 12_000,
  p99: 30_000,
} satisfies z.input<typeof planningDistributionSchema>;

const assumedOutputTokens = {
  status: 'planning_assumption',
  source: 'planning_assumption_pending_trace_measurement',
  p50: 300,
  p95: 1_000,
  p99: 2_000,
} satisfies z.input<typeof planningDistributionSchema>;

const assumedDownstreamLatency = {
  status: 'planning_assumption',
  source: 'planning_assumption_pending_trace_measurement',
  p50: 50,
  p95: 250,
  p99: 1_000,
} satisfies z.input<typeof planningDistributionSchema>;

const downstreamLatencyMs = {
  redisCoordinationMs: assumedDownstreamLatency,
  databaseQueryMs: assumedDownstreamLatency,
  embeddingMs: assumedDownstreamLatency,
  rerankerMs: assumedDownstreamLatency,
  modelFirstTokenMs: assumedDownstreamLatency,
  modelTotalMs: assumedDurationMs,
  groundingMs: assumedDownstreamLatency,
  persistenceMs: assumedDownstreamLatency,
  streamCloseMs: assumedDownstreamLatency,
} satisfies z.input<typeof downstreamLatencyDistributionsSchema>;

function target(value: 4_000 | 20_000): z.input<typeof profileTargetSchema> {
  return { status: 'profile_target', source: 'approved_active_turn_target', value };
}

function buildRampStages(targetTurns: 4_000 | 20_000): z.input<typeof rampStageSchema>[] {
  const turns = targetTurns === 4_000 ? [100, 500, 1_000, 4_000] : [100, 500, 1_000, 4_000, 20_000];
  return turns.map((activeTurns) => ({
    activeTurns,
    arrivalRatePerSecond: {
      status: 'planning_assumption',
      source: 'planning_assumption_pending_trace_measurement',
      value: activeTurns / (assumedMeanActiveTurnDurationMs.value / 1_000),
    },
    holdSeconds: {
      status: 'planning_assumption',
      source: 'planning_assumption_pending_trace_measurement',
      value: 60,
    },
  }));
}

function buildProfile(
  name: 'average-4k' | 'peak-20k',
  targetTurns: 4_000 | 20_000,
): z.input<typeof workloadProfileSchema> {
  const arrivalRate = targetTurns / (assumedMeanActiveTurnDurationMs.value / 1_000);
  const ramp = buildRampStages(targetTurns);
  return {
    version: 'wp0-v3',
    name,
    population: { unit: 'active_turns', target: targetTurns },
    authorization: {
      separateRunApprovalRequired: name === 'peak-20k',
      approvedNonProductionTargetRequired: true,
      paidProviderCostCapRequired: true,
    },
    methods: ['open_loop', 'closed_loop'],
    stageActiveTurns: ramp.map((stage) => stage.activeTurns),
    soakAfterWarmupSeconds: 1_800,
    meanActiveTurnDurationMs: assumedMeanActiveTurnDurationMs,
    openLoop: {
      arrival: {
        ratePerSecond: {
          status: 'planning_assumption',
          source: 'planning_assumption_pending_trace_measurement',
          value: arrivalRate,
        },
        derivedFrom: 'mean_active_turn_duration',
        source: 'little_law_assumption_not_capacity_claim',
      },
      interArrival: {
        distribution: 'poisson',
        scheduler: 'open_loop_wall_clock',
        rateScope: 'one_rate_per_stage',
        source: 'planning_assumption_pending_trace_measurement',
      },
      ramp: {
        semantics: 'stepwise_warmup_ramp',
        warmup: {
          clock: 'wall_clock',
          advanceWhen: 'stage_target_is_active',
          hold: 'hold_seconds_after_stage_target_is_active',
          discardMeasurements: true,
          source: 'planning_assumption_pending_trace_measurement',
        },
        stages: ramp,
        source: 'planning_assumption_pending_trace_measurement',
      },
      steady: {
        semantics: 'fixed_rate_after_warmup',
        startWhen: 'warmup_complete',
        clock: 'wall_clock',
        arrivalRatePerSecond: {
          status: 'planning_assumption',
          source: 'planning_assumption_pending_trace_measurement',
          value: arrivalRate,
        },
        durationSeconds: {
          status: 'planning_assumption',
          source: 'planning_assumption_pending_trace_measurement',
          value: 1_800,
        },
        collectMeasurements: true,
        source: 'planning_assumption_pending_trace_measurement',
      },
    },
    closedLoop: {
      semantics: 'fixed_active_turns_completion_driven',
      concurrency: {
        target: target(targetTurns),
        maxInFlightTurns: target(targetTurns),
        arrival: 'completion_driven',
        holdUntilTerminal: true,
      },
      interArrival: {
        distribution: 'completion_plus_think_time',
        scheduler: 'closed_loop_feedback',
        source: 'planning_assumption_pending_trace_measurement',
      },
      steady: {
        semantics: 'maintain_target_until_soak_complete',
        durationSeconds: {
          status: 'planning_assumption',
          source: 'planning_assumption_pending_trace_measurement',
          value: 1_800,
        },
        collectMeasurements: true,
        source: 'planning_assumption_pending_trace_measurement',
      },
    },
    downstreamLatencyMs,
    scenarioMixPercent,
    scenarioMixSource: 'planning_assumption_pending_trace_measurement',
    durationMs: assumedDurationMs,
    totalStepInputTokens: assumedInputTokens,
    outputTokens: assumedOutputTokens,
    cacheWarmthPercent: { cold: 30, warm: 70 },
    cacheWarmthSource: 'planning_assumption_pending_trace_measurement',
    cancellationPercent: 5,
    disconnectPercent: 2,
    terminationMixSource: 'planning_assumption_pending_trace_measurement',
    turnStartsPerSecondSensitivity: {
      meanDurationMs: assumedMeanActiveTurnDurationMs,
      arrivalRatePerSecond: {
        status: 'planning_assumption',
        source: 'planning_assumption_pending_trace_measurement',
        value: arrivalRate,
      },
      source: 'little_law_assumption_not_capacity_claim',
    },
  };
}

export const workloadProfiles: readonly WorkloadProfile[] = workloadProfileSchema.array().parse([
  buildProfile('average-4k', 4_000),
  buildProfile('peak-20k', 20_000),
]);

export function validateWorkloadProfile(profile: WorkloadProfile): readonly string[] {
  const result = workloadProfileSchema.safeParse(profile);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}
