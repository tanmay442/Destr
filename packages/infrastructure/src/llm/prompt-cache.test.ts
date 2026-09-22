import { describe, expect, it } from 'vitest';

import {
  GOOGLE_PROMPT_CACHE_CAPABILITIES,
  OLLAMA_PROMPT_CACHE_CAPABILITIES,
  OPENAI_PROMPT_CACHE_CAPABILITIES,
  buildGooglePromptCacheOptions,
  buildOpenAIPromptCacheOptions,
  getOpenAIPromptCacheCapabilities,
  parsePromptCacheUsage,
} from './prompt-cache';

const context = {
  stablePromptPrefix: 'You are a grounded assistant.',
  prefixVersion: 'system-v1',
};

function env(values: Readonly<Record<string, string>>): { get(key: string): string | undefined } {
  return { get: (key) => values[key] };
}

const nativeOpenAIEnv = env({ CUSTOM_LLM_BASE_URL: 'https://api.openai.com/v1' });

describe('provider prompt-cache capabilities', () => {
  it('advertises each provider strategy and supported controls', () => {
    expect(OPENAI_PROMPT_CACHE_CAPABILITIES).toEqual({
      strategy: 'automatic',
      automatic: true,
      explicit: true,
      telemetry: true,
    });
    expect(GOOGLE_PROMPT_CACHE_CAPABILITIES).toEqual({
      strategy: 'explicit',
      automatic: false,
      explicit: true,
      telemetry: true,
    });
    expect(OLLAMA_PROMPT_CACHE_CAPABILITIES).toEqual({
      strategy: 'none',
      automatic: false,
      explicit: false,
      telemetry: false,
    });
  });
});

describe('buildOpenAIPromptCacheOptions', () => {
  it('builds a deterministic key for the same stable prefix and version', () => {
    const first = buildOpenAIPromptCacheOptions(context, nativeOpenAIEnv);

    expect(first).toEqual({
      openai: {
        promptCacheKey: expect.stringMatching(/^destr:system-v1:[0-9a-f]{32}$/),
      },
    });
    expect(first).toEqual(buildOpenAIPromptCacheOptions({ ...context }, nativeOpenAIEnv));
    expect(first).not.toEqual(
      buildOpenAIPromptCacheOptions(
        { ...context, stablePromptPrefix: 'A different prefix.' },
        nativeOpenAIEnv,
      ),
    );
    expect(first).not.toEqual(
      buildOpenAIPromptCacheOptions(
        { ...context, prefixVersion: 'system-v2' },
        nativeOpenAIEnv,
      ),
    );
  });

  it('omits OpenAI-only options and capabilities for Groq by default', () => {
    const groqEnv = env({ CUSTOM_LLM_BASE_URL: 'https://api.groq.com/openai/v1' });

    expect(buildOpenAIPromptCacheOptions(context, groqEnv)).toBeUndefined();
    expect(getOpenAIPromptCacheCapabilities(groqEnv)).toEqual({
      strategy: 'none',
      automatic: false,
      explicit: false,
      telemetry: false,
    });
  });

  it('allows an explicit compatible-endpoint opt-in and native OpenAI opt-out', () => {
    const optedIn = env({
      CUSTOM_LLM_BASE_URL: 'https://compatible.example/v1',
      OPENAI_PROMPT_CACHE_ENABLED: 'true',
    });
    const optedOut = env({
      CUSTOM_LLM_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_PROMPT_CACHE_ENABLED: 'false',
    });

    expect(buildOpenAIPromptCacheOptions(context, optedIn)).toBeDefined();
    expect(getOpenAIPromptCacheCapabilities(optedIn)).toBe(OPENAI_PROMPT_CACHE_CAPABILITIES);
    expect(buildOpenAIPromptCacheOptions(context, optedOut)).toBeUndefined();
    expect(getOpenAIPromptCacheCapabilities(optedOut).strategy).toBe('none');
  });

  it('fails closed for a missing or malformed base URL', () => {
    expect(buildOpenAIPromptCacheOptions(context, env({}))).toBeUndefined();
    expect(buildOpenAIPromptCacheOptions(context, env({ CUSTOM_LLM_BASE_URL: 'not a url' })))
      .toBeUndefined();
  });
});

describe('buildGooglePromptCacheOptions', () => {
  it('leaves requests unchanged when no explicit cache resource is configured', () => {
    expect(buildGooglePromptCacheOptions(context, '')).toBeUndefined();
    expect(buildGooglePromptCacheOptions(context, '   ')).toBeUndefined();
  });

  it('trims and forwards a configured cache resource name', () => {
    expect(buildGooglePromptCacheOptions(context, '  cachedContents/example  ')).toEqual({
      google: { cachedContent: 'cachedContents/example' },
    });
  });
});

describe('parsePromptCacheUsage', () => {
  it('preserves a reported zero from raw OpenAI metadata', () => {
    expect(
      parsePromptCacheUsage('openai', {
        raw: {
          prompt_tokens: 100,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        },
      }),
    ).toMatchObject({
      inputTokens: 100,
      inputTokensStatus: 'reported',
      cachedInputTokens: 0,
      cachedInputTokensStatus: 'reported',
      cacheReadTokens: 0,
      cacheReadStatus: 'reported',
      cacheWriteTokens: 0,
      cacheWriteStatus: 'reported',
      cacheHitRatio: 0,
    });
  });

  it('marks absent raw cache fields unsupported instead of inventing zeroes', () => {
    expect(
      parsePromptCacheUsage('openai', {
        raw: {
          prompt_tokens: 100,
          prompt_tokens_details: {},
        },
      }),
    ).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: null,
      cacheReadStatus: 'unsupported',
      cachedInputTokens: null,
      cachedInputTokensStatus: 'unsupported',
      cacheWriteTokens: null,
      cacheWriteStatus: 'unsupported',
      cacheHitRatio: null,
    });
  });

  it('calculates ratios from reported cache reads and handles zero-input usage', () => {
    expect(
      parsePromptCacheUsage('openai', {
        inputTokens: 100,
        inputTokenDetails: { cacheReadTokens: 25 },
      }).cacheHitRatio,
    ).toBe(0.25);
    expect(
      parsePromptCacheUsage('openai', {
        inputTokens: 0,
        inputTokenDetails: { cacheReadTokens: 0 },
      }).cacheHitRatio,
    ).toBeNull();
    expect(
      parsePromptCacheUsage('openai', {
        inputTokens: 10,
        inputTokenDetails: { cacheReadTokens: 20 },
      }).cacheHitRatio,
    ).toBe(1);
  });

  it('reads Google cache metadata from raw provider usage', () => {
    expect(
      parsePromptCacheUsage('google', {
        raw: {
          promptTokenCount: 80,
          usageMetadata: {
            cachedContentTokenCount: 20,
            cacheWriteTokenCount: 10,
          },
        },
      }),
    ).toMatchObject({
      inputTokens: 80,
      cacheReadTokens: 20,
      cacheReadStatus: 'reported',
      cacheWriteTokens: 10,
      cacheWriteStatus: 'reported',
      cacheHitRatio: 0.25,
    });
  });
});
