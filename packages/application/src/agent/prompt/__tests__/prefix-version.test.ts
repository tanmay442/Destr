import { describe, expect, it } from 'vitest';
import { TOOL_CATALOG_VERSION } from '../../tool-catalog';
import {
  canonicalizeJson,
  checkStepCapabilityConformance,
  checkUnknownCacheCapability,
  computeSchemaDigest,
  currentPrefixVersion,
  estimatePrefixSavings,
  prefixVersionsMatch,
  promptCacheEligibility,
  recordStepUsage,
  buildPromptPrefixVersion,
  type ModelRuntimeCapabilities,
  type PrefixToolContract,
  type StepUsageRecord,
} from '../prefix-version';
import { HISTORY_SHAPE_VERSION } from '../../../chat/history-compaction';
import {
  normalizeStepUsage,
  type NormalizedStepUsage,
  type RawStepUsage,
  type TokenPriceRates,
} from '../../observability/usage-normalizer';

const PROVIDER_A_RATES: TokenPriceRates = Object.freeze({
  uncachedInputMicrosPerToken: 4,
  cacheReadMicrosPerToken: 1,
  cacheWriteMicrosPerToken: 5,
  outputMicrosPerToken: 12,
  priceVersion: 'provider-a-2026-09',
});

const PROVIDER_B_RATES: TokenPriceRates = Object.freeze({
  uncachedInputMicrosPerToken: 10,
  cacheReadMicrosPerToken: 2,
  cacheWriteMicrosPerToken: 8,
  outputMicrosPerToken: 30,
  priceVersion: 'provider-b-2026-09',
});

const LATENCY = Object.freeze({
  ttftMs: 120,
  ttftStatus: 'reported',
  totalMs: 900,
  totalStatus: 'reported',
} as const);

function toolsFixture(): PrefixToolContract[] {
  return [
    { name: 'searchDocumentation', jsonSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'createKnowledgeTicket', jsonSchema: { type: 'object', properties: { question: { type: 'string' } } } },
  ];
}

function prefixFixture() {
  return currentPrefixVersion(toolsFixture(), HISTORY_SHAPE_VERSION);
}

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

function recordFixture(usage: NormalizedStepUsage, rates: TokenPriceRates = PROVIDER_A_RATES): StepUsageRecord {
  return recordStepUsage({
    stepNumber: 1,
    providerId: 'provider-a',
    modelId: 'model-a-primary',
    usage,
    rates,
    latency: { ...LATENCY },
    prefix: prefixFixture(),
  });
}

function capableStub(overrides: Partial<ModelRuntimeCapabilities> = {}): ModelRuntimeCapabilities {
  return {
    promptCache: 'automatic',
    cacheTelemetry: 'per_step',
    stableToolRestriction: 'allowed_tools',
    maxContextTokens: 128_000,
    maxOutputTokens: 8_000,
    ...overrides,
  };
}

describe('canonicalizeJson', () => {
  it('normalizes object key order so serialization churn is stable', () => {
    expect(canonicalizeJson({ b: 1, a: { y: 2, x: 1 } })).toBe(canonicalizeJson({ a: { x: 1, y: 2 }, b: 1 }));
  });

  it('preserves array order because tool order is significant', () => {
    expect(canonicalizeJson([1, 2])).not.toBe(canonicalizeJson([2, 1]));
  });

  it('rejects non-JSON values instead of digesting them silently', () => {
    expect(() => canonicalizeJson(undefined)).toThrow();
    expect(() => canonicalizeJson(Number.NaN)).toThrow();
  });
});

describe('computeSchemaDigest', () => {
  it('is stable for the same contract and order', () => {
    expect(computeSchemaDigest(toolsFixture())).toBe(computeSchemaDigest(toolsFixture()));
  });

  it('ignores schema key order but rotates on tool order change', () => {
    const reordered = [toolsFixture()[1]!, toolsFixture()[0]!];
    expect(computeSchemaDigest(reordered)).not.toBe(computeSchemaDigest(toolsFixture()));
    const rekeyed: PrefixToolContract[] = [
      { name: 'searchDocumentation', jsonSchema: { properties: { query: { type: 'string' } }, type: 'object' } },
      { name: 'createKnowledgeTicket', jsonSchema: { type: 'object', properties: { question: { type: 'string' } } } },
    ];
    expect(computeSchemaDigest(rekeyed)).toBe(computeSchemaDigest(toolsFixture()));
  });

  it('rotates on contract change: added, removed, or edited schema', () => {
    const base = computeSchemaDigest(toolsFixture());
    expect(computeSchemaDigest([...toolsFixture(), { name: 'extraTool', jsonSchema: { type: 'object' } }])).not.toBe(base);
    expect(computeSchemaDigest([toolsFixture()[0]!])).not.toBe(base);
    expect(
      computeSchemaDigest([
        { name: 'searchDocumentation', jsonSchema: { type: 'object', properties: { query: { type: 'number' } } } },
        toolsFixture()[1]!,
      ]),
    ).not.toBe(base);
  });
});

describe('buildPromptPrefixVersion', () => {
  it('rotates the prefix version on any contract input change', () => {
    const base = buildPromptPrefixVersion({
      systemPromptVersion: 'system-prompt-v4',
      toolCatalogVersion: TOOL_CATALOG_VERSION,
      schemaDigest: 'digest-a',
      historyShapeVersion: HISTORY_SHAPE_VERSION,
    });
    expect(prefixVersionsMatch(base, base)).toBe(true);
    for (const variant of [
      { systemPromptVersion: 'system-prompt-v5' },
      { toolCatalogVersion: 'tool-catalog-v2' },
      { schemaDigest: 'digest-b' },
      { historyShapeVersion: 'history-shape-v2' },
    ]) {
      const rotated = buildPromptPrefixVersion({
        systemPromptVersion: 'system-prompt-v4',
        toolCatalogVersion: TOOL_CATALOG_VERSION,
        schemaDigest: 'digest-a',
        historyShapeVersion: HISTORY_SHAPE_VERSION,
        ...variant,
      });
      expect(prefixVersionsMatch(base, rotated)).toBe(false);
    }
  });

  it('pins the current catalog version and history shape', () => {
    const prefix = prefixFixture();
    expect(prefix.toolCatalogVersion).toBe(TOOL_CATALOG_VERSION);
    expect(prefix.historyShapeVersion).toBe(HISTORY_SHAPE_VERSION);
    expect(prefix.prefixVersion.startsWith('prompt-prefix-v1:')).toBe(true);
  });
});

describe('recordStepUsage statuses and provider-specific billing', () => {
  it('records all statuses and bills with provider-specific rates', () => {
    const usage = normalizeStepUsage(reportedRaw());
    const recordA = recordFixture(usage, PROVIDER_A_RATES);
    const recordB = recordStepUsage({
      stepNumber: 1,
      providerId: 'provider-b',
      modelId: 'model-b-fallback',
      usage,
      rates: PROVIDER_B_RATES,
      latency: { ...LATENCY },
      prefix: prefixFixture(),
    });
    expect(recordA.costCompleteness).toBe('complete');
    expect(recordA.costMicros).toBe(60 * 4 + 40 * 1 + 10 * 5 + 20 * 12);
    expect(recordB.costMicros).toBe(60 * 10 + 40 * 2 + 10 * 8 + 20 * 30);
    expect(recordB.costMicros).not.toBe(recordA.costMicros);
    expect(recordA.priceVersion).toBe('provider-a-2026-09');
    expect(recordA.usage.cacheReadTokens).toEqual({ value: 40, status: 'reported' });
    expect(recordA.latency.ttftMs).toBe(120);
    expect(recordA.prefixVersion).toBe(prefixFixture().prefixVersion);
  });

  it('never treats missing cache fields as zero', () => {
    const record = recordFixture(normalizeStepUsage({}));
    expect(record.usage.cacheReadTokens).toEqual({ value: null, status: 'missing' });
    expect(record.costCompleteness).toBe('unknown');
    expect(record.costMicros).toBe(0);
    expect(record.unknownCostComponents.length).toBeGreaterThan(0);
  });

  it('marks unsupported and parse_error distinctly from missing', () => {
    const record = recordFixture(
      normalizeStepUsage({
        cacheReadTokens: { status: 'unsupported' },
        outputTokens: { value: -1, status: 'reported' },
      }),
    );
    expect(record.usage.cacheReadTokens).toEqual({ value: null, status: 'unsupported' });
    expect(record.usage.outputTokens.status).toBe('parse_error');
    expect(record.usage.inputTokensTotal.status).toBe('missing');
    expect(record.costCompleteness).toBe('unknown');
  });

  it('labels partial cost when a provider rate is unknown', () => {
    const record = recordFixture(normalizeStepUsage(reportedRaw()), {
      ...PROVIDER_A_RATES,
      cacheReadMicrosPerToken: null,
    });
    expect(record.costCompleteness).toBe('partial');
    expect(record.unknownCostComponents).toEqual(['cache_read:unknown_rate']);
  });
});

describe('estimatePrefixSavings', () => {
  it('reports observed savings only for complete per-step evidence', () => {
    const steps = [recordFixture(normalizeStepUsage(reportedRaw()))];
    const estimate = estimatePrefixSavings(steps, PROVIDER_A_RATES);
    expect(estimate.evidence).toBe('observed_per_step');
    expect(estimate.completeness).toBe('complete');
    expect(estimate.counterfactualUncachedMicros).toBe((60 + 40 + 10) * 4 + 20 * 12);
    expect(estimate.savedMicros).toBe((60 + 40 + 10) * 4 + 20 * 12 - (60 * 4 + 40 * 1 + 10 * 5 + 20 * 12));
  });

  it('claims no savings without complete evidence', () => {
    const partial = estimatePrefixSavings(
      [recordFixture(normalizeStepUsage(reportedRaw())), recordFixture(normalizeStepUsage({}))],
      PROVIDER_A_RATES,
    );
    expect(partial.savedMicros).toBeNull();
    expect(partial.counterfactualUncachedMicros).toBeNull();
    expect(partial.evidence).toBe('insufficient');
    expect(estimatePrefixSavings([], PROVIDER_A_RATES).completeness).toBe('unknown');
  });
});

describe('capability-gated cache behavior (no provider keys)', () => {
  it('grants eligibility only for declared automatic/explicit support', () => {
    expect(promptCacheEligibility(capableStub({ promptCache: 'automatic' }))).toEqual({
      eligible: true,
      mechanism: 'automatic',
    });
    expect(promptCacheEligibility(capableStub({ promptCache: 'explicit' }))).toEqual({
      eligible: true,
      mechanism: 'explicit',
    });
    expect(promptCacheEligibility(capableStub({ promptCache: 'unsupported' })).eligible).toBe(false);
    expect(promptCacheEligibility(capableStub({ promptCache: 'unknown' })).eligible).toBe(false);
  });

  it('rejects per-step cache claims when telemetry is unsupported', () => {
    const usage = normalizeStepUsage(reportedRaw());
    const conformance = checkStepCapabilityConformance({
      capabilities: capableStub({ cacheTelemetry: 'unsupported' }),
      usage,
    });
    expect(conformance).toEqual({ ok: false, reason: 'cache_claim_without_capability' });
    const record = recordStepUsage(
      {
        stepNumber: 1,
        providerId: 'provider-a',
        modelId: 'model-a-primary',
        usage,
        rates: PROVIDER_A_RATES,
        latency: { ttftMs: null, ttftStatus: 'missing', totalMs: 100, totalStatus: 'reported' },
        prefix: prefixFixture(),
      },
      { capabilities: capableStub({ cacheTelemetry: 'unsupported' }) },
    );
    expect(record.capabilityConformance.ok).toBe(false);
  });

  it('rejects per-step claims under aggregate-only telemetry and unknown capability', () => {
    const usage = normalizeStepUsage(reportedRaw());
    expect(
      checkStepCapabilityConformance({ capabilities: capableStub({ cacheTelemetry: 'aggregate_only' }), usage }),
    ).toEqual({ ok: false, reason: 'per_step_telemetry_not_supported' });
    expect(
      checkUnknownCacheCapability(capableStub({ promptCache: 'unknown', cacheTelemetry: 'per_step' }), usage),
    ).toEqual({ ok: false, reason: 'cache_capability_unknown' });
    expect(
      checkUnknownCacheCapability(capableStub({ promptCache: 'automatic' }), usage),
    ).toEqual({ ok: true });
  });

  it('accepts missing cache fields under unsupported telemetry', () => {
    const usage = normalizeStepUsage({});
    expect(
      checkStepCapabilityConformance({ capabilities: capableStub({ cacheTelemetry: 'unsupported' }), usage }),
    ).toEqual({ ok: true });
  });
});
