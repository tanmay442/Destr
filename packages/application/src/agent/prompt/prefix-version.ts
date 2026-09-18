import { createHash } from 'node:crypto';
import { z } from 'zod';
import { logger } from '@app/domain';
import { TokenFieldStatusSchema } from '../observability/agent-event';
import {
  NormalizedStepUsageSchema,
  type NormalizedStepUsage,
  type TokenPriceRates,
} from '../observability/usage-normalizer';
import { computeStepCost } from '../observability/usage-normalizer';
import { TOOL_CATALOG_VERSION } from '../tool-catalog';

/**
 * Stable, versioned cacheable prompt prefix (WP-8 Task B, F-32/F-33).
 *
 * The provider prompt cache discounts an identical input prefix within model
 * calls. A configured cache key alone is never treated as a hit: reuse must be
 * observed per model step (see {@link recordStepUsage}) and priced with
 * provider-specific rates. This module owns the application-side contract that
 * keeps the prefix stable:
 *
 * - stable system instructions (`systemPromptVersion`),
 * - stable tool set, tool order, and schema serialization (`toolCatalogVersion`
 *   plus `schemaDigest`),
 * - stable history shape (`historyShapeVersion`, owned by
 *   `chat/history-compaction.ts` and passed here as an opaque string so this
 *   module never depends on chat message types).
 *
 * Any contract change rotates the digest by construction. Provider cache
 * options (`promptCacheKey`, cached-content resources, breakpoints) stay in
 * infrastructure adapters; this module contains no provider option keys and
 * gates every cache claim on an explicit capability declaration. Capability
 * syntax alone is never proof of reuse.
 */

export const PROMPT_PREFIX_VERSION_TAG = 'prompt-prefix-v1' as const;

/** Source of truth for the numeric system prompt version lives in chat/cache-key.ts. */
export const STABLE_SYSTEM_PROMPT_VERSION = 'system-prompt-v4' as const;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertNever(value: never): never {
  throw new Error(`prefix-version: unhandled case ${JSON.stringify(value)}`);
}

/**
 * Deterministic canonical JSON serialization: object keys sorted recursively,
 * arrays order-preserving (tool order is significant and must rotate the
 * digest). Throws on non-JSON values so a digest can never silently cover an
 * unserializable schema.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalizeJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalizeJson(entry)).join(',')}]`;
  if (typeof value === 'object') {
    const record = z.record(z.string(), z.unknown()).parse(value);
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`).join(',')}}`;
  }
  throw new Error(`canonicalizeJson: unsupported JSON value of type ${typeof value}`);
}

export const PrefixToolContractSchema = z.object({
  name: z.string().min(1).max(200),
  jsonSchema: z.unknown(),
});
export type PrefixToolContract = z.infer<typeof PrefixToolContractSchema>;

export const PrefixToolListSchema = z.array(PrefixToolContractSchema).min(1).max(64);
export type PrefixToolList = z.infer<typeof PrefixToolListSchema>;

/**
 * Schema digest over the ordered tool contract list. Array order is preserved
 * (reordering tools rotates the digest); object key order inside a schema is
 * normalized away (serialization churn must not rotate the digest).
 */
export function computeSchemaDigest(tools: unknown): string {
  const parsed = PrefixToolListSchema.parse(tools);
  const canonical = canonicalizeJson(
    parsed.map((tool) => ({ name: tool.name, schema: tool.jsonSchema })),
  );
  return sha256Hex(`schema-digest-v1\0${canonical}`);
}

export const PrefixVersionInputSchema = z.object({
  systemPromptVersion: z.string().min(1).max(200),
  toolCatalogVersion: z.string().min(1).max(200),
  schemaDigest: z.string().min(1).max(200),
  historyShapeVersion: z.string().min(1).max(200),
});
export type PrefixVersionInput = z.infer<typeof PrefixVersionInputSchema>;

export const PromptPrefixVersionSchema = PrefixVersionInputSchema.extend({
  prefixVersion: z.string().min(1).max(200),
});
export type PromptPrefixVersion = z.infer<typeof PromptPrefixVersionSchema>;

/** Build the versioned prefix identity. Any input change rotates `prefixVersion`. */
export function buildPromptPrefixVersion(input: unknown): PromptPrefixVersion {
  const parsed = PrefixVersionInputSchema.parse(input);
  const digest = sha256Hex(`${PROMPT_PREFIX_VERSION_TAG}\0${canonicalizeJson(parsed)}`);
  const versioned: PromptPrefixVersion = {
    ...parsed,
    prefixVersion: `${PROMPT_PREFIX_VERSION_TAG}:${digest.slice(0, 32)}`,
  };
  logger.info('prompt.prefix_version_built', {
    prefixVersion: versioned.prefixVersion,
    toolCatalogVersion: versioned.toolCatalogVersion,
    schemaDigest: versioned.schemaDigest.slice(0, 16),
  });
  return Object.freeze(versioned);
}

/** Current application prefix identity for an ordered tool contract list. */
export function currentPrefixVersion(tools: unknown, historyShapeVersion: string): PromptPrefixVersion {
  return buildPromptPrefixVersion({
    systemPromptVersion: STABLE_SYSTEM_PROMPT_VERSION,
    toolCatalogVersion: TOOL_CATALOG_VERSION,
    schemaDigest: computeSchemaDigest(tools),
    historyShapeVersion,
  });
}

export function prefixVersionsMatch(left: PromptPrefixVersion, right: PromptPrefixVersion): boolean {
  return left.prefixVersion === right.prefixVersion;
}

/**
 * Provider-neutral runtime capability facts (plan 8.6). Populated by adapter
 * contract tests and runtime configuration; never inferred from an
 * OpenAI-compatible URL or from request syntax. No provider option keys live
 * here.
 */
export const ModelRuntimeCapabilitiesSchema = z.object({
  promptCache: z.enum(['automatic', 'explicit', 'unsupported', 'unknown']),
  cacheTelemetry: z.enum(['per_step', 'aggregate_only', 'unsupported']),
  stableToolRestriction: z.enum(['allowed_tools', 'change_catalog', 'none']),
  maxContextTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
});
export type ModelRuntimeCapabilities = z.infer<typeof ModelRuntimeCapabilitiesSchema>;

export type PromptCacheEligibility =
  | { readonly eligible: true; readonly mechanism: 'automatic' | 'explicit' }
  | { readonly eligible: false; readonly reason: 'prompt_cache_unsupported' | 'prompt_cache_unknown' };

/** Capability-gated eligibility: syntax or configuration alone never qualifies. */
export function promptCacheEligibility(capabilities: ModelRuntimeCapabilities): PromptCacheEligibility {
  switch (capabilities.promptCache) {
    case 'automatic':
      return Object.freeze({ eligible: true, mechanism: 'automatic' });
    case 'explicit':
      return Object.freeze({ eligible: true, mechanism: 'explicit' });
    case 'unsupported':
      return Object.freeze({ eligible: false, reason: 'prompt_cache_unsupported' });
    case 'unknown':
      return Object.freeze({ eligible: false, reason: 'prompt_cache_unknown' });
    default:
      return assertNever(capabilities.promptCache);
  }
}

export type CapabilityConformance =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'per_step_telemetry_not_supported' | 'cache_claim_without_capability' | 'cache_capability_unknown' };

/**
 * Reject per-step cache claims that the declared capabilities cannot produce.
 * A provider that is `unsupported` (or `unknown`) for cache telemetry must
 * report cache fields as `unsupported`/`missing`, never as `reported` values:
 * request syntax alone is not proof of reuse.
 */
export function checkStepCapabilityConformance(input: {
  readonly capabilities: ModelRuntimeCapabilities;
  readonly usage: NormalizedStepUsage;
}): CapabilityConformance {
  const { capabilities, usage } = input;
  const cacheReadClaimed = usage.cacheReadTokens.status === 'reported' && usage.cacheReadTokens.value !== null;
  const cacheWriteClaimed =
    usage.cacheWriteTokens.status === 'reported' && usage.cacheWriteTokens.value !== null;
  const anyCacheClaimed = cacheReadClaimed || cacheWriteClaimed;
  switch (capabilities.cacheTelemetry) {
    case 'per_step':
      return Object.freeze({ ok: true });
    case 'aggregate_only':
      if (anyCacheClaimed) {
        return Object.freeze({ ok: false, reason: 'per_step_telemetry_not_supported' });
      }
      return Object.freeze({ ok: true });
    case 'unsupported':
      if (anyCacheClaimed) {
        return Object.freeze({ ok: false, reason: 'cache_claim_without_capability' });
      }
      return Object.freeze({ ok: true });
    default:
      return assertNever(capabilities.cacheTelemetry);
  }
}

export function checkUnknownCacheCapability(
  capabilities: ModelRuntimeCapabilities,
  usage: NormalizedStepUsage,
): CapabilityConformance {
  if (capabilities.promptCache !== 'unknown') return Object.freeze({ ok: true });
  const claimed =
    (usage.cacheReadTokens.status === 'reported' && usage.cacheReadTokens.value !== null) ||
    (usage.cacheWriteTokens.status === 'reported' && usage.cacheWriteTokens.value !== null);
  if (claimed) return Object.freeze({ ok: false, reason: 'cache_capability_unknown' });
  return Object.freeze({ ok: true });
}

export const TokenPriceRatesSchema = z.object({
  uncachedInputMicrosPerToken: z.number().finite().min(0).nullable(),
  cacheReadMicrosPerToken: z.number().finite().min(0).nullable(),
  cacheWriteMicrosPerToken: z.number().finite().min(0).nullable(),
  outputMicrosPerToken: z.number().finite().min(0).nullable(),
  priceVersion: z.string().min(1).max(200),
});

export const StepLatencySchema = z.object({
  ttftMs: z.number().int().min(0).nullable(),
  ttftStatus: TokenFieldStatusSchema,
  totalMs: z.number().int().min(0).nullable(),
  totalStatus: TokenFieldStatusSchema,
});
export type StepLatency = z.infer<typeof StepLatencySchema>;

export const RecordStepUsageInputSchema = z.object({
  stepNumber: z.number().int().min(1),
  providerId: z.string().min(1).max(200),
  modelId: z.string().min(1).max(200),
  usage: NormalizedStepUsageSchema,
  rates: TokenPriceRatesSchema,
  latency: StepLatencySchema,
  prefix: PromptPrefixVersionSchema,
});
export type RecordStepUsageInput = z.infer<typeof RecordStepUsageInputSchema>;

export const StepUsageRecordSchema = z.object({
  stepNumber: z.number().int().min(1),
  providerId: z.string().min(1).max(200),
  modelId: z.string().min(1).max(200),
  usage: NormalizedStepUsageSchema,
  latency: StepLatencySchema,
  costMicros: z.number().finite().min(0),
  costCompleteness: z.enum(['complete', 'partial', 'unknown']),
  unknownCostComponents: z.array(z.string()),
  priceVersion: z.string().min(1).max(200),
  prefixVersion: z.string().min(1).max(200),
  toolCatalogVersion: z.string().min(1).max(200),
  schemaDigest: z.string().min(1).max(200),
  systemPromptVersion: z.string().min(1).max(200),
  historyShapeVersion: z.string().min(1).max(200),
  capabilityConformance: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true) }),
    z.object({
      ok: z.literal(false),
      reason: z.enum([
        'per_step_telemetry_not_supported',
        'cache_claim_without_capability',
        'cache_capability_unknown',
      ]),
    }),
  ]),
});
export type StepUsageRecord = z.infer<typeof StepUsageRecordSchema>;

export interface RecordStepUsageOptions {
  readonly capabilities?: ModelRuntimeCapabilities | undefined;
}

/**
 * Per-step usage record (F-32). Extends the WP-7 usage normalizer with TTFT /
 * total latency, provider/model/prompt identity, provider-specific billable
 * cost, and capability conformance. Missing cache fields stay missing (never
 * zero); cost completeness is `complete` / `partial` / `unknown` and a record
 * whose cost is `unknown` carries `costMicros: 0` as an explicit non-total.
 */
export function recordStepUsage(input: unknown, options: RecordStepUsageOptions = {}): StepUsageRecord {
  const parsed = RecordStepUsageInputSchema.parse(input);
  const rates: TokenPriceRates = {
    uncachedInputMicrosPerToken: parsed.rates.uncachedInputMicrosPerToken,
    cacheReadMicrosPerToken: parsed.rates.cacheReadMicrosPerToken,
    cacheWriteMicrosPerToken: parsed.rates.cacheWriteMicrosPerToken,
    outputMicrosPerToken: parsed.rates.outputMicrosPerToken,
    priceVersion: parsed.rates.priceVersion,
  };
  const cost = computeStepCost(parsed.usage, rates);
  let conformance: CapabilityConformance = Object.freeze({ ok: true });
  if (options.capabilities !== undefined) {
    const granular = checkStepCapabilityConformance({ capabilities: options.capabilities, usage: parsed.usage });
    conformance = !granular.ok
      ? granular
      : checkUnknownCacheCapability(options.capabilities, parsed.usage);
    if (!conformance.ok) {
      logger.warn('prompt.step_cache_claim_rejected', {
        stepNumber: parsed.stepNumber,
        providerId: parsed.providerId,
        modelId: parsed.modelId,
        reason: conformance.reason,
      });
    }
  }
  const record: StepUsageRecord = {
    stepNumber: parsed.stepNumber,
    providerId: parsed.providerId,
    modelId: parsed.modelId,
    usage: parsed.usage,
    latency: parsed.latency,
    costMicros: cost.micros,
    costCompleteness: cost.completeness,
    unknownCostComponents: [...cost.unknownComponents],
    priceVersion: parsed.rates.priceVersion,
    prefixVersion: parsed.prefix.prefixVersion,
    toolCatalogVersion: parsed.prefix.toolCatalogVersion,
    schemaDigest: parsed.prefix.schemaDigest,
    systemPromptVersion: parsed.prefix.systemPromptVersion,
    historyShapeVersion: parsed.prefix.historyShapeVersion,
    capabilityConformance: conformance,
  };
  return Object.freeze(record);
}

export const PrefixSavingsEstimateSchema = z.object({
  billedMicros: z.number().finite().min(0),
  counterfactualUncachedMicros: z.number().finite().min(0).nullable(),
  savedMicros: z.number().finite().min(0).nullable(),
  completeness: z.enum(['complete', 'partial', 'unknown']),
  evidence: z.enum(['observed_per_step', 'insufficient']),
});
export type PrefixSavingsEstimate = z.infer<typeof PrefixSavingsEstimateSchema>;

/**
 * Compare billed input cost against the counterfactual where every reported
 * input token paid the uncached rate. Savings are returned only when every
 * step is cost-`complete` with observed per-step evidence; otherwise
 * `savedMicros` is null and `evidence` is `insufficient`. No savings are ever
 * claimed from missing fields, aggregate totals, or configuration alone.
 */
export function estimatePrefixSavings(
  steps: readonly StepUsageRecord[],
  rates: unknown,
): PrefixSavingsEstimate {
  const parsedRates = TokenPriceRatesSchema.parse(rates);
  let billed = 0;
  let counterfactual: number | null = 0;
  let allComplete = steps.length > 0;
  for (const step of steps) {
    billed += step.costMicros;
    if (step.costCompleteness !== 'complete') {
      allComplete = false;
      counterfactual = null;
      continue;
    }
    if (counterfactual === null) continue;
    const uncachedRate = parsedRates.uncachedInputMicrosPerToken;
    const outputRate = parsedRates.outputMicrosPerToken;
    if (uncachedRate === null || outputRate === null) {
      counterfactual = null;
      continue;
    }
    const usage: NormalizedStepUsage = step.usage;
    const uncached = usage.uncachedTokens.value ?? 0;
    const read = usage.cacheReadTokens.value ?? 0;
    const written = usage.cacheWriteTokens.value ?? 0;
    const output = usage.outputTokens.value ?? 0;
    counterfactual += (uncached + read + written) * uncachedRate + output * outputRate;
  }
  if (!allComplete || counterfactual === null) {
    return Object.freeze({
      billedMicros: billed,
      counterfactualUncachedMicros: null,
      savedMicros: null,
      completeness: steps.length === 0 ? 'unknown' : 'partial',
      evidence: 'insufficient',
    });
  }
  return Object.freeze({
    billedMicros: billed,
    counterfactualUncachedMicros: counterfactual,
    savedMicros: Math.max(0, counterfactual - billed),
    completeness: 'complete',
    evidence: 'observed_per_step',
  });
}
