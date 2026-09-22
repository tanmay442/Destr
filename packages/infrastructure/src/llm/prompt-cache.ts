import { createHash } from 'node:crypto';
import type { SharedV4ProviderOptions } from '@ai-sdk/provider';
import type { EnvSource } from '@app/domain';
import { defaultProcessEnv } from '../config/env';
import { isNativeOpenAIBaseURL } from './openai-base-url';

export type PromptCacheStrategy = 'automatic' | 'explicit' | 'telemetry' | 'none';

/** Provider-neutral capability facts. Provider names stay in the adapter. */
export interface PromptCacheCapabilities {
  readonly strategy: PromptCacheStrategy;
  readonly automatic: boolean;
  readonly explicit: boolean;
  readonly telemetry: boolean;
}

export const OPENAI_PROMPT_CACHE_CAPABILITIES: PromptCacheCapabilities = Object.freeze({
  strategy: 'automatic',
  automatic: true,
  explicit: true,
  telemetry: true,
});

export const GOOGLE_PROMPT_CACHE_CAPABILITIES: PromptCacheCapabilities = Object.freeze({
  strategy: 'explicit',
  automatic: false,
  explicit: true,
  telemetry: true,
});

export const OLLAMA_PROMPT_CACHE_CAPABILITIES: PromptCacheCapabilities = Object.freeze({
  strategy: 'none',
  automatic: false,
  explicit: false,
  telemetry: false,
});

const NO_PROMPT_CACHE_CAPABILITIES: PromptCacheCapabilities = OLLAMA_PROMPT_CACHE_CAPABILITIES;

export interface PromptCacheRequestContext {
  readonly stablePromptPrefix: string;
  readonly prefixVersion: string;
}

/** A metric can be a real zero, or unsupported/missing provider metadata. */
export type PromptCacheMetricStatus = 'reported' | 'unsupported';

export interface PromptCacheUsage {
  readonly inputTokens: number | null;
  readonly inputTokensStatus: PromptCacheMetricStatus;
  readonly cachedInputTokens: number | null;
  readonly cachedInputTokensStatus: PromptCacheMetricStatus;
  readonly cacheReadTokens: number | null;
  readonly cacheReadStatus: PromptCacheMetricStatus;
  readonly cacheWriteTokens: number | null;
  readonly cacheWriteStatus: PromptCacheMetricStatus;
  readonly cacheHitRatio: number | null;
}

type JsonObject = { readonly [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(value: JsonObject, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  return isObject(value) ? finiteNonNegative(own(value, key)) : undefined;
}

function reportedMetric(value: number | undefined): {
  value: number | null;
  status: PromptCacheMetricStatus;
} {
  return value === undefined
    ? { value: null, status: 'unsupported' }
    : { value, status: 'reported' };
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value) => value !== undefined);
}

function providerRawUsage(usage: JsonObject): JsonObject | null {
  const raw = own(usage, 'raw');
  return isObject(raw) ? raw : null;
}

function providerMetadataObject(metadata: unknown, provider: string): JsonObject | null {
  if (!isObject(metadata)) return null;
  const providerValue = own(metadata, provider);
  return isObject(providerValue) ? providerValue : null;
}

function rawCacheRead(provider: string, raw: JsonObject | null, metadata: unknown): number | undefined {
  if (provider === 'openai') {
    const details = raw && own(raw, 'prompt_tokens_details');
    const providerDetails = providerMetadataObject(metadata, 'openai');
    return firstNumber(
      readNumber(details, 'cached_tokens'),
      readNumber(providerDetails, 'cachedPromptTokens'),
      readNumber(providerDetails, 'cachedInputTokens'),
    );
  }
  if (provider === 'google') {
    const usageMetadata = raw && own(raw, 'usageMetadata');
    const providerDetails = providerMetadataObject(metadata, 'google');
    const providerUsageMetadata = providerDetails && own(providerDetails, 'usageMetadata');
    return firstNumber(
      readNumber(usageMetadata, 'cachedContentTokenCount'),
      readNumber(providerUsageMetadata, 'cachedContentTokenCount'),
    );
  }
  return undefined;
}

function rawCacheWrite(provider: string, raw: JsonObject | null, metadata: unknown): number | undefined {
  if (provider === 'openai') {
    const details = raw && own(raw, 'prompt_tokens_details');
    const providerDetails = providerMetadataObject(metadata, 'openai');
    return firstNumber(
      readNumber(details, 'cache_write_tokens'),
      readNumber(details, 'cached_write_tokens'),
      readNumber(providerDetails, 'cacheWriteTokens'),
    );
  }
  if (provider === 'google') {
    const usageMetadata = raw && own(raw, 'usageMetadata');
    const providerDetails = providerMetadataObject(metadata, 'google');
    const providerUsageMetadata = providerDetails && own(providerDetails, 'usageMetadata');
    return firstNumber(
      readNumber(usageMetadata, 'cacheWriteTokenCount'),
      readNumber(providerUsageMetadata, 'cacheWriteTokenCount'),
    );
  }
  return undefined;
}

/**
 * Parse normalized AI SDK usage without turning absent cache metadata into a
 * misleading zero. Raw provider usage is preferred because some adapters
 * normalize absent fields to `0`.
 */
export function parsePromptCacheUsage(
  provider: string,
  usage: unknown,
  providerMetadata?: unknown,
): PromptCacheUsage {
  const value = isObject(usage) ? usage : {};
  const raw = providerRawUsage(value);
  const inputTokens = firstNumber(
    finiteNonNegative(own(value, 'inputTokens')),
    readNumber(value, 'totalInputTokens'),
    readNumber(raw, 'prompt_tokens'),
    readNumber(raw, 'promptTokenCount'),
  );
  const inputMetric = reportedMetric(inputTokens);

  const details = own(value, 'inputTokenDetails');
  const normalizedRead = firstNumber(
    readNumber(details, 'cacheReadTokens'),
    finiteNonNegative(own(value, 'cachedInputTokens')),
  );
  const normalizedWrite = readNumber(details, 'cacheWriteTokens');

  // If raw provider usage exists, its field presence is authoritative. This
  // avoids interpreting the OpenAI/Google adapter's default `0` as a report.
  const read = raw !== null || providerMetadata !== undefined
    ? rawCacheRead(provider, raw, providerMetadata)
    : normalizedRead;
  const write = raw !== null || providerMetadata !== undefined
    ? rawCacheWrite(provider, raw, providerMetadata)
    : normalizedWrite;
  const readMetric = reportedMetric(read);
  const writeMetric = reportedMetric(write);
  const cachedMetric = readMetric;

  return {
    inputTokens: inputMetric.value,
    inputTokensStatus: inputMetric.status,
    cachedInputTokens: cachedMetric.value,
    cachedInputTokensStatus: cachedMetric.status,
    cacheReadTokens: readMetric.value,
    cacheReadStatus: readMetric.status,
    cacheWriteTokens: writeMetric.value,
    cacheWriteStatus: writeMetric.status,
    cacheHitRatio:
      inputMetric.value !== null && inputMetric.value > 0 && readMetric.value !== null
        ? Math.min(1, readMetric.value / inputMetric.value)
        : null,
  };
}

function prefixCacheKey(context: PromptCacheRequestContext): string {
  const digest = createHash('sha256')
    .update(`${context.prefixVersion}\0${context.stablePromptPrefix}`, 'utf8')
    .digest('hex');
  return `destr:${context.prefixVersion}:${digest.slice(0, 32)}`;
}

function supportsOpenAIPromptCacheKey(env: EnvSource): boolean {
  const override = env.get('OPENAI_PROMPT_CACHE_ENABLED')?.trim().toLowerCase();
  if (override === 'true') return true;
  if (override === 'false') return false;

  return isNativeOpenAIBaseURL(env.get('CUSTOM_LLM_BASE_URL'));
}

/**
 * OpenAI-compatible APIs do not necessarily accept OpenAI-only request fields.
 * Default to native OpenAI only; compatible endpoints must explicitly opt in.
 */
export function getOpenAIPromptCacheCapabilities(
  env: EnvSource = defaultProcessEnv,
): PromptCacheCapabilities {
  return supportsOpenAIPromptCacheKey(env)
    ? OPENAI_PROMPT_CACHE_CAPABILITIES
    : NO_PROMPT_CACHE_CAPABILITIES;
}

/** OpenAI's manual key only groups otherwise automatic prefix caching. */
export function buildOpenAIPromptCacheOptions(
  context: PromptCacheRequestContext,
  env: EnvSource = defaultProcessEnv,
): SharedV4ProviderOptions | undefined {
  if (!supportsOpenAIPromptCacheKey(env)) return undefined;
  return {
    openai: {
      promptCacheKey: prefixCacheKey(context),
    },
  };
}

/**
 * Google explicit caches are created out-of-band. Only pass a configured
 * cache resource name; an absent setting leaves the normal request untouched.
 */
export function buildGooglePromptCacheOptions(
  _context: PromptCacheRequestContext,
  cachedContent: string | undefined = defaultProcessEnv.get('GOOGLE_CACHED_CONTENT'),
): SharedV4ProviderOptions | undefined {
  const value = cachedContent?.trim();
  if (!value) return undefined;
  return { google: { cachedContent: value } };
}
