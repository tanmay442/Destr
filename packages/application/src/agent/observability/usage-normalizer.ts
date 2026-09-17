import { z } from 'zod';
import { TokenFieldStatusSchema, type TokenFieldStatus } from './agent-event';

export type { TokenFieldStatus };

export const TokenFieldSchema = z.object({
  value: z.number().int().min(0).nullable(),
  status: TokenFieldStatusSchema,
});
export type TokenField = z.infer<typeof TokenFieldSchema>;

export const AnswerCacheFieldSchema = z.object({
  value: z.boolean().nullable(),
  status: TokenFieldStatusSchema,
});
export type AnswerCacheField = z.infer<typeof AnswerCacheFieldSchema>;

export const NormalizedStepUsageSchema = z.object({
  inputTokensTotal: TokenFieldSchema,
  cacheReadTokens: TokenFieldSchema,
  cacheWriteTokens: TokenFieldSchema,
  uncachedTokens: TokenFieldSchema,
  outputTokens: TokenFieldSchema,
  answerCacheHit: AnswerCacheFieldSchema,
});
export type NormalizedStepUsage = z.infer<typeof NormalizedStepUsageSchema>;

export const TurnUsageRollupSchema = z.object({
  inputTokensTotal: TokenFieldSchema,
  cacheReadTokens: TokenFieldSchema,
  cacheWriteTokens: TokenFieldSchema,
  uncachedTokens: TokenFieldSchema,
  outputTokens: TokenFieldSchema,
  answerCacheHits: TokenFieldSchema,
});
export type TurnUsageRollup = z.infer<typeof TurnUsageRollupSchema>;

export interface RawTokenField {
  readonly value?: number | null;
  readonly status?: TokenFieldStatus;
}

export interface RawStepUsage {
  readonly inputTokensTotal?: RawTokenField;
  readonly cacheReadTokens?: RawTokenField;
  readonly cacheWriteTokens?: RawTokenField;
  readonly uncachedTokens?: RawTokenField;
  readonly outputTokens?: RawTokenField;
  readonly answerCacheHit?: boolean | null;
  readonly answerCacheStatus?: TokenFieldStatus;
}

function freezeTokenField(field: { value: number | null; status: TokenFieldStatus }): TokenField {
  return Object.freeze({ value: field.value, status: field.status });
}

function normalizeTokenField(raw: RawTokenField | undefined): TokenField {
  if (raw === undefined) return freezeTokenField({ value: null, status: 'missing' });
  const status = raw.status ?? 'missing';
  if (status === 'unsupported' || status === 'parse_error') {
    return freezeTokenField({ value: null, status });
  }
  if (raw.value === undefined || raw.value === null) {
    return freezeTokenField({ value: null, status: 'missing' });
  }
  if (!Number.isInteger(raw.value) || raw.value < 0) {
    return freezeTokenField({ value: null, status: 'parse_error' });
  }
  if (status === 'reported') return freezeTokenField({ value: raw.value, status: 'reported' });
  return freezeTokenField({ value: null, status });
}

export function normalizeStepUsage(raw: RawStepUsage): NormalizedStepUsage {
  const answerStatus = raw.answerCacheStatus ?? 'missing';
  const answerValue =
    answerStatus === 'reported' && typeof raw.answerCacheHit === 'boolean'
      ? raw.answerCacheHit
      : null;
  const normalized: NormalizedStepUsage = {
    inputTokensTotal: normalizeTokenField(raw.inputTokensTotal),
    cacheReadTokens: normalizeTokenField(raw.cacheReadTokens),
    cacheWriteTokens: normalizeTokenField(raw.cacheWriteTokens),
    uncachedTokens: normalizeTokenField(raw.uncachedTokens),
    outputTokens: normalizeTokenField(raw.outputTokens),
    answerCacheHit: Object.freeze({
      value: answerValue,
      status: answerValue === null && answerStatus === 'reported' ? 'missing' : answerStatus,
    }),
  };
  return Object.freeze(normalized);
}

function rollupField(fields: readonly TokenField[]): TokenField {
  let sum = 0;
  let reported = false;
  let parseError = false;
  let unsupported = false;
  for (const field of fields) {
    if (field.status === 'reported' && field.value !== null) {
      sum += field.value;
      reported = true;
    } else if (field.status === 'parse_error') {
      parseError = true;
    } else if (field.status === 'unsupported') {
      unsupported = true;
    }
  }
  if (reported) return freezeTokenField({ value: sum, status: 'reported' });
  if (parseError) return freezeTokenField({ value: null, status: 'parse_error' });
  if (unsupported) return freezeTokenField({ value: null, status: 'unsupported' });
  return freezeTokenField({ value: null, status: 'missing' });
}

export function sumTurnUsage(steps: readonly NormalizedStepUsage[]): TurnUsageRollup {
  const rollup: TurnUsageRollup = {
    inputTokensTotal: rollupField(steps.map((step) => step.inputTokensTotal)),
    cacheReadTokens: rollupField(steps.map((step) => step.cacheReadTokens)),
    cacheWriteTokens: rollupField(steps.map((step) => step.cacheWriteTokens)),
    uncachedTokens: rollupField(steps.map((step) => step.uncachedTokens)),
    outputTokens: rollupField(steps.map((step) => step.outputTokens)),
    answerCacheHits: rollupField(
      steps.map((step) =>
        step.answerCacheHit.value === true
          ? freezeTokenField({ value: 1, status: 'reported' })
          : freezeTokenField({ value: null, status: step.answerCacheHit.status }),
      ),
    ),
  };
  return Object.freeze(rollup);
}

export const DenseScoreSchema = z.object({
  signal: z.literal('dense'),
  value: z.number().finite(),
  rank: z.number().int().min(0),
});
export type DenseScore = z.infer<typeof DenseScoreSchema>;

export const LexicalScoreSchema = z.object({
  signal: z.literal('lexical'),
  value: z.number().finite(),
  rank: z.number().int().min(0),
});
export type LexicalScore = z.infer<typeof LexicalScoreSchema>;

export const FusionScoreSchema = z.object({
  signal: z.literal('fusion'),
  value: z.number().finite(),
  rank: z.number().int().min(0),
});
export type FusionScore = z.infer<typeof FusionScoreSchema>;

export const RerankerScoreSchema = z.object({
  signal: z.literal('reranker'),
  value: z.number().finite(),
  rank: z.number().int().min(0),
});
export type RerankerScore = z.infer<typeof RerankerScoreSchema>;

export const RankedEvidenceSchema = z.object({
  finalSignal: z.enum(['dense', 'lexical', 'fusion', 'reranker']),
  rank: z.number().int().min(0),
});
export type RankedEvidence = z.infer<typeof RankedEvidenceSchema>;

export function validateRankedEvidence(input: unknown): RankedEvidence {
  return Object.freeze(RankedEvidenceSchema.parse(input));
}

const SIGNAL_KEYS = ['dense', 'lexical', 'fusion', 'reranker'] as const;
const GENERIC_SCORE_KEYS = ['similarity', 'score', 'averageScore', 'combinedScore'] as const;

export function assertNoGenericAverage(input: unknown): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return;
  const record = input as Readonly<Record<string, unknown>>;
  const signalsPresent = SIGNAL_KEYS.filter((key) => typeof record[key] === 'number');
  const genericPresent = GENERIC_SCORE_KEYS.filter((key) => typeof record[key] === 'number');
  if (genericPresent.length > 0 && signalsPresent.length > 0) {
    throw new Error(
      `assertNoGenericAverage: generic score ${genericPresent.join(',')} merges distinct signal spaces ${signalsPresent.join(',')}`,
    );
  }
  if (genericPresent.length > 0 && signalsPresent.length === 0) {
    throw new Error(
      `assertNoGenericAverage: generic score ${genericPresent.join(',')} has no signal provenance`,
    );
  }
}

export interface TokenPriceRates {
  readonly uncachedInputMicrosPerToken: number | null;
  readonly cacheReadMicrosPerToken: number | null;
  readonly cacheWriteMicrosPerToken: number | null;
  readonly outputMicrosPerToken: number | null;
  readonly priceVersion: string;
}

export type CostCompleteness = 'complete' | 'partial' | 'unknown';

export interface StepCost {
  readonly micros: number;
  readonly completeness: CostCompleteness;
  readonly unknownComponents: readonly string[];
}

const COST_COMPONENTS = [
  { name: 'uncached_input', field: 'uncachedTokens', rate: 'uncachedInputMicrosPerToken' },
  { name: 'cache_read', field: 'cacheReadTokens', rate: 'cacheReadMicrosPerToken' },
  { name: 'cache_write', field: 'cacheWriteTokens', rate: 'cacheWriteMicrosPerToken' },
  { name: 'output', field: 'outputTokens', rate: 'outputMicrosPerToken' },
] as const;

export function computeStepCost(step: NormalizedStepUsage, rates: TokenPriceRates): StepCost {
  let micros = 0;
  let computed = false;
  const unknownComponents: string[] = [];
  for (const component of COST_COMPONENTS) {
    const field = step[component.field];
    const rate = rates[component.rate];
    if (field.status === 'reported' && field.value !== null && rate !== null) {
      micros += field.value * rate;
      computed = true;
    } else {
      unknownComponents.push(
        field.status === 'reported' && field.value !== null
          ? `${component.name}:unknown_rate`
          : `${component.name}:${field.status}`,
      );
    }
  }
  const completeness: CostCompleteness =
    unknownComponents.length === 0 ? 'complete' : computed ? 'partial' : 'unknown';
  return Object.freeze({
    micros,
    completeness,
    unknownComponents: Object.freeze(unknownComponents),
  });
}

export function computeTurnCost(
  steps: readonly NormalizedStepUsage[],
  rates: TokenPriceRates,
): StepCost {
  let micros = 0;
  let complete = true;
  let computed = false;
  const unknown = new Set<string>();
  for (const step of steps) {
    const cost = computeStepCost(step, rates);
    micros += cost.micros;
    if (cost.completeness !== 'complete') complete = false;
    if (cost.completeness !== 'unknown') computed = true;
    for (const component of cost.unknownComponents) unknown.add(component);
  }
  const completeness: CostCompleteness =
    steps.length > 0 && complete ? 'complete' : computed ? 'partial' : 'unknown';
  return Object.freeze({
    micros,
    completeness,
    unknownComponents: Object.freeze([...unknown].sort()),
  });
}
