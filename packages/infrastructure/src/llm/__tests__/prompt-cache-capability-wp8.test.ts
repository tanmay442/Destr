import { describe, expect, it } from 'vitest';
import {
  GOOGLE_PROMPT_CACHE_CAPABILITIES,
  OLLAMA_PROMPT_CACHE_CAPABILITIES,
  OPENAI_PROMPT_CACHE_CAPABILITIES,
  buildGooglePromptCacheOptions,
  buildOpenAIPromptCacheOptions,
  parsePromptCacheUsage,
  type PromptCacheUsage,
} from '../prompt-cache';

const CONTEXT = {
  stablePromptPrefix: 'You are a grounded assistant.',
  prefixVersion: 'system-v3',
};

type BillingStatus = 'reported' | 'unsupported' | 'missing' | 'parse_error';
type Completeness = 'complete' | 'partial' | 'unknown';

interface BillingField {
  readonly value: number | null;
  readonly status: BillingStatus;
}

interface BillingRecord {
  readonly micros: number;
  readonly completeness: Completeness;
  readonly unknownComponents: readonly string[];
}

/**
 * Adapter-to-billing contract mirror (kept local so this suite never depends
 * on application code): absent metadata is `missing`/`unsupported`, invalid
 * numbers are `parse_error`, and nothing is ever zero-filled. Reported values
 * with a known rate bill; everything else names its unknown component.
 */
function toBillingField(value: unknown, fallback: BillingStatus): BillingField {
  if (value === undefined || value === null) {
    return { value: null, status: fallback === 'reported' ? 'missing' : fallback };
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { value: null, status: 'parse_error' };
  }
  return { value, status: 'reported' };
}

function billStep(
  fields: Readonly<Record<'uncached' | 'read' | 'write' | 'output', BillingField>>,
  rates: Readonly<Record<'uncached' | 'read' | 'write' | 'output', number | null>>,
): BillingRecord {
  let micros = 0;
  let billed = false;
  const unknownComponents: string[] = [];
  (Object.keys(fields) as Array<keyof typeof fields>).forEach((name) => {
    const field = fields[name];
    const rate = rates[name];
    if (field.status === 'reported' && field.value !== null && rate !== null) {
      micros += field.value * rate;
      billed = true;
    } else {
      unknownComponents.push(
        field.status === 'reported' && field.value !== null
          ? `${name}:unknown_rate`
          : `${name}:${field.status}`,
      );
    }
  });
  const completeness: Completeness =
    unknownComponents.length === 0 ? 'complete' : billed ? 'partial' : 'unknown';
  return { micros, completeness, unknownComponents: Object.freeze(unknownComponents) };
}

function usageToBillingFields(
  parsed: PromptCacheUsage,
  uncached: number | null,
  output: number | null,
): Readonly<Record<'uncached' | 'read' | 'write' | 'output', BillingField>> {
  return {
    uncached: toBillingField(uncached, 'missing'),
    read: toBillingField(parsed.cacheReadTokens, parsed.cacheReadStatus),
    write: toBillingField(parsed.cacheWriteTokens, parsed.cacheWriteStatus),
    output: toBillingField(output, 'missing'),
  };
}

const OPENAI_RATES = Object.freeze({ uncached: 10, read: 2, write: 5, output: 30 });
const GOOGLE_RATES = Object.freeze({ uncached: 8, read: 2, write: 8, output: 24 });
const LOCAL_RATES = Object.freeze({
  uncached: null,
  read: null,
  write: null,
  output: null,
});

describe('wp8 openai-compatible capability and billing', () => {
  it('reports per-step cached reads and complete billing when raw fields exist', () => {
    expect(OPENAI_PROMPT_CACHE_CAPABILITIES.telemetry).toBe(true);
    const parsed = parsePromptCacheUsage('openai', {
      raw: {
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
      },
    });
    expect(parsed.inputTokens).toBe(100);
    expect(parsed.cacheReadStatus).toBe('reported');
    expect(parsed.cacheReadTokens).toBe(40);
    expect(parsed.cacheWriteTokens).toBe(10);
    const billing = billStep(usageToBillingFields(parsed, 60, 20), OPENAI_RATES);
    expect(billing).toEqual({
      micros: 60 * 10 + 40 * 2 + 10 * 5 + 20 * 30,
      completeness: 'complete',
      unknownComponents: [],
    });
  });

  it('never treats option syntax as cache proof: a key alone is not a hit', () => {
    const options = buildOpenAIPromptCacheOptions(CONTEXT, {
      get: (key) => key === 'CUSTOM_LLM_BASE_URL' ? 'https://api.openai.com/v1' : undefined,
    });
    expect(options).toEqual({
      openai: { promptCacheKey: expect.stringMatching(/^destr:system-v3:[0-9a-f]{32}$/) },
    });
    // Same options shape, but the step reports no raw cache fields.
    const parsed = parsePromptCacheUsage('openai', {
      raw: { prompt_tokens: 100, prompt_tokens_details: {} },
    });
    expect(parsed.cacheReadStatus).toBe('unsupported');
    expect(parsed.cacheReadTokens).toBeNull();
    const billing = billStep(usageToBillingFields(parsed, null, null), OPENAI_RATES);
    expect(billing.completeness).not.toBe('complete');
    expect(billing.unknownComponents).toContain('read:unsupported');
  });
});

describe('wp8 google capability and billing', () => {
  it('reports per-step cached content reads and complete billing when metadata exists', () => {
    expect(GOOGLE_PROMPT_CACHE_CAPABILITIES.telemetry).toBe(true);
    const parsed = parsePromptCacheUsage('google', {
      raw: {
        promptTokenCount: 80,
        usageMetadata: { cachedContentTokenCount: 20, cacheWriteTokenCount: 10 },
      },
    });
    expect(parsed.cacheReadStatus).toBe('reported');
    expect(parsed.cacheReadTokens).toBe(20);
    expect(parsed.cacheWriteTokens).toBe(10);
    const billing = billStep(usageToBillingFields(parsed, 60, 5), GOOGLE_RATES);
    expect(billing.completeness).toBe('complete');
    expect(billing.micros).toBe(60 * 8 + 20 * 2 + 10 * 8 + 5 * 24);
  });

  it('leaves requests untouched without a configured cache and reports unsupported, not zero', () => {
    expect(buildGooglePromptCacheOptions(CONTEXT, '')).toBeUndefined();
    expect(buildGooglePromptCacheOptions(CONTEXT, '   ')).toBeUndefined();
    const configured = buildGooglePromptCacheOptions(CONTEXT, 'cachedContents/example');
    expect(configured).toEqual({ google: { cachedContent: 'cachedContents/example' } });
    // A configured resource name still requires per-step telemetry proof.
    const parsed = parsePromptCacheUsage('google', { raw: { promptTokenCount: 80 } });
    expect(parsed.cacheReadStatus).toBe('unsupported');
    expect(parsed.cacheReadTokens).toBeNull();
    expect(parsed.cacheHitRatio).toBeNull();
  });
});

describe('wp8 ollama/local capability and billing', () => {
  it('is exempt only with capability proof and bills unknown, never zero', () => {
    expect(OLLAMA_PROMPT_CACHE_CAPABILITIES).toEqual({
      strategy: 'none',
      automatic: false,
      explicit: false,
      telemetry: false,
    });
    const parsed = parsePromptCacheUsage('ollama', { inputTokens: 50 });
    expect(parsed.cacheReadStatus).toBe('unsupported');
    expect(parsed.cacheWriteStatus).toBe('unsupported');
    const billing = billStep(usageToBillingFields(parsed, null, null), LOCAL_RATES);
    expect(billing.micros).toBe(0);
    expect(billing.completeness).toBe('unknown');
    expect(billing.unknownComponents.length).toBeGreaterThan(0);
    expect(billing.unknownComponents).not.toContain('read:reported');
  });
});

describe('wp8 missing and parse-error telemetry', () => {
  it('keeps absent usage missing instead of zero', () => {
    const field = toBillingField(undefined, 'missing');
    expect(field).toEqual({ value: null, status: 'missing' });
    const billing = billStep(
      {
        uncached: toBillingField(undefined, 'missing'),
        read: toBillingField(undefined, 'unsupported'),
        write: toBillingField(undefined, 'unsupported'),
        output: toBillingField(undefined, 'missing'),
      },
      OPENAI_RATES,
    );
    expect(billing.completeness).toBe('unknown');
    expect(billing.micros).toBe(0);
  });

  it('marks invalid token values as parse errors with explicit components', () => {
    expect(toBillingField(-1, 'missing')).toEqual({ value: null, status: 'parse_error' });
    expect(toBillingField(1.5, 'missing')).toEqual({ value: null, status: 'parse_error' });
    const billing = billStep(
      {
        uncached: toBillingField(60, 'missing'),
        read: toBillingField(-1, 'missing'),
        write: toBillingField(10, 'missing'),
        output: toBillingField(5, 'missing'),
      },
      OPENAI_RATES,
    );
    expect(billing.completeness).toBe('partial');
    expect(billing.unknownComponents).toContain('read:parse_error');
  });
});
