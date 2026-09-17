import { describe, expect, it } from 'vitest';
import {
  assertNoGenericAverage,
  computeStepCost,
  computeTurnCost,
  normalizeStepUsage,
  sumTurnUsage,
  validateRankedEvidence,
  type RawStepUsage,
  type TokenPriceRates,
} from '../usage-normalizer';

const RATES: TokenPriceRates = Object.freeze({
  uncachedInputMicrosPerToken: 2,
  cacheReadMicrosPerToken: 1,
  cacheWriteMicrosPerToken: 3,
  outputMicrosPerToken: 10,
  priceVersion: 'prices-2026-09',
});

function reportedRaw(overrides: RawStepUsage = {}): RawStepUsage {
  return {
    inputTokensTotal: { value: 100, status: 'reported' },
    cacheReadTokens: { value: 40, status: 'reported' },
    cacheWriteTokens: { value: 10, status: 'reported' },
    uncachedTokens: { value: 60, status: 'reported' },
    outputTokens: { value: 20, status: 'reported' },
    answerCacheHit: false,
    answerCacheStatus: 'reported',
    ...overrides,
  };
}

describe('normalizeStepUsage', () => {
  it('normalizes reported fields and keeps answer-cache separate from prompt-cache', () => {
    const step = normalizeStepUsage(reportedRaw({ answerCacheHit: true }));
    expect(step.inputTokensTotal).toEqual({ value: 100, status: 'reported' });
    expect(step.cacheReadTokens).toEqual({ value: 40, status: 'reported' });
    expect(step.answerCacheHit).toEqual({ value: true, status: 'reported' });
    expect(Object.isFrozen(step)).toBe(true);
  });

  it('keeps missing as missing and never converts it to zero', () => {
    const step = normalizeStepUsage({});
    expect(step.inputTokensTotal).toEqual({ value: null, status: 'missing' });
    expect(step.outputTokens).toEqual({ value: null, status: 'missing' });
    expect(step.answerCacheHit).toEqual({ value: null, status: 'missing' });
  });

  it('keeps unsupported as unsupported even when a value is present', () => {
    const step = normalizeStepUsage({
      cacheReadTokens: { value: 50, status: 'unsupported' },
    });
    expect(step.cacheReadTokens).toEqual({ value: null, status: 'unsupported' });
  });

  it('marks invalid numbers as parse errors', () => {
    const step = normalizeStepUsage({
      inputTokensTotal: { value: -5, status: 'reported' },
      outputTokens: { value: 1.5, status: 'reported' },
    });
    expect(step.inputTokensTotal.status).toBe('parse_error');
    expect(step.outputTokens.status).toBe('parse_error');
  });
});

describe('sumTurnUsage', () => {
  it('rolls up exactly the sum of normalized reported steps', () => {
    const steps = [
      normalizeStepUsage(reportedRaw()),
      normalizeStepUsage(
        reportedRaw({
          inputTokensTotal: { value: 50, status: 'reported' },
          cacheReadTokens: { value: 10, status: 'reported' },
          outputTokens: { value: 5, status: 'reported' },
        }),
      ),
    ];
    const rollup = sumTurnUsage(steps);
    const inputSum =
      (steps[0]?.inputTokensTotal.value ?? 0) + (steps[1]?.inputTokensTotal.value ?? 0);
    const outputSum = (steps[0]?.outputTokens.value ?? 0) + (steps[1]?.outputTokens.value ?? 0);
    expect(rollup.inputTokensTotal).toEqual({ value: inputSum, status: 'reported' });
    expect(rollup.outputTokens).toEqual({ value: outputSum, status: 'reported' });
    expect(rollup.inputTokensTotal.value).toBe(150);
    expect(rollup.outputTokens.value).toBe(25);
  });

  it('propagates missing and unsupported instead of zero-filling', () => {
    expect(sumTurnUsage([]).inputTokensTotal.status).toBe('missing');
    const unsupported = sumTurnUsage([
      normalizeStepUsage({ cacheReadTokens: { status: 'unsupported' } }),
    ]);
    expect(unsupported.cacheReadTokens).toEqual({ value: null, status: 'unsupported' });
  });
});

describe('score spaces', () => {
  it('accepts a single final signal with a rank', () => {
    expect(validateRankedEvidence({ finalSignal: 'fusion', rank: 0 })).toEqual({
      finalSignal: 'fusion',
      rank: 0,
    });
    expect(() => validateRankedEvidence({ finalSignal: 'cosine', rank: 0 })).toThrow();
    expect(() => validateRankedEvidence({ finalSignal: 'dense' })).toThrow();
  });

  it('throws when signals are merged into a generic average', () => {
    expect(() => assertNoGenericAverage({ dense: 0.9, lexical: 12.5, similarity: 0.7 })).toThrow(
      /merges distinct signal/,
    );
    expect(() => assertNoGenericAverage({ similarity: 0.7 })).toThrow(/no signal provenance/);
    expect(() =>
      assertNoGenericAverage({ dense: 0.9, reranker: 0.4, combinedScore: 0.65 }),
    ).toThrow(/merges distinct signal/);
  });

  it('passes records without generic scores', () => {
    expect(() => assertNoGenericAverage({ dense: 0.9, rank: 0 })).not.toThrow();
    expect(() => assertNoGenericAverage({})).not.toThrow();
  });
});

describe('cost accounting', () => {
  it('computes a complete step cost from versioned rates', () => {
    const cost = computeStepCost(normalizeStepUsage(reportedRaw()), RATES);
    expect(cost).toEqual({
      micros: 60 * 2 + 40 * 1 + 10 * 3 + 20 * 10,
      completeness: 'complete',
      unknownComponents: [],
    });
  });

  it('labels partial cost partial and names unknown components explicitly', () => {
    const cost = computeStepCost(normalizeStepUsage(reportedRaw()), {
      ...RATES,
      cacheWriteMicrosPerToken: null,
    });
    expect(cost.completeness).toBe('partial');
    expect(cost.completeness).not.toBe('total');
    expect(cost.unknownComponents).toEqual(['cache_write:unknown_rate']);
  });

  it('labels uncomputable cost unknown', () => {
    const cost = computeStepCost(normalizeStepUsage({}), RATES);
    expect(cost.completeness).toBe('unknown');
    expect(cost.micros).toBe(0);
    expect(cost.unknownComponents.length).toBeGreaterThan(0);
  });

  it('rolls turn cost up from steps without ever claiming a total', () => {
    const steps = [normalizeStepUsage(reportedRaw()), normalizeStepUsage({})];
    const turn = computeTurnCost(steps, RATES);
    const first = computeStepCost(steps[0]!, RATES);
    expect(turn.micros).toBe(first.micros);
    expect(turn.completeness).toBe('partial');
    expect(turn.completeness).not.toBe('total');
    expect(computeTurnCost([normalizeStepUsage(reportedRaw())], RATES).completeness).toBe(
      'complete',
    );
  });
});
