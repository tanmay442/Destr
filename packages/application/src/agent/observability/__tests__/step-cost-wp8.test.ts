import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOOL_CATALOG_VERSION } from '../agent-event';
import {
  buildWp8StepCostTelemetry,
  deriveProviderCacheStatus,
  rollupWp8StepCosts,
  wp8StepCostLabels,
} from '../wp8-events';
import {
  computeStepCost,
  computeTurnCost,
  normalizeStepUsage,
  type NormalizedStepUsage,
  type TokenPriceRates,
} from '../usage-normalizer';

/**
 * Provider-specific billable rates (micros per token). Missing prices stay
 * `null` so unknown components are explicit; they are never zero-filled.
 */
const OPENAI_RATES: TokenPriceRates = Object.freeze({
  uncachedInputMicrosPerToken: 10,
  cacheReadMicrosPerToken: 2,
  cacheWriteMicrosPerToken: 5,
  outputMicrosPerToken: 30,
  priceVersion: 'prices-openai-2026-09',
});

const GOOGLE_RATES: TokenPriceRates = Object.freeze({
  uncachedInputMicrosPerToken: 8,
  cacheReadMicrosPerToken: 2,
  cacheWriteMicrosPerToken: 8,
  outputMicrosPerToken: 24,
  priceVersion: 'prices-google-2026-09',
});

const LOCAL_RATES: TokenPriceRates = Object.freeze({
  uncachedInputMicrosPerToken: null,
  cacheReadMicrosPerToken: null,
  cacheWriteMicrosPerToken: null,
  outputMicrosPerToken: null,
  priceVersion: 'prices-local-2026-09',
});

function reportedStep(): NormalizedStepUsage {
  return normalizeStepUsage({
    inputTokensTotal: { value: 100, status: 'reported' },
    cacheReadTokens: { value: 40, status: 'reported' },
    cacheWriteTokens: { value: 10, status: 'reported' },
    uncachedTokens: { value: 60, status: 'reported' },
    outputTokens: { value: 20, status: 'reported' },
    answerCacheHit: false,
    answerCacheStatus: 'reported',
  });
}

describe('wp8 per-step cost by provider', () => {
  it('prices identical usage differently per provider rate card', () => {
    const step = reportedStep();
    const openai = computeStepCost(step, OPENAI_RATES);
    const google = computeStepCost(step, GOOGLE_RATES);
    expect(openai).toEqual({
      micros: 60 * 10 + 40 * 2 + 10 * 5 + 20 * 30,
      completeness: 'complete',
      unknownComponents: [],
    });
    expect(google).toEqual({
      micros: 60 * 8 + 40 * 2 + 10 * 8 + 20 * 24,
      completeness: 'complete',
      unknownComponents: [],
    });
    expect(openai.micros).not.toBe(google.micros);
  });

  it('keeps missing fields missing and never counts them as zero-cost hits', () => {
    const step = normalizeStepUsage({});
    expect(step.inputTokensTotal).toEqual({ value: null, status: 'missing' });
    expect(step.cacheReadTokens).toEqual({ value: null, status: 'missing' });
    expect(step.uncachedTokens).toEqual({ value: null, status: 'missing' });
    expect(step.outputTokens).toEqual({ value: null, status: 'missing' });
    const cost = computeStepCost(step, OPENAI_RATES);
    expect(cost.micros).toBe(0);
    expect(cost.completeness).toBe('unknown');
    expect(cost.unknownComponents).toEqual([
      'uncached_input:missing',
      'cache_read:missing',
      'cache_write:missing',
      'output:missing',
    ]);
  });

  it('labels partial cost partial with explicit unknown components, never total', () => {
    const cost = computeStepCost(reportedStep(), {
      ...OPENAI_RATES,
      cacheWriteMicrosPerToken: null,
    });
    expect(cost.completeness).toBe('partial');
    expect(cost.unknownComponents).toEqual(['cache_write:unknown_rate']);
    expect(cost.micros).toBe(60 * 10 + 40 * 2 + 20 * 30);
  });

  it('marks unsupported local telemetry unknown instead of free', () => {
    const local = normalizeStepUsage({
      cacheReadTokens: { value: 50, status: 'unsupported' },
      cacheWriteTokens: { status: 'unsupported' },
      uncachedTokens: { status: 'unsupported' },
    });
    expect(deriveProviderCacheStatus(local)).toBe('unsupported');
    const cost = computeStepCost(local, LOCAL_RATES);
    expect(cost.completeness).toBe('unknown');
    expect(cost.micros).toBe(0);
    expect(cost.unknownComponents.length).toBeGreaterThan(0);
    const turn = computeTurnCost([local], LOCAL_RATES);
    expect(turn.completeness).toBe('unknown');
  });

  it('propagates parse errors without zero-filling', () => {
    const step = normalizeStepUsage({
      inputTokensTotal: { value: -5, status: 'reported' },
      outputTokens: { value: 20, status: 'reported' },
    });
    expect(step.inputTokensTotal.status).toBe('parse_error');
    expect(deriveProviderCacheStatus(step)).toBe('missing');
    const cost = computeStepCost(step, OPENAI_RATES);
    expect(cost.completeness).toBe('partial');
    expect(cost.unknownComponents).toContain('uncached_input:missing');
  });
});

describe('wp8 per-step TTFT, latency, versions, and labels', () => {
  it('carries TTFT/latency where available and nulls where not', () => {
    const withTimings = buildWp8StepCostTelemetry({
      stepNumber: 1,
      provider: 'openai_compatible',
      usage: reportedStep(),
      rates: OPENAI_RATES,
      timeToFirstTokenMs: 120,
      latencyMs: 900,
      promptVersion: 'system-v3',
      toolCatalogVersion: TOOL_CATALOG_VERSION,
      schemaDigest: 'abc123ef',
    });
    expect(withTimings.timeToFirstTokenMs).toBe(120);
    expect(withTimings.latencyMs).toBe(900);
    expect(withTimings.providerStatus).toBe('reported');
    const withoutTimings = buildWp8StepCostTelemetry({
      stepNumber: 1,
      provider: 'local',
      usage: normalizeStepUsage({}),
      rates: LOCAL_RATES,
      timeToFirstTokenMs: null,
      latencyMs: null,
      promptVersion: 'system-v3',
      toolCatalogVersion: TOOL_CATALOG_VERSION,
      schemaDigest: 'abc123ef',
    });
    expect(withoutTimings.timeToFirstTokenMs).toBeNull();
    expect(withoutTimings.providerStatus).toBe('missing');
    expect(withoutTimings.costCompleteness).toBe('unknown');
  });

  it('carries provider, model, prompt, catalog, and digest as labels, not values', () => {
    const labels = wp8StepCostLabels({
      provider: 'google',
      modelId: 'chat-model-v1',
      promptVersion: 'system-v3',
      toolCatalogVersion: TOOL_CATALOG_VERSION,
      schemaDigest: 'abc123ef',
      cacheStatus: 'reported',
      completeness: 'complete',
    });
    expect(labels).toEqual({
      provider: 'google',
      modelId: 'chat-model-v1',
      promptVersion: 'system-v3',
      toolCatalogVersion: TOOL_CATALOG_VERSION,
      schemaDigest: 'abc123ef',
      cacheStatus: 'reported',
      completeness: 'complete',
    });
  });

  it('keeps turn cost consistent with per-step costs', () => {
    const steps = [reportedStep(), normalizeStepUsage({})];
    const rollup = rollupWp8StepCosts(steps, GOOGLE_RATES);
    const turn = computeTurnCost(steps, GOOGLE_RATES);
    expect(rollup.micros).toBe(turn.micros);
    expect(rollup.completeness).toBe(turn.completeness);
    expect(rollup.completeness).toBe('partial');
  });
});

describe('wp8 application layer holds no provider option keys', () => {
  it('defines no provider request fields in the observability module', () => {
    const source = readFileSync(new URL('../wp8-events.ts', import.meta.url), 'utf8');
    for (const forbidden of [
      'promptCacheKey',
      'cachedContent',
      'providerOptions',
      'prompt_tokens_details',
      'usageMetadata',
      'cachedContentTokenCount',
    ]) {
      expect(source, `wp8-events.ts must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});
